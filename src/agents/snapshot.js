// Per-reply diffs: snapshot the working folder as a git tree before and after
// an agent turn, then diff the two trees. Works in git repos (using a temporary
// index, so your staging area is untouched) and in small non-git folders (using
// a hidden "shadow" repo under agent-hub/data/shadow).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, HOME, normPath } from '../paths.js';

const run = promisify(execFile);
const SHADOW_DIR = path.join(DATA_DIR, 'shadow');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const MAX_FILES = 4000;
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'desktop.ini']);

async function git(args, { cwd, gitDir, workTree, env = {}, input } = {}) {
  const pre = gitDir ? ['--git-dir', gitDir, '--work-tree', workTree] : [];
  const p = run('git', [...pre, '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], {
    cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 120_000,
  });
  if (input != null) { p.child.stdin.write(input); p.child.stdin.end(); }
  return (await p).stdout;
}

function countFiles(dir, limit) {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      if (e.isDirectory()) stack.push(path.join(cur, e.name));
      else if (++n > limit) return n;
    }
  }
  return n;
}

async function target(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const homeNorm = normPath(HOME).toLowerCase();
  if (normPath(cwd).toLowerCase() === homeNorm) return null;
  try {
    const top = (await git(['rev-parse', '--show-toplevel'], { cwd })).trim();
    if (top) {
      if (normPath(top).toLowerCase() === homeNorm) return null;
      return { mode: 'git', root: normPath(top), gitDir: null };
    }
  } catch {}
  // Never shadow the whole home folder or other huge folders.
  if (countFiles(cwd, MAX_FILES) > MAX_FILES) return null;
  const gitDir = path.join(SHADOW_DIR, crypto.createHash('sha1').update(normPath(cwd).toLowerCase()).digest('hex').slice(0, 16));
  if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
    fs.mkdirSync(gitDir, { recursive: true });
    await git(['init', '--bare', '--quiet', gitDir]);
    fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), [...SKIP].map(s => s + '/').join('\n') + '\n*.tmp\n');
  }
  return { mode: 'shadow', root: normPath(cwd), gitDir };
}

// Returns { mode, root, gitDir, tree } or null when the folder can't be tracked.
export async function snapshot(cwd) {
  const t = await target(cwd);
  if (!t) return null;
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const index = path.join(TMP_DIR, `idx-${crypto.randomBytes(6).toString('hex')}`);
  const opts = { cwd: t.root, gitDir: t.gitDir, workTree: t.root, env: { GIT_INDEX_FILE: index } };
  try {
    await git(['add', '-A', '--', '.'], opts);
    const tree = (await git(['write-tree'], opts)).trim();
    return { ...t, tree };
  } catch { return null; }
  finally { fs.rmSync(index, { force: true }); }
}

const opt = s => ({ cwd: s.root, gitDir: s.gitDir, workTree: s.root });

export async function diffStat(s, before, after) {
  if (before === after) return { files: 0, add: 0, del: 0 };
  const out = await git(['diff', '--numstat', '-M', before, after], opt(s));
  let files = 0, add = 0, del = 0;
  for (const l of out.split('\n').filter(Boolean)) {
    const [a, d] = l.split('\t');
    files++; add += Number(a) || 0; del += Number(d) || 0;
  }
  return { files, add, del };
}

export async function diffText(s, before, after) {
  const out = await git(['diff', '--no-color', '-M', '--stat', '--patch', before, after], opt(s));
  return out.length > 600_000 ? out.slice(0, 600_000) + '\n… (diff truncated)' : out;
}

// Undo a reply's changes by applying the reverse patch. Fails cleanly (no
// partial changes) if the files were changed again since.
export async function revert(s, before, after) {
  const patch = await git(['diff', '--binary', '-M', after, before], opt(s));
  if (!patch.trim()) return { ok: true, empty: true };
  try {
    // Run plain `git apply` in the folder: it patches the working files in both modes.
    await git(['apply', '--whitespace=nowarn', '-'], { cwd: s.root, input: patch });
    return { ok: true };
  } catch (e) {
    throw new Error('Could not revert: the files changed again after this reply. ' + String(e.stderr || e.message).split('\n')[0]);
  }
}
