// Smoke test: start the memory MCP server over stdio and call each tool.
// Usage: node scripts/test-mcp.mjs   (uses a throwaway DB unless AGENT_HUB_DB is set)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = process.env.AGENT_HUB_DB || path.join(os.tmpdir(), `agent-hub-mcp-test-${Date.now()}.db`);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--no-warnings', path.join(root, 'mcp', 'memory-server.js')],
  env: { ...process.env, AGENT_HUB_DB: db, AGENT_HUB_CLIENT: 'codex' },
});
const client = new Client({ name: 'smoke-test', version: '1.0.0' });
await client.connect(transport);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return r.content.map(c => c.text).join('\n');
};

const tools = (await client.listTools()).tools.map(t => t.name);
console.log('tools:', tools.join(', '));
const added = await call('memory_add', { title: 'Smoke test fact', body: 'Agent Hub smoke test body about zebras', type: 'reference', tags: ['test'] });
console.log(added);
const id = added.match(/memory ([0-9a-f-]{36})/)[1];
console.log((await call('memory_search', { query: 'zebra' })).split('\n')[0]);
console.log((await call('memory_update', { id, body: 'updated body' })));
console.log((await call('memory_get', { id })).split('\n').slice(0, 4).join(' | '));
console.log((await call('project_context', { cwd: os.homedir() })).split('\n').slice(0, 3).join(' | '));
console.log(await call('memory_delete', { id }));
await client.close();
console.log('OK, test db:', db);
