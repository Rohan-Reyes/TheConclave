import * as claude from './adapters/claude.js';
import * as antigravity from './adapters/antigravity.js';
import * as codex from './adapters/codex.js';
import { fileStat } from './adapters/common.js';
import fs from 'node:fs';
import { getDb } from './db.js';
import { HOME, normPath } from './paths.js';

export const adapters = { claude, antigravity, codex };

const FTS_BODY_LIMIT = 400_000;
let running = null;
export const indexState = { lastRun: null, lastDurationMs: 0, changed: 0, errors: [] };

function ftsBody(messages) {
  let out = '';
  for (const m of messages) {
    if (m.kind !== 'text' || m.role === 'system') continue;
    out += m.text + '\n';
    if (out.length > FTS_BODY_LIMIT) break;
  }
  return out;
}

// Most sessions start in the home folder. When that happens, guess the real
// project from the folders the chat touched (user mentions count triple).
const SKIP_TOP = new Set(['appdata', '.claude', '.gemini', '.codex', '.cache', '.local', '.vscode', '.npm', 'node_modules']);
// Paths may contain spaces, so match greedily and then keep only the
// leading segments that exist as real folders on disk.
const PATH_RE = /[A-Za-z]:[\\/][^"'`<>|*?\n\r\t]+/g;
const BS = String.fromCharCode(92); // backslash
const MAX_DEPTH = 4;
const homeNorm = normPath(HOME);
const dirCache = new Map();
function isDir(p) {
  const k = p.toLowerCase();
  if (!dirCache.has(k)) { let ok = false; try { ok = fs.statSync(p).isDirectory(); } catch {} dirCache.set(k, ok); }
  return dirCache.get(k);
}

export function inferProject(cwd, messages) {
  if (cwd && cwd.toLowerCase() !== homeNorm.toLowerCase()) return cwd;
  const base = homeNorm.toLowerCase() + BS;
  const counts = Array.from({ length: MAX_DEPTH }, () => new Map());
  for (const m of messages) {
    if (m.kind === 'thinking' || m.role === 'system') continue;
    const weight = m.role === 'user' ? 3 : 1;
    const text = m.text.length > 20000 ? m.text.slice(0, 20000) : m.text;
    // Tool-call args are JSON, so backslashes may appear doubled.
    for (const raw of text.replace(/\\\\/g, BS).match(PATH_RE) || []) {
      const p = normPath(raw);
      if (!p.toLowerCase().startsWith(base)) continue;
      const segs = p.slice(base.length).split(/[\\/]/);
      if (!segs[0] || SKIP_TOP.has(segs[0].toLowerCase())) continue;
      for (let d = 0; d < Math.min(MAX_DEPTH, segs.length); d++) {
        const key = segs.slice(0, d + 1).join(BS);
        if (!isDir(homeNorm + BS + key)) break;
        counts[d].set(key, (counts[d].get(key) || 0) + weight);
      }
    }
  }
  let best = null, bestN = 0;
  for (let d = 0; d < MAX_DEPTH; d++) {
    let pick = null, n = 0;
    for (const [k, v] of counts[d]) if ((!best || k.startsWith(best + BS)) && v > n) { pick = k; n = v; }
    if (!pick || (best && n < bestN * 0.7)) break;
    best = pick; bestN = n;
  }
  if (!best || bestN < 3) return cwd || '';
  return homeNorm + BS + best;
}

async function indexFile(tool, item, existing) {
  const st = fileStat(item.path);
  if (!st) return false;
  if (existing && existing.source_mtime === st.mtime && existing.source_size === st.size) return false;
  const { meta, messages } = await adapters[tool].parse(item.path);
  // Sessions started by Conclave: name them after their Conclave chat.
  const conclave = getDb().prepare('SELECT t.title FROM thread_sessions s JOIN threads t ON t.id = s.thread_id WHERE s.native_id = ?').get(meta.nativeId);
  const preamble = /^(\/plan\s+)?You are [\w ]+, taking part in a chat inside (Conclave|Agent Hub)/.test(String(meta.title));
  if (conclave || preamble) { meta.title = `Conclave: ${conclave?.title || 'council session'}`; meta.variant = 'conclave'; }
  meta.title = String(meta.title || '').replace(/\s+/g, ' ').trim();
  if (meta.title.length > 120) meta.title = meta.title.slice(0, 117) + '…';
  const id = `${tool}:${meta.nativeId}`;
  const db = getDb();
  const visible = messages.filter(m => m.kind === 'text' && (m.role === 'user' || m.role === 'assistant')).length;
  db.exec('BEGIN');
  try {
    // A file can be re-keyed (e.g. Codex id read later); drop the old row by path.
    db.prepare('DELETE FROM chat_fts WHERE chat_id IN (SELECT id FROM chats WHERE source_path = ?)').run(item.path);
    db.prepare('DELETE FROM chats WHERE source_path = ?').run(item.path);
    db.prepare('DELETE FROM chat_fts WHERE chat_id = ?').run(id);
    db.prepare(`INSERT OR REPLACE INTO chats (id, tool, variant, native_id, title, cwd, project, started, updated, msg_count, parent_id, source_path, source_mtime, source_size, tokens_in, tokens_out, cost_usd)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, tool, meta.variant || item.variant || null, meta.nativeId, meta.title, meta.cwd || '', inferProject(meta.cwd || '', messages), meta.started || '',
           meta.updated || new Date(st.mtime).toISOString(), visible, meta.parent || null, item.path, st.mtime, st.size, meta.tokensIn || 0, meta.tokensOut || 0, meta.cost || 0);
    db.prepare('INSERT INTO chat_fts (chat_id, title, body) VALUES (?,?,?)').run(id, meta.title, ftsBody(messages));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return true;
}

export function runIndex() {
  if (running) return running;
  running = (async () => {
    const t0 = Date.now();
    const db = getDb();
    const known = new Map(db.prepare('SELECT source_path, source_mtime, source_size FROM chats').all().map(r => [r.source_path, r]));
    const seen = new Set();
    let changed = 0;
    const errors = [];
    for (const [tool, a] of Object.entries(adapters)) {
      for (const item of a.discover()) {
        seen.add(item.path);
        // Yield between files so live streams and requests are served during long passes.
        await new Promise(r => setImmediate(r));
        try { if (await indexFile(tool, item, known.get(item.path))) changed++; }
        catch (e) { errors.push(`${tool} ${item.path}: ${e.message}`); }
      }
    }
    for (const p of known.keys()) {
      if (!seen.has(p)) {
        db.prepare('DELETE FROM chat_fts WHERE chat_id IN (SELECT id FROM chats WHERE source_path = ?)').run(p);
        db.prepare('DELETE FROM chats WHERE source_path = ?').run(p);
        changed++;
      }
    }
    Object.assign(indexState, { lastRun: new Date().toISOString(), lastDurationMs: Date.now() - t0, changed, errors: errors.slice(0, 20) });
    return indexState;
  })().finally(() => { running = null; });
  return running;
}

export async function loadTranscript(chat) {
  return adapters[chat.tool].parse(chat.source_path);
}
