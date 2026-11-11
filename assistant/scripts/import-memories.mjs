// Imports owner-supplied dossiers into the configured PRIVATE database, never the repository.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { openDb } from '../src/db.js';
import { importMemoryDocument, previewMemoryImport } from '../src/memory-import.js';
const preview = process.argv.includes('--preview'), files = process.argv.slice(2).filter(a => a !== '--preview');
if (!files.length) { console.error('Usage: npm run memory:import -- [--preview] profile.txt [other.md ...]'); process.exit(1); }
const db = openDb();
try {
  for (const file of files) {
    const name = basename(file).replace(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}-/i, '').replace(/\.txt\.txt$/i, '.txt');
    const text = readFileSync(file, 'utf8');
    const result = preview ? previewMemoryImport(db, name, text) : importMemoryDocument(db, name, text);
    console.log(JSON.stringify({ source: name, preview, total_phrases: result.total_phrases, imported: result.imported, new_memories: result.new_memories, skipped_duplicates: result.skipped_duplicates, topics: result.topics, kinds: result.kinds }));
  }
} finally { db.close(); }
