import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'conclave-globals-'));
process.env.AGENT_HUB_DB = join(dir, 'test.db');
process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
const G = await import('../src/config/globals.js');
const { getDb } = await import('../src/db.js');
after(() => {
  getDb().close();
  rmSync(dir, { recursive: true, force: true });
});
test('secrets are encrypted, never listed or prompted, and granted only to chosen runtimes', () => {
  G.saveVariable({
    name: 'CLOUDFLARE_API_TOKEN',
    value: 'private-test-value-123',
    secret: true,
    targets: ['codex'],
  });
  assert.doesNotMatch(JSON.stringify(G.listVariables()), /private-test-value/);
  assert.doesNotMatch(
    JSON.stringify(getDb().prepare('SELECT * FROM global_variables').all()),
    /private-test-value/,
  );
  assert.equal(
    G.environmentFor('codex').CLOUDFLARE_API_TOKEN,
    'private-test-value-123',
  );
  assert.deepEqual(G.environmentFor('claude'), {});
  assert.equal(G.promptText('codex'), '');
  G.saveVariable({
    name: 'CLOUDFLARE_API_TOKEN',
    targets: ['runner'],
    secret: true,
  });
  assert.deepEqual(G.environmentFor('codex'), {});
  assert.equal(
    G.environmentFor('runner').CLOUDFLARE_API_TOKEN,
    'private-test-value-123',
  );
  assert.throws(
    () =>
      G.saveVariable({
        name: 'CLOUDFLARE_API_TOKEN',
        secret: false,
        targets: ['runner'],
      }),
    /replacement value/,
  );
  G.deleteVariable('CLOUDFLARE_API_TOKEN');
  assert.deepEqual(G.environmentFor('runner'), {});
});
test('reserved runtime names, malformed grants and missing encryption keys fail closed', () => {
  for (const name of [
    'HOME',
    'PATH',
    'NODE_OPTIONS',
    'CONCLAVE_INTERNAL_TOKEN',
    'AGENT_HUB_DB',
    'TOKEN_ENCRYPTION_KEY',
    'CODEX_HOME',
  ])
    assert.throws(
      () => G.saveVariable({ name, value: 'fixture', targets: ['codex'] }),
      /reserved/,
    );
  assert.throws(
    () => G.saveVariable({ name: 'TOKEN', value: 'fixture', targets: [] }),
    /runtime/,
  );
  const before = process.env.TOKEN_ENCRYPTION_KEY;
  delete process.env.TOKEN_ENCRYPTION_KEY;
  try {
    assert.throws(
      () =>
        G.saveVariable({ name: 'TOKEN', value: 'fixture', targets: ['codex'] }),
      /TOKEN_ENCRYPTION_KEY/,
    );
  } finally {
    process.env.TOKEN_ENCRYPTION_KEY = before;
  }
});
test('global prompts apply only to enabled selected runtimes and edits replace prior instructions', () => {
  const p = G.savePrompt({
    title: 'Writing style',
    content: 'Use concise prose.',
    targets: ['codex', 'assistant'],
  });
  assert.match(G.promptText('codex'), /concise prose/);
  assert.match(G.promptText('assistant'), /concise prose/);
  assert.equal(G.promptText('claude'), '');
  G.savePrompt({
    id: p.id,
    title: 'Writing style',
    content: 'New instruction.',
    targets: ['codex'],
    enabled: false,
  });
  assert.equal(G.promptText('codex'), '');
  G.deletePrompt(p.id);
  assert.deepEqual(G.listPrompts(), []);
});
