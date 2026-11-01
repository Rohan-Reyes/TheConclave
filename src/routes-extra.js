// Files, usage and agent-connection routes.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { getDb, kvGet } from './db.js';
import { members, listAgents, saveAgent, deleteAgent, detectPresets, runTurn } from './agents/drivers.js';
import { AttachmentStore } from './attachments.js';
import { HOME } from './paths.js';
import * as approvals from './agents/approvals.js';
import * as threads from './agents/threads.js';
import { getModels, getLimits, refreshAntigravityQuota } from './agents/catalog.js';
import { creditStatus, clearExhausted } from './agents/failover.js';

const TEXT_EXT = /\.(md|markdown|txt|json|jsonl|js|mjs|cjs|ts|tsx|jsx|py|html?|css|scss|xml|ya?ml|toml|ini|cfg|conf|csv|tsv|sql|sh|ps1|bat|cmd|c|cc|cpp|h|hpp|cs|java|kt|go|rs|rb|php|lua|r|swift|vue|svelte|env\.example|gitignore|log)$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const MAX_TEXT = 512 * 1024;

function statFile(p) {
  const file = path.resolve(String(p || ''));
  let st;
  try { st = fs.statSync(file); } catch { throw Object.assign(new Error('File not found'), { status: 404 }); }
  return { file, st };
}

export function mountExtra(app, wrap) {
  // ---- uploads remain inside the selected project's canonical directory
  const attachments = new AttachmentStore({ getThread: threads.getThread });
  const incomingFiles = req => Array.isArray(req.body.files) ? req.body.files : [req.body];
  app.post('/api/threads/:id/attachments', wrap(req => attachments.upload({ threadId: req.params.id, cwd: req.body.cwd, files: incomingFiles(req) })));
  app.post('/api/attachments', wrap(req => attachments.upload({ threadId: req.body.threadId, cwd: req.body.cwd, files: incomingFiles(req) })));
  app.get('/api/threads/:id/attachments', wrap(req => attachments.list({ threadId: req.params.id })));
  // ---- file preview / open
  app.get('/api/file', wrap(req => {
    const { file, st } = statFile(req.query.path);
    if (st.isDirectory()) {
      const entries = fs.readdirSync(file, { withFileTypes: true }).slice(0, 300)
        .map(e => ({ name: e.name, dir: e.isDirectory() })).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
      return { path: file, kind: 'dir', entries };
    }
    const kind = IMG_EXT.test(file) ? 'image' : TEXT_EXT.test(file) || st.size < 64 * 1024 && !/\.(exe|dll|zip|7z|png|jpg|pdf|blend|mp4|mov|wav|mp3)$/i.test(file) ? 'text' : 'binary';
    const out = { path: file, kind, size: st.size, mtime: st.mtime.toISOString() };
    if (kind === 'text') {
      const buf = fs.readFileSync(file).subarray(0, MAX_TEXT);
      if (buf.includes(0)) out.kind = 'binary';
      else { out.text = buf.toString('utf8'); out.truncated = st.size > MAX_TEXT; }
    }
    return out;
  }));
  app.get('/api/file/raw', (req, res) => {
    try {
      const { file, st } = statFile(req.query.path);
      if (!st.isFile() || !IMG_EXT.test(file)) return res.status(400).send('Only images are served raw');
      res.sendFile(file, { headers: { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" } });
    } catch (e) { res.status(e.status || 400).send(e.message); }
  });
  app.post('/api/open', wrap(req => {
    const { file, st } = statFile(req.body.path);
    const how = req.body.with || 'default';
    if (how === 'code') {
      const exe = [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'), 'C:\\Program Files\\Microsoft VS Code\\Code.exe'].find(p => fs.existsSync(p));
      if (!exe) throw new Error('VS Code not found');
      spawn(exe, [file], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    }
    else if (how === 'folder') execFile('explorer.exe', st.isDirectory() ? [file] : [`/select,${file}`], () => {});
    else execFile('explorer.exe', [file], () => {});   // default app
    return { ok: true };
  }));

  // ---- usage
  app.get('/api/usage', wrap(req => {
    const days = Math.min(Number(req.query.days) || 30, 365);
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const db = getDb();
    // History: whole sessions, attributed to the day they started.
    const history = db.prepare(`SELECT tool, substr(COALESCE(NULLIF(started,''), updated), 1, 10) AS day,
        COUNT(*) AS sessions, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, SUM(cost_usd) AS cost
      FROM chats WHERE COALESCE(NULLIF(started,''), updated) >= ? GROUP BY tool, day ORDER BY day`).all(since);
    const totals = db.prepare(`SELECT tool, COUNT(*) AS sessions, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, SUM(cost_usd) AS cost
      FROM chats WHERE COALESCE(NULLIF(started,''), updated) >= ? GROUP BY tool`).all(since);
    const top = db.prepare(`SELECT id, tool, title, tokens_in AS tin, tokens_out AS tout, cost_usd AS cost, updated
      FROM chats WHERE COALESCE(NULLIF(started,''), updated) >= ? ORDER BY (tokens_in + tokens_out) DESC LIMIT 10`).all(since);
    // Conclave runs: per reply, measured live.
    const runs = db.prepare(`SELECT m.tool, m.usage, m.thread_id, t.title FROM thread_messages m JOIN threads t ON t.id = m.thread_id
      WHERE m.role = 'agent' AND m.created >= ?`).all(since);
    const conclave = {}, byThread = {};
    for (const r of runs) {
      const u = JSON.parse(r.usage || '{}');
      const a = (conclave[r.tool] ||= { replies: 0, tin: 0, tout: 0, cached: 0, cost: 0, ms: 0 });
      a.replies++; a.tin += u.input || 0; a.tout += u.output || 0; a.cached += u.cached || 0; a.cost += u.cost || 0; a.ms += u.ms || 0;
      const b = (byThread[r.thread_id] ||= { id: r.thread_id, title: r.title, replies: 0, tokens: 0, cost: 0, ms: 0 });
      b.replies++; b.tokens += (u.input || 0) + (u.output || 0) + (u.cached || 0); b.cost += u.cost || 0; b.ms += u.ms || 0;
    }
    return {
      days, history, totals, top, conclave,
      threads: Object.values(byThread).sort((a, b) => b.tokens - a.tokens).slice(0, 10),
      rateLimits: { claude: kvGet('ratelimit:claude') },
    };
  }));

  // ---- permission prompts (posted by the approval_prompt MCP tool)
  app.post('/api/approvals', wrap(req => {
    const { threadId, messageId, agent, toolName, input } = req.body;
    const t = threads.getThread(threadId);
    return approvals.createApproval({ threadId, messageId, agent, toolName, input }, t.settings.alwaysAllow || []);
  }));
  app.get('/api/approvals/:id', wrap(req => {
    const a = approvals.getApproval(req.params.id);
    if (!a) throw Object.assign(new Error('Request expired'), { status: 404 });
    return a;
  }));
  app.post('/api/approvals/:id', wrap(req => {
    const a = approvals.getApproval(req.params.id);
    if (!a) throw Object.assign(new Error('Request expired'), { status: 404 });
    if (req.body.always && req.body.decision === 'allowed') {
      const t = threads.getThread(a.threadId);
      threads.updateThread(a.threadId, { settings: { alwaysAllow: [...new Set([...(t.settings.alwaysAllow || []), a.toolName])] } });
    }
    return approvals.decide(a.id, req.body.decision === 'allowed' ? 'allowed' : 'denied', req.body.message || '');
  }));

  // ---- council plans (Run plan, pause, cancel, per-step retry / skip / reassign)
  app.get('/api/threads/:id/plans', wrap(req => threads.listPlans(req.params.id)));
  app.post('/api/threads/:id/plans/:planId/run', wrap(req => threads.runPlan(req.params.id, req.params.planId)));
  app.post('/api/threads/:id/plans/:planId/pause', wrap(req => threads.pausePlan(req.params.id, req.params.planId)));
  app.post('/api/threads/:id/plans/:planId/cancel', wrap(req => threads.cancelPlan(req.params.id, req.params.planId)));
  app.post('/api/threads/:id/plans/:planId/steps/:stepId/:action', wrap(req =>
    threads.stepAction(req.params.id, req.params.planId, req.params.stepId, req.params.action, req.body.agent)));

  // ---- questions agents ask the user (posted by the ask_user MCP tool, answered in the browser)
  app.post('/api/questions', wrap(req => {
    const { threadId, messageId, planId, stepId, agent, question, options, multi } = req.body;
    return threads.createQuestion({ threadId, messageId, planId, stepId, agent, question, options, multi, via: 'tool' });
  }));
  app.get('/api/questions/:id', wrap(req => {
    const q = threads.getQuestion(req.params.id);
    if (!q) throw Object.assign(new Error('Question not found'), { status: 404 });
    return q;
  }));
  app.post('/api/questions/:id/answer', wrap(req => threads.answerQuestion(req.params.id, req.body.answer)));

  // ---- per-reply diffs
  app.get('/api/threads/:id/messages/:mid/diff', wrap(req => threads.messageDiff(req.params.id, req.params.mid)));
  app.post('/api/threads/:id/messages/:mid/revert', wrap(req => threads.revertMessage(req.params.id, req.params.mid)));

  // ---- out-of-credits handling
  app.get('/api/credits', wrap(() => creditStatus(Object.keys(members()))));
  app.post('/api/credits/:tool/clear', wrap(req => { clearExhausted(req.params.tool); return { ok: true }; }));
  app.post('/api/threads/:id/resume-waiting', wrap(req => threads.resumeWaiting(req.params.id)));
  app.post('/api/threads/:id/cancel-waiting', wrap(req => { threads.cancelWaiting(req.params.id); return { ok: true }; }));

  // ---- models & plan limits
  app.get('/api/models', wrap(req => getModels(req.query.refresh === '1')));
  app.get('/api/limits', wrap(() => getLimits()));
  app.post('/api/limits/antigravity', wrap(() => refreshAntigravityQuota()));

  // ---- agents (members of Conclave chats)
  app.get('/api/members', wrap(() => Object.entries(members()).map(([id, m]) => ({ id, label: m.label, builtin: !!m.builtin }))));
  app.get('/api/agents', wrap(() => ({ agents: listAgents(), presets: detectPresets() })));
  app.post('/api/agents', wrap(req => saveAgent(req.body)));
  app.delete('/api/agents/:id', wrap(req => { deleteAgent(req.params.id); return { ok: true }; }));
  app.post('/api/agents/:id/test', wrap(async req => {
    const h = runTurn(req.params.id, { cwd: HOME, prompt: 'Reply with exactly: pong', permission: 'read', timeoutMin: 2 });
    const r = await h.promise;
    return { ok: !r.error && /pong/i.test(r.text), text: r.text.slice(0, 500), error: r.error };
  }));
}
