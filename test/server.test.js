import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';

test('fresh server starts with isolated data, enforces host/origin and returns JSON command errors', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-server-test-'));
  const port = await new Promise(resolve => {
    const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
  });
  fs.mkdirSync(path.join(temp, 'profile'));
  const child = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, CONCLAVE_PORT: String(port), USERPROFILE: path.join(temp, 'profile'), HOME: path.join(temp, 'profile'),
      AGENT_HUB_DB: path.join(temp, 'test.db'), AGENT_HUB_DATA_DIR: path.join(temp, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  const closed = new Promise(resolve => child.on('close', resolve));
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await closed;
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) assert.fail(`Server exited: ${output}`);
    try { if ((await fetch(base + '/api/stats')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, output);
  assert.match(await (await fetch(base)).text(), /<title>Conclave<\/title>/);
  const badHost = await new Promise((resolve, reject) => {
    const req = http.get(base + '/api/stats', { headers: { Host: 'untrusted.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(badHost, 403);
  const json = (body, method = 'POST', extra = {}) => ({ method, headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  const chat = await (await fetch(base + '/api/threads', json({ cwd: temp, settings: { permission: 'read' } }))).json();
  assert.ok(chat.id); assert.equal(chat.settings.approvalMode, 'auto');
  assert.equal((await fetch(base + `/api/threads/${chat.id}`, json({}, 'DELETE', { Origin: 'https://untrusted.example' }))).status, 403);
  assert.equal((await fetch(base + `/api/threads/${chat.id}`, json({ settings: { permission: 'typo' } }, 'PATCH'))).status, 400);
  const uploaded = await fetch(base + `/api/threads/${chat.id}/attachments`, json({ files: [{ name: '../example.html', data: '<b>inert source</b>', encoding: 'utf8' }] }));
  assert.equal(uploaded.status, 200);
  const attachment = (await uploaded.json()).file;
  assert.equal(attachment.isImage, false); assert.equal(attachment.url, null);
  assert.equal(fs.readFileSync(attachment.path, 'utf8'), '<b>inert source</b>');
  assert.ok(attachment.path.startsWith(path.join(temp, '.conclave', 'attachments') + path.sep));
  const missingThread = await fetch(base + '/api/threads/not-a-thread/attachments', json({ cwd: temp, name: 'example.txt', data: 'fixture', encoding: 'utf8' }));
  assert.equal(missingThread.status, 404);
  const saved = await (await fetch(base + '/api/runner/commands', json({ cwd: temp, label: 'offline fixture', executable: process.execPath, args: ['-e', 'console.log("fixture ready")'] }))).json();
  assert.ok(saved.fingerprint);
  const needsConfirmation = await fetch(base + '/api/runner/jobs', json({ cwd: temp, commandId: saved.id }));
  assert.equal(needsConfirmation.status, 428);
  assert.match((await needsConfirmation.json()).error, /Confirm this exact command/);
  const started = await (await fetch(base + '/api/runner/jobs', json({ cwd: temp, commandId: saved.id, confirmation: saved.fingerprint }))).json();
  assert.ok(started.id);
  let job;
  for (let i = 0; i < 100; i++) {
    job = await (await fetch(base + `/api/runner/jobs/${started.id}?cwd=${encodeURIComponent(temp)}`)).json();
    if (job.finished) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(job.status, 'done', job.error);
  assert.match(job.logs.map(x => x.text).join(''), /fixture ready/);
});
