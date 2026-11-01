import { EventEmitter } from 'node:events';
import { getDb, now, newId } from '../db.js';
import fs from 'node:fs';
import path from 'node:path';
import { normPath, HOME } from '../paths.js';
import { runTurn, member, memberIds, isAgentAvailable } from './drivers.js';
import { snapshot, diffStat, diffText, revert } from './snapshot.js';
import { denyForMessage, approvalBus, listApprovals } from './approvals.js';
import { isQuotaError, isLaunchError, exhaustionSummary, markExhausted, outOfCredits, otherAgyBucket, fmtTime } from './failover.js';
import { getLimits } from './catalog.js';
import { kvGet, kvSet } from '../db.js';
import { loadTranscript } from '../indexer.js';
import { parsePlan, validatePlan, nextBatch, assign, PLAN_FORMAT } from './planner.js';
import { messageImages } from './images.js';

const BUILTIN_IDS = ['claude', 'antigravity', 'codex'];
const PROMPT_BUDGET = 24_000;      // chars of chat history per prompt (agy takes it as a CLI arg)
const MAX_RELAY_HOPS = 4;

const DEFAULT_SETTINGS = {
  permission: 'edit',              // access level: read | ask | edit | full
  approvalMode: 'auto',            // when a council plan runs: auto (right after the verdict) | risk (auto, but risky actions ask) | manual (Run plan)
  efforts: {},                     // optional per-tool reasoning effort
  alwaysAllow: [],                 // tool names auto-approved in this chat ("Always allow")
  councilPermission: 'read',       // council rounds only look; execution happens after
  members: [...BUILTIN_IDS],
  councilMode: 'debate',           // debate | build (one builds, the others review, builder fixes)
  rounds: 1,                       // debate rounds after the first answers
  chair: 'claude',                 // writes the debate verdict / is the builder in build mode
  autoRelay: true,                 // agents can hand work to each other with @mentions
  models: {},                      // optional per-tool model override
  timeoutMin: 20,
  shell: 'direct',                 // direct: agents run terminal commands freely | sandboxed: each tool's own limits
  stallMin: 4,                     // stop an agent that produces no output for this long (longer while a command runs)
  roles: {},                       // { claude: 'lead', codex: 'builder', ... }
  fallback: {                      // when an agent runs out of credits / hits a rate limit
    enabled: true,
    order: [...BUILTIN_IDS],       // who takes over, in order (custom agents can be added)
    otherModel: true,              // Antigravity: try its other quota bucket first
    waitForReset: true,            // if everyone is out, resume automatically after the earliest reset
  },
};

const bus = new EventEmitter();
bus.setMaxListeners(100);
const live = new Map();            // msgId -> { content, activity[] } while running
const running = new Map();         // threadId -> { handles:Set, cancelled }
const workspaceWriters = new Map(); // canonical folder -> promise tail (shared across chats)
const agentTurns = new Map();       // thread/tool -> promise tail (native session is exclusive)

function waitCancel(threadId) {
  const c = running.get(threadId);
  if (!c || c.cancelled) return Promise.resolve('cancelled');
  return new Promise(resolve => {
    c.onCancel.add(() => resolve('cancelled'));
  });
}

async function withAgentTurn(threadId, tool, fn) {
  const c = running.get(threadId);
  if (!c || c.cancelled) return null;
  const key = `${threadId}:${tool}`;
  const previous = agentTurns.get(key) || Promise.resolve();
  let release;
  const ticket = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => ticket);
  agentTurns.set(key, tail);
  const raced = await Promise.race([previous, waitCancel(threadId)]);
  try {
    if (raced === 'cancelled' || running.get(threadId) !== c || c.cancelled) return null;
    return await fn();
  } finally { release(); if (agentTurns.get(key) === tail) agentTurns.delete(key); }
}

async function withWorkspaceWriter(cwd, fn, threadId = null) {
  const c = threadId ? running.get(threadId) : null;
  if (threadId && (!c || c.cancelled)) return null;
  let key = path.resolve(cwd || HOME);
  try { key = fs.realpathSync(key); } catch {}
  if (process.platform === 'win32') key = key.toLowerCase();
  const previous = workspaceWriters.get(key) || Promise.resolve();
  let release;
  const ticket = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => ticket);
  workspaceWriters.set(key, tail);
  const raced = threadId ? await Promise.race([previous, waitCancel(threadId)]) : await previous;
  try {
    if (raced === 'cancelled' || (threadId && (running.get(threadId) !== c || c.cancelled))) return null;
    return await fn();
  } finally { release(); if (workspaceWriters.get(key) === tail) workspaceWriters.delete(key); }
}

function checkedSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Settings must be an object');
  for (const [key, values] of Object.entries({ permission: ['read', 'ask', 'edit', 'full'], approvalMode: ['auto', 'risk', 'manual'], shell: ['direct', 'sandboxed'], councilMode: ['debate', 'build'] })) {
    if (settings[key] !== undefined && !values.includes(settings[key])) throw new Error(`Invalid ${key}`);
  }
  if (settings.members !== undefined && (!Array.isArray(settings.members) || !settings.members.length || settings.members.some(m => !memberIds().includes(m)))) throw new Error('Invalid council members');
  if (settings.chair !== undefined && !memberIds().includes(settings.chair)) throw new Error('Unknown lead');
  if (settings.roles !== undefined && (!settings.roles || typeof settings.roles !== 'object' || Object.values(settings.roles).some(r => !Object.hasOwn(ROLES, r)))) throw new Error('Invalid team role');
  return settings;
}

approvalBus.on('change', a => emit(a.threadId, 'approval', { approval: a }));
export const onThreadEvent = (threadId, fn) => { const h = e => e.threadId === threadId && fn(e); bus.on('ev', h); return () => bus.off('ev', h); };
const emit = (threadId, type, data) => bus.emit('ev', { threadId, type, ...data });

// ---------- storage
const rowToThread = t => t && ({ ...t, settings: { ...DEFAULT_SETTINGS, ...JSON.parse(t.settings || '{}') }, running: running.has(t.id) });
const rowToMsg = m => {
  const l = live.get(m.id);
  return {
    ...m, content: l ? l.content : m.content, activity: l ? l.activity : JSON.parse(m.activity || '[]'),
    phase: l ? l.phase || null : null,
    files: l ? l.files : JSON.parse(m.files || '[]'), usage: JSON.parse(m.usage || '{}'),
    changes: m.snap ? { ...JSON.parse(m.snap).stat, reverted: !!JSON.parse(m.snap).reverted } : null, snap: undefined,
  };
};

// Paths an agent mentions in its reply that exist on disk (covers tools whose
// stream doesn't report file edits).
function filesMentioned(text, cwd) {
  const out = [];
  const seen = new Set();
  // Candidates: anything in `backticks`, and absolute Windows paths.
  for (let raw of String(text || '').match(/`[^`\n]{2,260}`|[A-Za-z]:[\\/][^\s"'`<>|*?]+/g) || []) {
    raw = raw.replace(/^`|`$/g, '').replace(/[.,;)]+$/, '').replace(/:\d+(?::\d+)?$/, '').trim();
    if (!/\.[A-Za-z0-9]{1,8}$/.test(raw) || /^https?:/i.test(raw) || /[\n{}=<>|]/.test(raw)) continue;
    const p = path.isAbsolute(raw) ? raw : path.join(cwd || HOME, raw);
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    try { if (fs.statSync(p).isFile()) out.push({ path: p, action: 'mentioned' }); } catch {}
    if (out.length >= 20) break;
  }
  return out;
}

export function listThreads() {
  return getDb().prepare(`SELECT t.*, (SELECT COUNT(*) FROM thread_messages m WHERE m.thread_id = t.id) AS n
    FROM threads t ORDER BY updated DESC`).all().map(rowToThread);
}
export function getThread(id) {
  const t = rowToThread(getDb().prepare('SELECT * FROM threads WHERE id = ?').get(id));
  if (!t) throw Object.assign(new Error('chat not found'), { status: 404 });
  t.messages = getDb().prepare('SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY seq').all(id).map(rowToMsg);
  t.sessions = getDb().prepare('SELECT tool, native_id FROM thread_sessions WHERE thread_id = ?').all(id);
  t.approvals = listApprovals(id);
  t.plans = listPlans(id);
  t.questions = listQuestions(id);
  t.waiting = waitingInfo(id);
  t.queue = getQueue(id);
  t.team = activeMembers(t).map(m => ({ id: m, role: roleOf(t, m) }));
  t.credits = Object.fromEntries(memberIds().map(m => [m, outOfCredits(m)]));
  return t;
}
// Chats started without a folder get their own under ~/Conclave.
export const QUICK_ROOT = path.join(HOME, 'Conclave');
export function createThread({ title, cwd, target = 'claude', settings = {} } = {}) {
  checkedSettings(settings);
  const id = newId();
  if (!cwd || !String(cwd).trim()) {
    const day = new Date().toISOString().slice(0, 10);
    cwd = path.join(QUICK_ROOT, `${day}-${id.slice(0, 6)}`);
    settings = { ...settings, quick: true };
  }
  getDb().prepare('INSERT INTO threads (id, title, cwd, target, settings, created, updated) VALUES (?,?,?,?,?,?,?)')
    .run(id, title || 'New chat', normPath(cwd || HOME), validTarget(target), JSON.stringify(settings), now(), now());
  return getThread(id);
}
export function updateThread(id, patch) {
  const t = getThread(id);
  const title = patch.title ?? t.title;
  const cwd = patch.cwd !== undefined ? normPath(patch.cwd) : t.cwd;
  const target = patch.target ? validTarget(patch.target) : t.target;
  const settings = { ...t.settings, ...checkedSettings(patch.settings || {}) };
  if (running.has(id) && cwd !== t.cwd) throw new Error('Wait for the agents to finish before changing the folder');
  getDb().prepare('UPDATE threads SET title=?, cwd=?, target=?, settings=?, updated=? WHERE id=?')
    .run(title, cwd, target, JSON.stringify(settings), now(), id);
  emit(id, 'thread', {});
  return getThread(id);
}
export function deleteThread(id) {
  stopThread(id);
  getDb().prepare('DELETE FROM threads WHERE id = ?').run(id);
}
function validTarget(t) { return t === 'council' || memberIds().includes(t) ? t : 'claude'; }

function addMessage(threadId, { role, tool = null, round = null, content = '', status = 'done' }) {
  const id = newId();
  getDb().prepare('INSERT INTO thread_messages (id, thread_id, role, tool, round, content, status, created) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, threadId, role, tool, round, content, status, now());
  getDb().prepare('UPDATE threads SET updated = ? WHERE id = ?').run(now(), threadId);
  const m = rowToMsg(getDb().prepare('SELECT * FROM thread_messages WHERE id = ?').get(id));
  emit(threadId, 'message', { message: m });
  return m;
}
function finishMessage(m, { content, activity, status, error, files = [], usage = {}, snap = null }) {
  getDb().prepare('UPDATE thread_messages SET content=?, activity=?, status=?, error=?, finished=?, files=?, usage=?, snap=? WHERE id=?')
    .run(content, JSON.stringify(activity.slice(-200)), status, error || null, now(), JSON.stringify(files.slice(0, 50)), JSON.stringify(usage), snap ? JSON.stringify(snap) : null, m.id);
  live.delete(m.id);
  const out = rowToMsg(getDb().prepare('SELECT * FROM thread_messages WHERE id = ?').get(m.id));
  emit(m.thread_id, 'message', { message: out });
  return out;
}
function session(threadId, tool) {
  return getDb().prepare('SELECT * FROM thread_sessions WHERE thread_id = ? AND tool = ?').get(threadId, tool)
    || { thread_id: threadId, tool, native_id: null, last_seen_seq: 0 };
}
function saveSession(threadId, tool, nativeId, lastSeen) {
  getDb().prepare(`INSERT INTO thread_sessions (thread_id, tool, native_id, last_seen_seq) VALUES (?,?,?,?)
    ON CONFLICT(thread_id, tool) DO UPDATE SET native_id = excluded.native_id, last_seen_seq = MAX(last_seen_seq, excluded.last_seen_seq)`)
    .run(threadId, tool, nativeId, lastSeen);
}

// ---------- prompts
const speaker = m => m.role === 'user' ? 'User' : m.role === 'system' ? 'Conclave' : member(m.tool).label || m.tool;

function formatMessages(msgs, budget) {
  const parts = [];
  let used = 0, omitted = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    let body = m.content || (m.error ? `(failed: ${m.error})` : '');
    if (body.length > 8000) body = body.slice(0, 8000) + '\n…(truncated)';
    const block = `[${speaker(m)}${m.round && m.round !== 'relay' ? ` · ${m.round}` : ''}]:\n${body}`;
    if (used + block.length > budget && parts.length) { omitted = i + 1; break; }
    parts.unshift(block); used += block.length;
  }
  return (omitted ? `(${omitted} earlier messages omitted)\n\n` : '') + parts.join('\n\n');
}

// ---------- roles and team status
export const ROLES = {
  lead: { label: 'Team lead', desc: 'plans the work, splits it fairly, writes the verdict, and makes the final call' },
  builder: { label: 'Builder', desc: 'implements features and edits code' },
  reviewer: { label: 'Reviewer', desc: 'reviews changes for bugs, risks and missed requirements; edits only when asked' },
  tester: { label: 'Tester', desc: 'writes and runs tests, reproduces bugs, checks the result really works' },
  researcher: { label: 'Researcher', desc: 'investigates docs, APIs and options, and reports findings' },
  designer: { label: 'Designer', desc: 'owns UI/UX, layout and visual polish' },
  member: { label: 'Member', desc: 'general contributor' },
  bench: { label: 'Benched', desc: 'not taking part right now' },
};
const roleOf = (thread, tool) => thread.settings.roles?.[tool] || (tool === thread.settings.chair ? 'lead' : 'member');
const activeMembers = thread => thread.settings.members.filter(t => memberIds().includes(t) && roleOf(thread, t) !== 'bench' && isAgentAvailable(t));
function leadOf(thread, members) {
  const r = thread.settings.roles || {};
  const lead = members.find(m => r[m] === 'lead') || thread.settings.chair;
  return [lead, ...members].find(t => members.includes(t) && !outOfCredits(t)) || members[0];
}

// Highest share of any short-term limit used, 0-100 (null = unknown).
function usedPct(tool, L) {
  try {
    if (tool === 'claude' && L.claude) return Math.round(Math.max(0, ...Object.values(L.claude.unifiedWindows || {}).map(w => (w.utilization || 0) * 100)));
    if (tool === 'codex' && L.codex) return Math.round(Math.max(0, ...[L.codex.primary, L.codex.secondary].filter(Boolean).map(w => w.usedPct || 0)));
    if (tool === 'antigravity' && L.antigravity) return Math.round(Math.max(0, ...L.antigravity.groups.flatMap(g => g.windows.map(w => 100 - w.remainingPct))));
  } catch {}
  return null;
}
function usageLine(tool, L) {
  const out = outOfCredits(tool);
  if (out) return `OUT OF CREDITS until ${fmtTime(out.until)}`;
  const pct = x => `${Math.round(x)}%`;
  if (tool === 'claude' && L.claude) {
    const w = L.claude.unifiedWindows || {};
    return [w.five_hour && `5-hour ${pct(w.five_hour.utilization * 100)} used`, w.seven_day && `weekly ${pct(w.seven_day.utilization * 100)} used`].filter(Boolean).join(', ') || 'limits unknown';
  }
  if (tool === 'codex' && L.codex) return [L.codex.primary && `5-hour ${pct(L.codex.primary.usedPct)} used`, L.codex.secondary && `weekly ${pct(L.codex.secondary.usedPct)} used`].filter(Boolean).join(', ');
  if (tool === 'antigravity' && L.antigravity) return L.antigravity.groups.map(g => `${g.name.toLowerCase()}: ${g.windows.map(w => `${w.window} ${pct(100 - w.remainingPct)} used`).join(', ')}`).join('; ');
  return 'limits unknown';
}
export function teamStatus(thread) {
  let L = {};
  try { L = getLimits(); } catch {}
  return activeMembers(thread).map(t => `- ${member(t).label} (@${t}): ${ROLES[roleOf(thread, t)]?.label || 'Member'} · ${usageLine(t, L)}`).join('\n');
}
// Planner balancing: prefer agents with headroom and a matching role.
function stepPenalty(thread, L) {
  return (m, step) => {
    const used = usedPct(m, L) ?? 30;
    const role = roleOf(thread, m);
    let p = used / 20 + (used >= 85 ? 6 : 0);
    if (step?.kind === 'build' && ['reviewer', 'tester', 'researcher'].includes(role)) p += 3;
    if (step?.kind === 'read' && role === 'builder') p += 1;
    if (step?.kind === 'read' && ['reviewer', 'tester', 'researcher'].includes(role)) p -= 1;
    return p;
  };
}

function preamble(thread, tool) {
  const others = thread.settings.members.filter(t => t !== tool);
  return [
    `You are ${member(tool).label}, taking part in a chat inside Conclave, a local app where the user works with several coding agents in one conversation.`,
    `Other agents who may appear in this chat: ${memberIds().filter(t => t !== tool).map(t => `${member(t).label} (@${t})`).join(', ')}. Messages are labelled with the speaker, e.g. [User] or [Codex].`,
    `Working folder: ${thread.cwd}`,
    `Your role in this team: ${ROLES[roleOf(thread, tool)]?.label || 'Member'}: you ${ROLES[roleOf(thread, tool)]?.desc || 'contribute generally'}.`,
    thread.settings.shell === 'direct' && thread.settings.permission !== 'read' ? 'You have direct terminal access: run shell commands (build, test, git, npm, etc.) yourself when useful.' : '',
    'Reply only as yourself. Never write replies on behalf of the other agents.',
    thread.settings.autoRelay && others.length
      ? `If another agent should do part of the work (e.g. review, test, or a task they are better at), end your reply with a line that starts with their handle, like "@${others[0]} please review the change in app.js". The hub delivers it. Use this only when it helps.`
      : '',
    'Shared memory: you have the agent-hub-memory MCP tools (memory_search, project_context, memory_add). Check them for context the user saved with any tool, and save durable facts worth sharing with the other agents.',
    'If you truly need a decision from the user to continue, call the agent-hub-memory tool ask_user (it waits for the answer). If you cannot call tools, end your reply with a fenced ```conclave-question block containing {"question": "...", "options": ["...", "..."]}. Otherwise make a sensible choice and say what you assumed.',
  ].filter(Boolean).join('\n');
}

function buildPrompt(thread, tool, instruction) {
  const s = session(thread.id, tool);
  const all = getDb().prepare("SELECT * FROM thread_messages WHERE thread_id = ? AND status != 'running' ORDER BY seq").all(thread.id);
  const maxSeq = all.length ? all[all.length - 1].seq : 0;
  const fresh = !s.native_id;
  const unseen = all.filter(m => m.seq > s.last_seen_seq && !(m.role === 'agent' && m.tool === tool));
  const parts = [];
  if (fresh) {
    parts.push(preamble(thread, tool));
    const history = all.filter(m => !(m.role === 'agent' && m.tool === tool && m.round === 'imported'));
    parts.push('--- Conversation so far ---\n' + (formatMessages(history, PROMPT_BUDGET) || '(empty)'));
  } else {
    parts.push('--- New messages in the Conclave chat since your last reply ---\n' + (formatMessages(unseen, PROMPT_BUDGET) || '(none)'));
  }
  if (activeMembers(thread).length > 1) parts.push('--- Team (roles and current usage limits; plan around them) ---\n' + teamStatus(thread));
  if (instruction) parts.push('--- Your task now ---\n' + instruction);
  else parts.push('Reply to the latest message addressed to you.');
  return { prompt: parts.join('\n\n'), maxSeq, nativeId: s.native_id };
}

// ---------- running agents
function ctrl(threadId) {
  if (!running.has(threadId)) {
    running.set(threadId, { handles: new Set(), onCancel: new Set(), cancelled: false, userStopped: false, replacing: false });
    emit(threadId, 'thread', {});
  }
  return running.get(threadId);
}
const isCancelled = threadId => {
  const c = running.get(threadId);
  return !c || c.cancelled;
};

async function runAgentOnce(thread, tool, opts = {}) {
  // Always take the session lock before the workspace lock. A read task and a
  // build task can be scheduled together, but cannot resume one native session
  // simultaneously. Different tools can still perform independent reads.
  return withAgentTurn(thread.id, tool, () => {
    // Recheck after waiting, since access may have been tightened meanwhile.
    const current = getThread(thread.id);
    const currentOpts = current.settings.permission === 'read' ? { ...opts, permission: 'read' } : opts;
    const permission = currentOpts.permission || current.settings.permission;
    if (permission === 'read') return runAgentUnlocked(current, tool, currentOpts);
    return withWorkspaceWriter(current.cwd, () => runAgentUnlocked(current, tool, currentOpts), current.id);
  });
}

async function runAgentUnlocked(thread, tool, { instruction, round = null, permission, modelOverride, stepRef } = {}) {
  const c = running.get(thread.id);
  if (!c || c.cancelled) return null;
  // A fallback can ask the user before its reply finishes. Publish its task
  // ownership before launching it so ask_user validates the active agent.
  if (stepRef) {
    const plan = getPlan(stepRef.planId);
    if (!plan || ['cancelled', 'superseded', 'paused'].includes(plan.status)) return null;
    patchStep(stepRef.planId, stepRef.stepId, { assignee: tool });
  }
  const msg = addMessage(thread.id, { role: 'agent', tool, round, status: 'running' });
  const state = { content: '', activity: [], files: [] };
  live.set(msg.id, state);
  try {
    const currentAccess = getThread(thread.id).settings.permission;
    const perm = currentAccess === 'read' ? 'read' : permission || currentAccess;
    // Quick chats get their own folder, created on first use.
    if (thread.cwd && !fs.existsSync(thread.cwd) && thread.settings.quick) fs.mkdirSync(thread.cwd, { recursive: true });
    // Snapshot the folder so this reply's changes can be shown and undone.
    const before = perm !== 'read' ? await snapshot(thread.cwd).catch(() => null) : null;
    if (c.cancelled) {
      denyForMessage(msg.id);
      return finishMessage(msg, { content: state.content, activity: state.activity, status: 'stopped', error: 'Stopped', files: state.files, usage: {} });
    }
    let attempt = buildPrompt(thread, tool, instruction);
    const isWaiting = () =>
      listApprovals(thread.id).some(a => a.messageId === msg.id) ||
      listQuestions(thread.id).some(q => q.message_id === msg.id && q.via === 'tool');
    const exec = (p, nativeId) => {
      if (c.cancelled) return Promise.resolve({ text: '', sessionId: null, error: 'Stopped', files: [], usage: {} });
      const h = runTurn(tool, {
        cwd: thread.cwd, prompt: p, nativeId, permission: perm,
        images: tool === 'codex' ? messageImages(getThread(thread.id).messages.filter(m => m.role === 'user').at(-1)?.content, thread.cwd) : [],
        shell: thread.settings.shell, stallMin: thread.settings.stallMin, isWaiting,
        model: modelOverride || thread.settings.models?.[tool], effort: thread.settings.efforts?.[tool], timeoutMin: thread.settings.timeoutMin,
        env: { CONCLAVE_THREAD: thread.id, CONCLAVE_MESSAGE: msg.id, CONCLAVE_AGENT: tool, CONCLAVE_PLAN: stepRef?.planId || '', CONCLAVE_STEP: stepRef?.stepId || '' },
      }, e => {
        if (e.type === 'delta') { state.content += e.text; emit(thread.id, 'delta', { id: msg.id, text: e.text }); }
        else if (e.type === 'activity') { state.activity.push(e.text); emit(thread.id, 'activity', { id: msg.id, text: e.text }); }
        else if (e.type === 'session' && e.id) saveSession(thread.id, tool, e.id, 0);
        else if (e.type === 'phase') { if (state.phase !== e.phase) { state.phase = e.phase; emit(thread.id, 'phase', { id: msg.id, phase: e.phase }); } }
        else if (e.type === 'file') {
          if (!state.files.some(f => f.path.toLowerCase() === e.path.toLowerCase())) state.files.push({ path: e.path, action: e.action });
          emit(thread.id, 'file', { id: msg.id, path: e.path, action: e.action });
        }
      });
      c.handles.add(h);
      if (c.cancelled) h.stop();
      return h.promise.finally(() => c.handles.delete(h));
    };
    let r = await exec(attempt.prompt, attempt.nativeId);
    // A resumed session can disappear (deleted, or made by another app). Start fresh once.
    if (r.error && !r.text && attempt.nativeId && !c.cancelled && r.error !== 'Stopped') {
      getDb().prepare('UPDATE thread_sessions SET native_id = NULL WHERE thread_id = ? AND tool = ?').run(thread.id, tool);
      state.content = ''; state.activity.push('(could not resume the earlier session; starting a fresh one with the chat history)');
      attempt = buildPrompt(thread, tool, instruction);
      r = await exec(attempt.prompt, null);
    }
    if (r.sessionId) saveSession(thread.id, tool, r.sessionId, attempt.maxSeq);
    const status = (r.error === 'Stopped' || (c.cancelled && r.error)) ? 'stopped' : r.error ? 'error' : 'done';
    const content = r.text || state.content;
    const files = [...state.files];
    for (const f of filesMentioned(content, thread.cwd)) if (!files.some(x => x.path.toLowerCase() === f.path.toLowerCase())) files.push(f);
    const usage = { ...(r.usage || {}), ms: Date.now() - new Date(msg.created).getTime() };
    delete usage.type;
    denyForMessage(msg.id);
    let snap = null;
    if (before && (!c.cancelled || state.files.length)) {
      const after = await snapshot(thread.cwd).catch(() => null);
      if (after && after.tree !== before.tree) {
        const stat = await diffStat(before, before.tree, after.tree).catch(() => null);
        if (stat?.files) snap = { mode: before.mode, root: before.root, gitDir: before.gitDir, before: before.tree, after: after.tree, stat };
      }
    }
    return finishMessage(msg, { content, activity: state.activity, status, error: r.error, files, usage, snap });
  } catch (err) {
    denyForMessage(msg.id);
    return finishMessage(msg, {
      content: state.content, activity: state.activity,
      status: c.cancelled ? 'stopped' : 'error',
      error: c.cancelled ? 'Stopped' : (err?.message || String(err)),
      files: state.files, usage: {},
    });
  }
}

// ---------- failover: when an agent is out of credits, hand the turn to the next one
const fb = thread => ({ ...DEFAULT_SETTINGS.fallback, ...(thread.settings.fallback || {}) });

async function runAgent(thread, tool, opts = {}) {
  const f = fb(thread);
  if (!f.enabled) return runAgentOnce(thread, tool, opts);
  const exclude = new Set(opts.exclude || []);
  const order = [tool, ...f.order.filter(t => t !== tool && !exclude.has(t) && memberIds().includes(t))];
  const outNotes = [];
  for (const cand of order) {
    if (isCancelled(thread.id)) return null;
    const out = outOfCredits(cand);
    if (out) { outNotes.push(`${member(cand).label} is out until ${fmtTime(out.until)}`); continue; }
    if (cand !== tool) addMessage(thread.id, { role: 'system', content: `${outNotes.join('; ')}. ${member(cand).label} is taking over.` });
    const candidateOpts = cand === tool ? opts : { ...opts, instruction: `${opts.instruction || ''}\n\nYou are taking over an interrupted task. Inspect the current files and diff before editing, preserve valid partial work, and complete the remaining work.` };
    let reply = await runAgentOnce(thread, cand, candidateOpts);
    if (reply?.status === 'error' && /^Stalled/.test(reply.error || '')) {
      outNotes.push(`${member(cand).label} stalled (no output)`);
      continue;
    }
    if (reply?.status === 'error' && isLaunchError(reply.error)) {
      outNotes.push(`${member(cand).label} failed to start (${reply.error})`);
      continue;
    }
    if (!reply || reply.status !== 'error' || !isQuotaError(reply.error)) return reply;
    // Antigravity: Gemini and Claude/GPT models have separate quotas. Try the other bucket once.
    if (cand === 'antigravity' && f.otherModel) {
      const alt = otherAgyBucket(thread.settings.models?.antigravity);
      addMessage(thread.id, { role: 'system', content: `Antigravity's current model is out of quota. Trying ${alt}.` });
      reply = await runAgentOnce(thread, cand, { ...opts, modelOverride: alt });
      if (!reply || reply.status !== 'error' || !isQuotaError(reply.error)) return reply;
    }
    const until = markExhausted(cand, reply.error);
    outNotes.push(`${member(cand).label} ran out of credits (back ${fmtTime(until)})`);
  }
  if (isCancelled(thread.id)) return null;
  // Everyone in the fallback order was exhausted or failed.
  const allExhausted = order.length > 0 && order.every(t => !!outOfCredits(t));
  const soonest = order.map(t => outOfCredits(t)?.until).filter(Boolean).sort((a, b) => a - b)[0];
  const msg = exhaustionSummary(allExhausted, outNotes);
  if (f.waitForReset && soonest && !opts.exclude?.length) {
    kvSet(`waiting:${thread.id}`, { until: soonest + 60_000, tool, round: opts.round || null });
    addMessage(thread.id, { role: 'system', content: `${msg} I'll continue automatically at ${fmtTime(soonest + 60_000)}. You can also retry now or cancel.` });
  } else {
    addMessage(thread.id, { role: 'system', content: `${msg} Add a local agent (Ollama) in Config → Agents to keep working offline.` });
  }
  return null;
}

// Resume chats that were waiting for credits to come back.
export function waitingInfo(threadId) { return kvGet(`waiting:${threadId}`)?.value || null; }
export function cancelWaiting(threadId) { getDb().prepare('DELETE FROM kv WHERE k = ?').run(`waiting:${threadId}`); emit(threadId, 'thread', {}); }
export function resumeWaiting(threadId) {
  const w = waitingInfo(threadId);
  cancelWaiting(threadId);
  if (running.has(threadId)) return { ok: false };
  const thread = getThread(threadId);
  const tool = w?.tool || (thread.target === 'council' ? thread.settings.chair : thread.target);
  startJob(threadId, () => runAgent(thread, tool, { instruction: 'Earlier attempts stopped because agents ran out of credits. Please answer the latest request now.' }));
  return { ok: true };
}
setInterval(() => {
  try {
    for (const r of getDb().prepare("SELECT k, v FROM kv WHERE k LIKE 'waiting:%'").all()) {
      const w = JSON.parse(r.v);
      if (w.until <= Date.now()) resumeWaiting(r.k.slice(8));
    }
  } catch {}
}, 60_000).unref();

// Lines like "@codex please review" at the start of a line hand work to that agent.
function mentionsIn(text, self, members) {
  const found = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^@([\w.-]+)\b/);
    if (!m) continue;
    const tool = memberIds().find(t => member(t).mention.includes(m[1].toLowerCase()));
    if (tool && tool !== self && members.includes(tool) && !found.includes(tool)) found.push(tool);
  }
  return found;
}

// Who should answer a user message: @mentions win, otherwise the thread's target.
function routeUserMessage(text, thread) {
  const m = String(text).match(/@([\w.-]+)/g) || [];
  const names = m.map(x => x.slice(1).toLowerCase());
  if (names.some(n => n === 'all' || n === 'council')) return { council: true };
  const tools = [...new Set(names.map(n => memberIds().find(t => member(t).mention.includes(n))).filter(Boolean))];
  if (tools.length) return { tools };
  return thread.target === 'council' ? { council: true } : { tools: [thread.target] };
}

async function runDirect(thread, tools) {
  const queue = tools.map(t => ({ tool: t, round: null }));
  let hops = 0;
  while (queue.length && !isCancelled(thread.id)) {
    const { tool, round } = queue.shift();
    const reply = await runAgent(thread, tool, { round });
    if (reply?.status === 'done') questionFromBlock(thread, reply, {});
    if (!reply || reply.status !== 'done' || !thread.settings.autoRelay) continue;
    for (const next of mentionsIn(reply.content, tool, memberIds())) {
      if (hops >= MAX_RELAY_HOPS) { addMessage(thread.id, { role: 'system', content: `Stopped automatic hand-offs after ${MAX_RELAY_HOPS} hops. Reply to continue.` }); queue.length = 0; break; }
      hops++;
      queue.push({ tool: next, round: 'relay' });
    }
  }
}

async function runCouncil(thread) {
  const members = activeMembers(thread);
  if (!members.length) return;
  const perm = thread.settings.councilPermission;
  const c = running.get(thread.id);
  if (!c || c.cancelled) return;
  const names = members.map(t => member(t).label).join(', ');
  await Promise.all(members.map(t => runAgent(thread, t, {
    round: 'council-1', permission: perm, exclude: members,
    instruction: `COUNCIL ROUND 1 (members: ${names}). Give your own independent answer to the user's latest request. You may inspect files, but do not change anything yet. Be specific and concise; the other members will review your answer.`,
  })));
  for (let r = 2; r <= 1 + Number(thread.settings.rounds || 0); r++) {
    if (c.cancelled) return;
    await Promise.all(members.map(t => runAgent(thread, t, {
      round: `council-${r}`, permission: perm, exclude: members,
      instruction: `COUNCIL ROUND ${r}. Read the other members' latest answers above. Say where you agree, point out mistakes or risks in their answers (or your own), then give your improved answer. Keep it short; do not repeat what everyone already agrees on.`,
    })));
  }
  if (c.cancelled) return;
  const chair = leadOf(thread, members);
  const mode = thread.settings.approvalMode;
  const verdict = await runAgent(thread, chair, {
    round: 'synthesis', permission: perm,
    instruction: `You chair this council. Write the council's FINAL answer for the user: the agreed solution, any remaining disagreement (and who holds which view), and if work is needed, a concrete step-by-step plan saying which member should do each step. Assign steps by ROLE (builders build, reviewers/testers check, researchers investigate, the designer owns UI) and by remaining USAGE LIMITS shown in the team status: give heavier steps to agents with more headroom, keep anyone above ~80% of a limit to small steps, and never assign agents that are out of credits. Keep steps that edit the same files in order. Do not do the work yet: ${mode === 'manual' ? 'the user will click Run plan.' : 'Conclave will start the plan automatically after your verdict.'}\n\n${PLAN_FORMAT.replace('MEMBERS', members.map(m => `"${m}"`).join(', '))}`,
  });
  if (verdict?.status === 'done') await planFromVerdict(thread, verdict, chair, members);
}

// Build & review: the chair builds, everyone else reviews, the chair fixes once.
async function runBuildReview(thread) {
  const members = activeMembers(thread);
  const builder = members.find(t => roleOf(thread, t) === 'builder' && !outOfCredits(t)) || leadOf(thread, members);
  const checkers = members.filter(t => t !== builder && ['reviewer', 'tester'].includes(roleOf(thread, t)));
  const reviewers = checkers.length ? checkers : members.filter(t => t !== builder);
  const c = running.get(thread.id);
  if (!c || c.cancelled) return;
  const built = await runAgent(thread, builder, {
    round: 'build',
    instruction: `BUILD STEP. You are the builder. Do the user's latest request now in the working folder. When done, summarise exactly what you changed (files and why) so the reviewers (${reviewers.map(t => member(t).label).join(', ') || 'none'}) can check it.`,
  });
  if (!built || built.status !== 'done' || !reviewers.length || c.cancelled) return;
  const reviews = await Promise.all(reviewers.map(t => runAgent(thread, t, {
    round: 'review', permission: 'read', exclude: members,
    instruction: `REVIEW STEP. ${member(builder).label} just made changes for the user's request (summary above). Inspect the actual files/diff in the working folder. List concrete problems (bugs, missed requirements, risks) with file and line where possible. If everything is fine, reply with "LGTM" and one sentence. Do not edit files.`,
  })));
  if (c.cancelled) return;
  const issues = reviews.filter(r => r && r.status === 'done' && !/^\W*LGTM\b/i.test(r.content.trim()));
  if (!issues.length) { addMessage(thread.id, { role: 'system', content: 'All reviewers approved the change.' }); return; }
  await runAgent(thread, builder, {
    round: 'fix',
    instruction: 'FIX STEP. Read the reviews above. Fix the valid problems, explain briefly why you skipped any you disagree with, and summarise the final state.',
  });
}

export function retryMessage(threadId, messageId) {
  const thread = getThread(threadId);
  if (running.has(threadId)) throw new Error('Agents are still working in this chat.');
  const m = thread.messages.find(x => x.id === messageId);
  if (!m || m.role !== 'agent') throw new Error('Only agent replies can be retried');
  startJob(threadId, () => runAgent(thread, m.tool, { round: m.round === 'review' ? 'review' : null, instruction: 'Your previous attempt at this reply failed or was stopped. Please answer the latest request again.' }));
  return { ok: true };
}

// Editing a prompt starts a new branch of the conversation. File changes from
// the old replies are preserved; use their diffs/Revert before editing if needed.
export async function editLastUserMessage(threadId, messageId, text) {
  const thread = getThread(threadId);
  if (running.has(threadId)) throw Object.assign(new Error('Wait for the agents to finish before editing'), { status: 409 });
  const last = thread.messages.filter(m => m.role === 'user').at(-1);
  if (!last || last.id !== messageId) throw Object.assign(new Error('Only the latest user message can be edited'), { status: 409 });
  text = String(text || '').trim();
  if (!text) throw new Error('Message is empty');
  const db = getDb();
  // Keep old replies and their diff records for audit, but clearly supersede
  // them and discard native sessions so agents receive the revised transcript.
  db.prepare('UPDATE thread_messages SET content = ? WHERE id = ?').run(text, messageId);
  db.prepare('DELETE FROM thread_sessions WHERE thread_id = ?').run(threadId);
  for (const p of listPlans(threadId).filter(p => ['proposed', 'paused', 'failed', 'invalid'].includes(p.status))) {
    patchPlan(p.id, p => { p.status = 'superseded'; });
    expirePlanQuestions(p.id);
  }
  emit(threadId, 'message', { message: rowToMsg(db.prepare('SELECT * FROM thread_messages WHERE id = ?').get(messageId)) });
  addMessage(threadId, { role: 'system', content: 'The latest user message was edited. Earlier replies and file changes are retained; respond to the revised request.' });
  const revised = getThread(threadId);
  const route = routeUserMessage(text, revised);
  startJob(threadId, () => route.council ? (revised.settings.councilMode === 'build' ? runBuildReview(revised) : runCouncil(revised)) : runDirect(revised, route.tools));
  return { ok: true, route };
}

export function exportMarkdown(threadId) {
  const t = getThread(threadId);
  const lines = [`# ${t.title}`, '', `Folder: \`${t.cwd}\``, `Exported ${new Date().toLocaleString()} from Conclave`, ''];
  for (const m of t.messages) {
    lines.push(`## ${speaker(m)}${m.round ? ` (${m.round})` : ''}`, `_${m.created}_`, '', m.content || (m.error ? `_failed: ${m.error}_` : ''), '');
  }
  return lines.join('\n');
}

// Messages sent while agents work are queued and sent in order when they finish.
// "Send now" stops the current run and sends right away.
const getQueue = id => kvGet(`queue:${id}`)?.value || [];
const setQueue = (id, q) => { if (q.length) kvSet(`queue:${id}`, q); else getDb().prepare('DELETE FROM kv WHERE k = ?').run(`queue:${id}`); emit(id, 'thread', {}); };
export function removeQueued(threadId, qid) { setQueue(threadId, getQueue(threadId).filter(q => q.id !== qid)); return { ok: true }; }
export async function sendQueuedNow(threadId, qid) {
  const q = getQueue(threadId).find(x => x.id === qid);
  if (!q) throw Object.assign(new Error('Queued message not found'), { status: 404 });
  removeQueued(threadId, qid);
  try {
    return await sendMessage(threadId, q.text, { mode: 'now' });
  } catch (e) {
    const cur = getQueue(threadId);
    if (!cur.some(x => x.id === q.id)) setQueue(threadId, [q, ...cur]);
    throw e;
  }
}

function cleanupRunningMessages(threadId, stopped = false) {
  const db = getDb();
  for (const m of db.prepare("SELECT * FROM thread_messages WHERE thread_id = ? AND status = 'running'").all(threadId)) {
    const l = live.get(m.id);
    denyForMessage(m.id);
    finishMessage(m, {
      content: l ? l.content : m.content,
      activity: l ? l.activity : JSON.parse(m.activity || '[]'),
      status: stopped ? 'stopped' : 'error',
      error: stopped ? 'Stopped' : (m.error || 'Interrupted'),
      files: l ? l.files : JSON.parse(m.files || '[]'),
      usage: JSON.parse(m.usage || '{}'),
    });
  }
}

function jobDone(threadId, finishedCtrl = null) {
  const c = running.get(threadId);
  if (finishedCtrl && c && c !== finishedCtrl) return;
  const targetCtrl = finishedCtrl || c;
  if (targetCtrl) {
    for (const h of targetCtrl.handles) { try { h.stop(); } catch {} }
    for (const fn of targetCtrl.onCancel) { try { fn(); } catch {} }
  }
  cleanupRunningMessages(threadId, !!(targetCtrl?.cancelled || targetCtrl?.userStopped));
  running.delete(threadId);
  // A plain Stop or a Send-Now replacement keeps the queue waiting instead of auto-dequeuing here.
  if (targetCtrl?.userStopped || targetCtrl?.replacing) {
    emit(threadId, 'thread', {});
    return;
  }
  // A fast answer can arrive while another task is still completing. Resume
  // once that run unwinds instead of losing the answer or starting a second job.
  const resume = listPlans(threadId).find(p => p.status === 'paused' && p.error === 'Waiting for your answer' && p.steps.some(s => s.status === 'queued' && s.answer));
  if (resume && !listQuestions(threadId).some(q => q.plan_id === resume.id)) {
    emit(threadId, 'thread', {});
    queueMicrotask(() => { if (!running.has(threadId)) runPlan(threadId, resume.id); });
    return;
  }
  const q = getQueue(threadId);
  if (q.length && !waitingInfo(threadId)) {
    const next = q[0];
    setQueue(threadId, q.slice(1));
    sendMessage(threadId, next.text).catch(e => {
      addMessage(threadId, { role: 'system', content: `Queued message failed: ${e.message}` });
      emit(threadId, 'thread', {});
    });
    return;
  }
  emit(threadId, 'thread', {});
}

export async function sendMessage(threadId, text, { executePlan = false, mode } = {}) {
  if (running.has(threadId)) {
    if (mode !== 'now') {
      const t = String(text || '').trim();
      if (!t) throw new Error('Message is empty');
      const q = [...getQueue(threadId), { id: newId(), text: t, at: now() }];
      setQueue(threadId, q);
      return { ok: true, queued: true, position: q.length };
    }
    stopThread(threadId, { keepQueue: true, replacing: true });
    for (let i = 0; i < 150 && running.has(threadId); i++) await new Promise(r => setTimeout(r, 50));
    if (running.has(threadId)) jobDone(threadId, running.get(threadId));
  }
  const thread = getThread(threadId);
  if (waitingInfo(threadId)) cancelWaiting(threadId);
  text = String(text || '').trim();
  if (!text && !executePlan) throw new Error('Message is empty');
  if (!thread.messages.length && text) updateThread(threadId, { title: text.replace(/\s+/g, ' ').slice(0, 80) });
  let route;
  if (executePlan) {
    const chair = thread.settings.chair;
    addMessage(threadId, { role: 'user', content: `@${chair} The plan is approved. Carry it out now, step by step. Hand steps to other members with @mentions where the plan says so.` });
    route = { tools: [chair] };
  } else {
    addMessage(threadId, { role: 'user', content: text });
    route = routeUserMessage(text, thread);
  }
  const team = thread.settings.councilMode === 'build' ? runBuildReview : runCouncil;
  startJob(threadId, () => route.council ? team(thread) : runDirect(thread, route.tools));
  return { ok: true, route };
}

export function stopThread(threadId, { keepQueue = false, replacing = false } = {}) {
  const c = running.get(threadId);
  if (!c) return false;
  c.cancelled = true;
  if (!keepQueue) c.userStopped = true;
  if (replacing) c.replacing = true;
  for (const fn of c.onCancel) { try { fn(); } catch {} }
  c.onCancel.clear();
  const db = getDb();
  for (const q of db.prepare("SELECT id FROM questions WHERE thread_id = ? AND status = 'pending' AND via = 'tool'").all(threadId)) {
    db.prepare("UPDATE questions SET status = 'expired' WHERE id = ?").run(q.id);
    const out = getQuestion(q.id);
    if (out) emit(threadId, 'question', { question: out });
  }
  for (const m of db.prepare("SELECT id FROM thread_messages WHERE thread_id = ? AND status = 'running'").all(threadId)) {
    denyForMessage(m.id);
  }
  for (const h of c.handles) h.stop();
  return true;
}

// Continue an indexed chat inside the hub: reuse its native session and copy
// its last turns in so the other agents can see what happened.
export async function threadFromChat(chat) {
  const thread = createThread({ title: chat.title, cwd: chat.cwd || chat.project || HOME, target: chat.tool });
  const { messages } = await loadTranscript(chat);
  const turns = messages.filter(m => m.kind === 'text' && (m.role === 'user' || m.role === 'assistant')).slice(-10);
  for (const m of turns) addMessage(thread.id, { role: m.role === 'user' ? 'user' : 'agent', tool: m.role === 'user' ? null : chat.tool, round: 'imported', content: m.text });
  const maxSeq = getDb().prepare('SELECT MAX(seq) AS s FROM thread_messages WHERE thread_id = ?').get(thread.id).s || 0;
  saveSession(thread.id, chat.tool, chat.native_id, maxSeq);
  addMessage(thread.id, { role: 'system', content: `Continued from a ${member(chat.tool).label} session. ${member(chat.tool).label} keeps its full history; the other agents see the last ${turns.length} messages above.` });
  return getThread(thread.id);
}

// Mark messages left "running" by a crash or restart as stopped.
export function recoverStale() {
  for (const id of [...running.keys()]) stopThread(id);
  running.clear();
  live.clear();
  const db = getDb();
  db.prepare("UPDATE thread_messages SET status = 'stopped', error = 'Hub restarted', finished = COALESCE(finished, ?) WHERE status = 'running'").run(now());
  // Plans that were mid-run pause; their running steps go back to the queue.
  for (const p of db.prepare("SELECT * FROM plans WHERE status = 'running'").all().map(planRow)) {
    p.steps.forEach(s => { if (s.status === 'running') s.status = 'queued'; });
    db.prepare("UPDATE plans SET status = 'paused', error = 'Conclave restarted', steps = ?, updated = ? WHERE id = ?").run(JSON.stringify(p.steps), now(), p.id);
  }
  // An agent waiting on ask_user is gone after a restart.
  db.prepare("UPDATE questions SET status = 'expired' WHERE status = 'pending' AND via = 'tool'").run();
}

// ---------- council plans
const planRow = p => p && ({ ...p, steps: JSON.parse(p.steps || '[]') });
export const getPlan = id => planRow(getDb().prepare('SELECT * FROM plans WHERE id = ?').get(id));
export const listPlans = threadId => getDb().prepare('SELECT * FROM plans WHERE thread_id = ? ORDER BY created DESC LIMIT 10').all(threadId).map(planRow);

function writePlan(p) {
  p.updated = now();
  getDb().prepare('UPDATE plans SET status = ?, summary = ?, steps = ?, error = ?, updated = ? WHERE id = ?')
    .run(p.status, p.summary, JSON.stringify(p.steps), p.error || null, p.updated, p.id);
  emit(p.thread_id, 'plan', { plan: p });
  return p;
}
// Read-modify-write in one synchronous block, so parallel steps never lose updates.
function patchPlan(planId, fn) {
  const p = getPlan(planId);
  if (!p) return null;
  fn(p);
  return writePlan(p);
}
function patchStep(planId, stepId, patch) {
  return patchPlan(planId, p => { const s = p.steps.find(x => x.id === stepId); if (s) Object.assign(s, patch); });
}

function insertPlan(threadId, messageId, { status, summary = '', steps = [], error = null }) {
  const db = getDb();
  const revision = db.prepare('SELECT COUNT(*) AS n FROM plans WHERE thread_id = ?').get(threadId).n + 1;
  const p = { id: newId(), thread_id: threadId, message_id: messageId, revision, status, summary, steps, error, created: now(), updated: now() };
  // A new verdict replaces older plans that never finished.
  for (const old of db.prepare("SELECT id FROM plans WHERE thread_id = ? AND status IN ('proposed', 'paused', 'invalid', 'failed')").all(threadId)) expirePlanQuestions(old.id);
  db.prepare("UPDATE plans SET status = 'superseded', updated = ? WHERE thread_id = ? AND status IN ('proposed', 'paused', 'invalid', 'failed')").run(now(), threadId);
  db.prepare('INSERT INTO plans (id, thread_id, message_id, revision, status, summary, steps, error, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(p.id, threadId, messageId, revision, status, summary, JSON.stringify(steps), error, p.created, p.updated);
  emit(threadId, 'plan', { plan: p });
  return p;
}

const MODE_LABEL = { auto: 'Auto', risk: 'Ask on risk', manual: 'Manual' };

// Read the verdict's plan (leniently), validate it (strictly), re-ask once on failure.
async function planFromVerdict(thread, verdict, chair, members) {
  const check = text => {
    const parsed = parsePlan(text);
    if (parsed.error) return { errors: [parsed.error] };
    return validatePlan(parsed.plan, { members, cwd: thread.cwd });
  };
  let v = check(verdict.content);
  if (v.errors.length && !isCancelled(thread.id)) {
    const fix = await runAgentOnce(thread, chair, {
      round: 'plan-fix', permission: 'read',
      instruction: `Your plan block could not be used: ${v.errors.join('; ')}. Reply with ONLY a corrected conclave-plan block.\n\n${PLAN_FORMAT.replace('MEMBERS', members.map(m => `"${m}"`).join(', '))}`,
    });
    if (fix?.status === 'done') v = check(fix.content);
  }
  if (v.errors.length) {
    insertPlan(thread.id, verdict.id, { status: 'invalid', error: v.errors.join('; ') });
    addMessage(thread.id, { role: 'system', content: `The council's plan couldn't be read: ${v.errors.join('; ')}. You can give the whole job to the lead, or ask the council to fix the plan.` });
    return;
  }
  if (!v.plan.steps.length) { insertPlan(thread.id, verdict.id, { status: 'empty', summary: v.plan.summary }); return; }
  const steps = v.plan.steps.map(s => ({ ...s, status: 'queued', assignee: null, messageId: null, attempts: 0, error: null, answer: null }));
  const p = insertPlan(thread.id, verdict.id, { status: 'proposed', summary: v.plan.summary, steps });
  const s = thread.settings;
  if (s.permission === 'read') {
    addMessage(thread.id, { role: 'system', content: `Plan ready (${steps.length} steps), but this chat is read-only. Change "What agents may do" in settings, then click Run plan.` });
  } else if (s.approvalMode === 'manual') {
    addMessage(thread.id, { role: 'system', content: `Plan ready (${steps.length} steps). Click Run plan to start.` });
  } else {
    addMessage(thread.id, { role: 'system', content: `Plan ready (${steps.length} steps). Starting automatically (${MODE_LABEL[s.approvalMode] || s.approvalMode} mode).` });
    await executePlan(thread, p.id);
  }
}

// What a plan step may do: read steps only look; build steps follow the chat's
// access level, and "Ask on risk" routes risky actions through approval cards.
function stepPermission(thread, step) {
  thread = getThread(thread.id);
  const access = thread.settings.permission;
  if (step.kind === 'read' || access === 'read') return 'read';
  if (access === 'full') return 'full';
  return thread.settings.approvalMode === 'risk' ? 'ask' : 'edit';
}

async function executePlan(thread, planId) {
  const c = running.get(thread.id);
  if (!c || c.cancelled) return;
  const start = patchPlan(planId, p => { p.status = 'running'; p.error = null; });
  if (!start) return;
  const members = activeMembers(thread);
  const available = m => memberIds().includes(m) && !outOfCredits(m);
  while (!c.cancelled) {
    const p = getPlan(planId);
    if (!p || p.status !== 'running') break;   // paused or cancelled from the UI
    const batch = nextBatch(p.steps);
    if (!batch.length) {
      const st = p.steps.map(s => s.status);
      if (st.every(x => x === 'done' || x === 'skipped')) {
        patchPlan(planId, q => { q.status = 'done'; });
        addMessage(thread.id, { role: 'system', content: `Plan finished: ${p.steps.filter(s => s.status === 'done').length} steps done${st.includes('skipped') ? `, ${st.filter(x => x === 'skipped').length} skipped` : ''}.` });
      } else if (st.includes('waiting')) {
        patchPlan(planId, q => { q.status = 'paused'; q.error = 'Waiting for your answer'; });
      } else {
        const failed = p.steps.filter(s => s.status === 'failed');
        patchPlan(planId, q => { q.status = 'paused'; q.error = failed.length ? `Step ${failed.map(s => s.id).join(', ')} failed. Retry, reassign or skip it.` : 'Nothing can run: check the step dependencies.'; });
      }
      break;
    }
    await Promise.all(batch.map(s => runStep(thread, planId, s, members, available)));
  }
  if (c.cancelled) patchPlan(planId, q => {
    if (q.status === 'running') { q.status = 'paused'; q.error = 'Stopped'; }
    q.steps.forEach(s => { if (s.status === 'running') s.status = 'queued'; });
  });
}

async function runStep(thread, planId, step, members, available) {
  const p0 = getPlan(planId);
  let L = {}; try { L = getLimits(); } catch {}
  const who = assign(step, p0.steps, { members, available, lead: leadOf(thread, members), penalty: stepPenalty(thread, L) });
  if (!who) { patchStep(planId, step.id, { status: 'failed', error: 'No agent with credits is available' }); return; }
  patchStep(planId, step.id, { status: 'running', assignee: who, attempts: (step.attempts || 0) + 1, error: null });
  const others = p0.steps.filter(s => s.id !== step.id).map(s => `  ${s.id}. ${s.title} (${s.assignee || s.owner}, ${s.status})`).join('\n');
  const instruction = [
    `PLAN STEP ${step.id} of ${p0.steps.length}: ${step.title}`,
    step.detail,
    step.files.length ? `Files this step owns: ${step.files.join(', ')}. Avoid editing other files unless necessary, and say so if you do.` : '',
    step.answer ? `The user answered your earlier question: ${step.answer}` : '',
    step.attempts || step.assignee ? 'This step may have partial edits from an earlier attempt. Inspect the current files and diff first; preserve valid work and complete what remains.' : '',
    p0.summary ? `Plan summary: ${p0.summary}` : '',
    `Other steps (for context only, do not do them):\n${others || '  (none)'}`,
    step.kind === 'read' ? 'This is a read-only step: do not edit files.' : 'Do only this step. When done, list exactly what you changed.',
  ].filter(Boolean).join('\n\n');
  const reply = await runAgent(thread, who, { round: `step-${step.id}`, permission: stepPermission(thread, step), instruction, stepRef: { planId, stepId: step.id } });
  if (getPlan(planId)?.status === 'cancelled') return;
  if (!reply) {
    if (isCancelled(thread.id) || getPlan(planId)?.status === 'paused') patchStep(planId, step.id, { status: 'queued', error: null });
    else patchStep(planId, step.id, { status: 'failed', error: 'No agent could run this step' });
    return;
  }
  patchStep(planId, step.id, { assignee: reply.tool });
  if (reply.status !== 'done') {
    patchStep(planId, step.id, { status: reply.status === 'stopped' ? 'queued' : 'failed', error: reply.status === 'stopped' ? null : (reply.error || reply.status), messageId: reply.id });
    return;
  }
  if (questionFromBlock(thread, reply, { planId, stepId: step.id })) {
    return;
  }
  patchStep(planId, step.id, { messageId: reply.id });
  // Optional quick review by a different agent, with one fix round.
  const reviewer = step.kind === 'build' && step.review
    ? (step.review === 'any' ? members.find(m => m !== reply.tool && available(m)) : step.review) : null;
  if (isCancelled(thread.id)) return;
  if (!reviewer || reviewer === reply.tool) { patchStep(planId, step.id, { status: 'done' }); return; }
  if (!available(reviewer)) { patchStep(planId, step.id, { status: 'failed', error: 'The required reviewer is unavailable' }); return; }
  const rev = await runAgent(thread, reviewer, {
    round: `review-${step.id}`, permission: 'read', exclude: members,
    instruction: `REVIEW of plan step ${step.id} ("${step.title}") done by ${member(who).label}. Check the actual files. List concrete problems with file and line, or reply "LGTM" and one sentence. Do not edit files.`,
  });
  if (getPlan(planId)?.status === 'cancelled') return;
  if (!rev || rev.status !== 'done') { patchStep(planId, step.id, { status: 'failed', error: rev?.error || 'Review could not finish' }); return; }
  if (rev?.status === 'done' && !/^\W*LGTM\b/i.test(rev.content.trim()) && !isCancelled(thread.id)) {
    const fixed = await runAgent(thread, reply.tool, {
      round: `fix-${step.id}`, permission: stepPermission(thread, step), stepRef: { planId, stepId: step.id },
      instruction: `FIX for plan step ${step.id}: read ${member(reviewer).label}'s review above, fix the valid problems, and say briefly why you skipped any you disagree with.`,
    });
    if (getPlan(planId)?.status === 'cancelled') return;
    if (!fixed || fixed.status !== 'done') { patchStep(planId, step.id, { status: 'failed', error: fixed?.error || 'Fix could not finish' }); return; }
    if (questionFromBlock(thread, fixed, { planId, stepId: step.id })) return;
  }
  if (!isCancelled(thread.id)) patchStep(planId, step.id, { status: 'done' });
}

function startJob(threadId, fn) {
  const c = ctrl(threadId);
  c.job = Promise.resolve()
    .then(fn)
    .catch(e => addMessage(threadId, { role: 'system', content: `Error: ${e.message}` }))
    .finally(() => jobDone(threadId, c));
}

// Run plan button: runs exactly this plan revision, never twice at once.
export function runPlan(threadId, planId) {
  const thread = getThread(threadId);
  const p = getPlan(planId);
  if (!p || p.thread_id !== threadId) throw Object.assign(new Error('Plan not found'), { status: 404 });
  if (running.has(threadId)) throw Object.assign(new Error('Agents are already working in this chat'), { status: 409 });
  if (!['proposed', 'paused', 'failed'].includes(p.status)) throw Object.assign(new Error(`This plan is ${p.status}`), { status: 409 });
  if (thread.settings.permission === 'read') throw new Error('This chat is read-only. Change "What agents may do" first.');
  if (p.status !== 'proposed') patchPlan(planId, q => q.steps.forEach(s => { if (s.status === 'failed') { s.status = 'queued'; s.error = null; } }));
  startJob(threadId, () => executePlan(thread, planId));
  return { ok: true };
}

export function pausePlan(threadId, planId) {
  ownedPlan(threadId, planId);
  return patchPlan(planId, p => { if (p.status === 'running') { p.status = 'paused'; p.error = 'Paused: the current step will finish first'; } });
}

export function cancelPlan(threadId, planId) {
  const before = ownedPlan(threadId, planId);
  if (['done', 'cancelled', 'superseded'].includes(before.status)) throw Object.assign(new Error(`This plan is ${before.status}`), { status: 409 });
  const p = patchPlan(planId, q => {
    q.status = 'cancelled';
    q.steps.forEach(s => { if (['queued', 'running', 'waiting'].includes(s.status)) s.status = 'skipped'; });
  });
  stopThread(threadId);
  expirePlanQuestions(planId);
  return p;
}

export function stepAction(threadId, planId, stepId, action, agent) {
  const owned = ownedPlan(threadId, planId);
  if (['done', 'cancelled', 'superseded', 'invalid'].includes(owned.status)) throw Object.assign(new Error(`This plan is ${owned.status}`), { status: 409 });
  if (running.has(threadId)) {
    const s = getPlan(planId)?.steps.find(x => x.id === stepId);
    if (s?.status === 'running') throw Object.assign(new Error('That step is running right now'), { status: 409 });
  }
  return patchPlan(planId, p => {
    const s = p.steps.find(x => x.id === stepId);
    if (!s) throw Object.assign(new Error('Step not found'), { status: 404 });
    if (s.status === 'done') throw Object.assign(new Error('Completed steps cannot be changed; create a new plan to revise them'), { status: 409 });
    if (['skip', 'reassign', 'retry'].includes(action) && s.status === 'waiting') expirePlanQuestions(planId, stepId);
    if (action === 'retry') { s.status = 'queued'; s.error = null; }
    else if (action === 'skip') s.status = 'skipped';
    else if (action === 'reassign') {
      if (!activeMembers(getThread(threadId)).includes(agent)) throw new Error('Unknown or inactive agent');
      s.assignee = agent; s.owner = agent;
      if (['failed', 'waiting'].includes(s.status)) { s.status = 'queued'; s.error = null; s.answer = null; }
    } else throw new Error('Unknown action');
  });
}

function ownedPlan(threadId, planId) {
  const p = getPlan(planId);
  if (!p || p.thread_id !== threadId) throw Object.assign(new Error('Plan not found'), { status: 404 });
  return p;
}

function expirePlanQuestions(planId, stepId = null) {
  const clause = stepId ? ' AND step_id = ?' : '';
  const args = stepId ? [planId, stepId] : [planId];
  const pending = getDb().prepare("SELECT id FROM questions WHERE plan_id = ? AND status = 'pending'" + clause).all(...args);
  getDb().prepare("UPDATE questions SET status = 'expired' WHERE plan_id = ? AND status = 'pending'" + clause).run(...args);
  for (const q of pending) { const question = getQuestion(q.id); emit(question.thread_id, 'question', { question }); }
}

// ---------- questions from agents
const qRow = q => q && ({ ...q, options: JSON.parse(q.options || '[]'), multi: !!q.multi });
export const getQuestion = id => qRow(getDb().prepare('SELECT * FROM questions WHERE id = ?').get(id));
export const listQuestions = threadId => getDb().prepare("SELECT * FROM questions WHERE thread_id = ? AND status = 'pending' ORDER BY created").all(threadId).map(qRow);

export function createQuestion({ threadId, messageId = null, planId = null, stepId = null, agent, question, options = [], multi = false, via = 'tool' }) {
  const thread = getThread(threadId);   // throws if the chat is gone
  if (!['tool', 'block'].includes(via)) throw new Error('Unknown question channel');
  if (!memberIds().includes(agent)) throw new Error('Unknown question agent');
  if (messageId && !thread.messages.some(m => m.id === messageId && m.tool === agent)) throw Object.assign(new Error('Message not found for this agent'), { status: 404 });
  if (!!planId !== !!stepId) throw new Error('Questions need both a plan and step ID');
  if (planId) {
    const p = ownedPlan(threadId, planId);
    const s = p.steps.find(s => s.id === stepId);
    if (!s || !['running', 'waiting'].includes(s.status) || !['running', 'paused'].includes(p.status)) throw Object.assign(new Error('This task is no longer waiting for input'), { status: 409 });
    if (s.assignee && s.assignee !== agent) throw Object.assign(new Error('Question agent does not own this task'), { status: 409 });
  }
  const q = {
    id: newId(), thread_id: threadId, message_id: messageId, plan_id: planId || null, step_id: stepId || null, agent: String(agent || 'agent'),
    question: String(question || '').slice(0, 2000), options: JSON.stringify((Array.isArray(options) ? options : []).map(String).slice(0, 8)),
    multi: multi ? 1 : 0, via, status: 'pending', created: now(),
  };
  if (!q.question) throw new Error('Question is empty');
  getDb().prepare('INSERT INTO questions (id, thread_id, message_id, plan_id, step_id, agent, question, options, multi, via, status, created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(q.id, q.thread_id, q.message_id, q.plan_id, q.step_id, q.agent, q.question, q.options, q.multi, q.via, q.status, q.created);
  const out = qRow(q);
  emit(threadId, 'question', { question: out });
  // An agent waiting on ask_user gives up after 15 minutes.
  if (via === 'tool') setTimeout(() => {
    const cur = getQuestion(q.id);
    if (cur?.status === 'pending') { getDb().prepare("UPDATE questions SET status = 'expired' WHERE id = ?").run(q.id); emit(threadId, 'question', { question: { ...cur, status: 'expired' } }); }
  }, 15 * 60_000).unref();
  return out;
}

export function answerQuestion(id, answer) {
  const q = getQuestion(id);
  if (!q) throw Object.assign(new Error('Question not found'), { status: 404 });
  if (q.status !== 'pending') throw Object.assign(new Error(`This question was already ${q.status}`), { status: 409 });
  if (q.plan_id) {
    const p = ownedPlan(q.thread_id, q.plan_id);
    const s = p.steps.find(s => s.id === q.step_id);
    if (!['running', 'paused'].includes(p.status) || !s || !['running', 'waiting'].includes(s.status) || s.assignee && s.assignee !== q.agent) {
      getDb().prepare("UPDATE questions SET status = 'expired' WHERE id = ?").run(id);
      throw Object.assign(new Error('This question belongs to an inactive task'), { status: 409 });
    }
  }
  const text = (Array.isArray(answer) ? answer.join(', ') : String(answer ?? '')).trim().slice(0, 4000);
  if (!text) throw new Error('Answer is empty');
  // Guarded update: only one answer wins even if two arrive at once.
  const r = getDb().prepare("UPDATE questions SET status = 'answered', answer = ?, answered = ? WHERE id = ? AND status = 'pending'").run(text, now(), id);
  if (!r.changes) throw Object.assign(new Error('This question was already answered'), { status: 409 });
  const out = getQuestion(id);
  emit(q.thread_id, 'question', { question: out });
  addMessage(q.thread_id, { role: 'user', content: `Answer to ${member(q.agent).label}: ${text}` });
  if (q.via === 'block') {
    if (q.plan_id && q.step_id) {
      // Resume the paused step once, with the answer.
      patchStep(q.plan_id, q.step_id, { status: 'queued', answer: text });
      const p = getPlan(q.plan_id);
      if (p && p.status === 'paused' && !running.has(q.thread_id)) runPlan(q.thread_id, q.plan_id);
    } else if (!running.has(q.thread_id)) {
      startJob(q.thread_id, () => runDirect(getThread(q.thread_id), [q.agent]));
    }
  }
  return out;
}

// Fallback channel: a ```conclave-question block at the end of a reply.
function questionFromBlock(thread, reply, { planId = null, stepId = null }) {
  const m = String(reply.content || '').match(/```\s*conclave-question\s*\n([\s\S]*?)```/i);
  if (!m) return null;
  let q;
  try { q = JSON.parse(m[1].replace(/,\s*([}\]])/g, '$1')); } catch { q = { question: m[1].trim() }; }
  if (!q?.question) return null;
  // Publish the waiting state before the question event: an immediate browser
  // answer must not be overwritten by a later transition back to waiting.
  if (planId && stepId) patchStep(planId, stepId, { status: 'waiting', messageId: reply.id });
  return createQuestion({ threadId: thread.id, messageId: reply.id, planId, stepId, agent: reply.tool, question: q.question, options: q.options, multi: q.multi, via: 'block' });
}

// ---------- per-reply diffs
function snapOf(threadId, messageId) {
  const m = getDb().prepare('SELECT snap FROM thread_messages WHERE id = ? AND thread_id = ?').get(messageId, threadId);
  if (!m?.snap) throw Object.assign(new Error('This reply made no tracked changes'), { status: 404 });
  return JSON.parse(m.snap);
}
export async function messageDiff(threadId, messageId) {
  const s = snapOf(threadId, messageId);
  return { ...s.stat, root: s.root, mode: s.mode, reverted: !!s.reverted, diff: await diffText(s, s.before, s.after) };
}
export async function revertMessage(threadId, messageId) {
  if (running.has(threadId)) throw new Error('Wait for the agents to finish before reverting.');
  const s = snapOf(threadId, messageId);
  if (s.reverted) throw new Error('Already reverted');
  await revert(s, s.before, s.after);
  s.reverted = new Date().toISOString();
  getDb().prepare('UPDATE thread_messages SET snap = ? WHERE id = ?').run(JSON.stringify(s), messageId);
  addMessage(threadId, { role: 'system', content: `Reverted the changes from one reply (${s.stat.files} file${s.stat.files === 1 ? '' : 's'}).` });
  const out = rowToMsg(getDb().prepare('SELECT * FROM thread_messages WHERE id = ?').get(messageId));
  emit(threadId, 'message', { message: out });
  return { ok: true };
}
