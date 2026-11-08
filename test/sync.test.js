import test, { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import express from 'express';

const WIN_ROOT = ['C:', 'Users', 'User'].join('\\');
const PI_ROOT = ['', 'home', 'rasp-pi'].join('/');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-sync-'));
process.env.AGENT_HUB_DB = path.join(temp, 'test.db');
process.env.AGENT_HUB_DATA_DIR = path.join(temp, 'data');
const { SyncService, translatePath, mountSync } = await import('../src/sync.js');
const threads = await import('../src/agents/threads.js');
const { getDb } = await import('../src/db.js');
after(() => { threads.setLockProvider(null); getDb().close(); fs.rmSync(temp,{recursive:true,force:true}); });

test('translatePath translates Windows and Raspberry Pi Linux paths bidirectionally', () => {
  // Windows to Linux
  assert.equal(
    translatePath(WIN_ROOT + '\\Conclave\\project-alpha', 'win32', 'linux'),
    PI_ROOT + '/Conclave/project-alpha'
  );
  assert.equal(
    translatePath(['c:', 'users', 'user', 'conclave', 'project-beta'].join('/'), 'win32', 'linux'),
    PI_ROOT + '/Conclave/project-beta'
  );
  assert.equal(
    translatePath(WIN_ROOT + '\\agent-hub', 'win32', 'linux'),
    PI_ROOT + '/.local/share/conclave/app'
  );
  assert.equal(
    translatePath(WIN_ROOT + '\\Desktop\\notes.txt', 'win32', 'linux'),
    PI_ROOT + '/Desktop/notes.txt'
  );

  // Embedded path in message content (Windows to Linux)
  assert.equal(
    translatePath('Check directory ' + WIN_ROOT + '\\Conclave\\site for files', 'win32', 'linux'),
    'Check directory ' + PI_ROOT + '/Conclave/site for files'
  );

  // Linux to Windows
  assert.equal(
    translatePath(PI_ROOT + '/Conclave/project-alpha', 'linux', 'win32'),
    WIN_ROOT + '\\Conclave\\project-alpha'
  );
  assert.equal(
    translatePath(PI_ROOT + '/.local/share/conclave/app', 'linux', 'win32'),
    WIN_ROOT + '\\agent-hub'
  );
  assert.equal(
    translatePath(PI_ROOT + '/Desktop/notes.txt', 'linux', 'win32'),
    WIN_ROOT + '\\Desktop\\notes.txt'
  );

  // Embedded path in message content (Linux to Windows)
  assert.equal(
    translatePath('View files in ' + PI_ROOT + '/Conclave/site today', 'linux', 'win32'),
    'View files in ' + WIN_ROOT + '\\Conclave\\site today'
  );

  // Non-path / falsy edge cases
  assert.equal(translatePath(null, 'win32', 'linux'), null);
  assert.equal(translatePath(undefined, 'win32', 'linux'), undefined);
  assert.equal(translatePath(123, 'win32', 'linux'), 123);
  assert.equal(translatePath('Hello world', 'win32', 'win32'), 'Hello world');
});

test('isSeamless identifies seamless vs local-only threads', () => {
  const service = new SyncService({ device: 'rasp-pi', remoteOrigin: '' });

  // Explicit sync: true
  assert.equal(service.isSeamless({ cwd: 'C:\\test', settings: { sync: true } }), true);
  // Explicit sync: false
  assert.equal(service.isSeamless({ cwd: WIN_ROOT + '\\Conclave\\app', settings: { sync: false } }), false);
  // Default: true for Conclave paths
  assert.equal(service.isSeamless({ cwd: WIN_ROOT + '\\Conclave\\app', settings: {} }), true);
  assert.equal(service.isSeamless({ cwd: PI_ROOT + '/Conclave/app', settings: {} }), true);
  // Default: false for non-Conclave paths
  assert.equal(service.isSeamless({ cwd: WIN_ROOT + '\\other-project', settings: {} }), false);
  assert.equal(service.isSeamless(null), false);
});

test('toggleSync toggles thread sync setting between seamless and local only', () => {
  const service = new SyncService({ device: 'rasp-pi', remoteOrigin: '' });
  const thread = threads.createThread({
    title: 'Test Sync Toggle Thread',
    cwd: WIN_ROOT + '\\other-project',
    target: 'claude'
  });

  try {
    // Initially local-only because not in Conclave
    assert.equal(service.isSeamless(threads.getThread(thread.id)), false);

    // Toggle to Seamless
    const res1 = service.toggleSync(thread.id, true);
    assert.equal(res1.sync, true);
    assert.equal(res1.syncMode, 'seamless');
    assert.equal(service.isSeamless(threads.getThread(thread.id)), true);

    // Toggle to Local Only
    const res2 = service.toggleSync(thread.id, false);
    assert.equal(res2.sync, false);
    assert.equal(res2.syncMode, 'local');
    assert.equal(service.isSeamless(threads.getThread(thread.id)), false);

    // Reject non-existent thread
    assert.throws(() => service.toggleSync('non-existent-thread-id', true), /chat not found|thread not found/i);
  } finally {
    threads.deleteThread(thread.id);
  }
});

test('getStatus returns counts and thread sync details', () => {
  const service = new SyncService({ device: 'rasp-pi', remoteOrigin: '' });
  const status = service.getStatus();
  assert.ok(typeof status.totalThreads === 'number');
  assert.ok(typeof status.seamlessCount === 'number');
  assert.ok(typeof status.localCount === 'number');
  assert.equal(status.totalThreads, status.seamlessCount + status.localCount);
  assert.ok(Array.isArray(status.threads));
  if (status.threads.length > 0) {
    const first = status.threads[0];
    assert.ok(first.id);
    assert.ok(typeof first.sync === 'boolean');
    assert.ok(['seamless', 'local'].includes(first.syncMode));
  }
});

test('receive upserts thread, translates paths, and records messages, plans, questions', () => {
  const service = new SyncService({ device: 'rasp-pi', remoteOrigin: '' });
  const db = getDb();
  const testThreadId = 'test-sync-remote-thread-' + Date.now();
  const testMsgId = 'test-sync-msg-' + Date.now();
  const testPlanId = 'test-sync-plan-' + Date.now();
  const testQId = 'test-sync-q-' + Date.now();

  try {
    const payload = {
      fromPlatform: 'linux',
      thread: {
        id: testThreadId,
        title: 'Remote Thread from Pi',
        cwd: PI_ROOT + '/Conclave/remote-app',
        target: 'council',
        settings: { permission: 'edit' }
      },
      messages: [
        {
          id: testMsgId,
          role: 'user',
          content: 'Hello from ' + PI_ROOT + '/Conclave/remote-app',
          created: new Date().toISOString()
        }
      ],
      plans: [
        {
          id: testPlanId,
          revision: 1,
          status: 'done',
          summary: 'Sync plan'
        }
      ],
      questions: [
        {
          id: testQId,
          agent: 'council',
          question: 'Are you ready to sync?',
          options: ['yes', 'no']
        }
      ]
    };

    const res = service.receive(payload);
    assert.equal(res.ok, true);
    assert.equal(res.threadId, testThreadId);
    assert.equal(res.insertedMessages, 1);

    // Verify stored thread in DB
    const storedThread = threads.getThread(testThreadId);
    assert.ok(storedThread);
    assert.equal(storedThread.title, 'Remote Thread from Pi');
    assert.equal(storedThread.settings.sync, true);
    if (process.platform === 'win32') {
      assert.equal(storedThread.cwd, WIN_ROOT + '\\Conclave\\remote-app');
    }

    // Verify stored message
    const msg = db.prepare('SELECT * FROM thread_messages WHERE id = ?').get(testMsgId);
    assert.ok(msg);
    if (process.platform === 'win32') {
      assert.match(msg.content, new RegExp(WIN_ROOT.replace(/\\/g, '\\\\') + '\\\\Conclave\\\\remote-app'));
    }

    // Verify idempotency (re-receiving doesn't duplicate)
    const res2 = service.receive(payload);
    assert.equal(res2.insertedMessages, 0);
  } finally {
    threads.deleteThread(testThreadId);
  }
});

test('mountSync exposes HTTP endpoints for status, toggle, and receive', async () => {
  const app = express();
  app.use(express.json());
  const wrap = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).then(
    data => res.json(data ?? { ok: true }),
    err => res.status(err.status || 400).json({ error: err.message }));

  const service = new SyncService({ device: 'rasp-pi', remoteOrigin: '' });
  mountSync(app, wrap, service);

  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const tempThread = threads.createThread({
    title: 'HTTP Sync Route Test',
    cwd: WIN_ROOT + '\\other-temp',
    target: 'claude'
  });

  try {
    // 1. GET /api/sync/status
    const r1 = await fetch(`${base}/api/sync/status`);
    assert.equal(r1.status, 200);
    const sData = await r1.json();
    assert.ok(typeof sData.seamlessCount === 'number');

    // 2. PATCH /api/threads/:id/sync (toggle to true)
    const r2 = await fetch(`${base}/api/threads/${tempThread.id}/sync`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sync: true })
    });
    assert.equal(r2.status, 200);
    const tData = await r2.json();
    assert.equal(tData.sync, true);
    assert.equal(tData.syncMode, 'seamless');

    // 3. POST /api/sync/receive
    const r3 = await fetch(`${base}/api/sync/receive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromPlatform: 'linux',
        thread: {
          id: tempThread.id,
          title: 'Updated title from sync',
          cwd: PI_ROOT + '/Conclave/other-temp'
        },
        messages: []
      })
    });
    assert.equal(r3.status, 200);
    const recData = await r3.json();
    assert.equal(recData.ok, true);

    // 4. Lock endpoints: GET /api/sync/lock/:id, POST /api/sync/lock/:id, DELETE /api/sync/lock/:id
    const lockRes = await fetch(`${base}/api/sync/lock/${tempThread.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'rasp-pi', requestId: 'pi-request-123' })
    });
    assert.equal(lockRes.status, 200);
    const lockData = await lockRes.json();
    assert.equal(lockData.acquired, true);

    // Conflict: laptop tries to lock while rasp-pi holds lock
    const conflictRes = await fetch(`${base}/api/sync/lock/${tempThread.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'laptop', requestId: 'laptop-request-123' })
    });
    const conflictData = await conflictRes.json();
    assert.equal(conflictData.busy, true);
    assert.equal(conflictData.note, '(other device already working)');

    // Release lock
    const delRes = await fetch(`${base}/api/sync/lock/${tempThread.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: lockData.token })
    });
    assert.equal(delRes.status, 200);
  } finally {
    server.close();
    threads.deleteThread(tempThread.id);
  }
});

test('seamless thread rejects duplicate processing and records note (other device already working)', async () => {
  const service = new SyncService({ device: 'rasp-pi', remoteOrigin: '' });
  const testThread = threads.createThread({
    title: 'Test Duplicate Prevention Thread',
    cwd: WIN_ROOT + '\\Conclave\\test-duplicate',
    target: 'claude'
  });

  try {
    // Thread is seamless because in Conclave
    assert.equal(service.isSeamless(threads.getThread(testThread.id)), true);

    // Simulate other device holding the lock
    const otherDevice = service.device === 'laptop' ? 'rasp-pi' : 'laptop';
    const held = service.claims.acquire({ threadId: testThread.id, requestId: 'remote-held-test', device: otherDevice });
    threads.setLockProvider(service);

    // Attempt to send a message on this machine
    const res = await threads.sendMessage(testThread.id, 'Hello while remote is working');
    assert.equal(res.ok, false);
    assert.equal(res.busy, true);
    assert.equal(res.note, '(other device already working)');

    // Verify system note was recorded in thread messages
    const updated = threads.getThread(testThread.id);
    const noteMsg = updated.messages.find(m => m.role === 'system' && m.content === '(other device already working)');
    assert.ok(noteMsg, 'System note (other device already working) should be present in messages');

    // Clear remote lock
    service.claims.finish({ threadId: testThread.id, token: held.token });
  } finally {
    threads.deleteThread(testThread.id);
  }
});
