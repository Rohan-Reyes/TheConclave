// Model lists and plan limits for the built-in tools.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HOME, P } from '../paths.js';
import { kvGet, kvSet } from '../db.js';
import { walk } from '../adapters/common.js';

const run = promisify(execFile);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

let modelCache = null;
export async function getModels(force = false) {
  if (modelCache && !force && Date.now() - modelCache.at < 3600_000) return modelCache.data;
  const claude = {
    models: [
      { id: '', label: 'Default' },
      { id: 'claude-fable-5-1', label: 'Fable 5.1' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
    ],
    efforts: EFFORTS,
  };
  const antigravity = { models: [{ id: '', label: 'Default' }], efforts: EFFORTS };
  try {
    const { stdout } = await run('agy', ['models'], { timeout: 30000, windowsHide: true });
    for (const line of stdout.split(/\r?\n/)) {
      const [id, label] = line.split('\t');
      // agy --model resolves display names ("Gemini 3.8 Flash (Low)"), not the short ids.
      if (id && label && !/^Fetching/.test(id)) antigravity.models.push({ id: label.trim(), label: label.trim() });
    }
  } catch {}
  const codex = { models: [{ id: '', label: 'Default' }], efforts: [] };
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(P.codex.home, 'models_cache.json'), 'utf8'));
    const eff = new Set();
    for (const m of cache.models || []) {
      if (m.visibility && m.visibility !== 'list') continue;
      const levels = (m.supported_reasoning_levels || []).map(r => r.effort).filter(Boolean);
      levels.forEach(l => eff.add(l));
      codex.models.push({ id: m.slug, label: m.display_name || m.slug, efforts: levels, defaultEffort: m.default_reasoning_level });
    }
    codex.efforts = [...eff];
  } catch {}
  if (!codex.efforts.length) codex.efforts = EFFORTS;
  modelCache = { at: Date.now(), data: { claude, antigravity, codex } };
  return modelCache.data;
}

// ---------- plan limits
let codexCache = { at: 0, data: null };
function codexLimits() {
  if (Date.now() - codexCache.at < 30_000) return codexCache.data;
  codexCache = { at: Date.now(), data: readCodexLimits() };
  return codexCache.data;
}
function readCodexLimits() {
  // Newest rollouts carry rate_limits in their token_count events.
  const files = walk(P.codex.sessions, (p, n) => n.endsWith('.jsonl'))
    .map(p => ({ p, t: fs.statSync(p).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 5);
  for (const { p, t } of files) {
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      try {
        const rl = JSON.parse(lines[i]).payload?.rate_limits;
        if (!rl) continue;
        const win = w => w && { usedPct: w.used_percent, windowMin: w.window_minutes, resetsAt: w.resets_at ? w.resets_at * 1000 : null };
        return { primary: win(rl.primary), secondary: win(rl.secondary), seen: new Date(t).toISOString() };
      } catch {}
    }
  }
  return null;
}

// Antigravity only shows quota in its interactive /usage screen, so open agy in
// a hidden pseudo-terminal, type /usage, and read the screen.
let agyRefreshing = null;
export function refreshAntigravityQuota() {
  if (agyRefreshing) return agyRefreshing;
  agyRefreshing = (async () => {
    const { default: pty } = await import('@lydell/node-pty');
    const env = { ...process.env };
    delete env.CONCLAVE_CHILD;
    const p = pty.spawn('agy.exe', [], { name: 'xterm-256color', cols: 160, rows: 120, cwd: HOME, env });
    let raw = '';
    p.onData(d => { raw += d; });
    const strip = s => s.replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, ' ').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b[=>]/g, '').replace(/\r/g, '');
    const waitFor = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test(strip(raw))) return true; await new Promise(r => setTimeout(r, 250)); } return false; };
    try {
      if (!await waitFor(t => /for shortcuts|Do you trust/.test(t), 20000)) throw new Error('Antigravity did not start');
      if (/Do you trust/.test(strip(raw))) throw new Error('Antigravity asks to trust your home folder. Run agy once there and accept.');
      p.write('/usage');
      await new Promise(r => setTimeout(r, 900));
      p.write('\r');
      await waitFor(t => /Limit Remaining[\s\S]*Limit Remaining/.test(t.slice(t.lastIndexOf('Models & Quota'))), 20000);
      await new Promise(r => setTimeout(r, 1500));   // let the rest render
      const text = strip(raw);
      const data = parseAgyUsage(text.slice(text.lastIndexOf('Models & Quota')));
      if (!data.groups.length) throw new Error('Could not read /usage output');
      kvSet('quota:antigravity', data);
      return data;
    } finally {
      try { p.write('\x1b'); p.kill(); } catch {}
    }
  })().finally(() => { agyRefreshing = null; });
  return agyRefreshing;
}

export function parseAgyUsage(text) {
  // Drop progress-bar block characters (U+2580–U+259F) and brackets.
  const t = text.replace(/[▀-▟\[\]]/g, ' ').replace(/[ \t]+/g, ' ');
  const account = (t.match(/Account:\s*(\S+@\S+)/) || [])[1] || '';
  const headerRe = /([A-Z][A-Z0-9][A-Z0-9 &.\-]{3,40}?)\s*(?=Models within this group|For paid)/g;
  const heads = [...t.matchAll(headerRe)].map(m => ({ name: m[1].trim(), at: m.index }));
  const groups = heads.map((h, i) => {
    const seg = t.slice(h.at, heads[i + 1]?.at ?? t.length);
    const models = ((seg.match(/Models within this group:\s*(.+?)\s*(?=Weekly|Five Hour|For paid|$)/) || [])[1] || '').trim();
    const windows = [...seg.matchAll(/(Weekly|Five Hour) Limit Remaining\s*([\d.]+)%\s*(?:Refreshes in ([0-9dhm ]+?)(?=\s*[A-Z]|$)|Quota available)?/g)]
      .map(m => ({ window: m[1] === 'Weekly' ? 'weekly' : '5h', remainingPct: Number(m[2]), refresh: (m[3] || '').trim() }));
    return { name: h.name.replace(/\s+/g, ' '), models, windows };
  }).filter(g => g.windows.length);
  return { account, groups, at: new Date().toISOString() };
}

export function getLimits() {
  const claude = kvGet('ratelimit:claude');
  const agy = kvGet('quota:antigravity');
  return {
    claude: claude && { ...claude.value, seen: claude.updated },
    codex: codexLimits(),
    antigravity: agy && { ...agy.value, seen: agy.updated },
    antigravityRefreshing: !!agyRefreshing,
  };
}
