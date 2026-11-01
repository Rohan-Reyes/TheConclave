// Run one headless turn of an agent CLI and turn its output into common events:
//   session | delta | activity | file | usage | ratelimit | error
import { spawn, execFile, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { codexExe, HOME } from '../paths.js';
import { getDb, now, kvSet } from '../db.js';

const BUILTIN = {
  claude: { label: 'Claude Code', short: 'Claude', mention: ['claude'], builtin: true },
  antigravity: { label: 'Antigravity', short: 'Antigravity', mention: ['antigravity', 'agy'], builtin: true },
  codex: { label: 'Codex', short: 'Codex', mention: ['codex'], builtin: true },
};

// Presets for other agent CLIs. "check" is the executable looked up on PATH.
const WELL_KNOWN_EXES = {
  ollama: [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
    path.join(process.env.ProgramFiles || '', 'Ollama', 'ollama.exe'),
  ],
};

export function members() {
  const out = { ...BUILTIN };
  for (const a of listAgents()) {
    if (!a.enabled || out[a.id]) continue;
    const mentions = new Set([a.id, a.id.replace(/[-_.]/g, '')]);
    if (a.id.includes('qwen') || (Array.isArray(a.args) && a.args.some(x => String(x).includes('qwen')))) {
      mentions.add('qwen'); mentions.add('qwen3.8'); mentions.add('qwen38');
    }
    if (a.id.includes('ollama') || String(a.command).includes('ollama')) {
      mentions.add('ollama');
    }
    out[a.id] = { label: a.name, short: a.name, mention: [...mentions], builtin: false, agent: a };
  }
  return out;
}
export const memberIds = () => Object.keys(members());
export const member = id => members()[id] || { label: id, short: id, mention: [id] };

// ---------- custom agents
export function listAgents() {
  return getDb().prepare('SELECT * FROM agents ORDER BY created').all().map(a => ({ ...a, args: JSON.parse(a.args), enabled: !!a.enabled }));
}
export function saveAgent(a) {
  const id = String(a.id || a.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  if (!id) throw new Error('Name is required');
  if (BUILTIN[id] || ['all', 'council', 'user'].includes(id)) throw new Error(`"${id}" is reserved`);
  if (!a.command) throw new Error('Command is required');
  const args = Array.isArray(a.args) ? a.args.map(String) : [];
  const input = a.input === 'arg' ? 'arg' : 'stdin';
  if (input === 'arg' && !args.some(x => x.includes('{prompt}'))) throw new Error('Add {prompt} to the arguments, or send the prompt on stdin');
  getDb().prepare(`INSERT INTO agents (id, name, command, args, input, enabled, created) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, command=excluded.command, args=excluded.args, input=excluded.input, enabled=excluded.enabled`)
    .run(id, a.name || id, a.command, JSON.stringify(args), input, a.enabled === false ? 0 : 1, now());
  return listAgents().find(x => x.id === id);
}
export function deleteAgent(id) { getDb().prepare('DELETE FROM agents WHERE id = ?').run(id); }

// Presets for other agent CLIs. "check" is the executable looked up on PATH.
export const PRESETS = [
  { id: 'gemini', name: 'Gemini CLI', check: 'gemini', command: 'gemini', args: ['-p', 'Answer the conversation above.', '-o', 'text', '--approval-mode', 'plan', '--skip-trust'], input: 'stdin', note: 'Needs a Gemini API key (GEMINI_API_KEY); free Code Assist logins now redirect to Antigravity.' },
  { id: 'ollama', name: 'Ollama (qwen3.8)', check: 'ollama', command: 'ollama', args: ['run', 'qwen3.8', '--nowordwrap'], input: 'stdin', note: 'Runs local Qwen 3.8 offline with Ollama.' },
  { id: 'aider', name: 'Aider', check: 'aider', command: 'aider', args: ['--message', '{prompt}', '--yes-always', '--no-pretty', '--no-stream'], input: 'arg', note: 'Edits files in the working folder; uses your configured model keys.' },
  { id: 'opencode', name: 'OpenCode', check: 'opencode', command: 'opencode', args: ['run', '{prompt}'], input: 'arg', note: '' },
  { id: 'copilot', name: 'GitHub Copilot CLI', check: 'copilot', command: 'copilot', args: ['-p', '{prompt}', '--allow-all-tools'], input: 'arg', note: 'Allows all tools: it can run commands.' },
  { id: 'qwen', name: 'Qwen Code', check: 'qwen', command: 'qwen', args: ['-p', 'Answer the conversation above.'], input: 'stdin', note: '' },
  { id: 'goose', name: 'Goose', check: 'goose', command: 'goose', args: ['run', '-t', '{prompt}'], input: 'arg', note: '' },
  { id: 'llm', name: 'llm (Simon Willison)', check: 'llm', command: 'llm', args: [], input: 'stdin', note: 'Uses your default llm model.' },
];

export function whichAll(names) {
  const out = {};
  for (const n of names) {
    let hit = null;
    try { hit = execFileSync('where', [n], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] }).split(/\r?\n/).filter(Boolean)[0] || null; }
    catch { hit = null; }
    if (!hit && WELL_KNOWN_EXES[n]) {
      hit = WELL_KNOWN_EXES[n].find(p => p && fs.existsSync(p)) || null;
    }
    out[n] = hit;
  }
  return out;
}
export function detectPresets() {
  const found = whichAll(PRESETS.map(p => p.check));
  const have = new Set(listAgents().map(a => a.id));
  return PRESETS.map(p => ({ ...p, path: found[p.check], added: have.has(p.id) }));
}

// Windows npm shims (.cmd) can't be spawned without a shell. Run their JS
// entry with node instead, so prompts never pass through cmd.exe.
export function resolveCommand(cmd) {
  if (process.platform !== 'win32' || /[\\/]/.test(cmd) && fs.existsSync(cmd)) return { file: cmd, pre: [] };
  const baseName = path.basename(cmd, '.exe').toLowerCase();
  if (WELL_KNOWN_EXES[baseName]) {
    const known = WELL_KNOWN_EXES[baseName].find(p => p && fs.existsSync(p));
    if (known) return { file: known, pre: [] };
  }
  let hits = [];
  try { hits = execFileSync('where', [cmd], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] }).split(/\r?\n/).filter(Boolean); } catch {}
  const exe = hits.find(h => /\.exe$/i.test(h));
  if (exe) return { file: exe, pre: [] };
  const shim = hits.find(h => /\.cmd$/i.test(h));
  if (shim) {
    const text = fs.readFileSync(shim, 'utf8');
    const m = text.match(/"%(?:~)?dp0%\\([^"]+\.(?:js|mjs|cjs))"/i) || text.match(/%dp0%\\([^"\s]+\.(?:js|mjs|cjs))/i);
    if (m) return { file: process.execPath, pre: [path.join(path.dirname(shim), m[1])] };
  }
  return { file: cmd, pre: [] };
}

export function isAgentAvailable(tool) {
  if (tool === 'claude' || tool === 'codex' || tool === 'antigravity') return true;
  const m = member(tool);
  const a = m?.agent;
  if (!a) return false;
  if (process.platform === 'win32') {
    const res = resolveCommand(a.command);
    if (res.file && (fs.existsSync(res.file) || res.file === process.execPath)) return true;
    const hit = whichAll([a.command])[a.command];
    return !!hit;
  }
  return true;
}

// Permission levels shared by the built-in tools.
//   read: look only · ask: Claude asks you in the browser for anything risky
//   edit: edit files in the folder · full: anything, no sandbox
// Codex and Antigravity can't ask in headless mode, so "ask" = sandboxed edits for them.
export const APPROVAL_TOOL = 'mcp__agent-hub-memory__approval_prompt';
const PERMS = {
  claude: {
    read: ['--permission-mode', 'plan'],
    ask: ['--permission-mode', 'default', '--permission-prompt-tool', APPROVAL_TOOL],
    edit: ['--permission-mode', 'acceptEdits'],
    full: ['--dangerously-skip-permissions'],
  },
  antigravity: { read: ['--mode', 'plan'], ask: ['--mode', 'accept-edits'], edit: ['--mode', 'accept-edits'], full: ['--dangerously-skip-permissions'] },
  codex: { read: ['-c', 'sandbox_mode="read-only"'], ask: ['-c', 'sandbox_mode="workspace-write"'], edit: ['-c', 'sandbox_mode="workspace-write"'], full: ['--dangerously-bypass-approvals-and-sandbox'] },
};
export const CAN_ASK = { claude: true };

const short = (s, n = 160) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

const EFFORT_RE = /^(low|medium|high|xhigh|max|ultra|minimal)$/;

// Terminal access: "direct" lets agents run shell commands without a sandbox or
// prompts (unless the chat is read-only); "sandboxed" keeps each tool's own limits.
function terminalArgs(tool, permission, shell) {
  if (shell !== 'direct' || permission === 'read' || permission === 'full') return null;
  if (tool === 'claude') return [...PERMS.claude[permission], '--allowedTools', 'Bash', 'PowerShell'];
  if (tool === 'codex') return ['-c', 'sandbox_mode="danger-full-access"'];
  if (tool === 'antigravity') return ['--dangerously-skip-permissions'];
  return null;
}

export function buildCommand(tool, { prompt, nativeId, permission, model, effort, shell, images = [] }) {
  const perm = terminalArgs(tool, permission, shell) || PERMS[tool]?.[permission] || PERMS[tool]?.read;
  if (effort && !EFFORT_RE.test(effort)) effort = null;
  if (tool === 'claude') {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...perm];
    if (nativeId) args.push('--resume', nativeId);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    return { cmd: 'claude', args, stdin: prompt, format: 'claude' };
  }
  if (tool === 'antigravity') {
    const args = ['--output-format', 'stream-json', ...perm];
    if (nativeId) args.push('--conversation', nativeId);
    if (model) args.push('--model', model);
    if (effort && effort !== 'ultra' && effort !== 'minimal') args.push('--effort', effort);
    args.push('-p', prompt);   // agy takes the prompt as an argument
    return { cmd: 'agy', args, stdin: null, format: 'antigravity' };
  }
  if (tool === 'codex') {
    // Headless Codex can't answer MCP approval prompts, so pre-approve Conclave's own tools.
    const common = ['--json', '--skip-git-repo-check', ...perm, '-c', 'mcp_servers.agent-hub-memory.default_tools_approval_mode="approve"'];
    if (model) common.push('-m', model);
    if (effort) common.push('-c', `model_reasoning_effort="${effort}"`);
    for (const image of images.slice(0, 8)) common.push('--image', image);
    const args = nativeId ? ['exec', 'resume', ...common, nativeId, '-'] : ['exec', ...common, '-'];
    return { cmd: codexExe(), args, stdin: prompt, format: 'codex' };
  }
  const a = member(tool).agent;
  if (!a) throw new Error(`Unknown agent "${tool}"`);
  const args = a.args.map(x => a.input === 'arg' ? x.replaceAll('{prompt}', prompt) : x.replaceAll('{prompt}', ''));
  return { cmd: a.command, args, stdin: a.input === 'stdin' ? prompt : null, format: 'text' };
}

const FILE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|write_to_file|replace_file_content|multi_replace_file_content|create_file|edit_file)$/;

// ---------- stream parsers
function claudeParser() {
  const texts = [];
  const pendingFiles = new Map();   // tool_use_id -> file event, sent once the tool succeeds
  return (j) => {
    const ev = [];
    if (j.type === 'system' && j.subtype === 'init' && j.session_id) ev.push({ type: 'session', id: j.session_id });
    else if (j.type === 'stream_event') {
      const e = j.event || {};
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') ev.push({ type: 'delta', text: e.delta.text });
      if (e.type === 'message_start') ev.push({ type: 'break' });
      if (e.type === 'content_block_start') {
        const k = e.content_block?.type;
        ev.push({ type: 'phase', phase: k === 'thinking' || k === 'redacted_thinking' ? 'thinking' : k === 'tool_use' ? 'tool' : 'writing' });
      }
    } else if (j.type === 'assistant') {
      for (const b of j.message?.content || []) {
        if (b.type === 'text' && b.text) texts.push(b.text);
        if (b.type === 'tool_use') {
          if (/^bash$/i.test(b.name || '')) ev.push({ type: 'phase', phase: 'tool', command: true });
          ev.push({ type: 'activity', text: `${b.name} ${short(JSON.stringify(b.input), 140)}` });
          const fp = b.input?.file_path || b.input?.notebook_path;
          if (FILE_TOOLS.test(b.name) && fp) pendingFiles.set(b.id, { type: 'file', path: fp, action: b.name === 'Write' ? 'created' : 'edited' });
        }
      }
    } else if (j.type === 'user') {
      for (const b of j.message?.content || []) {
        if (b.type !== 'tool_result') continue;
        ev.push({ type: 'phase', phase: 'thinking' });
        const f = pendingFiles.get(b.tool_use_id);
        pendingFiles.delete(b.tool_use_id);
        if (b.is_error) ev.push({ type: 'activity', text: `↳ ${/denied|reject/i.test(JSON.stringify(b.content)) ? 'denied' : 'error'}: ${short(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), 140)}` });
        else if (f) ev.push(f);   // only show a file chip once the write actually happened
      }
    } else if (j.type === 'rate_limit_event' && j.rate_limit_info) {
      ev.push({ type: 'ratelimit', tool: 'claude', info: j.rate_limit_info });
    } else if (j.type === 'result') {
      if (j.session_id) ev.push({ type: 'session', id: j.session_id });
      const u = j.usage || {};
      ev.push({ type: 'usage', input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cached: u.cache_read_input_tokens || 0, output: u.output_tokens || 0, cost: j.total_cost_usd || 0 });
      if (j.is_error) ev.push({ type: 'error', text: j.result || j.subtype || 'error' });
      ev.push({ type: 'final', text: texts.join('\n\n') || j.result || '' });
    }
    return ev;
  };
}

function agyParser() {
  let text = '';
  return (j) => {
    const ev = [];
    if (j.event === 'init' && j.conversation_id) ev.push({ type: 'session', id: j.conversation_id });
    else if (j.event === 'step_update') {
      const s = j.step_update || {};
      const name = s.tool_name || s.name || s.tool_call?.name || s.step_type || '';
      if (s.thinking_delta || s.thought_delta) ev.push({ type: 'phase', phase: 'thinking' });
      else if (s.state === 'ACTIVE' && s.step_type !== 'agent_response' && s.step_type !== 'user_input') {
        ev.push({ type: 'phase', phase: 'tool', command: /command|shell|bash|terminal/i.test(name) });
      }
      if (s.step_type === 'agent_response') {
        if (s.text_delta) { text += s.text_delta; ev.push({ type: 'delta', text: s.text_delta }); }
      } else if (s.state === 'DONE' && s.step_type !== 'user_input') {
        ev.push({ type: 'phase', phase: 'thinking' });
        ev.push({ type: 'activity', text: short(`${name} ${s.summary || s.description || ''}`) });
        const fp = s.target_file || s.file_path || s.tool_call?.args?.TargetFile;
        if (fp) ev.push({ type: 'file', path: String(fp).replace(/^"|"$/g, ''), action: 'edited' });
      }
    } else if (j.event === 'result') {
      const r = j.result || {};
      if (r.conversation_id) ev.push({ type: 'session', id: r.conversation_id });
      const u = r.usage || {};
      ev.push({ type: 'usage', input: u.input_tokens || 0, cached: u.cache_read_tokens || 0, output: (u.output_tokens || 0) + (u.thinking_tokens || 0), cost: 0 });
      if (r.status && r.status !== 'SUCCESS') ev.push({ type: 'error', text: r.error || r.status });
      ev.push({ type: 'final', text: r.response || text });
    } else if (j.event === 'error') {
      ev.push({ type: 'error', text: j.error?.message || JSON.stringify(j.error || j) });
    }
    return ev;
  };
}

function codexParser() {
  const texts = [];
  return (j) => {
    const ev = [];
    if (j.type === 'thread.started' && j.thread_id) ev.push({ type: 'session', id: j.thread_id });
    else if (j.type === 'turn.started') ev.push({ type: 'phase', phase: 'thinking' });
    else if (j.type === 'item.started') {
      const it = j.item || {};
      if (it.type === 'reasoning') ev.push({ type: 'phase', phase: 'thinking' });
      else if (it.type === 'command_execution') ev.push({ type: 'phase', phase: 'tool', command: true }, { type: 'activity', text: `▶ ${short(it.command, 140)}` });
      else if (it.type === 'mcp_tool_call' || it.type === 'file_change') ev.push({ type: 'phase', phase: 'tool' });
    }
    else if (j.type === 'item.completed') {
      const it = j.item || {};
      if (it.type === 'agent_message') { texts.push(it.text); ev.push({ type: 'delta', text: (texts.length > 1 ? '\n\n' : '') + it.text }); }
      else if (it.type === 'command_execution') ev.push({ type: 'phase', phase: 'thinking' }, { type: 'activity', text: `$ ${short(it.command, 140)}${it.exit_code ? ` (exit ${it.exit_code})` : ''}` });
      else if (it.type === 'file_change') {
        ev.push({ type: 'phase', phase: 'thinking' });
        ev.push({ type: 'activity', text: `edit ${short((it.changes || []).map(c => `${c.kind} ${c.path}`).join(', '))}` });
        for (const c of it.changes || []) ev.push({ type: 'file', path: c.path, action: c.kind === 'add' ? 'created' : c.kind === 'delete' ? 'deleted' : 'edited' });
      }
      else if (it.type === 'mcp_tool_call') ev.push({ type: 'phase', phase: 'thinking' }, { type: 'activity', text: `${it.server}.${it.tool}` });
      else if (it.type === 'web_search') ev.push({ type: 'activity', text: `search ${short(it.query)}` });
    } else if (j.type === 'turn.completed') {
      const u = j.usage || {};
      ev.push({ type: 'usage', input: Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0)), cached: u.cached_input_tokens || 0, output: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0), cost: 0 });
      ev.push({ type: 'final', text: texts.join('\n\n') });
    }
    else if (j.type === 'turn.failed' || j.type === 'error') ev.push({ type: 'error', text: j.error?.message || j.message || 'Codex error' });
    return ev;
  };
}

const PARSERS = { claude: claudeParser, antigravity: agyParser, codex: codexParser };

// Strip variables that make a CLI think it is nested in another session, and
// mark children so the memory MCP server won't let them start councils (no loops).
function childEnv(extra = {}) {
  const env = { ...process.env, CONCLAVE_CHILD: '1', ...extra };
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  return env;
}

export function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else if (child.exitCode === null) { try { child.kill('SIGTERM'); } catch {} }
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Run one turn. Returns { promise, stop() }; promise resolves to
 * { text, sessionId, error, files[], usage{} }.
 */
export function runTurn(tool, { cwd, prompt, nativeId, permission = 'read', model, effort, images = [], shell = 'sandboxed', timeoutMin = 20, stallMin = 4, isWaiting = null, env: extraEnv = {} }, onEvent = () => {}) {
  let built;
  try { built = buildCommand(tool, { prompt, nativeId, permission, model, effort, shell, images }); }
  catch (e) { return { promise: Promise.resolve({ text: '', error: e.message, files: [], usage: {} }), stop() {} }; }
  const { cmd, args, stdin, format } = built;
  const dir = cwd && fs.existsSync(cwd) ? cwd : HOME;
  const parse = format === 'text' ? null : PARSERS[format]();
  const files = new Map();
  let usage = {};
  let sessionId = nativeId || null, finalText = null, errorText = null, streamed = '', stopped = false;
  let child, forceStop = null;
  const promise = new Promise(resolve => {
    try {
      const { file, pre } = resolveCommand(cmd);
      child = spawn(file, [...pre, ...args], { cwd: dir, env: childEnv(extraEnv), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { resolve({ text: '', sessionId, error: e.message, files: [], usage }); return; }
    const stderr = [];
    child.stderr.on('data', d => { stderr.push(d); if (stderr.length > 200) stderr.shift(); });
    child.stdin.on('error', () => {});
    if (stdin != null) child.stdin.write(stdin);
    child.stdin.end();
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let settled = false, exitTimer = null, killTimer = null, finalTimer = null;
    const finish = (code = child?.exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(exitTimer);
      clearTimeout(killTimer);
      clearTimeout(finalTimer);
      clearInterval(watchdog);
      try { rl.close(); } catch {}
      try { child.stdout?.destroy(); } catch {}
      try { child.stderr?.destroy(); } catch {}
      try { child.stdin?.destroy(); } catch {}
      const text = (finalText ?? streamed).trim();
      if (stopped) errorText = 'Stopped';
      else if (code && !errorText && !text) errorText = Buffer.concat(stderr).toString('utf8').replace(ANSI, '').trim().slice(-800) || `${cmd} exited with code ${code}`;
      resolve({ text, sessionId, error: errorText, files: [...files.values()], usage });
    };
    const forceKill = reason => {
      if (reason && !errorText) errorText = reason;
      killTree(child);
      if (!settled && !killTimer) {
        killTimer = setTimeout(() => finish(child?.exitCode ?? 1), 600);
        killTimer.unref?.();
      }
    };
    forceStop = () => forceKill('Stopped');
    if (stopped) { forceStop(); return; }
    child.on('error', e => {
      errorText = `Could not start ${cmd}: ${e.message}`;
      setTimeout(() => finish(1), 50).unref?.();
    });
    // Stall watchdog: no output at all for stallMin minutes (longer while a shell
    // command is running) means the agent is stuck, e.g. waiting on a hidden prompt.
    let lastOut = Date.now(), inCommand = false;
    const pollMs = Math.min(15_000, Math.max(100, Math.round(stallMin * 15_000)));
    const watchdog = setInterval(() => {
      if (typeof isWaiting === 'function' && isWaiting()) { lastOut = Date.now(); return; }
      const limit = (inCommand ? Math.max(stallMin, 20) : stallMin) * 60_000;
      if (Date.now() - lastOut > limit) {
        forceKill(`Stalled: no output for ${Math.max(1, Math.round(limit / 60_000))} minutes`);
      }
    }, pollMs);
    watchdog.unref?.();
    child.stderr.on('data', () => { lastOut = Date.now(); });
    rl.on('line', line => {
      lastOut = Date.now();
      if (!parse) {   // plain-text agents: every line is reply text
        const t = line.replace(ANSI, '') + '\n';
        streamed += t; onEvent({ type: 'delta', text: t });
        return;
      }
      if (!line.startsWith('{')) return;
      let j; try { j = JSON.parse(line); } catch { return; }
      for (const e of parse(j)) {
        if (e.type === 'session') { sessionId = e.id; onEvent(e); }
        else if (e.type === 'final') {
          finalText = e.text;
          if (!finalTimer) {
            finalTimer = setTimeout(() => { killTree(child); finish(child?.exitCode ?? 0); }, 2500);
            finalTimer.unref?.();
          }
        }
        else if (e.type === 'error') { errorText = e.text; onEvent(e); }
        else if (e.type === 'usage') usage = e;
        else if (e.type === 'ratelimit') kvSet(`ratelimit:${e.tool}`, e.info);
        else if (e.type === 'file') {
          const p = path.isAbsolute(e.path) ? e.path : path.join(dir, e.path);
          files.set(p.toLowerCase(), { path: p, action: e.action });
          onEvent({ type: 'file', path: p, action: e.action });
        }
        else if (e.type === 'phase') { if (e.command) inCommand = true; else if (e.phase !== 'tool') inCommand = false; onEvent({ type: 'phase', phase: e.phase }); }
        else if (e.type === 'break') { if (streamed && !streamed.endsWith('\n\n')) { streamed += '\n\n'; onEvent({ type: 'delta', text: '\n\n' }); } }
        else { if (e.type === 'delta') streamed += e.text; onEvent(e); }
      }
    });
    const timer = setTimeout(() => forceKill(`Timed out after ${timeoutMin} min`), timeoutMin * 60_000);
    timer.unref?.();
    // Detached grandchildren can inherit stdio pipes and keep 'close' from firing
    // after the agent CLI process itself has exited. Flush briefly on 'exit' then settle.
    child.on('exit', code => {
      if (!settled && !exitTimer) {
        exitTimer = setTimeout(() => finish(code), 250);
        exitTimer.unref?.();
      }
    });
    child.on('close', code => finish(code));
  });
  return { promise, stop() { stopped = true; if (forceStop) forceStop(); else killTree(child); } };
}
