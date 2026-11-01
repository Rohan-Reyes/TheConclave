import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ensureDirs } from './paths.js';
import crypto from 'node:crypto';

let db;

export function getDb() {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(DB_PATH);
  if (!db.prepare('PRAGMA compile_options').all().some(row => Object.values(row).includes('ENABLE_FTS5'))) {
    db.close(); db = undefined;
    throw new Error('This Node.js build lacks SQLite FTS5. Install the Node.js version in .nvmrc (22.23.4+) and restart Conclave.');
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,          -- "<tool>:<native id>"
      tool TEXT NOT NULL,           -- claude | antigravity | codex
      variant TEXT,                 -- cli | ide | sdk ...
      native_id TEXT NOT NULL,
      title TEXT,
      cwd TEXT,
      project TEXT,                 -- folder the work was about (cwd, or inferred when cwd is home)
      started TEXT,
      updated TEXT,
      msg_count INTEGER DEFAULT 0,
      parent_id TEXT,
      source_path TEXT NOT NULL,
      source_mtime REAL,
      source_size INTEGER
    );
    CREATE INDEX IF NOT EXISTS chats_updated ON chats(updated DESC);
    CREATE INDEX IF NOT EXISTS chats_cwd ON chats(cwd);

    CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(
      chat_id UNINDEXED, title, body, tokenize = 'unicode61'
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'reference',   -- user | feedback | project | reference
      scope TEXT NOT NULL DEFAULT 'global',     -- global | normalized project path
      tags TEXT NOT NULL DEFAULT '',            -- comma separated
      source_tool TEXT NOT NULL DEFAULT 'hub',
      import_key TEXT UNIQUE,                   -- set when imported from a file
      created TEXT NOT NULL,
      updated TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      id UNINDEXED, title, body, tags, tokenize = 'unicode61'
    );

    -- Hub chats: one thread can talk to any tool, or to all of them as a council.
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New chat',
      cwd TEXT NOT NULL DEFAULT '',
      target TEXT NOT NULL DEFAULT 'claude',   -- claude | antigravity | codex | council
      settings TEXT NOT NULL DEFAULT '{}',
      created TEXT NOT NULL,
      updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thread_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL,                      -- user | agent | system
      tool TEXT,
      round TEXT,                              -- e.g. council-1, council-2, synthesis, relay, imported
      content TEXT NOT NULL DEFAULT '',
      activity TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'done',     -- running | done | error | stopped
      error TEXT,
      created TEXT NOT NULL,
      finished TEXT
    );
    CREATE INDEX IF NOT EXISTS thread_messages_thread ON thread_messages(thread_id, seq);
    CREATE TABLE IF NOT EXISTS thread_sessions (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      tool TEXT NOT NULL,
      native_id TEXT,
      last_seen_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (thread_id, tool)
    );

    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,          -- hub | claude | antigravity | codex | mcp
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT
    );
  `);
  // Migrations for databases created by older versions.
  const chatCols = db.prepare('PRAGMA table_info(chats)').all().map(c => c.name);
  if (!chatCols.includes('project')) {
    db.exec('ALTER TABLE chats ADD COLUMN project TEXT');
    db.exec('UPDATE chats SET source_mtime = 0'); // force a re-parse to fill it in
  }
  db.exec('CREATE INDEX IF NOT EXISTS chats_project ON chats(project)');
  if (!chatCols.includes('tokens_in')) {
    db.exec('ALTER TABLE chats ADD COLUMN tokens_in INTEGER DEFAULT 0');
    db.exec('ALTER TABLE chats ADD COLUMN tokens_out INTEGER DEFAULT 0');
    db.exec('ALTER TABLE chats ADD COLUMN cost_usd REAL DEFAULT 0');
    db.exec('UPDATE chats SET source_mtime = 0');
  }
  const msgCols = db.prepare('PRAGMA table_info(thread_messages)').all().map(c => c.name);
  if (!msgCols.includes('files')) db.exec("ALTER TABLE thread_messages ADD COLUMN files TEXT NOT NULL DEFAULT '[]'");
  if (!msgCols.includes('usage')) db.exec("ALTER TABLE thread_messages ADD COLUMN usage TEXT NOT NULL DEFAULT '{}'");
  if (!msgCols.includes('snap')) db.exec('ALTER TABLE thread_messages ADD COLUMN snap TEXT');
  db.exec(`
    -- Extra CLI agents the user connects (Gemini CLI, Ollama, Aider, ...).
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,            -- slug, also the @mention handle
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '[]',-- JSON array; "{prompt}" is replaced by the prompt
      input TEXT NOT NULL DEFAULT 'stdin', -- stdin | arg
      enabled INTEGER NOT NULL DEFAULT 1,
      created TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, updated TEXT);

    -- A council verdict's structured plan. Run plan / Auto execute exactly one revision.
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      message_id TEXT,              -- the verdict message
      revision INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,         -- proposed | running | paused | done | failed | cancelled | invalid | empty
      summary TEXT NOT NULL DEFAULT '',
      steps TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      created TEXT NOT NULL,
      updated TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS plans_thread ON plans(thread_id, created);

    -- Questions agents ask the user (ask_user tool or a conclave-question block).
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      message_id TEXT,
      plan_id TEXT,
      step_id TEXT,
      agent TEXT NOT NULL,
      question TEXT NOT NULL,
      options TEXT NOT NULL DEFAULT '[]',
      multi INTEGER NOT NULL DEFAULT 0,
      via TEXT NOT NULL DEFAULT 'tool',  -- tool (agent is waiting) | block (answer starts a follow-up)
      status TEXT NOT NULL DEFAULT 'pending', -- pending | answered | expired | cancelled
      answer TEXT,
      created TEXT NOT NULL,
      answered TEXT
    );
    CREATE INDEX IF NOT EXISTS questions_thread ON questions(thread_id, status);
  `);
  return db;
}

export const now = () => new Date().toISOString();

export function kvSet(k, v) {
  getDb().prepare('INSERT INTO kv (k, v, updated) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated = excluded.updated')
    .run(k, JSON.stringify(v), now());
}
export function kvGet(k) {
  const r = getDb().prepare('SELECT v, updated FROM kv WHERE k = ?').get(k);
  return r ? { value: JSON.parse(r.v), updated: r.updated } : null;
}
export const newId = () => crypto.randomUUID();

export function logActivity(actor, action, target, detail = '') {
  getDb().prepare('INSERT INTO activity (at, actor, action, target, detail) VALUES (?,?,?,?,?)')
    .run(now(), actor || 'hub', action, target || null, String(detail).slice(0, 500));
}

// Turn free text into a safe FTS5 query: every word becomes a prefix term.
export function ftsQuery(q) {
  const terms = String(q || '').match(/[\p{L}\p{N}_]+/gu) || [];
  return terms.slice(0, 12).map(t => `"${t}"*`).join(' ');
}
