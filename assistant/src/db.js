import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const id = () => randomUUID();
export function openDb(path = resolve(process.env.DATA_DIR || './private', 'jarvis.sqlite')) {
  if (path !== ':memory:') mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL UNIQUE, password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, label TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL, content TEXT NOT NULL, provenance TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, title TEXT NOT NULL, original_text TEXT NOT NULL, rule TEXT NOT NULL, timezone TEXT NOT NULL, next_run INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','paused','cancelled','completed')), missed_policy TEXT NOT NULL CHECK(missed_policy IN ('skip','catch_up')), created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, schedule_id TEXT REFERENCES schedules(id), occurrence_at INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','running','waiting_for_approval','completed','failed','uncertain','cancelled')), attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, lease_until INTEGER, error TEXT, completed_at INTEGER, UNIQUE(schedule_id, occurrence_at));
    CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(state, available_at);
    CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY, job_id TEXT UNIQUE REFERENCES jobs(id), title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER);
    CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, recipients TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, attachments TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, draft_id TEXT NOT NULL UNIQUE REFERENCES drafts(id), job_id TEXT NOT NULL REFERENCES jobs(id), state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected')), created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS connections(provider TEXT PRIMARY KEY, permission TEXT NOT NULL CHECK(permission IN ('read','prepare','automatic')), status TEXT NOT NULL, token_cipher TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, name TEXT NOT NULL, capabilities TEXT NOT NULL, last_seen INTEGER NOT NULL, revoked_at INTEGER);
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, event TEXT NOT NULL, target TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS secrets(key TEXT PRIMARY KEY, cipher TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_states(state TEXT PRIMARY KEY, provider TEXT NOT NULL, session_id TEXT NOT NULL, verifier TEXT NOT NULL, permission TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS refresh_locks(provider TEXT PRIMARY KEY, holder TEXT NOT NULL, lease_until INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS consumed_previews(token TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS passkeys(id TEXT PRIMARY KEY, public_key TEXT NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY, challenge TEXT NOT NULL, purpose TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS push_subscriptions(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, subscription TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_deliveries(notification_id TEXT NOT NULL REFERENCES notifications(id), subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL, PRIMARY KEY(notification_id,subscription_id));
    PRAGMA user_version=1;`);
  // Serialize additive migrations: API and worker may open the same old database together.
  transaction(db, () => {
    const memoryColumns = new Set(db.prepare('PRAGMA table_info(memories)').all().map(c => c.name));
    for (const [name, definition] of Object.entries({ category: 'TEXT', access_count: 'INTEGER NOT NULL DEFAULT 0', topic: 'TEXT', last_accessed: 'INTEGER', source: 'TEXT', metadata: "TEXT NOT NULL DEFAULT '{}'" })) {
      if (!memoryColumns.has(name)) db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${definition}`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS memory_activity(id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_activity_time ON memory_activity(created_at);
      CREATE INDEX IF NOT EXISTS memory_activity_memory ON memory_activity(memory_id, id);
      PRAGMA user_version=2;`);
  });
  return db;
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function audit(db, event, target = null) {
  db.prepare('INSERT INTO audit VALUES (?, ?, ?, ?)').run(id(), event, target, Date.now());
}
