import express from 'express';
import { mountGlobals } from './src/config/globals.js';
import { readTaskUpdates } from './src/context-updates.js';
import { mountAssistant } from './src/unified-assistant.js';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { ROOT } from './src/paths.js';
import { getDb, ftsQuery } from './src/db.js';
import { runIndex, loadTranscript, indexState } from './src/indexer.js';
import * as memory from './src/memory.js';
import * as projects from './src/projects.js';
import { resumeChat, newSession } from './src/launch.js';
import * as mcp from './src/config/mcp.js';
import * as skills from './src/config/skills.js';
import { lineDiff } from './src/config/backup.js';
import * as threads from './src/agents/threads.js';
import { mountExtra } from './src/routes-extra.js';
import { mountRunner } from './src/runner.js';
import { mountAuth } from './src/auth.js';
import { mountFileExplorer } from './src/file-explorer.js';
import { mountTerminal, attachTerminalWs } from './src/terminal.js';
import { mountSync } from './src/sync.js';

const PORT = Number(process.env.CONCLAVE_PORT || process.env.PORT || 4777);
const HOST = '127.0.0.1';
const app = express();

// This server can open terminals and edit config files, so only accept
// requests that come from its own page on localhost (blocks DNS rebinding / CSRF).
const okHost = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
if (process.env.CONCLAVE_PUBLIC_ORIGIN) okHost.add(new URL(process.env.CONCLAVE_PUBLIC_ORIGIN).host);
app.use((req, res, next) => {
  if (!okHost.has(req.headers.host)) return res.status(403).send('Forbidden host');
  const origin = req.headers.origin;
  if (!['GET', 'HEAD'].includes(req.method) && origin && !okHost.has(origin.replace(/^https?:\/\//, ''))) return res.status(403).send('Forbidden origin');
  if (!['GET', 'HEAD', 'DELETE'].includes(req.method)) {
    const hasBody = (req.headers['content-length'] && req.headers['content-length'] !== '0') || req.headers['transfer-encoding'];
    if (hasBody && !req.is('application/json')) return res.status(415).json({ error: 'JSON only' });
  }
  next();
});
app.get('/vendor/simplewebauthn-browser.umd.min.js', (_req, res) => res.sendFile(path.join(ROOT, 'node_modules', '@simplewebauthn', 'browser', 'dist', 'bundle', 'index.umd.min.js')));
let revokeAssistantSession = () => {};
const auth = mountAuth(app, { root: ROOT, onSessionRevoked: id => revokeAssistantSession(id) });
revokeAssistantSession = mountAssistant(app, { authenticated: auth.enabled });
app.use(express.json({ limit: '6mb' }));
// Gzip JSON responses over 2 KB when the client accepts it. Event streams never pass through res.json.
// Honors quality values: "gzip;q=0" (or "*;q=0" without an explicit gzip entry) means no gzip.
function acceptsGzip(req) {
  let gzip = null, star = null;
  for (const part of String(req.headers['accept-encoding'] || '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const qp = params.map(x => x.trim()).find(x => x.startsWith('q='));
    const q = qp ? Number(qp.slice(2)) : 1;
    if (name === 'gzip' || name === 'x-gzip') gzip = Math.max(gzip ?? 0, Number.isFinite(q) ? q : 0);
    else if (name === '*') star = Number.isFinite(q) ? q : 0;
  }
  return (gzip ?? star ?? 0) > 0;
}
app.use('/api', (req, res, next) => {
  if (!acceptsGzip(req)) return next();
  const json = res.json.bind(res);
  res.json = body => {
    const text = JSON.stringify(body);
    if (text === undefined || Buffer.byteLength(text) < 2048 || res.headersSent) return json(body);
    zlib.gzip(text, { level: 6 }, (err, gz) => {
      if (res.headersSent) return;
      if (err) return json(body);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Vary', 'Accept-Encoding');
      res.end(gz);
    });
    return res;
  };
  next();
});
// Precompressed static text assets (cached per file mtime); falls through to express.static otherwise.
const gzCache = new Map();
app.get(/\.(?:js|css|html|svg|json|webmanifest)$/, (req, res, next) => {
  if (!acceptsGzip(req) || req.path.startsWith('/api/')) return next();
  const file = path.join(ROOT, 'public', path.normalize(req.path).replace(/^([/\\])+/, ''));
  if (!file.startsWith(path.join(ROOT, 'public') + path.sep)) return next();
  fs.stat(file, (err, st) => {
    if (err || !st.isFile() || st.size < 1024) return next();
    const hit = gzCache.get(file);
    const send = gz => {
      res.type(path.extname(file)); res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Last-Modified', st.mtime.toUTCString()); res.setHeader('Cache-Control', 'no-cache');
      if (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']) >= new Date(st.mtime.toUTCString())) return res.status(304).end();
      res.end(gz);
    };
    if (hit && hit.mtime === st.mtimeMs) return send(hit.gz);
    fs.readFile(file, (e2, raw) => {
      if (e2) return next();
      zlib.gzip(raw, { level: 9 }, (e3, gz) => { if (e3) return next(); gzCache.set(file, { mtime: st.mtimeMs, gz }); send(gz); });
    });
  });
});
app.use(express.static(path.join(ROOT, 'public')));

const wrap = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).then(
  data => { if (!res.headersSent) res.json(data ?? { ok: true }); },
  err => res.status(err.status || 400).json({ error: err.message }));

mountGlobals(app, wrap);
mountRunner(app, wrap);
mountFileExplorer(app, wrap);
const terminalService = mountTerminal(app, wrap);
const syncService = mountSync(app, wrap);
app.post('/api/threads/:id/messages/:mid/edit', wrap(req => threads.editLastUserMessage(req.params.id, req.params.mid, req.body.text)));

function chatOr404(id) {
  const c = getDb().prepare('SELECT * FROM chats WHERE id = ?').get(id);
  if (!c) throw Object.assign(new Error('chat not found'), { status: 404 });
  return c;
}

// ---- overview
app.get('/api/stats', wrap(() => {
  const db = getDb();
  return {
    version: '2.0.0',
    chats: db.prepare('SELECT tool, COUNT(*) AS n, MAX(updated) AS last FROM chats GROUP BY tool').all(),
    memories: db.prepare('SELECT COUNT(*) AS n FROM memories').get().n,
    projects: db.prepare("SELECT COUNT(DISTINCT project) AS n FROM chats WHERE project != ''").get().n,
    index: indexState,
  };
}));
app.get('/api/version', wrap(() => ({ version: '2.0.0', name: 'conclave' })));
app.post('/api/reindex', wrap(() => runIndex()));

// ---- chats
app.get('/api/chats', wrap(req => {
  const { q, tool, cwd, from, to } = req.query;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Number(req.query.offset) || 0;
  const where = [], args = [];
  if (tool) { where.push('c.tool = ?'); args.push(tool); }
  if (req.query.project) { where.push('c.project = ?'); args.push(req.query.project); }
  if (cwd) { where.push('c.cwd = ?'); args.push(cwd); }
  if (from) { where.push('c.updated >= ?'); args.push(from); }
  if (to) { where.push('c.updated <= ?'); args.push(to + 'T23:59:59'); }
  const fq = ftsQuery(q);
  const cols = 'c.id, c.tool, c.variant, c.native_id, c.title, c.cwd, c.project, c.started, c.updated, c.msg_count, c.parent_id';
  const db = getDb();
  if (fq) {
    return db.prepare(`SELECT ${cols}, snippet(chat_fts, 2, '[[', ']]', '…', 20) AS snippet
      FROM chat_fts f JOIN chats c ON c.id = f.chat_id
      WHERE chat_fts MATCH ? ${where.map(w => 'AND ' + w).join(' ')}
      ORDER BY bm25(chat_fts, 0, 5, 1) LIMIT ? OFFSET ?`).all(fq, ...args, limit, offset);
  }
  return db.prepare(`SELECT ${cols} FROM chats c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY c.updated DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
}));

app.get('/api/chats/:id', wrap(async req => {
  const chat = chatOr404(req.params.id);
  const { messages } = await loadTranscript(chat);
  return { chat, messages };
}));

app.post('/api/chats/:id/resume', wrap(req => resumeChat(chatOr404(req.params.id))));

app.get('/api/chats/:id/handoff', wrap(async req => {
  const chat = chatOr404(req.params.id);
  const { messages } = await loadTranscript(chat);
  const turns = messages.filter(m => m.kind === 'text' && (m.role === 'user' || m.role === 'assistant'));
  const tail = turns.slice(-12).map(m => `**${m.role}:** ${m.text.length > 1500 ? m.text.slice(0, 1500) + '…' : m.text}`);
  const md = [
    `# Handoff: ${chat.title}`,
    `Continuing work from a **${chat.tool}** session.`,
    `- Folder: \`${chat.cwd || 'unknown'}\``,
    `- Full transcript (read it if you need more detail): \`${chat.source_path}\``,
    `- Started ${chat.started}, last activity ${chat.updated}`,
    '',
    `## First request`, turns.find(m => m.role === 'user')?.text.slice(0, 2000) || '(none)',
    '',
    `## Last ${tail.length} turns`, ...tail,
    '',
    'Please pick up where this left off. Check the central memory (agent-hub-memory MCP: project_context) for project facts.',
  ].join('\n');
  return { markdown: md };
}));

// ---- memory
app.get('/api/memories', wrap(req => memory.listMemories(req.query)));
app.post('/api/memories', wrap(req => memory.addMemory(req.body, 'hub')));
app.put('/api/memories/:id', wrap(req => memory.updateMemory(req.params.id, req.body, 'hub')));
app.delete('/api/memories/:id', wrap(req => ({ ok: memory.deleteMemory(req.params.id, 'hub') })));
app.post('/api/memories/import', wrap(() => memory.importClaudeMemories()));
app.get('/api/activity', wrap(() => memory.recentActivity(100)));

// ---- projects
app.get('/api/projects', wrap(() => projects.listProjects()));
app.get('/api/projects/detail', wrap(req => projects.projectDetail(String(req.query.path || ''))));
app.post('/api/launch', wrap(req => newSession(req.body.tool, req.body.cwd)));
app.get('/api/instructions/global', wrap(() => projects.GLOBAL_INSTRUCTIONS.map(g => ({ ...g, ...projects.readInstruction(g.path) }))));
app.get('/api/instructions', wrap(req => projects.readInstruction(String(req.query.path || ''))));
app.post('/api/instructions/preview', wrap(req => {
  const cur = projects.readInstruction(req.body.path);
  return { diff: lineDiff(cur.content, req.body.content) };
}));
app.put('/api/instructions', wrap(req => projects.writeInstruction(req.body.path, String(req.body.content ?? ''))));

// ---- config: MCP + skills
app.get('/api/mcp', wrap(() => mcp.readAll()));
app.post('/api/mcp/preview', wrap(req => mcp.preview(req.body.name, req.body.server || null, req.body.targets || [])));
app.post('/api/mcp/apply', wrap(req => mcp.apply(req.body.name, req.body.server || null, req.body.targets || [])));
app.get('/api/mcp/hub-server', wrap(() => ({
  name: 'agent-hub-memory',
  server: { type: 'stdio', command: process.execPath, args: ['--no-warnings', path.join(ROOT, 'mcp', 'memory-server.js')], env: {} },
})));
app.post('/api/skills/install/preview', wrap(req => skills.previewInstall(req.body)));
app.post('/api/skills/install', wrap(req => skills.installSkill(req.body)));
app.get('/api/skills', wrap(() => skills.listSkills()));
app.post('/api/skills/copy', wrap(req => skills.copySkill(req.body.folder, req.body.from, req.body.to)));

// ---- hub chats (direct chat, tool switching, council)
app.get('/api/threads', wrap(() => threads.listThreads()));
app.post('/api/threads', wrap(req => threads.createThread(req.body)));
app.post('/api/threads/:id/context/read', wrap(req => {const updates=readTaskUpdates(req.params.id, req.body.tool);threads.notifyContextRead(req.params.id);return updates;}));
app.post('/api/threads/:id/queue/:qid/details', wrap(req => threads.sendQueuedDetails(req.params.id,req.params.qid)));
app.get('/api/threads/:id', wrap(req => {
  const q = req.query, opts = {};
  if (q.limit !== undefined) opts.limit = q.limit;
  if (q.before !== undefined) opts.before = q.before;
  if (q.activity === 'lazy') opts.activity = 'lazy';
  return threads.getThread(req.params.id, opts);
}));
app.get('/api/threads/:id/messages', wrap(req => {
  const { before, after, limit, activity } = req.query;
  return threads.getMessages(req.params.id, { before, after, limit, activity: activity === 'lazy' ? 'lazy' : 'full' });
}));
app.get('/api/threads/:id/messages/:mid/activity', wrap(req => threads.getMessageActivity(req.params.id, req.params.mid)));
app.patch('/api/threads/:id', wrap(req => threads.updateThread(req.params.id, req.body)));
app.delete('/api/threads/:id', wrap(req => { threads.deleteThread(req.params.id); return { ok: true }; }));
app.post('/api/threads/:id/messages', wrap(req => threads.sendMessage(req.params.id, req.body.text, { executePlan: !!req.body.executePlan, mode: req.body.mode, requestId: req.body.requestId })));
app.delete('/api/threads/:id/queue/:qid', wrap(req => threads.removeQueued(req.params.id, req.params.qid)));
app.post('/api/threads/:id/queue/:qid/send', wrap(req => threads.sendQueuedNow(req.params.id, req.params.qid)));
app.get('/api/roles', wrap(() => threads.ROLES));
app.post('/api/threads/:id/stop', wrap(req => ({ ok: threads.stopThread(req.params.id) })));
app.post('/api/threads/:id/retry', wrap(req => threads.retryMessage(req.params.id, req.body.messageId)));
app.get('/api/threads/:id/export', (req, res) => {
  try {
    res.type('text/markdown').set('Content-Disposition', 'attachment; filename="agent-hub-chat.md"').send(threads.exportMarkdown(req.params.id));
  } catch (e) { res.status(404).send(e.message); }
});

mountExtra(app, wrap);

// ---- global search (Ctrl+K)
app.get('/api/search', wrap(req => {
  const q = String(req.query.q || '').trim();
  if (!q) return { chats: [], memories: [], threads: [], projects: [] };
  const db = getDb();
  const fq = ftsQuery(q);
  const like = `%${q.replace(/[%_]/g, '')}%`;
  return {
    chats: fq ? db.prepare(`SELECT c.id, c.tool, c.title, c.updated FROM chat_fts f JOIN chats c ON c.id = f.chat_id
      WHERE chat_fts MATCH ? ORDER BY bm25(chat_fts, 0, 5, 1) LIMIT 8`).all(fq) : [],
    memories: memory.listMemories({ q, limit: 6 }).map(m => ({ id: m.id, title: m.title, type: m.type })),
    threads: db.prepare('SELECT id, title, target, updated FROM threads WHERE title LIKE ? ORDER BY updated DESC LIMIT 6').all(like),
    projects: projects.listProjects().filter(p => p.path.toLowerCase().includes(q.toLowerCase())).slice(0, 6).map(p => ({ path: p.path, name: p.name, total: p.total })),
  };
}));
app.post('/api/chats/:id/continue', wrap(req => threads.threadFromChat(chatOr404(req.params.id))));
app.get('/api/threads/:id/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  req.socket.setNoDelay?.(true);
  // retry: tells EventSource to reconnect after 3 s; hello carries the latest seq so a reconnecting
  // client can fetch only what it missed (GET /api/threads/:id/messages?after=<seq>).
  // Subscribe before reading the cursor: anything emitted from here on is either streamed live or
  // already counted in lastSeq (clients upsert by message id, so overlap is harmless; gaps are not).
  res.write('retry: 3000\n: connected\n\n');
  const off = threads.onThreadEvent(req.params.id, e => res.write(`data: ${JSON.stringify(e)}\n\n`));
  let lastSeq = 0; try { lastSeq = threads.lastMessageSeq(req.params.id); } catch {}
  res.write(`data: ${JSON.stringify({ type: 'hello', lastSeq, at: Date.now() })}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => { off(); clearInterval(ping); });
});

app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

getDb();
threads.recoverStale();
syncService.markDeviceInterrupted().catch(() => {});
const server = app.listen(PORT, HOST, () => {
  console.log(`Conclave running at http://${HOST}:${PORT}`);
  runIndex().then(s => console.log(`Indexed: ${s.changed} changed in ${s.lastDurationMs} ms${s.errors.length ? `, ${s.errors.length} errors` : ''}`));
  // Background indexing re-parses changed CLI transcripts. While agents are working their transcripts
  // change constantly, so defer until idle, but never let the index go more than 3 minutes stale.
  let lastIndexAt = Date.now();
  setInterval(() => {
    const busy = threads.activeJobCount() > 0;
    if (busy && Date.now() - lastIndexAt < 180_000) { indexState.deferred = (indexState.deferred || 0) + 1; return; }
    lastIndexAt = Date.now();
    runIndex().then(s => { if (s.lastDurationMs > 1500) console.log(`Index pass took ${s.lastDurationMs} ms (${s.changed} changed)`); }).catch(() => {});
  }, 30_000);
});

// Event-loop delay diagnostics: log a summary when the loop stalls (stalls freeze live streams).
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
export const loopStats = { maxMs: 0, p99Ms: 0, meanMs: 0, stalls: 0, since: new Date().toISOString() };
setInterval(() => {
  const maxMs = Math.round(loopDelay.max / 1e6), p99Ms = Math.round(loopDelay.percentile(99) / 1e6);
  Object.assign(loopStats, { maxMs, p99Ms, meanMs: Math.round(loopDelay.mean / 1e6), at: new Date().toISOString() });
  if (maxMs > 200) { loopStats.stalls++; console.log(`Event loop stall: max ${maxMs} ms, p99 ${p99Ms} ms over the last minute (active jobs: ${threads.activeJobCount()})`); }
  loopDelay.reset();
}, 60_000).unref();
app.get('/api/health', (req, res) => res.json({ loop: loopStats, index: { lastRun: indexState.lastRun, lastDurationMs: indexState.lastDurationMs, deferred: indexState.deferred || 0 }, activeJobs: threads.activeJobCount() }));
attachTerminalWs(server, terminalService);
