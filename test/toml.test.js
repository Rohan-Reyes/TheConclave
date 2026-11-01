import test from 'node:test';
import assert from 'node:assert/strict';
import TOML from '@iarna/toml';
import { editTomlServer } from '../src/config/mcp.js';

test('updating one MCP server preserves other servers, sections and comments', () => {
  const original = '# user settings\nmodel = "example"\n[mcp_servers.keep]\ncommand = "other"\n[mcp_servers.target]\ncommand = "old"\n[mcp_servers.target.env]\nOLD = "value"\n[features]\nflag = true\n';
  const next = editTomlServer(original, 'target', { command: 'node', args: ['path with spaces', '$literal'], env: { HELLO: 'world' } });
  const parsed = TOML.parse(next);
  assert.match(next, /^# user settings/m);
  assert.equal(parsed.model, 'example');
  assert.deepEqual(parsed.mcp_servers.keep, { command: 'other' });
  assert.deepEqual(parsed.mcp_servers.target, { command: 'node', args: ['path with spaces', '$literal'], env: { HELLO: 'world' } });
  assert.equal(parsed.features.flag, true);
  assert.equal(TOML.parse(editTomlServer(next, 'target', null)).mcp_servers.target, undefined);
});

test('quoted server names roundtrip and similarly named servers remain intact', () => {
  const input = '[mcp_servers.target-extra]\ncommand="keep"\n';
  const added = editTomlServer(input, 'name with spaces', { command: 'node' });
  assert.equal(TOML.parse(added).mcp_servers['name with spaces'].command, 'node');
  const removed = editTomlServer(added, 'name with spaces', null);
  assert.equal(TOML.parse(removed).mcp_servers['target-extra'].command, 'keep');
});
