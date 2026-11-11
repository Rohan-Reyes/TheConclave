import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentCommand, agentInput, parseAgentOutput, runAgent, createBridge, ANTIGRAVITY_SETTINGS } from '../src/agent-bridge.js';

test('every coding agent runs text-only with the prompt on stdin', () => {
  const claude = agentCommand('claude-cli');
  assert.deepEqual(claude.args.slice(claude.args.indexOf('--tools'), claude.args.indexOf('--tools') + 2), ['--tools', '']);
  assert(claude.args.includes('--strict-mcp-config'));
  const codex = agentCommand('codex-cli');
  assert(codex.args.includes('read-only') && codex.args.includes('shell_tool'));
  const agy = agentCommand('antigravity-cli', 'some-model');
  assert(agy.args.includes('--sandbox'));
  const settings = JSON.parse(ANTIGRAVITY_SETTINGS);
  assert.equal(settings.allowNonWorkspaceAccess, false);
  assert(settings.permissions.deny.includes('command(*)') && settings.permissions.allow.length === 0);
  const secret = 'PRIVATE MEMORY 123';
  for (const p of ['claude-cli', 'codex-cli', 'antigravity-cli']) assert(!agentCommand(p).args.some(a => a.includes(secret)));
  assert.equal(JSON.parse(agentInput('antigravity-cli', secret)).message.content, secret);
  assert.throws(() => agentCommand('bash'), /Unknown/);
});

test('agent outputs are parsed and failures are reported', () => {
  assert.equal(parseAgentOutput('claude-cli', JSON.stringify({ result: 'hi', is_error: false })), 'hi');
  assert.throws(() => parseAgentOutput('claude-cli', JSON.stringify({ is_error: true })), /did not produce/);
  const codex = [{ type: 'thread.started' }, { type: 'item.completed', item: { type: 'agent_message', text: 'from codex' } }].map(x => JSON.stringify(x)).join('\n');
  assert.equal(parseAgentOutput('codex-cli', codex), 'from codex');
  const agy = [{ event: 'init' }, { event: 'result', result: { status: 'SUCCESS', response: 'from agy\n' } }].map(x => JSON.stringify(x)).join('\n');
  assert.equal(parseAgentOutput('antigravity-cli', agy), 'from agy');
  const denied = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'read_file' }] } });
  assert.throws(() => parseAgentOutput('antigravity-cli', denied), /blocked tool/);
});

test('runAgent uses a throwaway working directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-bridge-'));
  let seen;
  try {
    const text = await runAgent('claude-cli', '', 'hello', { workRoot: root, run: async (bin, args, input, cwd) => { seen = cwd; assert.equal(bin, 'claude'); assert.equal(input, 'hello'); return JSON.stringify({ result: 'ok' }); } });
    assert.equal(text, 'ok');
    assert(seen.startsWith(root) && !existsSync(seen));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bridge serves replies over a Unix socket and queues per agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-sock-'));
  const socket = join(dir, 'bridge.sock');
  let active = 0, peak = 0;
  const server = createBridge({
    runner: async (provider, model, prompt) => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 20)); active--; return `${provider}:${prompt}`; },
    inventory: async () => [{ provider: 'claude-cli', installed: true }],
    maxQueue: 2,
  });
  await new Promise(r => server.listen(socket, r));
  const previous = process.env.AGENT_BRIDGE_SOCKET;
  process.env.AGENT_BRIDGE_SOCKET = socket;
  try {
    const { cliReply, cliInventory } = await import('../src/cli-model.js');
    assert.equal((await cliInventory())[0].installed, true);
    const [a, b] = await Promise.all([cliReply('codex-cli', '', 'one'), cliReply('codex-cli', '', 'two')]);
    assert.deepEqual([a, b], ['codex-cli:one', 'codex-cli:two']);
    assert.equal(peak, 1);
    const results = await Promise.allSettled([1, 2, 3].map(n => cliReply('antigravity-cli', '', String(n))));
    assert(results.some(r => r.status === 'rejected' && /busy/.test(r.reason.message)));
    await assert.rejects(cliReply('bash', '', 'x'), /no verified/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_BRIDGE_SOCKET; else process.env.AGENT_BRIDGE_SOCKET = previous;
    await new Promise(r => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
