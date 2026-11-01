import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HOME = os.homedir();
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.AGENT_HUB_DATA_DIR || path.join(ROOT, 'data'));
export const BACKUP_DIR = path.join(ROOT, 'backups');
export const DB_PATH = process.env.AGENT_HUB_DB || path.join(DATA_DIR, 'hub.db');

const h = (...p) => path.join(HOME, ...p);

export const P = {
  claude: {
    projects: h('.claude', 'projects'),
    skills: h('.claude', 'skills'),
    userConfig: h('.claude.json'),
    instructions: h('.claude', 'CLAUDE.md'),
    memoryDirs: () => {
      const base = h('.claude', 'projects');
      if (!fs.existsSync(base)) return [];
      return fs.readdirSync(base)
        .map(d => path.join(base, d, 'memory'))
        .filter(d => fs.existsSync(d));
    },
  },
  antigravity: {
    roots: [
      { variant: 'cli', dir: h('.gemini', 'antigravity-cli') },
      { variant: 'ide', dir: h('.gemini', 'antigravity') },
    ],
    instructions: h('.gemini', 'GEMINI.md'),
  },
  codex: {
    home: h('.codex'),
    sessions: h('.codex', 'sessions'),
    config: h('.codex', 'config.toml'),
    skills: h('.codex', 'skills'),
    instructions: h('.codex', 'AGENTS.md'),
    state: h('.codex', 'state_5.sqlite'),
  },
};

// Find the newest standalone codex.exe (it is not on PATH on this machine).
export function codexExe() {
  const rel = h('.codex', 'packages', 'standalone', 'releases');
  try {
    const dirs = fs.readdirSync(rel).sort().reverse();
    for (const d of dirs) {
      const exe = path.join(rel, d, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {}
  return 'codex';
}

export function ensureDirs() {
  for (const d of [DATA_DIR, BACKUP_DIR]) fs.mkdirSync(d, { recursive: true });
}

// Normalize a folder path so chats from different tools group together.
export function normPath(p) {
  if (!p) return '';
  let s = String(p);
  if (s.startsWith('file:///')) s = decodeURIComponent(s.slice(8));
  else if (s.startsWith('file://')) s = decodeURIComponent(s.slice(7));
  s = s.replace(/\//g, '\\').replace(/\\+$/, '');
  if (/^[a-z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1);
  if (/^[A-Z]:$/.test(s)) s += '\\';
  return s;
}
