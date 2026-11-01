import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { snapshot, diffStat, diffText, revert } from '../src/agents/snapshot.js';
const exec = promisify(execFile);
const git = (cwd,...args) => exec('git',args,{cwd,windowsHide:true});
async function fixture(fn) {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'conclave-snapshot-test-'));
  try { await git(cwd,'init','--quiet'); await fn(cwd); }
  finally { fs.rmSync(cwd,{recursive:true,force:true}); }
}
test('snapshot and revert preserve the user staging area', async () => fixture(async cwd => {
  fs.writeFileSync(path.join(cwd,'demo.txt'),'original\n');
  await git(cwd,'add','demo.txt');
  const index=fs.readFileSync(path.join(cwd,'.git','index'));
  const before=await snapshot(cwd); assert.ok(before);
  fs.writeFileSync(path.join(cwd,'demo.txt'),'edited\n');
  fs.writeFileSync(path.join(cwd,'created.txt'),'new\n');
  const after=await snapshot(cwd);
  assert.deepEqual(await diffStat(before,before.tree,after.tree),{files:2,add:2,del:1});
  assert.match(await diffText(before,before.tree,after.tree),/created.txt/);
  assert.deepEqual(fs.readFileSync(path.join(cwd,'.git','index')),index);
  await revert(before,before.tree,after.tree);
  assert.equal(fs.readFileSync(path.join(cwd,'demo.txt'),'utf8'),'original\n');
  assert.equal(fs.existsSync(path.join(cwd,'created.txt')),false);
  assert.deepEqual(fs.readFileSync(path.join(cwd,'.git','index')),index);
}));
test('revert rejects a conflicting later edit without partially reverting files', async () => fixture(async cwd => {
  fs.writeFileSync(path.join(cwd,'a.txt'),'original\n'); fs.writeFileSync(path.join(cwd,'b.txt'),'original\n');
  const before=await snapshot(cwd);
  fs.writeFileSync(path.join(cwd,'a.txt'),'agent\n'); fs.writeFileSync(path.join(cwd,'b.txt'),'agent\n');
  const after=await snapshot(cwd);
  fs.writeFileSync(path.join(cwd,'a.txt'),'later user edit\n');
  await assert.rejects(revert(before,before.tree,after.tree),/files changed again/);
  assert.equal(fs.readFileSync(path.join(cwd,'a.txt'),'utf8'),'later user edit\n');
  assert.equal(fs.readFileSync(path.join(cwd,'b.txt'),'utf8'),'agent\n');
}));
