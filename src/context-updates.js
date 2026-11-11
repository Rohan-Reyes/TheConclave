// Context additions share the transcript, but never cancel or start a run.
import { getDb, now } from './db.js';
const initialized = new WeakSet();
function store() {
  const db = getDb();
  if (!initialized.has(db)) {
    db.exec(`CREATE INDEX IF NOT EXISTS thread_context_updates ON thread_messages(thread_id,seq) WHERE round='context-update';
      CREATE TABLE IF NOT EXISTS context_update_reads(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,tool TEXT NOT NULL,cursor INTEGER NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(thread_id,tool));
      CREATE TABLE IF NOT EXISTS context_update_requests(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,request_id TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(thread_id,request_id));`);
    initialized.add(db);
  }
  return db;
}
export function recordDetails(threadId, text, requestId, addMessage) {
  const db = store();
  if (typeof text !== 'string' || !text.trim() || text.length > 32000)
    throw new Error('Details must contain 1–32000 characters');
  if (
    typeof requestId !== 'string' ||
    !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)
  )
    throw new Error('Invalid request ID');
  const prior = db
    .prepare(
      'SELECT message_id FROM context_update_requests WHERE thread_id=? AND request_id=?',
    )
    .get(threadId, requestId);
  if (prior)
    return {
      ok: true,
      details: true,
      duplicate: true,
      messageId: prior.message_id,
    };
  db.exec('BEGIN IMMEDIATE');
  try {
    const message = addMessage(threadId, {
      role: 'user',
      round: 'context-update',
      content: text.trim(),
    });
    db.prepare('INSERT INTO context_update_requests VALUES(?,?,?)').run(
      threadId,
      requestId,
      message.id,
    );
    db.exec('COMMIT');
    return {
      ok: true,
      details: true,
      messageId: message.id,
      delivery:
        'Available at the next context check; retained for the next turn if unread',
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function readTaskUpdates(threadId, tool) {
  const db = store();
  if (!db.prepare('SELECT id FROM threads WHERE id=?').get(threadId))
    throw new Error('Chat not found');
  if (typeof tool !== 'string' || !/^[a-z][a-z0-9-]{0,59}$/.test(tool))
    throw new Error('An agent identity is required');
  const cursor =
    db
      .prepare(
        'SELECT cursor FROM context_update_reads WHERE thread_id=? AND tool=?',
      )
      .get(threadId, tool)?.cursor || 0;
  const updates = db
    .prepare(
      "SELECT id,seq,content,created FROM thread_messages WHERE thread_id=? AND round='context-update' AND seq>? ORDER BY seq LIMIT 50",
    )
    .all(threadId, cursor);
  if (updates.length)
    db.prepare(
      'INSERT INTO context_update_reads VALUES(?,?,?,?) ON CONFLICT(thread_id,tool) DO UPDATE SET cursor=excluded.cursor,updated=excluded.updated',
    ).run(threadId, tool, updates.at(-1).seq, now());
  return { updates, delivery: updates.length ? 'read' : 'No new details' };
}
export function detailsStatus(threadId) {
  const db = store();
  return {
    readers: db
      .prepare(
        'SELECT tool,cursor,updated FROM context_update_reads WHERE thread_id=?',
      )
      .all(threadId),
    latest:
      db
        .prepare(
          "SELECT MAX(seq) AS seq FROM thread_messages WHERE thread_id=? AND round='context-update'",
        )
        .get(threadId)?.seq || 0,
  };
}
