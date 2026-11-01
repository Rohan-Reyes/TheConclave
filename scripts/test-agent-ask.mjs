// Calls the agent_ask MCP tool the way a terminal session would (Conclave must be running).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, AGENT_HUB_CLIENT: 'claude' };
delete env.CONCLAVE_CHILD;
const client = new Client({ name: 'agent-ask-test', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--no-warnings', path.join(root, 'mcp', 'memory-server.js')], env }));
console.log('tools:', (await client.listTools()).tools.map(t => t.name).join(', '));
const r = await client.callTool({ name: 'agent_ask', arguments: { agent: process.argv[2] || 'codex', prompt: 'Reply with exactly: pong from you', cwd: os.tmpdir() } }, undefined, { timeout: 300000 });
console.log(r.content.map(c => c.text).join('\n'));
await client.close();
