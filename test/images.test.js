import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { messageImages } from '../src/agents/images.js';
import { buildCommand } from '../src/agents/drivers.js';

test('new and resumed Codex commands attach image paths with argument boundaries preserved', () => {
  const image = path.join(os.tmpdir(), 'image with spaces.png');
  for (const nativeId of [null, 'session-fixture']) {
    const command = buildCommand('codex', { prompt: 'Describe this', nativeId, permission: 'read', images: [image] });
    const index = command.args.indexOf('--image');
    assert.equal(command.args[index + 1], image);
    assert.equal(command.stdin, 'Describe this');
    assert.equal(command.args.includes('resume'), !!nativeId);
  }
});

test('image forwarding accepts only project uploads and rejects symlink escapes', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-images-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'project'), uploads = path.join(root, '.conclave', 'attachments');
  fs.mkdirSync(uploads, { recursive: true });
  const image = path.join(uploads, 'image.png'), outside = path.join(temp, 'outside.png');
  fs.writeFileSync(image, 'fixture'); fs.writeFileSync(outside, 'fixture');
  const line = file => `- Image: example (canonical path: \`${file}\`)`;
  assert.deepEqual(messageImages(line(image) + '\n' + line(outside), root), [fs.realpathSync(image)]);
  fs.renameSync(uploads, uploads + '-real');
  fs.symlinkSync(temp, uploads, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(messageImages(line(outside), root), []);
});
