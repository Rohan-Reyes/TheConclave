import fs from 'node:fs';
import path from 'node:path';
import { P, normPath } from '../paths.js';
import { readJsonl, openReadOnly, firstLine, stripInjected, clip } from './common.js';

export const tool = 'antigravity';

// Titles, folders and parent links live in each root's conversation_summaries.db.
const summaryCache = new Map();
function summaries(rootDir) {
  const dbFile = path.join(rootDir, 'conversation_summaries.db');
  let mtime = 0;
  try { mtime = Math.max(fs.statSync(dbFile).mtimeMs, fs.statSync(dbFile + '-wal').mtimeMs || 0); } catch {}
  const hit = summaryCache.get(rootDir);
  if (hit && hit.mtime === mtime) return hit.map;
  const map = new Map();
  const db = openReadOnly(dbFile);
  if (db) {
    try {
      for (const r of db.prepare('SELECT conversation_id, title, preview, workspace_uris, parent_conversation_id, agent_name, last_modified_time FROM conversation_summaries').all()) {
        let ws = '';
        try { ws = JSON.parse(r.workspace_uris || '[]')[0] || ''; } catch {}
        map.set(r.conversation_id, {
          title: r.title || r.preview || '',
          cwd: normPath(ws),
          parent: r.parent_conversation_id || '',
          agent: r.agent_name || '',
        });
      }
    } catch {} finally { db.close(); }
  }
  summaryCache.set(rootDir, { mtime, map });
  return map;
}

export function discover() {
  const out = [];
  for (const { variant, dir } of P.antigravity.roots) {
    const brain = path.join(dir, 'brain');
    let ids = [];
    try { ids = fs.readdirSync(brain); } catch { continue; }
    for (const id of ids) {
      const t = path.join(brain, id, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(t)) out.push({ path: t, nativeId: id, variant, rootDir: dir });
    }
  }
  return out;
}

function rootOf(file) {
  return P.antigravity.roots.find(r => file.toLowerCase().startsWith(r.dir.toLowerCase() + '\\'));
}

function userText(content) {
  const m = String(content || '').match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  return stripInjected(m ? m[1] : content);
}

function argsText(args) {
  // Antigravity stores each arg as a JSON-encoded string; decode where possible.
  const o = {};
  for (const [k, v] of Object.entries(args || {})) {
    try { o[k] = typeof v === 'string' ? JSON.parse(v) : v; } catch { o[k] = v; }
  }
  return JSON.stringify(o, null, 2);
}

export async function parse(file) {
  const nativeId = file.split('\\brain\\')[1]?.split('\\')[0] || path.basename(file);
  const root = rootOf(file);
  const s = root ? summaries(root.dir).get(nativeId) : null;
  const meta = {
    nativeId,
    variant: root?.variant || 'cli',
    title: s?.title || '',
    cwd: s?.cwd || '',
    parent: s?.parent ? `antigravity:${s.parent}` : '',
    started: '', updated: '',
  };
  const messages = [];
  for await (const j of readJsonl(file)) {
    const at = j.created_at || '';
    if (at) { if (!meta.started) meta.started = at; meta.updated = at; }
    switch (j.type) {
      case 'USER_INPUT': {
        const t = userText(j.content);
        if (t) messages.push({ role: 'user', kind: 'text', text: t, at });
        break;
      }
      case 'PLANNER_RESPONSE':
        if (j.thinking) messages.push({ role: 'assistant', kind: 'thinking', text: j.thinking, at });
        if (j.content) messages.push({ role: 'assistant', kind: 'text', text: j.content, at });
        for (const c of j.tool_calls || []) {
          messages.push({ role: 'assistant', kind: 'tool_call', name: c.name, text: clip(argsText(c.args), 6000), at });
        }
        break;
      case 'SYSTEM_MESSAGE':
        messages.push({ role: 'system', kind: 'text', text: clip(j.content, 4000), at });
        break;
      default:
        if (j.content) messages.push({ role: 'tool', kind: 'tool_result', text: clip(j.content, 6000), at });
    }
  }
  if (!meta.title) meta.title = firstLine(messages.find(m => m.role === 'user')?.text) || s?.agent || '(untitled)';
  return { meta, messages };
}

export function resumeCommand(chat) {
  if (chat.variant === 'ide') return { cwd: chat.cwd, cmd: 'antigravity', args: [chat.cwd || '.'] };
  return { cwd: chat.cwd, cmd: 'agy', args: ['--conversation', chat.native_id] };
}

export function newCommand(cwd) {
  return { cwd, cmd: 'agy', args: [] };
}
