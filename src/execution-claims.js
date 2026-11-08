import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

const terminalStates = new Set(['done', 'failed', 'stopped', 'interrupted']);
const valid = (value, name, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw Object.assign(new Error(`Invalid ${name}`), { status: 400 });
  return value;
};

// Only the coordinator owns this ledger. A request is never replayed because
// time passed or a network reply was lost. Partial execution needs a new,
// deliberate request after the old executor has been confirmed stopped.
export class ExecutionClaims {
  constructor({ db = getDb(), now = Date.now } = {}) {
    this.db = db;
    this.now = now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS execution_requests (
        thread_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        device TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('running','done','failed','stopped','interrupted')),
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        PRIMARY KEY(thread_id, request_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS execution_one_running_thread
        ON execution_requests(thread_id) WHERE state = 'running';
    `);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  describe(row, duplicate = false, requestingDevice = null) {
    if (!row) return { busy: false };
    const busy = row.state === 'running';
    const sameDevice = requestingDevice ? row.device === requestingDevice : false;
    let note;
    if (busy) {
      note = sameDevice ? '(this device is already working on this chat)' : '(other device already working)';
    } else if (row.state === 'interrupted') {
      note = 'This message was interrupted; check partial changes before sending a new request.';
    } else {
      note = 'This message has already been processed.';
    }
    return {
      busy, duplicate, threadId: row.thread_id, requestId: row.request_id,
      device: row.device, state: row.state, startedAt: row.started_at, finishedAt: row.finished_at,
      note,
    };
  }

  acquire({ threadId, requestId, device }) {
    valid(threadId, 'thread ID'); valid(requestId, 'request ID'); valid(device, 'device', 100);
    return this.transaction(() => {
      const seen = this.db.prepare('SELECT * FROM execution_requests WHERE thread_id = ? AND request_id = ?').get(threadId, requestId);
      if (seen) return { acquired: false, ...this.describe(seen, true, device) };
      const active = this.db.prepare("SELECT * FROM execution_requests WHERE thread_id = ? AND state = 'running'").get(threadId);
      if (active) return { acquired: false, ...this.describe(active, false, device) };
      const token = randomUUID();
      this.db.prepare("INSERT INTO execution_requests (thread_id,request_id,device,token,state,started_at) VALUES (?,?,?,?,'running',?)")
        .run(threadId, requestId, device, token, this.now());
      const row = this.db.prepare('SELECT * FROM execution_requests WHERE thread_id = ? AND request_id = ?').get(threadId, requestId);
      return { acquired: true, ...this.describe(row, false, device), token };
    });
  }

  finish({ threadId, token, state = 'done' }) {
    valid(threadId, 'thread ID'); valid(token, 'claim token');
    if (!terminalStates.has(state)) throw Object.assign(new Error('Invalid execution completion state'), { status: 400 });
    return this.transaction(() => {
      const changed = this.db.prepare("UPDATE execution_requests SET state = ?, finished_at = ? WHERE thread_id = ? AND token = ? AND state = 'running'")
        .run(state, this.now(), threadId, token).changes;
      return { ok: changed === 1, released: changed === 1 };
    });
  }

  get(threadId, requestingDevice = null) {
    valid(threadId, 'thread ID');
    return this.describe(this.db.prepare("SELECT * FROM execution_requests WHERE thread_id = ? AND state = 'running'").get(threadId), false, requestingDevice);
  }

  interruptDeviceClaim({ threadId, device }) {
    valid(threadId, 'thread ID'); valid(device, 'device', 100);
    return this.transaction(() => {
      const changed = this.db.prepare("UPDATE execution_requests SET state = 'interrupted', finished_at = ? WHERE thread_id = ? AND device = ? AND state = 'running'")
        .run(this.now(), threadId, device).changes;
      return { ok: changed > 0, interrupted: changed };
    });
  }

  // Call only on startup of this exact executor after confirming the prior
  // process is gone, or to clear stale orphaned claims from this exact device.
  // Never use a remote timeout as proof that a remote device stopped.
  markDeviceInterrupted(device, threadId = null) {
    valid(device, 'device', 100);
    return this.transaction(() => {
      const sql = threadId
        ? "UPDATE execution_requests SET state = 'interrupted', finished_at = ? WHERE device = ? AND thread_id = ? AND state = 'running'"
        : "UPDATE execution_requests SET state = 'interrupted', finished_at = ? WHERE device = ? AND state = 'running'";
      const args = threadId ? [this.now(), device, threadId] : [this.now(), device];
      return { interrupted: this.db.prepare(sql).run(...args).changes };
    });
  }
}
