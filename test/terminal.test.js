import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import WebSocket from 'ws';
import { TerminalService, mountTerminal, attachTerminalWs } from '../src/terminal.js';

test('terminal info returns system details and default quick actions', () => {
  const service = new TerminalService();
  const info = service.getInfo();
  assert.equal(info.platform, process.platform);
  assert.ok(Array.isArray(info.quickActions));
  assert.ok(info.quickActions.length >= 6);
  assert.ok(info.quickActions.some(a => a.id === 'git-status'));
  assert.ok(info.quickActions.some(a => a.id === 'agents'));
});

test('terminal exec executes basic command and captures output', async () => {
  const service = new TerminalService();
  const res = await service.exec({ cmd: 'node -e "console.log(\'test-term-ok\')"' });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.match(res.output, /test-term-ok/);
  assert.ok(res.durationMs >= 0);
});

test('terminal exec reports non-zero exit code on failure', async () => {
  const service = new TerminalService();
  const res = await service.exec({ cmd: 'node -e "console.error(\'err-msg\'); process.exit(42)"' });
  assert.equal(res.ok, false);
  assert.notEqual(res.exitCode, 0);
  assert.match(res.stderr, /err-msg/);
});

test('terminal exec respects custom working directory', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-term-test-'));
  const testFile = path.join(tmp, 'proof.txt');
  fs.writeFileSync(testFile, 'proof-content');

  const service = new TerminalService();
  const res = await service.exec({
    cmd: process.platform === 'win32' ? 'type proof.txt' : 'cat proof.txt',
    cwd: tmp
  });
  assert.equal(res.ok, true);
  assert.match(res.output, /proof-content/);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('terminal exec rejects empty command and invalid cwd', async () => {
  const service = new TerminalService();
  await assert.rejects(() => service.exec({ cmd: '' }), /Command string is required/);
  await assert.rejects(() => service.exec({ cmd: 'echo hi', cwd: '/nonexistent/path/for/conclave' }), /Directory not found/);
});

test('mountTerminal exposes HTTP routes', async () => {
  const app = express();
  app.use(express.json());
  const wrap = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).then(
    data => res.json(data ?? { ok: true }),
    err => res.status(err.status || 400).json({ error: err.message }));

  const service = new TerminalService();
  mountTerminal(app, wrap, service);

  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const r1 = await fetch(`${base}/api/terminal/info`);
    assert.equal(r1.status, 200);
    const info = await r1.json();
    assert.equal(info.platform, process.platform);

    const r2 = await fetch(`${base}/api/terminal/actions`);
    assert.equal(r2.status, 200);
    const actions = await r2.json();
    assert.ok(actions.length > 0);

    const r3 = await fetch(`${base}/api/terminal/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'node -e "console.log(\'http-term-test\')"' })
    });
    assert.equal(r3.status, 200);
    const execRes = await r3.json();
    assert.equal(execRes.ok, true);
    assert.match(execRes.output, /http-term-test/);
  } finally {
    server.close();
  }
});

test('attachTerminalWs connects and handles PTY session over WebSocket', async () => {
  const service = new TerminalService();
  const app = express();
  const server = app.listen(0);
  const wss = attachTerminalWs(server, service);
  const port = server.address().port;

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws?cols=80&rows=24`);
    
    const messages = [];
    await new Promise((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'input',
          data: process.platform === 'win32' ? "Write-Host 'ws-pty-ok'\r" : "echo 'ws-pty-ok'\n"
        }));
      });
      ws.on('message', data => {
        const str = data.toString();
        messages.push(str);
        if (str.includes('ws-pty-ok')) {
          ws.close();
          resolve();
        }
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('WebSocket PTY test timeout')), 8000);
    });

    assert.ok(messages.some(m => m.includes('ws-pty-ok')));
  } finally {
    wss.close();
    server.close();
  }
});
