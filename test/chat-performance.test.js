import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-perf-test-'));
process.env.AGENT_HUB_DB = path.join(temp, 'perf.db');
const { getDb, now } = await import('../src/db.js');
const T = await import('../src/agents/threads.js');
const C = await import('../src/agents/catalog.js');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

function seedThread(count) {
  const t = T.createThread({ title: 'Perf fixture', cwd: temp, target: 'claude', settings: { sync: false } });
  const ins = getDb().prepare("INSERT INTO thread_messages(id,thread_id,role,tool,content,activity,status,created) VALUES(?,?,?,?,?,?,?,?)");
  for (let i = 1; i <= count; i++) {
    const activity = JSON.stringify(Array.from({ length: 20 }, (_, k) => `tool call ${i}.${k} ${'x'.repeat(200)}`));
    ins.run(`${t.id}-m${i}`, t.id, i % 2 ? 'user' : 'agent', i % 2 ? null : 'claude', `message ${i}`, activity, i === count ? 'running' : 'done', now());
  }
  return t.id;
}

test('getThread without options still returns the full transcript with activity', () => {
  const id = seedThread(30);
  const t = T.getThread(id);
  assert.equal(t.messages.length, 30);
  assert.equal(t.page, undefined);
  assert.equal(t.messages[0].activity.length, 20);
});

test('paged reads return the newest page, then older pages by cursor, without gaps or overlap', () => {
  const id = seedThread(130);
  const first = T.getThread(id, { limit: 60 });
  assert.equal(first.messages.length, 60);
  assert.deepEqual([first.messages[0].content, first.messages.at(-1).content], ['message 71', 'message 130']);
  assert.equal(first.page.hasMore, true);
  const second = T.getMessages(id, { before: first.page.firstSeq, limit: 60 });
  assert.deepEqual([second.messages[0].content, second.messages.at(-1).content], ['message 11', 'message 70']);
  assert.equal(second.hasMore, true);
  const third = T.getMessages(id, { before: second.firstSeq, limit: 60 });
  assert.equal(third.messages.length, 10); assert.equal(third.hasMore, false);
  const seqs = [...third.messages, ...second.messages, ...first.messages].map(m => m.seq);
  assert.equal(new Set(seqs).size, 130);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
});

test('after-cursor reconciliation returns only newer messages', () => {
  const id = seedThread(12);
  const page = T.getThread(id, { limit: 5 });
  const lastSeq = page.page.lastSeq;
  getDb().prepare("INSERT INTO thread_messages(id,thread_id,role,content,status,created) VALUES(?,?,?,?,?,?)").run('late1', id, 'agent', 'late reply', 'done', now());
  const missed = T.getMessages(id, { after: lastSeq });
  assert.deepEqual(missed.messages.map(m => m.content), ['late reply']);
  assert.equal(missed.hasMore, false);
  assert.equal(T.lastMessageSeq(id), missed.lastSeq);
});

test('lazy activity drops finished-message logs, keeps running ones, and loads on demand', () => {
  const id = seedThread(8);
  const full = Buffer.byteLength(JSON.stringify(T.getThread(id)));
  const t = T.getThread(id, { limit: 60, activity: 'lazy' });
  const done = t.messages.find(m => m.status === 'done'), live = t.messages.find(m => m.status === 'running');
  assert.deepEqual(done.activity, []); assert.equal(done.activityCount, 20);
  assert.equal(live.activity.length, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(t)) < full / 3, 'lazy payload is much smaller');
  assert.equal(T.getMessageActivity(id, done.id).activity.length, 20);
  assert.throws(() => T.getMessageActivity(id, 'missing'), /not found/);
  assert.throws(() => T.getMessageActivity('other-thread', done.id), /not found/);
});

test('limit is clamped and activeJobCount is idle with no running jobs', () => {
  const id = seedThread(3);
  assert.equal(T.getMessages(id, { limit: 0 }).messages.length, 3);
  assert.equal(T.getMessages(id, { limit: 99999 }).messages.length, 3);
  assert.equal(T.activeJobCount(), 0);
});

test('plan-limit scans read a bounded tail and fall back to the full file when needed', () => {
  const dir = path.join(temp, 'copilot');
  const filler = JSON.stringify({ type: 'noise', data: 'y'.repeat(900) }) + '\n';
  const snap = (n, ts) => JSON.stringify({ type: 'usage', timestamp: ts, data: { accountingSnapshot: { totalNanoAiu: n, totalUserRequests: 3 } } }) + '\n';
  // Newest snapshot near the end: found in the tail.
  fs.mkdirSync(path.join(dir, 's1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 's1', 'events.jsonl'), filler.repeat(2000) + snap(2e9, '2026-11-12T00:00:00Z') + filler.repeat(5));
  assert.equal(C.readCopilotLimits({ sessionDir: dir }).creditsUsed, 2);
  // Only snapshot far before the tail window: the full-file fallback still finds it.
  fs.writeFileSync(path.join(dir, 's1', 'events.jsonl'), snap(5e9, '2026-11-12T00:00:00Z') + filler.repeat(2000));
  assert.equal(C.readCopilotLimits({ sessionDir: dir }).creditsUsed, 5);
  const tail = C.readTailLines(path.join(dir, 's1', 'events.jsonl'), 4096);
  assert.equal(tail.partial, true);
  assert.ok(tail.lines.every(l => l === '' || l.startsWith('{')), 'partial first line dropped');
  assert.equal(typeof C.invalidateLimitsCache, 'function');
  C.invalidateLimitsCache();
});
