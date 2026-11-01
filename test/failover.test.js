import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-failover-test-'));
process.env.AGENT_HUB_DB = path.join(temp, 'test.db');
const F = await import('../src/agents/failover.js');
const { getDb } = await import('../src/db.js');
after(() => { getDb().close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('quota detection distinguishes exhausted credits from oversized context', () => {
  for (const message of ['Usage limit reached', 'HTTP 429 too many requests', 'resource_exhausted', 'out of credits', 'quota exhausted; try again in 2 hours']) assert.equal(F.isQuotaError(message), true, message);
  for (const message of ['context window limit exceeded', 'maximum context length', 'prompt is too long', 'syntax error', 'file not found']) assert.equal(F.isQuotaError(message), false, message);
});
test('exhaustion reset is remembered and can be cleared without another agent run', () => {
  const before = Date.now();
  const until = F.markExhausted('fixture', 'quota exhausted, try again in 2 hours');
  assert.ok(until >= before + 2 * 3600_000 && until <= Date.now() + 2 * 3600_000);
  assert.equal(F.outOfCredits('fixture').until, until);
  F.clearExhausted('fixture');
  assert.equal(F.outOfCredits('fixture'), null);
});
test('Antigravity quota fallback switches model buckets', () => {
  assert.match(F.otherAgyBucket('Gemini 3.8 Flash'), /Claude/);
  assert.match(F.otherAgyBucket('Claude Sonnet'), /Gemini/);
  assert.match(F.otherAgyBucket('GPT'), /Gemini/);
});
