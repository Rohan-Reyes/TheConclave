import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb } from './db.js';
import { normPath, HOME, P } from './paths.js';
import { listMemories } from './memory.js';
import { backupFile } from './config/backup.js';

const run = promisify(execFile);

export const INSTRUCTION_FILES = [
  { tool: 'claude', rel: 'CLAUDE.md' },
  { tool: 'claude', rel: '.claude\\CLAUDE.md' },
  { tool: 'codex', rel: 'AGENTS.md' },
  { tool: 'antigravity', rel: 'GEMINI.md' },
  { tool: 'antigravity', rel: '.agents\\rules' },
];

// Global (user-level) instruction files for each tool.
export const GLOBAL_INSTRUCTIONS = [
  { tool: 'claude', path: P.claude.instructions },
  { tool: 'codex', path: P.codex.instructions },
  { tool: 'antigravity', path: P.antigravity.instructions },
];

export function listProjects() {
  const rows = getDb().prepare(`
    SELECT project AS cwd, tool, COUNT(*) AS n, MAX(updated) AS last
    FROM chats WHERE project != '' GROUP BY project, tool`).all();
  const map = new Map();
  for (const r of rows) {
    const p = map.get(r.cwd) || { path: r.cwd, name: path.basename(r.cwd) || r.cwd, tools: {}, total: 0, last: '' };
    p.tools[r.tool] = r.n;
    p.total += r.n;
    if (r.last > p.last) p.last = r.last;
    map.set(r.cwd, p);
  }
  // Include hub-only workspaces; they may have no imported CLI transcripts.
  const hub = getDb().prepare("SELECT cwd, COUNT(*) AS n, MAX(updated) AS last FROM threads WHERE cwd != '' GROUP BY cwd").all();
  for (const row of hub) {
    const p = map.get(row.cwd) || {path:row.cwd,name:path.basename(row.cwd),tools:{},total:0,last:''};
    p.tools.hub=row.n;p.total+=row.n;if(row.last>p.last)p.last=row.last;map.set(row.cwd,p);
  }
  const mem = getDb().prepare("SELECT scope, COUNT(*) AS n FROM memories WHERE scope != 'global' GROUP BY scope").all();
  for (const m of mem) {
    const p = map.get(m.scope) || { path: m.scope, name: path.basename(m.scope), tools: {}, total: 0, last: '' };
    p.memories = m.n;
    map.set(m.scope, p);
  }
  return [...map.values()].map(p => ({ ...p, exists: fs.existsSync(p.path), isHome: p.path === normPath(HOME) }))
    .sort((a, b) => (b.last || '').localeCompare(a.last || ''));
}

async function gitStatus(dir) {
  try {
    const opts = { cwd: dir, timeout: 4000, windowsHide: true };
    const { stdout: top } = await run('git', ['rev-parse', '--show-toplevel'], opts);
    const { stdout: br } = await run('git', ['branch', '--show-current'], opts);
    const { stdout: st } = await run('git', ['status', '--porcelain'], opts);
    const { stdout: lg } = await run('git', ['log', '-5', '--pretty=format:%h\t%cr\t%s'], opts).catch(() => ({ stdout: '' }));
    return {
      root: normPath(top.trim()),
      branch: br.trim() || '(detached)',
      dirty: st.split('\n').filter(Boolean).length,
      commits: lg.split('\n').filter(Boolean).map(l => { const [hash, when, msg] = l.split('\t'); return { hash, when, msg }; }),
    };
  } catch { return null; }
}

function instructionFiles(dir) {
  return INSTRUCTION_FILES.map(f => {
    const p = path.join(dir, f.rel);
    let exists = false, isDir = false;
    try { const s = fs.statSync(p); exists = true; isDir = s.isDirectory(); } catch {}
    return { tool: f.tool, name: f.rel, path: p, exists, isDir };
  }).filter(f => !f.isDir);
}

export async function projectDetail(p) {
  const dir = normPath(p);
  const chats = getDb().prepare('SELECT id, tool, variant, title, updated, msg_count FROM chats WHERE project = ? ORDER BY updated DESC LIMIT 100').all(dir);
  return {
    path: dir,
    name: path.basename(dir),
    exists: fs.existsSync(dir),
    chats,
    plans: getDb().prepare(`SELECT p.*, t.title AS thread_title FROM plans p JOIN threads t ON t.id=p.thread_id WHERE t.cwd=? ORDER BY p.updated DESC LIMIT 30`).all(dir).map(p=>({...p,steps:JSON.parse(p.steps || '[]')})),
    memories: listMemories({ scope: dir }).filter(m => m.scope !== 'global'),
    git: fs.existsSync(dir) ? await gitStatus(dir) : null,
    files: fs.existsSync(dir) ? instructionFiles(dir) : [],
  };
}

// Only instruction files (known names) may be read or written through the hub.
function allowedInstructionPath(file) {
  const f = path.resolve(file);
  if (GLOBAL_INSTRUCTIONS.some(g => path.resolve(g.path).toLowerCase() === f.toLowerCase())) return f;
  const base = path.basename(f).toUpperCase();
  if (['CLAUDE.MD', 'AGENTS.MD', 'GEMINI.MD'].includes(base)) return f;
  throw new Error('Only CLAUDE.md, AGENTS.md and GEMINI.md files can be edited here');
}

export function readInstruction(file) {
  const f = allowedInstructionPath(file);
  return { path: f, exists: fs.existsSync(f), content: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' };
}

export function writeInstruction(file, content) {
  const f = allowedInstructionPath(file);
  const backup = backupFile(f);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content, 'utf8');
  return { path: f, backup };
}
