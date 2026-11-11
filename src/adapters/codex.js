import path from 'node:path';
import { P, normPath, codexExe } from '../paths.js';
import { readJsonl, openReadOnly, walk, firstLine, clip } from './common.js';

export const tool = 'codex';

export function discover() {
  return walk(P.codex.sessions, (p, n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))
    .map(p => ({ path: p }));
}

// Codex keeps titles in state_5.sqlite; read them when available.
function threadInfo(id) {
  const db = openReadOnly(P.codex.state);
  if (!db) return null;
  try {
    return db.prepare('SELECT title, name, cwd, first_user_message FROM threads WHERE id = ?').get(id) || null;
  } catch { return null; } finally { db.close(); }
}

const SKIP_USER = /^(<environment_context>|<user_instructions>|<permissions|# AGENTS\.md|<INSTRUCTIONS>)/;

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || []).map(c => c.text || '').filter(Boolean).join('\n');
}

export async function parse(file) {
  const meta = { nativeId: '', title: '', cwd: '', started: '', updated: '', variant: 'cli' };
  const messages = [];
  for await (const j of readJsonl(file)) {
    const at = j.timestamp || '';
    if (at) { if (!meta.started) meta.started = at; meta.updated = at; }
    const p = j.payload || {};
    if (j.type === 'session_meta') {
      meta.nativeId = p.id || meta.nativeId;
      if (p.cwd) meta.cwd = normPath(p.cwd);
      if (p.originator && /desktop|app/i.test(p.originator)) meta.variant = 'app';
      continue;
    }
    if (j.type === 'turn_context' && p.cwd && !meta.cwd) { meta.cwd = normPath(p.cwd); continue; }
    if (j.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
      const u = p.info.total_token_usage;
      meta.tokensIn = u.input_tokens || 0;
      meta.tokensOut = (u.output_tokens || 0) + (u.reasoning_output_tokens || 0);
      continue;
    }
    if (j.type !== 'response_item') continue;
    if (p.type === 'message') {
      const text = textOf(p.content).trim();
      if (!text) continue;
      if (p.role === 'user' && SKIP_USER.test(text)) continue;
      if (p.role === 'developer' || p.role === 'system') continue;
      messages.push({ role: p.role === 'assistant' ? 'assistant' : 'user', kind: 'text', text, at });
    } else if (p.type === 'reasoning') {
      const t = (p.summary || []).map(s => s.text).join('\n');
      if (t) messages.push({ role: 'assistant', kind: 'thinking', text: t, at });
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      messages.push({ role: 'assistant', kind: 'tool_call', name: p.name || p.type, text: clip(p.arguments || p.input || JSON.stringify(p.action || {}), 6000), at });
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
      messages.push({ role: 'tool', kind: 'tool_result', text: clip(out, 6000), at });
    }
  }
  if (!meta.nativeId) {
    const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i);
    meta.nativeId = m ? m[1] : path.basename(file, '.jsonl');
  }
  const t = threadInfo(meta.nativeId);
  if (t?.cwd && !meta.cwd) meta.cwd = normPath(t.cwd);
  meta.title = t?.name || t?.title || firstLine(messages.find(m => m.role === 'user')?.text) || '(untitled)';
  return { meta, messages };
}

export function resumeCommand(chat) {
  return { cwd: chat.cwd, cmd: codexExe(), args: ['resume', chat.native_id] };
}

export function newCommand(cwd) {
  return { cwd, cmd: codexExe(), args: [] };
}
