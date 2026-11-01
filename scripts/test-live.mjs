// Explicit opt-in: this uses the user's configured agents and may spend credits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-live-'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
console.log('Live agent smoke test: uses configured accounts and credits, with a temporary database.');
try {
  const result = spawnSync(process.execPath, ['scripts/test-council.mjs', tmp], {
    cwd: root, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, AGENT_HUB_DB: path.join(tmp, 'hub.db') },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
