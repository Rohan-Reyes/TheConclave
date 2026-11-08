import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { ExecutionClaims } from '../src/execution-claims.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-claims-'));
  const file = path.join(dir, 'claims.db');
  const connections = [];
  let clock = 1000;
  const open = () => {
    const db = new DatabaseSync(file); connections.push(db);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    return new ExecutionClaims({ db, now: () => clock });
  };
  t.after(() => { for (const db of connections) { try { db.close(); } catch {} } fs.rmSync(dir, { recursive: true, force: true }); });
  return { open, file, advance: ms => { clock += ms; } };
}

test('simultaneous worker processes competing through SQLite grant one thread owner', async t => {
  const f = fixture(t); f.open();
  const barrier = new SharedArrayBuffer(4);
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { DatabaseSync } = require('node:sqlite');
      const { ExecutionClaims } = await import(workerData.module);
      const db = new DatabaseSync(workerData.file);
      db.exec('PRAGMA busy_timeout=5000');
      const claims = new ExecutionClaims({db});
      parentPort.postMessage({ready:true});
      Atomics.wait(new Int32Array(workerData.barrier),0,0);
      const result = claims.acquire({threadId:'race',requestId:workerData.device,device:workerData.device});
      db.close(); parentPort.postMessage({result});
    })().catch(e=>{throw e});
  `;
  const workers = ['laptop', 'rasp-pi'].map(device => new Worker(workerSource, { eval: true,
    workerData: { file: f.file, device, barrier, module: new URL('../src/execution-claims.js', import.meta.url).href } }));
  t.after(() => Promise.all(workers.map(w => w.terminate())));
  const ready = workers.map(worker => new Promise((resolve, reject) => {
    worker.on('message', value => { if (value.ready) resolve(); }); worker.once('error', reject);
  }));
  const outcomes = workers.map(worker => new Promise((resolve, reject) => {
    worker.on('message', value => { if (value.result) resolve(value.result); }); worker.once('error', reject);
  }));
  await Promise.all(ready);
  Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
  const results = await Promise.all(outcomes);
  assert.equal(results.filter(x => x.acquired).length, 1);
  assert.equal(results.filter(x => !x.acquired && x.busy).length, 1);
});

test('independent coordinator connections grant one device and reject even same-device duplicates', t => {
  const f = fixture(t), a = f.open(), b = f.open();
  const first = a.acquire({ threadId: 'chat', requestId: 'message', device: 'laptop' });
  assert.equal(first.acquired, true); assert.ok(first.token);
  const duplicate = b.acquire({ threadId: 'chat', requestId: 'message', device: 'rasp-pi', token: first.token });
  assert.equal(duplicate.acquired, false); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.token, undefined);
  assert.equal(a.acquire({ threadId: 'chat', requestId: 'message', device: 'laptop', token: first.token }).acquired, false);
  const other = b.acquire({ threadId: 'chat', requestId: 'another-message', device: 'rasp-pi' });
  assert.equal(other.busy, true); assert.equal(other.device, 'laptop');
  assert.equal(other.note, '(other device already working)');
  assert.equal(a.acquire({ threadId: 'another-chat', requestId: 'message', device: 'rasp-pi' }).acquired, true);
});

test('completed requests stay deduplicated while new messages may acquire the thread', t => {
  const f = fixture(t), a = f.open(), b = f.open();
  const first = a.acquire({ threadId: 'chat', requestId: 'message', device: 'laptop' });
  assert.deepEqual(b.finish({ threadId: 'chat', token: 'wrong-token' }), { ok: false, released: false });
  assert.equal(a.get('chat').busy, true);
  assert.equal(a.finish({ threadId: 'chat', token: first.token }).released, true);
  const replay = b.acquire({ threadId: 'chat', requestId: 'message', device: 'rasp-pi' });
  assert.equal(replay.acquired, false); assert.equal(replay.duplicate, true); assert.equal(replay.state, 'done');
  const next = b.acquire({ threadId: 'chat', requestId: 'next-message', device: 'rasp-pi' });
  assert.equal(next.acquired, true);
  assert.equal(a.finish({ threadId: 'chat', token: first.token }).released, false);
  assert.equal(b.get('chat').requestId, 'next-message');
});

test('elapsed time and coordinator reopen never expire or grant an active claim', t => {
  const f = fixture(t), first = f.open();
  first.acquire({ threadId: 'chat', requestId: 'message', device: 'laptop' });
  f.advance(24 * 3600_000);
  const reopened = f.open();
  assert.equal(reopened.get('chat').busy, true);
  assert.equal(reopened.acquire({ threadId: 'chat', requestId: 'new-message', device: 'rasp-pi' }).acquired, false);
});

test('explicit interrupted-device recovery preserves tombstones and affects only that owner', t => {
  const f = fixture(t), a = f.open();
  a.acquire({ threadId: 'chat', requestId: 'message', device: 'laptop' });
  a.acquire({ threadId: 'other', requestId: 'message', device: 'rasp-pi' });
  assert.equal(a.markDeviceInterrupted('laptop').interrupted, 1);
  const replay = a.acquire({ threadId: 'chat', requestId: 'message', device: 'laptop' });
  assert.equal(replay.acquired, false); assert.equal(replay.state, 'interrupted');
  assert.equal(a.get('other').busy, true);
  assert.equal(a.acquire({ threadId: 'chat', requestId: 'deliberate-new-request', device: 'laptop' }).acquired, true);
  assert.throws(() => a.acquire({ threadId: '', requestId: 'x', device: 'laptop' }), /Invalid/);
  assert.throws(() => a.finish({ threadId: 'chat', token: 'x', state: 'running' }), /Invalid/);
});
