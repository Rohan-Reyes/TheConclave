#!/usr/bin/env node
// Agent Hub memory MCP server (stdio). Claude Code, Antigravity and Codex all
// connect to this, so they share one memory stored in agent-hub/data/hub.db.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDb } from '../src/db.js';
import { normPath } from '../src/paths.js';
import * as memory from '../src/memory.js';

// Every write is tagged with the tool that made it. Set AGENT_HUB_CLIENT in each
// tool's MCP config, otherwise we use the client name sent during initialize.
let clientName = process.env.AGENT_HUB_CLIENT || '';
const actor = () => {
  const n = (clientName || server.server.getClientVersion?.()?.name || 'mcp').toLowerCase();
  if (n.includes('claude')) return 'claude';
  if (n.includes('codex')) return 'codex';
  if (n.includes('antigravity') || n.includes('gemini') || n.includes('agy') || n.includes('jetski')) return 'antigravity';
  return n.slice(0, 40);
};

const server = new McpServer({ name: 'agent-hub-memory', version: '1.0.0' });
const TYPE = z.enum(['user', 'feedback', 'project', 'reference']);

const fmt = m => [
  `id: ${m.id}`, `title: ${m.title}`, `type: ${m.type} | scope: ${m.scope} | tags: ${m.tags || '-'}`,
  `updated: ${m.updated} by ${m.source_tool}`, '', m.body,
].join('\n');
const text = t => ({ content: [{ type: 'text', text: t }] });
const list = rows => rows.length
  ? rows.map(m => `- [${m.id}] (${m.type}, ${m.scope === 'global' ? 'global' : 'project'}) ${m.title}${m.snippet ? `\n    ${m.snippet}` : ''}`).join('\n')
  : 'No memories found.';

server.registerTool('memory_search', {
  title: 'Search shared memory',
  description: 'Search the central memory shared by Claude Code, Antigravity and Codex. Use it at the start of a task to recall user preferences, project facts and past decisions. Pass cwd to include that project\'s memories plus global ones.',
  inputSchema: { query: z.string().describe('Words to search for'), cwd: z.string().optional().describe('Current project folder'), limit: z.number().int().min(1).max(50).optional() },
}, async ({ query, cwd, limit }) => text(list(memory.listMemories({ q: query, scope: cwd, limit: limit || 15 }))));

server.registerTool('memory_get', {
  title: 'Read one memory',
  description: 'Read the full text of a memory by id.',
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  const m = memory.getMemory(id);
  return m ? text(fmt(m)) : text(`No memory with id ${id}`);
});

server.registerTool('memory_add', {
  title: 'Save a memory',
  description: 'Save a durable fact to the shared memory so every coding agent can use it later. Save one fact per memory: user preferences (type user), corrections or confirmed ways of working (feedback, include why), project facts not visible in code (project), or pointers to external resources (reference). Search first to avoid duplicates; update instead if one exists.',
  inputSchema: {
    title: z.string().describe('Short one-line summary'),
    body: z.string().describe('The fact, with Why / How to apply for feedback and project types'),
    type: TYPE.optional(),
    scope: z.string().optional().describe('"global" (default) or the project folder path this applies to'),
    tags: z.array(z.string()).optional(),
  },
}, async (args) => {
  const m = memory.addMemory(args, actor());
  return text(`Saved memory ${m.id}: ${m.title}`);
});

server.registerTool('memory_update', {
  title: 'Update a memory',
  description: 'Change an existing memory (only the fields you pass are changed). Use this when a fact changed or was wrong.',
  inputSchema: { id: z.string(), title: z.string().optional(), body: z.string().optional(), type: TYPE.optional(), scope: z.string().optional(), tags: z.array(z.string()).optional() },
}, async ({ id, ...rest }) => {
  const m = memory.updateMemory(id, rest, actor());
  return text(`Updated memory ${m.id}: ${m.title}`);
});

server.registerTool('memory_delete', {
  title: 'Delete a memory',
  description: 'Delete a memory that is wrong or no longer true.',
  inputSchema: { id: z.string() },
}, async ({ id }) => text(memory.deleteMemory(id, actor()) ? `Deleted ${id}` : `No memory with id ${id}`));

server.registerTool('memory_list_recent', {
  title: 'List recent memories',
  description: 'List the most recently changed memories, optionally for one project folder.',
  inputSchema: { cwd: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
}, async ({ cwd, limit }) => text(list(memory.listMemories({ scope: cwd, limit: limit || 20 }))));

server.registerTool('project_context', {
  title: 'Project context',
  description: 'Get everything the hub knows about a project folder: its memories, global memories, and recent chats from Claude Code, Antigravity and Codex. Call this when starting work in a folder or when the user hands off work from another tool.',
  inputSchema: { cwd: z.string().describe('Project folder path') },
}, async ({ cwd }) => {
  const dir = normPath(cwd);
  const mems = memory.listMemories({ scope: dir, limit: 40 });
  const chats = getDb().prepare('SELECT tool, title, updated, source_path FROM chats WHERE project = ? OR cwd = ? ORDER BY updated DESC LIMIT 15').all(dir, dir);
  const projectMems = mems.filter(m => m.scope !== 'global');
  const globalMems = mems.filter(m => m.scope === 'global');
  return text([
    `# Project: ${dir}`,
    `\n## Project memories (${projectMems.length})`, projectMems.length ? projectMems.map(fmt).join('\n\n---\n') : '(none)',
    `\n## Global memories (${globalMems.length}, titles only, use memory_get for detail)`, list(globalMems),
    `\n## Recent chats in this folder`, chats.length ? chats.map(c => `- [${c.tool}] ${c.updated.slice(0, 10)} ${c.title}\n    transcript: ${c.source_path}`).join('\n') : '(none indexed)',
  ].join('\n'));
});

// ---- Talk to the other agents through Conclave (needs the Conclave app running).
const HUB = `http://127.0.0.1:${process.env.CONCLAVE_PORT || 4777}`;
async function hub(pathname, body, method = body ? 'POST' : 'GET') {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  if (process.env.CONCLAVE_INTERNAL_TOKEN) headers['X-Conclave-Internal'] = process.env.CONCLAVE_INTERNAL_TOKEN;
  const r = await fetch(HUB + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Conclave returned HTTP ${r.status}`);
  return j;
}
async function runInHub({ cwd, target, settings, text, title, timeoutMin = 15 }) {
  if (process.env.CONCLAVE_CHILD) return text_('This session was started by Conclave, so it cannot start another Conclave chat (that would loop). Use @mentions in your reply instead.');
  let t;
  try { t = await hub('/api/threads', { cwd, target, title, settings }); }
  catch { return text_('Conclave is not running. Start it with agent-hub\\start.cmd (http://127.0.0.1:4777) and try again.'); }
  await hub(`/api/threads/${t.id}/messages`, { text });
  const end = Date.now() + timeoutMin * 60_000;
  while (Date.now() < end) {
    await new Promise(r => setTimeout(r, 3000));
    const cur = await hub(`/api/threads/${t.id}`);
    if (!cur.running) {
      const replies = cur.messages.filter(m => m.role === 'agent');
      const final = replies[replies.length - 1];
      return text_([
        ...replies.slice(0, -1).map(m => `### ${m.tool}${m.round ? ` (${m.round})` : ''}\n${m.content.slice(0, 1500)}`),
        `### FINAL: ${final?.tool || '?'}${final?.round ? ` (${final.round})` : ''}\n${final?.content || final?.error || '(no reply)'}`,
        `\nFull chat: ${HUB}/#/hub/${t.id}`,
      ].join('\n\n'));
    }
  }
  return text_(`Still running after ${timeoutMin} min. Follow it at ${HUB}/#/hub/${t.id}`);
}
function text_(t) { return { content: [{ type: 'text', text: t }] }; }

server.registerTool('council_ask', {
  title: 'Ask the Conclave council',
  description: 'Ask Claude Code, Antigravity and Codex together (the Conclave council) and get their combined answer. mode "debate": each answers, they review each other, the lead writes a verdict and plan (read-only). mode "build": the lead builds in cwd, the others review the real files, the lead fixes. Use for hard decisions, second opinions, or reviews. Takes minutes.',
  inputSchema: {
    question: z.string().describe('What to ask, with enough context for agents that cannot see your conversation'),
    cwd: z.string().describe('Project folder the council should work in'),
    mode: z.enum(['debate', 'build']).optional(),
    lead: z.enum(['claude', 'antigravity', 'codex']).optional().describe('Who writes the verdict / builds'),
  },
}, async ({ question, cwd, mode = 'debate', lead }) => runInHub({
  cwd, target: 'council', title: `[via ${actor()}] ${question.slice(0, 70)}`, text: question,
  settings: { councilMode: mode, ...(lead ? { chair: lead } : {}), permission: mode === 'build' ? 'edit' : 'read' },
}));

server.registerTool('agent_ask', {
  title: 'Ask another coding agent',
  description: 'Ask one other agent (claude, antigravity, codex, or a custom Conclave agent) a question or give it a task, and get its reply. Read-only unless allow_edits is true.',
  inputSchema: {
    agent: z.string().describe('claude | antigravity | codex | custom agent id'),
    prompt: z.string().describe('The request, with enough context for an agent that cannot see your conversation'),
    cwd: z.string().describe('Project folder'),
    allow_edits: z.boolean().optional(),
  },
}, async ({ agent, prompt, cwd, allow_edits }) => runInHub({
  cwd, target: agent, title: `[via ${actor()}] ${prompt.slice(0, 70)}`, text: prompt,
  settings: { permission: allow_edits ? 'edit' : 'read', autoRelay: false },
}));

// Conclave passes this to Claude as --permission-prompt-tool. Each request shows
// up in the browser with Allow / Deny; we wait for the answer.
server.registerTool('approval_prompt', {
  title: 'Conclave permission prompt (internal)',
  description: 'Internal: used by Conclave to ask the user to allow or deny a tool call. Do not call this yourself.',
  inputSchema: { tool_name: z.string(), input: z.record(z.string(), z.unknown()), tool_use_id: z.string().optional() },
}, async ({ tool_name, input }) => {
  const answer = o => text_(JSON.stringify(o));
  const threadId = process.env.CONCLAVE_THREAD;
  if (!threadId) return answer({ behavior: 'deny', message: 'Not running inside a Conclave chat.' });
  let a;
  try {
    a = await hub('/api/approvals', { threadId, messageId: process.env.CONCLAVE_MESSAGE, agent: process.env.CONCLAVE_AGENT || 'claude', toolName: tool_name, input });
  } catch (e) { return answer({ behavior: 'deny', message: `Conclave unreachable: ${e.message}` }); }
  const end = Date.now() + 16 * 60_000;
  while (a.status === 'pending' && Date.now() < end) {
    await new Promise(r => setTimeout(r, 800));
    try { a = await hub(`/api/approvals/${a.id}`); } catch { break; }
  }
  return a.status === 'allowed'
    ? answer({ behavior: 'allow', updatedInput: input })
    : answer({ behavior: 'deny', message: a.message || 'The user denied this in Conclave.' });
});

// Ask the user a question from inside a Conclave chat and wait for the answer.
server.registerTool('ask_user', {
  title: 'Ask the user (Conclave)',
  description: 'Ask the user a question and wait for their answer. Only works inside a Conclave chat. Use it only when you cannot make a sensible choice yourself (e.g. a product decision or missing information). Offer 2-5 short options when possible; the user can also type a free answer. Waits up to 15 minutes.',
  inputSchema: {
    question: z.string().describe('The question, with enough context to answer it'),
    options: z.array(z.string()).max(8).optional().describe('Short choices to show as buttons'),
    multi: z.boolean().optional().describe('Allow picking several options'),
  },
}, async ({ question, options, multi }) => {
  const threadId = process.env.CONCLAVE_THREAD;
  if (!threadId) return text_('ask_user only works inside a Conclave chat. Make a sensible choice and state your assumption.');
  let q;
  try {
    q = await hub('/api/questions', {
      threadId, messageId: process.env.CONCLAVE_MESSAGE || null, agent: process.env.CONCLAVE_AGENT || actor(),
      planId: process.env.CONCLAVE_PLAN || null, stepId: process.env.CONCLAVE_STEP || null, question, options: options || [], multi: !!multi,
    });
  } catch (e) { return text_(`Could not reach Conclave (${e.message}). Make a sensible choice and state your assumption.`); }
  const end = Date.now() + 15 * 60_000;
  while (q.status === 'pending' && Date.now() < end) {
    await new Promise(r => setTimeout(r, 1000));
    try { q = await hub(`/api/questions/${q.id}`); } catch { break; }
  }
  if (q.status === 'answered') return text_(`The user answered: ${q.answer}`);
  return text_('No answer from the user. Make a sensible choice, state your assumption, and continue.');
});

getDb();
await server.connect(new StdioServerTransport());
