import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('shared MCP exposes memory and returns a question answer to the requesting task', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-mcp-test-'));
  let posted, polls = 0;
  const hub = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/questions') {
      let body = ''; for await (const chunk of req) body += chunk;
      posted = JSON.parse(body);
      res.end(JSON.stringify({ id: 'question-fixture', status: 'pending' }));
    } else if (req.url === '/api/questions/question-fixture') {
      polls++;
      res.end(JSON.stringify({ id: 'question-fixture', status: 'answered', answer: 'blue' }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(resolve => hub.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'conclave-offline-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--no-warnings', path.resolve('mcp/memory-server.js')],
    env: { ...process.env, AGENT_HUB_DB: path.join(tmp, 'memory.db'), AGENT_HUB_CLIENT: 'codex',
      CONCLAVE_PORT: String(hub.address().port), CONCLAVE_THREAD: 'thread-fixture',
      CONCLAVE_MESSAGE: 'message-fixture', CONCLAVE_AGENT: 'codex', CONCLAVE_PLAN: 'plan-fixture', CONCLAVE_STEP: 'step-fixture' },
  });
  t.after(async () => {
    await client.close();
    await new Promise(resolve => { hub.close(resolve); hub.closeAllConnections(); });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(x => x.name);
  assert.ok(names.includes('ask_user')); assert.ok(names.includes('memory_search'));
  const memory = await client.callTool({ name: 'memory_search', arguments: { query: 'no fixture memories' } });
  assert.ok(!memory.isError);
  const answer = await client.callTool({ name: 'ask_user', arguments: { question: 'Which color?', options: ['blue', 'green'] } });
  assert.match(answer.content[0].text, /The user answered: blue/);
  assert.equal(posted.threadId, 'thread-fixture'); assert.equal(posted.messageId, 'message-fixture');
  assert.equal(posted.planId, 'plan-fixture'); assert.equal(posted.stepId, 'step-fixture');
  assert.equal(posted.agent, 'codex'); assert.equal(polls, 1);
});
