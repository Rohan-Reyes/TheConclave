import fs from 'node:fs';
import { createHash } from 'node:crypto';
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
  const skills = Object.create(null);   // folder name -> { description, in: {target: path} }
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
  if (!Object.hasOwn(SKILL_DIRS, from) || !Object.hasOwn(SKILL_DIRS, to)) throw new Error('unknown target');
  const src = path.join(SKILL_DIRS[from].dir, folder);
  const dest = path.join(SKILL_DIRS[to].dir, folder);
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error('source skill not found');
  if (fs.existsSync(dest)) throw new Error(`${SKILL_DIRS[to].label} already has a skill named ${folder}`);
  fs.mkdirSync(SKILL_DIRS[to].dir, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, filter: p => !/desktop\.ini$/i.test(p) });
  return { dest };
}

// Install a reviewed local package or pasted SKILL.md. No package code is run.
const MAX_FILES=200, MAX_BYTES=2*1024*1024;
function packageFiles(input) {
  const name=input.name;
  if(typeof name!=='string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))throw new Error('Use a lowercase skill name with letters, digits and hyphens');
  const files=[];let bytes=0;
  const add=(relative,content,mode=0o600)=>{
    bytes+=content.length;
    if(files.length>=MAX_FILES || bytes>MAX_BYTES)throw new Error('Skill packages are limited to 200 files and 2 MB');
    files.push({relative,content,mode});
  };
  if(input.source) {
    if(typeof input.source!=='string' || !path.isAbsolute(input.source))throw new Error('Choose an absolute source folder on the server');
    const root=path.resolve(input.source);
    if(fs.lstatSync(root).isSymbolicLink() || !fs.statSync(root).isDirectory())throw new Error('Source must be a directory, not a symlink');
    const visit=(dir,depth=0)=>{
      if(depth>12)throw new Error('Skill directory is too deeply nested');
      for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
        if(entry.name.startsWith('.') || entry.name==='node_modules' || /^desktop\.ini$/i.test(entry.name))continue;
        const file=path.join(dir,entry.name);
        if(entry.isSymbolicLink())throw new Error('Skill packages cannot contain symlinks');
        if(entry.isDirectory())visit(file,depth+1);
        else if(entry.isFile()){
          const stat=fs.statSync(file);if(stat.size>MAX_BYTES-bytes)throw new Error('Skill package exceeds 2 MB');
          add(path.relative(root,file),fs.readFileSync(file),0o600 | (stat.mode & 0o100));
        }else throw new Error('Unsupported file type in skill package');
      }
    };visit(root);
  } else {
    if(typeof input.content!=='string' || !input.content.trim())throw new Error('Choose a source folder or paste a SKILL.md document');
    add('SKILL.md',Buffer.from(input.content));
  }
  const main=files.find(file=>file.relative==='SKILL.md')?.content.toString('utf8');
  const front=main?.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const field=key=>front?.[1].match(new RegExp(`^${key}:\\s*(.+)$`,'m'))?.[1]?.trim().replace(/^["']|["']$/g,'');
  if(field('name')!==name || !field('description'))throw new Error('SKILL.md needs frontmatter with a matching name and a description');
  if(!Array.isArray(input.targets) || !input.targets.length || input.targets.some(target=>!Object.hasOwn(SKILL_DIRS,target)))throw new Error('Choose supported skill targets');
  const targets=[...new Set(input.targets)];
  for(const target of targets){const parent=SKILL_DIRS[target].dir;if(fs.existsSync(path.join(parent,name)))throw new Error(`${SKILL_DIRS[target].label} already has ${name}`);}
  return {name,description:field('description'),files,targets};
}
function packageDigest(pkg) {
  const hash=createHash('sha256');hash.update(JSON.stringify({name:pkg.name,targets:pkg.targets}));
  for(const file of pkg.files){hash.update(file.relative);hash.update(String(file.mode));hash.update('\0');hash.update(String(file.content.length));hash.update('\0');hash.update(file.content);}
  return hash.digest('hex');
}
export function previewInstall(input) {
  const pkg=packageFiles(input);
  return {name:pkg.name,description:pkg.description,targets:pkg.targets,files:pkg.files.map(file=>({path:file.relative,bytes:file.content.length})),digest:packageDigest(pkg)};
}
export function installSkill(input) {
  const pkg=packageFiles(input);
  if(input.digest!==packageDigest(pkg))throw new Error('The package changed or was not reviewed; preview it again');
  const staged=[],installed=[];
  try {
    for(const target of pkg.targets) {
      const parent=SKILL_DIRS[target].dir;fs.mkdirSync(parent,{recursive:true});
      const tmp=fs.mkdtempSync(path.join(parent,'.install-'));staged.push(tmp);
      for(const file of pkg.files){const destination=path.join(tmp,file.relative);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,file.content,{mode:file.mode,flag:'wx'});}
      const destination=path.join(parent,pkg.name);
      // Never overwrite an existing installation. The directory contains SKILL.md,
      // so a competing install cannot be silently replaced by rename.
      if(fs.existsSync(destination))throw new Error('A target skill was installed since preview; review again');
      fs.renameSync(tmp,destination);installed.push(destination);
    }
    return {ok:true,name:pkg.name,installed};
  }catch(error){for(const destination of installed)fs.rmSync(destination,{recursive:true,force:true});throw error;}
  finally{for(const tmp of staged)fs.rmSync(tmp,{recursive:true,force:true});}
}
