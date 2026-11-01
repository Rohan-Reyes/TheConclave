import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import TOML from '@iarna/toml';
import { P, HOME } from '../paths.js';
import { backupFile, lineDiff } from './backup.js';

const run = promisify(execFile);

// Common shape used by the hub: { type: 'stdio'|'http', command, args, env, url, headers }
export const TARGETS = {
  claude: { label: 'Claude Code', file: P.claude.userConfig, format: 'claude-json' },
  // Current Antigravity (CLI + IDE) reads one shared file; the older per-app
  // mcp_config.json files under antigravity/ and antigravity-cli/ are unused.
  antigravity: { label: 'Antigravity', file: path.join(HOME, '.gemini', 'config', 'mcp_config.json'), format: 'agy-json' },
  codex: { label: 'Codex', file: P.codex.config, format: 'codex-toml' },
};

function fromNative(format, s) {
  if (!s || typeof s !== 'object') return null;
  const url = s.url || s.serverUrl || s.httpUrl;
  if (url) return { type: 'http', url, headers: s.headers || s.http_headers || {} };
  return { type: 'stdio', command: s.command || '', args: s.args || [], env: s.env || {} };
}

function toNative(format, s) {
  const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length) && !(v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)));
  if (s.type === 'http') {
    if (format === 'claude-json') return clean({ type: 'http', url: s.url, headers: s.headers });
    if (format === 'agy-json') return clean({ serverUrl: s.url, headers: s.headers });
    return clean({ url: s.url, http_headers: s.headers });
  }
  const base = clean({ command: s.command, args: s.args, env: s.env });
  return format === 'claude-json' ? { type: 'stdio', ...base } : base;
}

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }

function parseServers(target) {
  const t = TARGETS[target];
  const text = readText(t.file);
  if (!text.trim()) return {};
  if (t.format === 'codex-toml') return TOML.parse(text).mcp_servers || {};
  return JSON.parse(text).mcpServers || {};
}

export function readAll() {
  const servers = {};   // name -> { [target]: normalized }
  const errors = {};
  for (const target of Object.keys(TARGETS)) {
    try {
      for (const [name, s] of Object.entries(parseServers(target))) {
        (servers[name] ||= {})[target] = fromNative(TARGETS[target].format, s);
      }
    } catch (e) { errors[target] = e.message; }
  }
  return {
    targets: Object.fromEntries(Object.entries(TARGETS).map(([k, v]) => [k, { label: v.label, file: v.file, exists: fs.existsSync(v.file) }])),
    servers, errors,
  };
}

// Build the new file text for a JSON/TOML target (Claude is done through its CLI).
function plannedText(target, name, server) {
  const t = TARGETS[target];
  const before = readText(t.file);
  if (t.format === 'codex-toml') {
    const after = editTomlServer(before, name, server ? toNative(t.format, server) : null);
    TOML.parse(after); // throws if the result is not valid TOML
    return { before, after };
  }
  const doc = before.trim() ? JSON.parse(before) : {};
  doc.mcpServers ||= {};
  if (server) doc.mcpServers[name] = toNative(t.format, server); else delete doc.mcpServers[name];
  return { before, after: JSON.stringify(doc, null, 2) + '\n' };
}

// Edit only one [mcp_servers.<name>] section so the rest of config.toml keeps
// its formatting and comments.
const tomlKey = k => /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
const tomlVal = v => Array.isArray(v) ? `[${v.map(tomlVal).join(', ')}]`
  : v && typeof v === 'object' ? `{ ${Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${tomlVal(x)}`).join(', ')} }`
  : JSON.stringify(v);

export function editTomlServer(text, name, native) {
  const lines = text.split(/\r?\n/);
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const own = new RegExp(`^\\s*\\[\\s*mcp_servers\\.(?:${esc(name)}|"${esc(name)}")(?:\\.[^\\]]*)?\\s*\\]\\s*$`);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) skipping = own.test(line);
    if (!skipping) out.push(line);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  if (native) {
    out.push('', `[mcp_servers.${tomlKey(name)}]`);
    for (const [k, v] of Object.entries(native)) out.push(`${k} = ${tomlVal(v)}`);
  }
  return out.join('\n') + '\n';
}

function claudeJson(server) { return JSON.stringify(toNative('claude-json', server)); }

// Preview: returns per-target diffs without writing anything.
export function preview(name, server, targets) {
  return targets.map(target => {
    if (target === 'claude') {
      const cur = readAll().servers[name]?.claude;
      return {
        target, file: TARGETS.claude.file, via: 'claude CLI',
        diff: [
          ...(cur ? [{ op: '-', text: `${name}: ${JSON.stringify(toNative('claude-json', cur))}` }] : []),
          ...(server ? [{ op: '+', text: `${name}: ${claudeJson(server)}` }] : []),
        ],
      };
    }
    const { before, after } = plannedText(target, name, server);
    return { target, file: TARGETS[target].file, diff: lineDiff(before, after) };
  });
}

export async function apply(name, server, targets) {
  if (!/^[\w .-]{1,64}$/.test(name)) throw new Error('Server name may only use letters, numbers, space, dot, dash, underscore');
  const results = [];
  for (const target of targets) {
    if (!TARGETS[target]) continue;
    try {
      if (target === 'claude') {
        // Use the CLI so Claude Code owns writes to its busy ~/.claude.json.
        const backup = backupFile(TARGETS.claude.file);
        const exists = !!readAll().servers[name]?.claude;
        if (exists) await run('claude', ['mcp', 'remove', '-s', 'user', name], { timeout: 30000, windowsHide: true });
        if (server) await run('claude', ['mcp', 'add-json', '-s', 'user', name, claudeJson(server)], { timeout: 30000, windowsHide: true });
        results.push({ target, ok: true, backup });
      } else {
        const { after } = plannedText(target, name, server);
        const backup = backupFile(TARGETS[target].file);
        fs.mkdirSync(path.dirname(TARGETS[target].file), { recursive: true });
        fs.writeFileSync(TARGETS[target].file, after, 'utf8');
        results.push({ target, ok: true, backup });
      }
    } catch (e) {
      results.push({ target, ok: false, error: (e.stderr || e.message || '').toString().slice(0, 400) });
    }
  }
  return results;
}
