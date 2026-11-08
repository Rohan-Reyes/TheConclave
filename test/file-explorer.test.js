import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { FileExplorer, mountFileExplorer } from '../src/file-explorer.js';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-files-'));
  const root = path.join(base, 'workspace');
  const explorer = new FileExplorer(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { explorer, root, base };
}

test('workspace directory lifecycle, binary upload and text edit preserve content', t => {
  const { explorer: x } = fixture(t);
  x.mkdir('project'); x.mkdir('project/nested');
  assert.deepEqual(x.list().entries.map(e => [e.name, e.directory]), [['project', true]]);
  const bytes = Buffer.from([0, 255, 1, 2]);
  x.upload({ path: 'project/data.bin', base64: bytes.toString('base64') });
  assert.equal(x.list('project').entries.find(e => e.name === 'data.bin').size, 4);
  assert.throws(() => x.read('project/data.bin'), /Binary/);
  x.upload({ path: 'project/readme.md', base64: Buffer.from('hello 🌍\n').toString('base64') });
  const a = x.read('project/readme.md'); assert.equal(a.text, 'hello 🌍\n');
  const b = x.write({ path: a.path, etag: a.etag, text: 'updated\n' });
  assert.equal(b.text, 'updated\n'); assert.notEqual(a.etag, b.etag);
  x.rename({ path: 'project', destination: 'renamed' });
  assert.equal(x.read('renamed/readme.md').text, 'updated\n');
});

test('traversal, absolute paths, windows path tricks and workspace root rename are refused', t => {
  const { explorer: x, base } = fixture(t);
  for (const value of ['../outside', 'a/../../outside', '/etc/passwd', 'C:\\Windows', 'a\\..\\b', 'a:stream', 'bad\0name', 'name.', 'name ']) {
    assert.throws(() => x.resolve(value, { missing: true }), /path|workspace/i, value);
  }
  assert.throws(() => x.mkdir('missing/child'), /not found/);
  assert.throws(() => x.rename({ path: '', destination: 'new' }));
  assert.equal(fs.existsSync(path.join(base, 'outside')), false);
});

test('links to outside directories and files are blocked in every operation', t => {
  const { explorer: x, root, base } = fixture(t);
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'private');
  fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(x.list().entries[0].blocked, true);
  for (const fn of [() => x.list('link'), () => x.read('link/secret.txt'), () => x.mkdir('link/new'), () => x.upload({ path: 'link/new.txt', base64: '' }), () => x.rename({ path: 'link', destination: 'elsewhere' })]) {
    assert.throws(fn, /Symbolic links/);
  }
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'private');
});

test('uploads never overwrite, invalid base64 is refused, edits reject stale versions', t => {
  const { explorer: x, root } = fixture(t);
  x.upload({ path: 'notes.txt', base64: Buffer.from('first').toString('base64') });
  const original = x.read('notes.txt');
  assert.throws(() => x.upload({ path: 'notes.txt', base64: '' }), e => e.status === 409);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'external change');
  assert.throws(() => x.write({ path: 'notes.txt', text: 'would overwrite', etag: original.etag }), e => e.status === 409);
  assert.equal(x.read('notes.txt').text, 'external change');
  for (const base64 of ['?', 'Y Q==', 'YR==', 'aaaa=']) assert.throws(() => x.upload({ path: 'bad.txt', base64 }), /base64/);
  assert.throws(() => x.upload({ path: 'big.bin', base64: Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64') }), /4 MB/);
  x.upload({ path: 'other.txt', base64: '' });
  assert.throws(() => x.rename({ path: 'notes.txt', destination: 'other.txt' }), e => e.status === 409);
  assert.throws(() => x.write({ path: 'other.txt', text: 'a'.repeat(512 * 1024 + 1), etag: x.read('other.txt').etag }), /512 KB/);
});

test('HTTP routes preserve workspace errors and support addressed upload/edit flows', async t => {
  const { explorer: x } = fixture(t);
  const app = express(); app.use(express.json({ limit: '6mb' }));
  const wrap = fn => (req, res) => Promise.resolve().then(() => fn(req)).then(data => res.json(data), e => res.status(e.status || 400).json({ error: e.message }));
  mountFileExplorer(app, wrap, x);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (p, method = 'GET', body) => fetch(url + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await request('/api/files/folder', 'POST', { path: 'project' })).status, 200);
  assert.equal((await request('/api/files/upload', 'POST', { path: 'project/a.txt', base64: Buffer.from('hi').toString('base64') })).status, 200);
  const current = await (await request('/api/files/content?path=project%2Fa.txt')).json();
  assert.equal(current.text, 'hi');
  assert.equal((await request('/api/files/content', 'PUT', { ...current, text: 'changed' })).status, 200);
  assert.equal((await request('/api/files/content', 'PUT', { ...current, text: 'stale' })).status, 409);
  assert.equal((await request('/api/files?path=..')).status, 400);
});
