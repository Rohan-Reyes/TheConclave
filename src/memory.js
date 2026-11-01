import fs from 'node:fs';
import path from 'node:path';
import { getDb, now, newId, logActivity, ftsQuery } from './db.js';
import { P, normPath } from './paths.js';

export const TYPES = ['user', 'feedback', 'project', 'reference'];

function clean(input = {}) {
  const o = {};
  if (input.title !== undefined) o.title = String(input.title).trim().slice(0, 300);
  if (input.body !== undefined) o.body = String(input.body);
  if (input.type !== undefined) o.type = TYPES.includes(input.type) ? input.type : 'reference';
  if (input.scope !== undefined) o.scope = !input.scope || input.scope === 'global' ? 'global' : normPath(input.scope);
  if (input.tags !== undefined) {
    const t = Array.isArray(input.tags) ? input.tags : String(input.tags).split(',');
    o.tags = t.map(x => String(x).trim().toLowerCase()).filter(Boolean).join(',');
  }
  return o;
}

function syncFts(m) {
  const db = getDb();
  db.prepare('DELETE FROM memory_fts WHERE id = ?').run(m.id);
  db.prepare('INSERT INTO memory_fts (id, title, body, tags) VALUES (?,?,?,?)').run(m.id, m.title, m.body, m.tags);
}

export function getMemory(id) {
  return getDb().prepare('SELECT * FROM memories WHERE id = ?').get(id) || null;
}

export function addMemory(input, actor = 'hub') {
  const c = clean({ type: 'reference', scope: 'global', tags: '', body: '', ...input });
  if (!c.title) throw new Error('title is required');
  const m = { id: newId(), source_tool: actor, import_key: input.import_key || null, created: now(), updated: now(), ...c };
  getDb().prepare(`INSERT INTO memories (id, title, body, type, scope, tags, source_tool, import_key, created, updated)
                   VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(m.id, m.title, m.body, m.type, m.scope, m.tags, m.source_tool, m.import_key, m.created, m.updated);
  syncFts(m);
  logActivity(actor, 'memory.add', m.id, m.title);
  return getMemory(m.id);
}

export function updateMemory(id, input, actor = 'hub') {
  const cur = getMemory(id);
  if (!cur) throw new Error('memory not found');
  const m = { ...cur, ...clean(input), updated: now() };
  if (!m.title) throw new Error('title is required');
  getDb().prepare('UPDATE memories SET title=?, body=?, type=?, scope=?, tags=?, updated=? WHERE id=?')
    .run(m.title, m.body, m.type, m.scope, m.tags, m.updated, id);
  syncFts(m);
  logActivity(actor, 'memory.update', id, m.title);
  return getMemory(id);
}

export function deleteMemory(id, actor = 'hub') {
  const cur = getMemory(id);
  if (!cur) return false;
  const db = getDb();
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  db.prepare('DELETE FROM memory_fts WHERE id = ?').run(id);
  logActivity(actor, 'memory.delete', id, cur.title);
  return true;
}

// scope filter: 'global' → only global, a path → that project + global, undefined → all.
export function listMemories({ q, scope, type, limit = 200 } = {}) {
  const db = getDb();
  const where = [], args = [];
  if (scope) {
    const s = normPath(scope);
    if (scope === 'global') where.push("m.scope = 'global'");
    else { where.push("(m.scope = 'global' OR m.scope = ? OR ? LIKE m.scope || '\\%')"); args.push(s, s); }
  }
  if (type && TYPES.includes(type)) { where.push('m.type = ?'); args.push(type); }
  const fq = ftsQuery(q);
  let sql;
  if (fq) {
    sql = `SELECT m.*, snippet(memory_fts, 2, '[', ']', '…', 18) AS snippet
           FROM memory_fts f JOIN memories m ON m.id = f.id
           WHERE memory_fts MATCH ? ${where.length ? 'AND ' + where.join(' AND ') : ''}
           ORDER BY bm25(memory_fts, 0, 4, 1, 2) LIMIT ?`;
    args.unshift(fq);
  } else {
    sql = `SELECT m.* FROM memories m ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.updated DESC LIMIT ?`;
  }
  args.push(Math.min(Number(limit) || 200, 1000));
  return db.prepare(sql).all(...args);
}

export function recentActivity(limit = 50) {
  return getDb().prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit);
}

// --- Import Claude Code memory files (frontmatter markdown). Originals are never changed.
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { fm, body: m[2].trim() };
}

export function claudeMemoryFiles() {
  const files = [];
  for (const dir of P.claude.memoryDirs()) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.md') && f !== 'MEMORY.md') files.push(path.join(dir, f));
    }
  }
  return files;
}

export function importClaudeMemories() {
  const db = getDb();
  let added = 0, updated = 0, skipped = 0;
  for (const file of claudeMemoryFiles()) {
    const { fm, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const key = 'claude-file:' + file.toLowerCase();
    const input = {
      title: fm.description ? `${fm.name || path.basename(file, '.md')}: ${fm.description}`.slice(0, 300) : (fm.name || path.basename(file, '.md')),
      body,
      type: TYPES.includes(fm.type) ? fm.type : 'reference',
      scope: 'global',
      tags: [fm.name, 'imported-claude'].filter(Boolean).join(','),
      import_key: key,
    };
    const existing = db.prepare('SELECT * FROM memories WHERE import_key = ?').get(key);
    if (!existing) { addMemory(input, 'import'); added++; }
    else if (existing.body !== body) { updateMemory(existing.id, { body }, 'import'); updated++; }
    else skipped++;
  }
  return { added, updated, skipped };
}
