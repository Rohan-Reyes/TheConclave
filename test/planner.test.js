import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePlan, validatePlan, nextBatch, assign } from '../src/agents/planner.js';

const members = ['claude', 'antigravity', 'codex'];
const cwd = process.cwd();
const step = (id, extra = {}) => ({ id, title: id, owner: 'any', files: [], dependsOn: [], kind: 'build', effort: 2, status: 'queued', ...extra });
const validate = steps => validatePlan({ steps }, { members, cwd });

test('lenient parsing preserves string content, URLs, and escaped quotes', () => {
  const detail = 'Keep ,] and ,} and https://localhost/path and "quoted" text';
  const json = JSON.stringify({ steps: [step('a', { detail })] });
  const src = 'Verdict\n````conclave-plan\n// comment\n' + json.replace(/\]\}$/, '],}') + '\n````';
  assert.equal(parsePlan(src).plan.steps[0].detail, detail);
  assert.deepEqual(parsePlan('~~~json\n{"steps": [],}\n~~~').plan.steps, []);
  assert.deepEqual(parsePlan('```\n{"steps": []}\n```').plan.steps, []);
  assert.match(parsePlan('no plan').error, /No conclave/);
  assert.match(parsePlan('```conclave-plan\n{invalid}\n```').error, /valid JSON/);
});

test('invalid schema cannot silently become an empty successful plan', () => {
  for (const raw of [null, 1, [], {}, { steps: null }, { steps: 'work' }]) assert.ok(validatePlan(raw, { members, cwd }).errors.length);
  assert.deepEqual(validate([]).errors, []);
  for (const raw of [[null], [42], [step('')], [step('a', { files: 'file' })], [step('a', { dependsOn: 'x' })], [step('a', { kind: 'typo' })], [step('a', { readOnly: 'false' })], [step('a', { effort: Infinity })]]) {
    assert.ok(validate(raw).errors.length, JSON.stringify(raw));
  }
});

test('validates owners, reviewers, unique ids, missing dependencies and cycles', () => {
  for (const steps of [
    [step('a'), step('a')], [step('a', { owner: 'unknown' })],
    [step('a', { review: 'unknown' })], [step('a', { dependsOn: ['missing'] })],
    [step('a', { dependsOn: ['a'] })],
    [step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['c'] }), step('c', { dependsOn: ['a'] })],
  ]) assert.ok(validate(steps).errors.length);
  assert.deepEqual(validate([step('a'), step('b', { dependsOn: ['a'] })]).errors, []);
});

test('rejects traversal, absolute paths, drives, UNC paths and NTFS streams', () => {
  for (const file of ['../escape', '..\\escape', '/etc/file', 'C:\\outside', 'C:relative', '\\\\server\\share', 'src/file:stream', 'a/../../escape', 'nul\0x', 42]) {
    assert.ok(validate([step('a', { files: [file] })]).errors.length, String(file));
  }
  const result = validate([step('a', { files: ['src/../src/a.js', 'src\\a.js', '..notes'] })]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.plan.steps[0].files, ['src/a.js', '..notes']);
});

test('rejects existing symlinks/junctions escaping the project', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-path-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'project'), outside = path.join(tmp, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok(validatePlan({ steps: [step('a', { files: ['linked/new.txt'] })] }, { members, cwd: root }).errors.length);
});

test('one writer at a time for both overlapping and disjoint file lists', () => {
  for (const files of [['same.js'], ['other.js']]) {
    const steps = [step('a', { files: ['same.js'] }), step('b', { files }), step('r', { kind: 'read' })];
    assert.deepEqual(nextBatch(steps).map(s => s.id), ['r', 'a']);
    steps[0].status = 'running';
    assert.deepEqual(nextBatch(steps).map(s => s.id), ['r']);
  }
});

test('dependencies run only after done or explicit skip; failures and waits block', () => {
  const steps = [step('a'), step('b', { dependsOn: ['a'] })];
  for (const status of ['running', 'waiting', 'failed']) {
    steps[0].status = status;
    assert.equal(nextBatch(steps).some(s => s.id === 'b'), false);
  }
  for (const status of ['done', 'skipped']) {
    steps[0].status = status;
    assert.deepEqual(nextBatch(steps).map(s => s.id), ['b']);
  }
});

test('balances estimated effort and quota/role penalty, with deterministic lead ties', () => {
  const task = step('new');
  const options = { members, available: () => true, lead: 'codex' };
  assert.equal(assign(task, [], options), 'codex');
  const history = [step('old', { assignee: 'codex', effort: 5, status: 'done' })];
  assert.equal(assign(task, history, options), 'claude');
  assert.equal(assign(task, history, { ...options, penalty: m => m === 'claude' ? 20 : 0 }), 'antigravity');
  assert.equal(assign(task, [], { ...options, available: () => false }), null);
  assert.equal(assign(task, [], { ...options, penalty: () => NaN }), null);
});

test('reassigns exhausted or removed owners while preserving partial-edit metadata', () => {
  const task = step('a', { owner: 'claude', assignee: 'claude', answer: 'keep changes', attempts: 1 });
  const before = structuredClone(task);
  assert.equal(assign(task, [task], { members, lead: 'codex', available: m => m !== 'claude' }), 'codex');
  assert.deepEqual(task, before);
  assert.equal(assign({ ...task, owner: 'any', assignee: 'removed' }, [], { members, lead: 'codex', available: () => true }), 'codex');
});
