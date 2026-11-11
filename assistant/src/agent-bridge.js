// Agent bridge: lets the isolated Jarvis service account use the coding-agent CLIs
// (Claude Code, Codex, Antigravity) that are logged in under the owner's account.
// Runs as its own service under the owner's user, listens only on a Unix socket that
// the jarvis group can reach, and runs every CLI text-only: no shell, file, web or MCP tools.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, chmodSync, chownSync, unlinkSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

export const AGENTS = {
  'claude-cli': { binary: 'claude', label: 'Claude Code' },
  'codex-cli': { binary: 'codex', label: 'Codex' },
  'antigravity-cli': { binary: 'agy', label: 'Antigravity' },
};
const fail = (message, status = 409) => Object.assign(new Error(message), { status });

function childEnv() {
  // Never pass Jarvis keys, connector credentials, or provisioning tokens to a CLI.
  return Object.fromEntries(['PATH','HOME','USER','LANG','TERM','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
}

export function invoke(binary, args, input = '', cwd, timeout = 180_000) {
  return new Promise((done, reject) => {
    const child = spawn(binary, args, { shell: false, env: childEnv(), cwd, stdio: ['pipe','pipe','pipe'] });
    let out = '', bytes = 0, settled = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(fail('CLI request timed out. Check its login state and usage limits.', 504)); }, timeout);
    function finish(e, value) { if (settled) return; settled = true; clearTimeout(timer); e ? reject(e) : done(value); }
    child.on('error', () => finish(fail(`${binary} is not installed or not on PATH for the agent bridge.`)));
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 2_000_000) { child.kill('SIGKILL'); finish(fail('CLI output exceeded the response limit', 502)); } else out += chunk; });
    // Drain stderr without logging prompts, tokens, or private content.
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('close', code => code === 0 ? finish(null, out) : finish(fail(`${binary} exited with code ${code}. Check its login and usage limits on the server.`, 502)));
    child.stdin.end(input);
  });
}

// Settings that deny every Antigravity tool; headless mode also auto-denies anything not allowed.
export const ANTIGRAVITY_SETTINGS = JSON.stringify({ toolPermission: 'request-review', agentMode: 'plan', allowNonWorkspaceAccess: false, trustedWorkspaces: [], permissions: { allow: [], deny: ['command(*)', 'file(*)', 'mcp(*)', 'read_file(*)', 'browser(*)'] } });

export function agentCommand(provider, model) {
  const m = model ? String(model).slice(0, 120) : '';
  if (provider === 'claude-cli') return { binary: 'claude', args: ['-p','--output-format','json','--tools','','--disallowedTools','mcp__*','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands','--no-session-persistence','--setting-sources','','--max-turns','1', ...(m ? ['--model', m] : [])] };
  if (provider === 'codex-cli') return { binary: 'codex', args: ['exec','--json','--ephemeral','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--sandbox','read-only','--config','approval_policy="never"','--disable','shell_tool','--disable','unified_exec','--disable','apps','--disable','plugins','--disable','memories','--config','tools.view_image=false','--config','web_search="disabled"','--config','features.code_mode.enabled=false', ...(m ? ['--model', m] : []), '-'] };
  if (provider === 'antigravity-cli') return { binary: 'agy', args: ['--sandbox','--settings', ANTIGRAVITY_SETTINGS,'--input-format','stream-json','--output-format','stream-json','--print-timeout','170s', ...(m ? ['--model', m] : [])] };
  throw fail('Unknown coding agent', 400);
}

export function agentInput(provider, prompt) {
  // Prompts go through stdin so private memory never appears in the process list.
  return provider === 'antigravity-cli' ? JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n' : prompt;
}

export function parseAgentOutput(provider, raw) {
  if (provider === 'claude-cli') {
    let parsed; try { parsed = JSON.parse(raw); } catch { throw fail('Claude CLI returned an unsupported response format', 502); }
    if (parsed.is_error || typeof parsed.result !== 'string') throw fail('Claude CLI did not produce a response', 502);
    return parsed.result;
  }
  const events = raw.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } });
  if (provider === 'codex-cli') {
    if (events.some(x => x.type === 'turn.failed' || x.type === 'error')) throw fail('Codex CLI could not complete the request', 502);
    const answer = events.filter(x => x.type === 'item.completed' && x.item?.type === 'agent_message').map(x => x.item.text).join('\n');
    if (!answer) throw fail('Codex CLI returned no final answer', 502);
    return answer;
  }
  const result = events.find(x => x.event === 'result')?.result;
  if (!result || result.status !== 'SUCCESS') throw fail('Antigravity CLI could not complete the request', 502);
  if (!result.response?.trim()) throw fail(result.denied_actions?.length ? 'Antigravity tried to use a blocked tool and returned no answer' : 'Antigravity CLI returned no answer', 502);
  return result.response.trim();
}

export async function runAgent(provider, model, prompt, { workRoot = tmpdir(), run = invoke } = {}) {
  const { binary, args } = agentCommand(provider, model);
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const cwd = mkdtempSync(join(workRoot, 'jarvis-turn-'));
  try { return parseAgentOutput(provider, await run(binary, args, agentInput(provider, prompt), cwd)); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
}

export async function agentInventory(run = invoke) {
  return Promise.all(Object.entries(AGENTS).map(async ([provider, { binary, label }]) => {
    try { const version = await run(binary, ['--version'], '', undefined, 10_000); return { provider, label, installed: true, version: version.trim().split('\n')[0].slice(0, 120), usable_as_model: true, note: 'Text-only: shell, file, web and MCP tools are disabled.' }; }
    catch { return { provider, label, installed: false, usable_as_model: false }; }
  }));
}

// One request at a time per agent keeps the Pi responsive and respects CLI usage limits.
export function createBridge({ runner = runAgent, inventory = agentInventory, maxQueue = 4 } = {}) {
  const queues = new Map();
  const enqueue = (provider, task) => {
    const q = queues.get(provider) || { tail: Promise.resolve(), size: 0 };
    if (q.size >= maxQueue) throw fail(`${AGENTS[provider].label} is busy. Try again shortly.`, 429);
    q.size++; queues.set(provider, q);
    const next = q.tail.then(task, task).finally(() => { q.size--; });
    q.tail = next.catch(() => {});
    return next;
  };
  return createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      if (req.method === 'GET' && req.url === '/agents') return send(200, await inventory());
      if (req.method === 'POST' && req.url === '/reply') {
        let body = '', size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 400_000) throw fail('Prompt too large', 413); body += chunk; }
        const { provider, model, prompt } = JSON.parse(body || '{}');
        if (!AGENTS[provider]) throw fail('Unknown coding agent', 400);
        if (typeof prompt !== 'string' || !prompt.trim()) throw fail('Prompt required', 400);
        return send(200, { text: await enqueue(provider, () => runner(provider, model, prompt)) });
      }
      send(404, { error: 'Not found' });
    } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Agent bridge error' }); }
  });
}

// Resolve symlinks: production starts this via /opt/jarvis/current, a symlink to the release.
const isMain = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isMain) {
  const socket = resolve(process.env.AGENT_BRIDGE_SOCKET || '/run/jarvis-agents/bridge.sock');
  // Only members of this group (the Jarvis service account) may connect to the socket.
  const groupName = process.env.AGENT_BRIDGE_GROUP;
  const group = groupName ? Number(readFileSync('/etc/group', 'utf8').split('\n').map(l => l.split(':')).find(f => f[0] === groupName)?.[2]) : null;
  if (groupName && !Number.isInteger(group)) throw new Error(`Group ${groupName} not found`);
  if (existsSync(socket)) unlinkSync(socket);
  const server = createBridge();
  server.listen(socket, () => {
    if (group !== null) chownSync(socket, process.getuid(), group);
    chmodSync(socket, 0o660);
    console.log(`Agent bridge listening on ${socket}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
