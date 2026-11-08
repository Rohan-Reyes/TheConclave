import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AttachmentStore, decodeAttachment, MAX_ATTACHMENT_BYTES } from '../src/attachments.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7FYAAAAASUVORK5CYII=';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-attachments-'));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  const quickRoot = path.join(root, 'Conclave');
  const threads = { existing: { cwd: project, settings: {} }, quick: { cwd: path.join(quickRoot, 'new-chat'), settings: { quick: true } } };
  const store = new AttachmentStore({ getThread(id) { if (!threads[id]) throw new Error('Thread not found'); return threads[id]; }, quickRoot });
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.ok(path.basename(resolved).startsWith('conclave-attachments-') && path.dirname(resolved) === fs.realpathSync(os.tmpdir()));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, project, outside, quickRoot, threads, store };
}
const text = (name = 'notes.txt', data = 'hello') => ({ name, data, encoding: 'utf8' });

test('text and real image uploads remain inside the canonical project', t => {
  const { project, store } = fixture(t);
  const result = store.upload({ threadId: 'existing', files: [text(), { name: 'pixel.png', data: png }] });
  assert.equal(result.ok, true);
  assert.equal(result.files.length, 2);
  for (const file of result.files) assert.equal(path.dirname(file.path), path.join(fs.realpathSync.native(project), '.conclave', 'attachments'));
  assert.equal(fs.readFileSync(result.files[0].path, 'utf8'), 'hello');
  assert.equal(result.files[0].isImage, false);
  assert.equal(result.files[0].url, null);
  assert.equal(result.files[1].isImage, true);
  assert.match(result.files[1].url, /^\/api\/file\/raw\?path=/);
  const listing = store.list({ threadId: 'existing' });
  assert.equal(listing.files.length, 2);
  assert.equal(listing.files.filter(file => file.isImage).length, 1);
});

test('unknown threads never fall back to a supplied cwd or shared storage', t => {
  const { store, outside } = fixture(t);
  assert.throws(() => store.upload({ threadId: 'missing', cwd: outside, files: [text()] }), error => error.status === 404);
  assert.throws(() => store.list({ threadId: 'missing', cwd: outside }), error => error.status === 404);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.throws(() => store.upload({ threadId: 'existing', cwd: outside, files: [text()] }), error => error.status === 403);
});

test('quick-chat project folders can be created before the first agent run', t => {
  const { threads, quickRoot, store } = fixture(t);
  assert.equal(fs.existsSync(quickRoot), false);
  const result = store.upload({ threadId: 'quick', files: [text()] });
  assert.equal(path.relative(threads.quick.cwd, result.dir), path.join('.conclave', 'attachments'));
  assert.ok(fs.existsSync(result.file.path));
});

test('missing normal projects and quick paths outside the quick root are refused', t => {
  const { threads, root, store } = fixture(t);
  threads.existing.cwd = path.join(root, 'missing');
  assert.throws(() => store.upload({ threadId: 'existing', files: [text()] }), error => error.status === 404);
  threads.quick.cwd = path.join(root, 'elsewhere');
  assert.throws(() => store.upload({ threadId: 'quick', files: [text()] }), error => error.status === 404);
  assert.equal(fs.existsSync(threads.quick.cwd), false);
});

test('malicious filenames cannot traverse directories or inject markup', t => {
  const { store, project } = fixture(t);
  const result = store.upload({ threadId: 'existing', files: [text('../../outside/evil.txt'), text('C:\\outside\\escape.txt'), text('bad](`x`)\n.txt')] });
  for (const file of result.files) {
    assert.equal(path.dirname(file.path), path.join(project, '.conclave', 'attachments'));
    assert.match(file.filename, /^[a-f0-9-]+-[A-Za-z0-9._-]+\.txt$/);
    assert.doesNotMatch(file.originalName, /[\[\]()`\r\n\\/]/);
  }
  assert.equal(fs.existsSync(path.join(project, 'evil.txt')), false);
  assert.throws(() => store.upload({ threadId: 'existing', files: [text('name\0.txt')] }), /filename/);
});

test('HTML, SVG and source files are stored only as inert text', t => {
  const { store } = fixture(t);
  const result = store.upload({ threadId: 'existing', files: [text('page.html', '<script>alert(1)</script>'), text('image.svg', '<svg onload="alert(1)"/>'), text('script.js', 'console.log(1)')] });
  for (const file of result.files) {
    assert.match(file.path, /\.txt$/);
    assert.equal(file.isImage, false);
    assert.equal(file.url, null);
  }
});

test('base64 validation rejects garbage, whitespace, bad padding and unknown encodings', () => {
  for (const data of ['a', 'abc', 'a===', '====', 'YW Jj', 'YWJj\n', 'Zm9=', 'Zm==', 'data:text/plain;base64,YQ==', '%%==']) assert.throws(() => decodeAttachment(data), /base64/);
  assert.equal(decodeAttachment('YWJj').toString(), 'abc');
  assert.equal(decodeAttachment('YQ==').toString(), 'a');
  assert.equal(decodeAttachment('').length, 0);
  assert.throws(() => decodeAttachment('hello', 'hex'), /encodings/);
  assert.throws(() => decodeAttachment(null), /string/);
});

test('per-file and aggregate limits reject uploads before any file is stored', t => {
  const { store, project } = fixture(t);
  assert.throws(() => decodeAttachment('a'.repeat(MAX_ATTACHMENT_BYTES + 1), 'utf8'), error => error.status === 413);
  assert.throws(() => decodeAttachment(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64')), error => error.status === 413);
  assert.throws(() => store.upload({ threadId: 'existing', files: [text('one.txt', 'a'.repeat(3 * 1024 * 1024)), text('two.txt', 'b'.repeat(2 * 1024 * 1024))] }), error => error.status === 413);
  assert.equal(fs.existsSync(path.join(project, '.conclave')), false);
  assert.throws(() => store.upload({ threadId: 'existing', files: [] }), /between 1 and 10/);
  assert.throws(() => store.upload({ threadId: 'existing', files: Array.from({ length: 11 }, () => text()) }), /between 1 and 10/);
});

test('binary and disguised images are rejected while empty text is allowed', t => {
  const { store } = fixture(t);
  for (const file of [text('bad.png', '<svg/>'), { name: 'bad.txt', data: 'AP8=' }, text('file.exe', 'executable')]) assert.throws(() => store.upload({ threadId: 'existing', files: [file] }));
  const result = store.upload({ threadId: 'existing', files: [text('empty.txt', '')] });
  assert.equal(result.file.size, 0);
});

test('user can attach almost all filetypes including pdfs, docs, and archives', t => {
  const { store } = fixture(t);
  const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
  const zipBytes = Buffer.from('PK\x03\x04\x14\x00\x00\x00\x00\x00archive content');
  const result = store.upload({
    threadId: 'existing',
    files: [
      { name: 'document.pdf', data: pdfBytes.toString('base64') },
      { name: 'data.zip', data: zipBytes.toString('base64') }
    ]
  });
  assert.equal(result.files.length, 2);
  assert.match(result.files[0].path, /\.pdf$/i);
  assert.equal(result.files[0].isImage, false);
  assert.equal(result.files[0].url, null);
  assert.ok(fs.existsSync(result.files[0].path));
  assert.deepEqual(fs.readFileSync(result.files[0].path), pdfBytes);

  assert.match(result.files[1].path, /\.zip$/i);
  assert.equal(result.files[1].isImage, false);
  assert.ok(fs.existsSync(result.files[1].path));
  assert.deepEqual(fs.readFileSync(result.files[1].path), zipBytes);
});

for (const segment of ['.conclave', 'attachments']) test(`symbolic link/junction escape through ${segment} is refused`, t => {
  const { project, outside, store } = fixture(t);
  const target = segment === '.conclave' ? path.join(project, '.conclave') : path.join(project, '.conclave', 'attachments');
  if (segment === 'attachments') fs.mkdirSync(path.join(project, '.conclave'));
  fs.symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => store.upload({ threadId: 'existing', files: [text()] }), error => error.status === 403);
  assert.throws(() => store.list({ threadId: 'existing' }), error => error.status === 403);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('quick-root junctions cannot redirect missing chat folders outside the root', t => {
  const { outside, quickRoot, store } = fixture(t);
  fs.symlinkSync(outside, quickRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => store.upload({ threadId: 'quick', files: [text()] }), error => error.status === 403);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('quick-root junctions remain forbidden when the redirected chat folder already exists', t => {
  const { outside, quickRoot, store } = fixture(t);
  fs.mkdirSync(path.join(outside, 'new-chat'));
  fs.symlinkSync(outside, quickRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => store.upload({ threadId: 'quick', files: [text()] }), error => error.status === 403);
  assert.deepEqual(fs.readdirSync(path.join(outside, 'new-chat')), []);
});

test('stored names are unique and existing content is never overwritten', t => {
  const { store } = fixture(t);
  const first = store.upload({ threadId: 'existing', files: [text()] }).file;
  const second = store.upload({ threadId: 'existing', files: [text('notes.txt', 'second')] }).file;
  assert.notEqual(first.filename, second.filename);
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'hello');
  assert.equal(fs.readFileSync(second.path, 'utf8'), 'second');
});
