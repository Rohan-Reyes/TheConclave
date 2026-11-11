import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const sourcePath = resolve(process.env.DATA_DIR || './private', 'jarvis.sqlite');
if (!existsSync(sourcePath)) throw new Error(`Database file not found: ${sourcePath}`);
const backupDir = resolve(process.env.BACKUP_DIR || 'backups');
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const destination = resolve(backupDir, `jarvis-${new Date().toISOString().replaceAll(':','-')}.sqlite`);
// Open read-only raw SQLite connection without calling openDb() so missing paths fail closed and pre-migration backups never mutate schema.
const db = new DatabaseSync(sourcePath, { readOnly: true });
db.exec('PRAGMA busy_timeout=5000;');
try { await backup(db, destination); chmodSync(destination, 0o600); console.log(`Consistent database backup: ${destination}`); console.log('Back up the private environment/encryption key separately. Never commit either file.'); } finally { db.close(); }
