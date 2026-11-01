// Council plans: read the `conclave-plan` block from a verdict, validate it,
// decide which steps can run now, and pick who runs each step.
import path from 'node:path';
import fs from 'node:fs';

// Strip comments and trailing commas outside strings only: regular expressions
// would corrupt URLs and task text containing literal comma/bracket sequences.
function tidyJson(src) {
  let out = '', quoted = false, escaped = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; out += c; }
    else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === ',' && /^\s*[}\]]/.test(src.slice(i + 1))) { /* trailing comma */ }
    else out += c;
  }
  return out;
}

// Lenient extraction: handles trailing commas, comments, and a
// missing language tag. Returns { plan } or { error }.
export function parsePlan(text) {
  const src = String(text || '');
  if (src.length > 256_000) return { error: 'Plan exceeds the 256 KB limit' };
  const blocks = [...src.matchAll(/^[ \t]*(`{3,}|~{3,})[ \t]*(conclave-plan|json)?[ \t]*\r?\n([\s\S]*?)^[ \t]*\1[ \t]*$/gim)];
  const m = blocks.find(x => x[2]?.toLowerCase() === 'conclave-plan')
    || blocks.find(x => (!x[2] || x[2].toLowerCase() === 'json') && /"steps"\s*:/.test(x[3]));
  if (!m) return { error: 'No conclave-plan block found' };
  const body = tidyJson(m[3].trim());
  try {
    const plan = JSON.parse(body);
    return { plan: Array.isArray(plan) ? { steps: plan } : plan };
  } catch (e) {
    return { error: `Plan block is not valid JSON: ${e.message}` };
  }
}

// Strict validation and normalisation. Returns { plan, errors[] }.
export function validatePlan(raw, { members = [], cwd } = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.steps)) {
    return { plan: { summary: '', steps: [] }, errors: ['Plan must be an object with a steps array'] };
  }
  if (raw.steps.length > 100) return { plan: { summary: '', steps: [] }, errors: ['Plan may contain at most 100 steps'] };
  const steps = Array.isArray(raw?.steps) ? raw.steps : [];
  if (!steps.length) return { plan: { summary: raw?.summary || '', steps: [] }, errors };
  const ids = new Set();
  const out = steps.map((entry, i) => {
    const s = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
    if (s !== entry) errors.push(`Step ${i + 1} must be an object`);
    const id = typeof s.id === 'string' || typeof s.id === 'number' ? String(s.id).trim() : '';
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) errors.push(`Step ${i + 1} needs a valid id`);
    if (ids.has(id)) errors.push(`Duplicate step id "${id}"`);
    ids.add(id);
    const owner = String(s.owner || 'any').toLowerCase().replace(/^@/, '');
    if (owner !== 'any' && !members.includes(owner)) errors.push(`Step ${id}: unknown owner "${owner}"`);
    const review = s.review ? String(s.review).toLowerCase().replace(/^@/, '') : null;
    if (review && review !== 'any' && !members.includes(review)) errors.push(`Step ${id}: unknown reviewer "${review}"`);
    if (s.files !== undefined && !Array.isArray(s.files)) errors.push(`Step ${id}: files must be an array`);
    if (s.dependsOn !== undefined && !Array.isArray(s.dependsOn)) errors.push(`Step ${id}: dependsOn must be an array`);
    if (s.kind !== undefined && !['build', 'read'].includes(s.kind)) errors.push(`Step ${id}: kind must be build or read`);
    if (s.readOnly !== undefined && typeof s.readOnly !== 'boolean') errors.push(`Step ${id}: readOnly must be a boolean`);
    const effort = s.effort === undefined ? 2 : Number(s.effort);
    if (!Number.isFinite(effort) || effort < 1 || effort > 5) errors.push(`Step ${id}: effort must be between 1 and 5`);
    const files = [...new Set((Array.isArray(s.files) ? s.files : []).map(f => normalizeFile(f, cwd, errors, id)).filter(Boolean))];
    return {
      id,
      title: String(s.title || s.task || `Step ${id}`).slice(0, 200),
      detail: String(s.detail || s.description || '').slice(0, 4000),
      owner,
      review,
      files,
      dependsOn: [...new Set((Array.isArray(s.dependsOn) ? s.dependsOn : []).map(d => String(d).trim()))],
      kind: s.kind === 'read' || s.readOnly === true ? 'read' : 'build',
      effort: Math.min(5, Math.max(1, Number(s.effort) || 2)),
    };
  });
  for (const s of out) for (const d of s.dependsOn) if (!ids.has(d)) errors.push(`Step ${s.id} depends on missing step "${d}"`);
  const cycle = findCycle(out);
  if (cycle) errors.push(`Dependency cycle: ${cycle.join(' → ')}`);
  return { plan: { summary: String(raw.summary || '').slice(0, 2000), steps: out }, errors };
}

function normalizeFile(f, cwd, errors, id) {
  const fail = () => { errors.push(`Step ${id}: file "${String(f)}" must stay inside the working folder`); return null; };
  if (typeof f !== 'string') return fail();
  const clean = f.trim().replace(/^`(.*)`$/, '$1').replace(/\\/g, '/');
  if (!clean || /[\x00-\x1f:]/.test(clean) || path.posix.isAbsolute(clean) || path.win32.isAbsolute(clean)) return fail();
  const root = path.resolve(cwd || '.');
  const abs = path.resolve(root, clean);
  const inside = (base, target) => { const r = path.relative(base, target); return r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
  if (!inside(root, abs)) return fail();
  try {
    if (fs.existsSync(root)) {
      const realRoot = fs.realpathSync(root);
      let parent = abs;
      while (!fs.existsSync(parent) && parent !== path.dirname(parent)) parent = path.dirname(parent);
      if (!inside(realRoot, fs.realpathSync(parent))) return fail();
    }
  } catch { return fail(); }
  return path.relative(root, abs).replace(/\\/g, '/') || '.';
}

function findCycle(steps) {
  const by = new Map(steps.map(s => [s.id, s]));
  const state = new Map();
  const stack = [];
  const visit = id => {
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    if (state.get(id) === 2) return null;
    state.set(id, 1); stack.push(id);
    for (const d of by.get(id)?.dependsOn || []) { const c = visit(d); if (c) return c; }
    stack.pop(); state.set(id, 2);
    return null;
  };
  for (const s of steps) { const c = visit(s.id); if (c) return c; }
  return null;
}

// Steps that can start now. One writer per folder at a time (file lists guide
// scheduling but cannot enforce boundaries); read-only steps may run alongside.
export function nextBatch(steps) {
  const done = new Set(steps.filter(s => s.status === 'done' || s.status === 'skipped').map(s => s.id));
  const writing = steps.some(s => s.status === 'running' && s.kind !== 'read');
  const ready = steps.filter(s => s.status === 'queued' && (s.dependsOn || []).every(d => done.has(d)));
  const batch = ready.filter(s => s.kind === 'read');
  if (!writing) { const w = ready.find(s => s.kind !== 'read'); if (w) batch.push(w); }
  return batch;
}

// Who runs a step: its owner when available, otherwise the available member with
// the least assigned effort (ties: the lead first).
// penalty(member, step) adds cost for agents near their usage limits or whose
// role doesn't fit the step (see stepPenalty in threads.js).
export function assign(step, steps, { members, available, lead, penalty = () => 0 }) {
  if (step.assignee && members.includes(step.assignee) && available(step.assignee)) return step.assignee;
  if (step.owner !== 'any' && members.includes(step.owner) && available(step.owner)) return step.owner;
  const load = new Map(members.map(m => [m, 0]));
  for (const s of steps) if (s.id !== step.id && s.assignee && s.status !== 'skipped') load.set(s.assignee, (load.get(s.assignee) || 0) + (Number.isFinite(s.effort) ? s.effort : 2));
  const pool = [...new Set(members)].filter(m => available(m));
  if (!pool.length) return null;
  const ranked = pool.map((m, i) => ({ m, i, score: load.get(m) + Number(penalty(m, step)) })).filter(x => Number.isFinite(x.score));
  ranked.sort((a, b) => a.score - b.score || Number(b.m === lead) - Number(a.m === lead) || a.i - b.i);
  return ranked[0]?.m || null;
}

export const PLAN_FORMAT = `End your answer with the plan as a fenced block exactly like this (valid JSON, no comments):
\`\`\`conclave-plan
{"summary": "one line", "steps": [
  {"id": "1", "title": "short title", "detail": "what to do", "owner": "claude", "files": ["src/a.js"], "dependsOn": [], "kind": "build", "review": "codex", "effort": 2}
]}
\`\`\`
owner/review: one of MEMBERS, or "any". kind: "build" (edits files) or "read" (review, tests that don't edit, research). effort: 1-5. files: paths relative to the working folder that the step will edit. If no work is needed, use "steps": [].`;
