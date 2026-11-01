import fs from 'node:fs';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

// Stream a JSONL file line by line, skipping bad lines.
export async function* readJsonl(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line[0] !== '{') continue;
    try { yield JSON.parse(line); } catch {}
  }
}

// Open another tool's SQLite file without ever writing to it.
export function openReadOnly(file) {
  if (!fs.existsSync(file)) return null;
  try { return new DatabaseSync(file, { readOnly: true }); } catch { return null; }
}

export function walk(dir, test, out = [], depth = 0, maxDepth = 6) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = dir + '\\' + e.name;
    if (e.isDirectory()) { if (depth < maxDepth) walk(p, test, out, depth + 1, maxDepth); }
    else if (test(p, e.name)) out.push(p);
  }
  return out;
}

export function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function firstLine(s, n = 90) {
  const line = String(s || '').replace(/\s+/g, ' ').trim();
  return clip(line, n);
}

// Strip injected <system-reminder> style blocks so user turns read cleanly.
export function stripInjected(s) {
  return String(s || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .trim();
}

export function fileStat(p) {
  try { const s = fs.statSync(p); return { mtime: s.mtimeMs, size: s.size }; } catch { return null; }
}
