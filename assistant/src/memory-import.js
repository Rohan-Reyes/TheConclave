import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { id, transaction, audit } from './db.js';
import { parsePhrases, classify } from './memory-graph.js';

const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const readMeta = value => { try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } };
const key = (content, topic, kind) => JSON.stringify([normalize(content), normalize(topic), kind || 'statement']);
const phraseMeta = p => p.metadata || { kind: p.kind || 'statement', qualification: p.qualification || 'imported_unverified', source_line: p.source_line ?? null, source_end_line: p.source_end_line ?? p.source_line ?? null, parent_context: p.parent_context || null, original_phrase: p.content };
export function memoryImportPlan(db, name, text) {
  if (typeof name !== 'string' || !/\.(md|txt)$/i.test(name) || name.length > 200) bad('Use a named Markdown (.md) or text (.txt) file');
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 50000) bad('Use a nonempty UTF-8 file smaller than 50 KB');
  name = basename(name.replaceAll('\\', '/'));
  const phrases = parsePhrases(text);
  if (!phrases.length) bad('No memory phrases were found in this file');
  if (phrases.length > 2000) bad('This file has more than 2,000 phrases; split it into smaller files');
  const existing = new Map(db.prepare('SELECT id,content,topic,source,metadata FROM memories').all().map(m => [key(m.content, m.topic, readMeta(m.metadata).kind), m]));
  const counts = {}, kinds = {}, seen = new Set(existing.keys()); let fresh = 0;
  for (const p of phrases) {
    const meta = phraseMeta(p), k = key(p.content, p.topic, meta.kind); if (!seen.has(k)) { fresh++; seen.add(k); }
    counts[p.topic || 'General'] = (counts[p.topic || 'General'] || 0) + 1;
    kinds[meta.kind || 'statement'] = (kinds[meta.kind || 'statement'] || 0) + 1;
  }
  return { name, source_hash: createHash('sha256').update(text).digest('hex'), phrases, total_phrases: phrases.length, new_memories: fresh, skipped_duplicates: phrases.length - fresh, topics: counts, kinds, existing };
}
export function previewMemoryImport(db, name, text) {
  const { existing, ...preview } = memoryImportPlan(db, name, text); return preview;
}
export function importMemoryDocument(db, name, text) {
  return transaction(db, () => {
    const plan = memoryImportPlan(db, name, text), now = Date.now(), inserted = [];
    const insert = db.prepare('INSERT INTO memories(id,content,updated_at,topic,category,source,metadata) VALUES(?,?,?,?,?,?,?)');
    const update = db.prepare('UPDATE memories SET metadata=?,source=COALESCE(source,?) WHERE id=?');
    for (const p of plan.phrases) {
      const meta = phraseMeta(p), fingerprint = key(p.content, p.topic, meta.kind), existing = plan.existing.get(fingerprint);
      const source = { name: plan.name, hash: plan.source_hash, line: meta.source_line ?? null, end_line: meta.source_end_line ?? meta.source_line ?? null };
      const metadata = existing ? readMeta(existing.metadata) : { ...meta, provenance: 'owner_import', verified: false, sources: [] };
      metadata.sources = Array.isArray(metadata.sources) ? metadata.sources : [];
      if (!metadata.sources.some(s => s.name === source.name && s.hash === source.hash && s.line === source.line)) metadata.sources.push(source);
      if (existing) { update.run(JSON.stringify(metadata), plan.name, existing.id); existing.metadata = JSON.stringify(metadata); }
      else {
        const memoryId = id(); insert.run(memoryId, p.content, now, p.topic || null, classify(`${p.topic || ''} ${p.content}`), plan.name, JSON.stringify(metadata));
        inserted.push(memoryId); plan.existing.set(fingerprint, { id: memoryId, metadata: JSON.stringify(metadata) });
      }
    }
    audit(db, 'memory.imported');
    return { imported: inserted.length, skipped_duplicates: plan.phrases.length - inserted.length, total_phrases: plan.phrases.length, topics: plan.topics, kinds: plan.kinds, source: plan.name, memory_ids: inserted };
  });
}
