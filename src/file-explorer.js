import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const MAX_UPLOAD = 4 * 1024 * 1024;
const MAX_TEXT = 512 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Every request resolves inside one workspace; symlinks are never followed.
export class FileExplorer {
  constructor(root = process.env.CONCLAVE_FILES_ROOT || path.join(os.homedir(), 'Conclave')) {
    fs.mkdirSync(root, { recursive: true });
    this.root = fs.realpathSync(root);
  }
  resolve(input = '', { missing = false } = {}) {
    if (typeof input !== 'string' || input.includes('\0') || input.includes('\\') || path.isAbsolute(input)) throw fail('Use a relative workspace path');
    const parts = input.split('/').filter(Boolean);
    if (parts.some(p => p === '.' || p === '..' || /[:<>"|?*]/.test(p) || /[. ]$/.test(p))) throw fail('Invalid workspace path');
    let target = this.root;
    for (let i = 0; i < parts.length; i++) {
      target = path.join(target, parts[i]);
      let st;
      try { st = fs.lstatSync(target); }
      catch (e) { if (missing && i === parts.length - 1 && e.code === 'ENOENT') return target; throw fail('Path not found', 404); }
      if (st.isSymbolicLink()) throw fail('Symbolic links are not available in the file explorer', 403);
      if (i < parts.length - 1 && !st.isDirectory()) throw fail('Parent is not a folder');
    }
    const rel = path.relative(this.root, target);
    if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) throw fail('Path is outside the workspace', 403);
    return target;
  }
  relative(file) { return path.relative(this.root, file).split(path.sep).join('/'); }
  list(input = '') {
    const folder = this.resolve(input);
    if (!fs.statSync(folder).isDirectory()) throw fail('Choose a folder');
    const names = fs.readdirSync(folder, { withFileTypes: true });
    const entries = names.slice(0, 2000).map(e => {
      const blocked = e.isSymbolicLink();
      const st = fs.lstatSync(path.join(folder, e.name));
      return { name: e.name, path: this.relative(path.join(folder, e.name)), directory: e.isDirectory(), blocked, size: st.size, modified: st.mtime.toISOString() };
    }).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    return { root: this.root, path: this.relative(folder), entries, truncated: names.length > 2000 };
  }
  mkdir(input) {
    if (!input) throw fail('Enter a folder name');
    const target = this.resolve(input, { missing: true });
    try { fs.mkdirSync(target); } catch (e) { if (e.code === 'EEXIST') throw fail('A file or folder already exists', 409); throw e; }
    return { path: this.relative(target) };
  }
  upload({ path: input, base64 }) {
    if (!input) throw fail('Enter a file name');
    if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_UPLOAD / 3) * 4 || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw fail('Upload must be valid base64, at most 4 MB');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > MAX_UPLOAD || bytes.toString('base64') !== base64) throw fail('Upload must be valid base64, at most 4 MB');
    const target = this.resolve(input, { missing: true });
    try { fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code === 'EEXIST') throw fail('File already exists; rename your upload or edit the existing file', 409); throw e; }
    return { path: this.relative(target), size: bytes.length };
  }
  read(input) {
    const target = this.resolve(input);
    const st = fs.statSync(target);
    if (!st.isFile()) throw fail('Choose a regular file');
    if (st.size > MAX_TEXT) throw fail('Editor supports text files up to 512 KB');
    const bytes = fs.readFileSync(target);
    if (bytes.includes(0)) throw fail('Binary files cannot be edited');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fail('Editor supports UTF-8 text files only'); }
    return { path: this.relative(target), text, etag: digest(bytes), size: bytes.length };
  }
  write({ path: input, text, etag }) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT || text.includes('\0')) throw fail('Text must be at most 512 KB without null characters');
    const current = this.read(input);
    if (!etag || etag !== current.etag) throw fail('File changed since you opened it. Reload before saving.', 409);
    fs.writeFileSync(this.resolve(input), text, 'utf8');
    return this.read(input);
  }
  rename({ path: input, destination }) {
    if (!input || !destination) throw fail('Choose a file or folder and a destination');
    const source = this.resolve(input);
    const target = this.resolve(destination, { missing: true });
    if (source === this.root || target === this.root) throw fail('Workspace root cannot be renamed');
    if (fs.existsSync(target)) throw fail('Destination already exists', 409);
    fs.renameSync(source, target);
    return { path: this.relative(target) };
  }
}

export function mountFileExplorer(app, wrap, explorer = new FileExplorer()) {
  app.get('/api/files', wrap(req => explorer.list(req.query.path || '')));
  app.get('/api/files/content', wrap(req => explorer.read(req.query.path)));
  app.put('/api/files/content', wrap(req => explorer.write(req.body)));
  app.post('/api/files/folder', wrap(req => explorer.mkdir(req.body.path)));
  app.post('/api/files/upload', wrap(req => explorer.upload(req.body)));
  app.post('/api/files/rename', wrap(req => explorer.rename(req.body)));
}
