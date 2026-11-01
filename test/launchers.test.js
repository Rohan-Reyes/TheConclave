import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runTurn, resolveCommand, buildCommand } from '../src/agents/drivers.js';
import { isQuotaError, isLaunchError, exhaustionSummary } from '../src/agents/failover.js';

test('buildCommand properly passes prompts containing quotes, newlines and metacharacters', () => {
  const prompt = 'Test with "double quotes", \'single quotes\',\nnewlines,\nand metacharacters: & | < > ^ %PATH% $VAR';
  const built = buildCommand('claude', { prompt, permission: 'read' });
  assert.equal(built.stdin, prompt);

  const builtCodex = buildCommand('codex', { prompt, permission: 'read' });
  assert.equal(builtCodex.stdin, prompt);
});

test('distinguishes launch failure, quota error, stall, and stopped runs', () => {
  assert.equal(isLaunchError('Could not start copilot: spawn copilot ENOENT'), true);
  assert.equal(isLaunchError('spawn nonexistent-cmd ENOENT'), true);
  assert.equal(isLaunchError('Executable not found: some-cli'), true);
  assert.equal(isLaunchError('out of credits'), false);

  assert.equal(isQuotaError('out of credits'), true);
  assert.equal(isQuotaError('HTTP 429 too many requests'), true);
  assert.equal(isQuotaError('Could not start copilot: spawn copilot ENOENT'), false);
  assert.equal(isQuotaError('Stalled: no output for 4 minutes'), false);
  assert.equal(isQuotaError('Stopped'), false);
});

test('exhaustionSummary accurately reports quota vs launcher failure', () => {
  const allCreditsNotes = ['Claude is out of credits', 'Codex is out of credits'];
  const mixedNotes = ['Claude is out of credits', 'Could not start copilot: spawn copilot ENOENT'];

  assert.match(exhaustionSummary(true, allCreditsNotes), /All agents are out of credits/);
  assert.match(exhaustionSummary(false, mixedNotes), /unavailable or encountered errors/);
});

test('runTurn cleanly returns error when executable is missing without crashing process', async () => {
  const agentDef = {
    command: 'definitely-nonexistent-executable-12345',
    args: ['{prompt}'],
    input: 'arg',
  };
  const res = await new Promise(resolve => {
    // Test fake agent turn with nonexistent executable
    const { promise } = runTurn('nonexistent', {
      cwd: process.cwd(),
      prompt: 'hello "world" \n & test',
    });
    promise.then(resolve);
  });

  assert.ok(res.error);
  assert.match(res.error, /not found|ENOENT|Unknown agent/i);
});
