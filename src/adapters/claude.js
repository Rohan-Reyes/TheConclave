import fs from 'node:fs';
import path from 'node:path';
import { P, normPath } from '../paths.js';
import { readJsonl, firstLine, stripInjected, clip } from './common.js';

export const tool = 'claude';

// Top-level session files only (subfolders hold tool-results / subagents).
export function discover() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(P.claude.projects, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    const dir = path.join(P.claude.projects, d.name);
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.jsonl')) out.push({ path: path.join(dir, f), nativeId: f.slice(0, -6) });
    }
  }
  return out;
}

function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function resultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(b => b.text || (b.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

export async function parse(file) {
  const meta = { nativeId: path.basename(file, '.jsonl'), title: '', cwd: '', started: '', updated: '', variant: 'cli' };
  const messages = [];
  let aiTitle = '', agentName = '';
  const usageById = new Map();   // streamed messages repeat; count each API message once
  let cost = 0;
  for await (const j of readJsonl(file)) {
    if (j.type === 'ai-title' && j.aiTitle) { aiTitle = j.aiTitle; continue; }
    if (j.type === 'agent-name' && j.agentName) { agentName = j.agentName; continue; }
    if (j.type === 'cost-state' && j.totalCostUSD) { cost = j.totalCostUSD; continue; }
    if (j.type === 'assistant' && j.message?.usage && j.message.id) usageById.set(j.message.id, j.message.usage);
    if (j.type !== 'user' && j.type !== 'assistant') continue;
    if (j.isSidechain) continue;
    if (j.cwd && !meta.cwd) meta.cwd = normPath(j.cwd);
    if (j.entrypoint && j.entrypoint.includes('sdk')) meta.variant = 'sdk';
    const at = j.timestamp || '';
    if (at) { if (!meta.started) meta.started = at; meta.updated = at; }
    const role = j.message?.role || j.type;
    for (const b of blocksOf(j.message?.content)) {
      if (b.type === 'text') {
        const text = role === 'user' ? stripInjected(b.text) : b.text;
        if (!text) continue;
        if (j.isMeta || /^<(command-|local-command|task-notification)/.test(text)) {
          messages.push({ role: 'system', kind: 'text', text: clip(text, 4000), at });
        } else {
          messages.push({ role, kind: 'text', text, at });
        }
      } else if (b.type === 'thinking' && b.thinking) {
        messages.push({ role: 'assistant', kind: 'thinking', text: b.thinking, at });
      } else if (b.type === 'tool_use') {
        messages.push({ role: 'assistant', kind: 'tool_call', name: b.name, text: clip(JSON.stringify(b.input, null, 2), 6000), at });
      } else if (b.type === 'tool_result') {
        messages.push({ role: 'tool', kind: 'tool_result', text: clip(resultText(b.content), 6000), error: !!b.is_error, at });
      }
    }
  }
  const firstUser = messages.find(m => m.role === 'user' && m.kind === 'text');
  meta.tokensIn = 0; meta.tokensOut = 0; meta.cost = cost;
  for (const u of usageById.values()) {
    meta.tokensIn += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    meta.tokensOut += u.output_tokens || 0;
  }
  meta.title = aiTitle || agentName || firstLine(firstUser?.text) || '(empty session)';
  return { meta, messages };
}

export function resumeCommand(chat) {
  return { cwd: chat.cwd, cmd: 'claude', args: ['--resume', chat.native_id] };
}

export function newCommand(cwd) {
  return { cwd, cmd: 'claude', args: [] };
}
