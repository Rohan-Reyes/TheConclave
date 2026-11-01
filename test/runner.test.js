import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProjectRunner, loopbackUrls, projectFolder, mountRunner } from '../src/runner.js';
import express from 'express';

function fixture(t, options = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-runner-'));
  const runner = new ProjectRunner({ storagePath: path.join(folder, 'runner-settings.json'), ...options });
  t.after(async () => {
    await runner.shutdown();
    const resolved = fs.realpathSync(folder);
    assert.ok(path.basename(resolved).startsWith('conclave-runner-') && path.dirname(resolved) === fs.realpathSync(os.tmpdir()));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const script = (name, code) => { const file = path.join(folder, name); fs.writeFileSync(file, code); return file; };
  const save = code => runner.saveCommand(folder, { label: 'Fixture', executable: process.execPath, args: [script(`fake-${Math.random().toString(36).slice(2)}.cjs`, code)] });
  return { folder, runner, script, save };
}

async function until(fn, message = 'condition was not reached') {
  for (let i = 0; i < 200; i++) { const value = fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(message);
}

test('only existing absolute project folders are accepted', t => {
  const { folder, runner } = fixture(t);
  assert.equal(projectFolder(folder), fs.realpathSync.native(folder));
  assert.throws(() => runner.commands('.'), /absolute/);
  assert.throws(() => runner.commands(path.join(folder, 'missing')), /does not exist/);
  assert.throws(() => runner.saveCommand(folder, { executable: process.execPath, args: 'unparsed shell text' }), /array/);
  assert.throws(() => runner.start(folder, 'unregistered', 'yes'), /Choose a project script/);
});

test('first run requires the exact command fingerprint and preserves argument boundaries', async t => {
  const { folder, runner, script } = fixture(t);
  const expected = ['hello world', 'literal; & | $(never-execute)', '"quoted"'];
  const command = runner.saveCommand(folder, { executable: process.execPath, args: [script('args.cjs', 'console.log(JSON.stringify(process.argv.slice(2)))'), ...expected] });
  assert.throws(() => runner.start(folder, command.id), error => error.status === 428);
  assert.throws(() => runner.start(folder, command.id, 'yes'), error => error.status === 428);
  const job = runner.start(folder, command.id, command.fingerprint);
  const result = await runner.job(folder, job.id).done;
  assert.equal(result.status, 'done');
  assert.deepEqual(JSON.parse(result.logs.map(log => log.text).join('').trim()), expected);
  assert.equal(runner.commands(folder).commands[0].confirmed, true);
  const reloaded = new ProjectRunner({ storagePath: path.join(folder, 'runner-settings.json') });
  assert.equal(reloaded.commands(folder).commands[0].confirmed, true);
  await reloaded.shutdown();
});

test('npm scripts launch through Node and changed lifecycle hooks require new confirmation', async t => {
  const { folder, runner, script } = fixture(t);
  script('task.cjs', 'console.log("npm fixture finished")');
  const manifest = { name: 'runner-fixture', private: true, scripts: { check: 'node task.cjs' } };
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify(manifest));
  const command = runner.commands(folder).commands.find(item => item.id === 'npm:check');
  assert.equal(command.executable, process.execPath);
  assert.match(command.args[0], /npm-cli\.js$/);
  const started = runner.start(folder, command.id, command.fingerprint);
  const result = await runner.job(folder, started.id).done;
  assert.equal(result.status, 'done', result.logs.map(log => log.text).join(''));
  assert.match(result.logs.map(log => log.text).join(''), /npm fixture finished/);
  manifest.scripts.precheck = 'node task.cjs';
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify(manifest));
  const changed = runner.commands(folder).commands.find(item => item.id === command.id);
  assert.notEqual(changed.fingerprint, command.fingerprint);
  assert.equal(changed.confirmed, false);
  assert.throws(() => runner.start(folder, command.id, command.fingerprint), error => error.status === 428);
});

test('duplicate starts are rejected and stop is idempotent', async t => {
  const { folder, runner, save } = fixture(t);
  const command = save('console.log("ready"); setInterval(() => {}, 1000)');
  const job = runner.start(folder, command.id, command.fingerprint);
  await until(() => runner.get(folder, job.id).logs.length);
  assert.throws(() => runner.start(folder, command.id), error => error.status === 409);
  const [first, second] = await Promise.all([runner.stop(folder, job.id), runner.stop(folder, job.id)]);
  assert.equal(first.status, 'stopped');
  assert.equal(second.status, 'stopped');
  assert.equal((await runner.stop(folder, job.id)).status, 'stopped');
});

test('subscriptions replay logs after a sequence without relaunching the process', async t => {
  const { folder, runner, save } = fixture(t);
  const command = save('console.log("once"); setInterval(() => {}, 1000)');
  const job = runner.start(folder, command.id, command.fingerprint);
  await until(() => runner.get(folder, job.id).logs.length);
  const events = [];
  const off = runner.subscribe(folder, job.id, event => events.push(event));
  assert.equal(events[0].type, 'snapshot');
  const lastSeq = events[0].job.lastSeq;
  off();
  const replay = [];
  const offAgain = runner.subscribe(folder, job.id, event => replay.push(event), lastSeq);
  assert.deepEqual(replay[0].job.logs, []);
  assert.equal(replay[0].job.pid, runner.get(folder, job.id).pid);
  assert.equal(runner.list(folder).jobs.length, 1);
  offAgain();
});

test('failed launch records an error and does not reserve a running slot', async t => {
  const { folder, runner } = fixture(t);
  const command = runner.saveCommand(folder, { executable: path.join(folder, 'missing-executable'), args: [] });
  const job = runner.start(folder, command.id, command.fingerprint);
  const result = await runner.job(folder, job.id).done;
  assert.equal(result.status, 'failed');
  assert.match(result.error, /ENOENT/);
  assert.equal((await runner.stop(folder, job.id)).status, 'failed');
});

test('logs remain bounded and only loopback web links are exposed', async t => {
  const { folder, runner, save } = fixture(t, { maxLogBytes: 1024 });
  const command = save('console.log("http://localhost:3000/app"); console.log("a".repeat(20000)); console.log("http://evil.test:3000");');
  const job = runner.start(folder, command.id, command.fingerprint);
  const result = await runner.job(folder, job.id).done;
  assert.ok(Buffer.byteLength(result.logs.map(log => log.text).join('')) <= 1024);
  assert.ok(result.droppedBytes > 0);
  assert.deepEqual(result.urls, ['http://localhost:3000/app']);
  assert.deepEqual(loopbackUrls('http://127.0.0.1:80/a https://[::1]:444/ http://localhost.evil/ http://user@localhost/ javascript:alert(1)'), ['http://127.0.0.1/a', 'https://[::1]:444/']);
});

test('a job cannot be accessed from a different project', async t => {
  const { folder, runner, save } = fixture(t);
  const other = path.join(folder, 'other'); fs.mkdirSync(other);
  const command = save('console.log("ok")');
  const job = runner.start(folder, command.id, command.fingerprint);
  assert.throws(() => runner.get(other, job.id), error => error.status === 404);
  assert.throws(() => runner.subscribe(other, job.id, () => {}), error => error.status === 404);
  await assert.rejects(runner.stop(other, job.id), error => error.status === 404);
});

test('restart creates a new job and shutdown kills the full process tree', async t => {
  const { folder, runner, save, script } = fixture(t);
  const childFile = script('child.cjs', 'setInterval(() => {}, 1000)');
  const pidFile = path.join(folder, 'child.pid');
  const command = save(`const fs = require('node:fs'); const { spawn } = require('node:child_process'); const child = spawn(process.execPath, [${JSON.stringify(childFile)}], { stdio: 'ignore', windowsHide: true }); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); console.log('ready'); setInterval(() => {}, 1000);`);
  const first = runner.start(folder, command.id, command.fingerprint);
  await until(() => fs.existsSync(pidFile));
  const firstChild = Number(fs.readFileSync(pidFile, 'utf8'));
  const restarted = await runner.restart(folder, first.id);
  assert.notEqual(restarted.id, first.id);
  assert.equal(runner.get(folder, first.id).status, 'stopped');
  await until(() => { try { process.kill(firstChild, 0); return false; } catch { return true; } }, 'first child survived stop');
  await until(() => Number(fs.readFileSync(pidFile, 'utf8')) !== firstChild);
  const secondChild = Number(fs.readFileSync(pidFile, 'utf8'));
  await runner.shutdown();
  assert.equal(runner.get(folder, restarted.id).status, 'stopped');
  await until(() => { try { process.kill(secondChild, 0); return false; } catch { return true; } }, 'second child survived shutdown');
  assert.throws(() => runner.start(folder, command.id), error => error.status === 409);
});

test('children are cleaned up even when their parent command exits first', async t => {
  const { folder, runner, save, script } = fixture(t);
  const childFile = script('background-child.cjs', 'setInterval(() => {}, 1000)');
  const pidFile = path.join(folder, 'background-child.pid');
  const command = save(`const fs = require('node:fs'); const { spawn } = require('node:child_process'); const child = spawn(process.execPath, [${JSON.stringify(childFile)}], { stdio: 'ignore', windowsHide: true }); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); child.unref();`);
  const job = runner.start(folder, command.id, command.fingerprint);
  const result = await runner.job(folder, job.id).done;
  assert.equal(result.status, 'done', result.error || 'command failed');
  const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
  await until(() => { try { process.kill(childPid, 0); return false; } catch { return true; } }, 'background child survived completion');
});

test('HTTP endpoints require confirmation and SSE reconnect never creates a job', async t => {
  const { folder, runner, save } = fixture(t);
  const command = save('console.log("http ready"); setInterval(() => {}, 1000)');
  const app = express(); app.use(express.json());
  const wrap = fn => async (req, res) => { try { res.json(await fn(req, res)); } catch (error) { res.status(error.status || 400).json({ error: error.message }); } };
  mountRunner(app, wrap, runner, { shutdownHooks: false });
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(`${base}/api/runner/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ cwd: folder, commandId: command.id })).status, 428);
  const response = await post({ cwd: folder, commandId: command.id, confirmation: command.fingerprint });
  assert.equal(response.status, 200);
  const job = await response.json();
  await until(() => runner.get(folder, job.id).logs.length);
  for (let i = 0; i < 2; i++) {
    const abort = new AbortController();
    const stream = await fetch(`${base}/api/runner/jobs/${job.id}/events?cwd=${encodeURIComponent(folder)}`, { signal: abort.signal });
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const reader = stream.body.getReader();
    const chunk = await reader.read();
    assert.match(new TextDecoder().decode(chunk.value), /"type":"snapshot"/);
    abort.abort();
    await reader.cancel().catch(() => {});
  }
  assert.equal(runner.list(folder).jobs.length, 1);
});
