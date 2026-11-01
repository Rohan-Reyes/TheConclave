import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_DIR, HOME } from '../paths.js';

// Copy a file into backups/<timestamp>/<path relative to home> before changing it.
export function backupFile(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let rel = path.relative(HOME, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) rel = file.replace(/[:\\/]+/g, '_');
  const dest = path.join(BACKUP_DIR, stamp, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
  return dest;
}

// Small line diff (LCS) for the "review before saving" screen.
export function lineDiff(a, b) {
  const x = String(a ?? '').split('\n'), y = String(b ?? '').split('\n');
  if (x.length * y.length > 4_000_000) return [{ op: '~', text: '(file too large to diff)' }];
  const n = x.length, m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: ' ', text: x[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', text: x[i++] });
    else out.push({ op: '+', text: y[j++] });
  }
  while (i < n) out.push({ op: '-', text: x[i++] });
  while (j < m) out.push({ op: '+', text: y[j++] });
  // Keep 3 lines of context around changes.
  const keep = new Set();
  out.forEach((l, k) => { if (l.op !== ' ') for (let d = -3; d <= 3; d++) keep.add(k + d); });
  const res = [];
  let gap = false;
  out.forEach((l, k) => {
    if (keep.has(k)) { res.push(l); gap = false; }
    else if (!gap) { res.push({ op: '~', text: '…' }); gap = true; }
  });
  return res;
}
