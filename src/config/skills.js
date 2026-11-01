import fs from 'node:fs';
import path from 'node:path';
import { HOME } from '../paths.js';

export const SKILL_DIRS = {
  claude: { label: 'Claude Code', dir: path.join(HOME, '.claude', 'skills') },
  'antigravity-cli': { label: 'Antigravity CLI', dir: path.join(HOME, '.gemini', 'antigravity-cli', 'skills') },
  'antigravity-ide': { label: 'Antigravity IDE', dir: path.join(HOME, '.gemini', 'antigravity', 'skills') },
  codex: { label: 'Codex', dir: path.join(HOME, '.codex', 'skills') },
};

function describe(skillDir) {
  const md = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(md)) return null;
  const text = fs.readFileSync(md, 'utf8');
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const get = k => fm?.[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.replace(/^["']|["']$/g, '') || '';
  return { name: get('name') || path.basename(skillDir), description: get('description') };
}

export function listSkills() {
  const skills = {};   // folder name -> { description, in: {target: path} }
  for (const [target, { dir }] of Object.entries(SKILL_DIRS)) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')); } catch {}
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const d = describe(p);
      if (!d) continue;   // not a skill folder (e.g. Claude's internal "synced")
      const s = (skills[e.name] ||= { folder: e.name, name: d.name, description: d.description, in: {} });
      s.in[target] = p;
    }
  }
  return {
    targets: Object.fromEntries(Object.entries(SKILL_DIRS).map(([k, v]) => [k, { label: v.label, dir: v.dir }])),
    skills: Object.values(skills).sort((a, b) => a.folder.localeCompare(b.folder)),
  };
}

export function copySkill(folder, from, to) {
  if (!/^[\w.-]+$/.test(folder)) throw new Error('bad skill name');
  if (!SKILL_DIRS[from] || !SKILL_DIRS[to]) throw new Error('unknown target');
  const src = path.join(SKILL_DIRS[from].dir, folder);
  const dest = path.join(SKILL_DIRS[to].dir, folder);
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error('source skill not found');
  if (fs.existsSync(dest)) throw new Error(`${SKILL_DIRS[to].label} already has a skill named ${folder}`);
  fs.mkdirSync(SKILL_DIRS[to].dir, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, filter: p => !/desktop\.ini$/i.test(p) });
  return { dest };
}
