// Store user attachments inside the selected project's own private directory.
// Images are identified by their bytes. All source/text files get a .txt suffix,
// so HTML, SVG and scripts cannot become active documents in a file preview.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { TextDecoder } from 'node:util';

export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const TEXT_EXTENSION = /\.(?:txt|md|markdown|json|jsonl|ya?ml|toml|csv|tsv|log|ini|cfg|conf|xml|css|scss|less|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|c|cc|cpp|h|hpp|java|kt|sql|sh|ps1|bat|cmd|html?|svg|vue|svelte|r|swift|lua|php|gitignore|env|example)$/i;
const RASTER_EXTENSION = /\.(?:png|jpe?g|webp|gif)$/i;
const INERT_WEB_EXTENSION = /\.(?:html?|svg|js|mjs|cjs|ts|tsx|jsx|php|cgi|pl|sh|ps1|bat|cmd)$/i;
const EXECUTABLE_EXTENSION = /\.(?:exe|dll|so|dylib|msi|com|scr|sys)$/i;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const same = (a, b) => key(path.resolve(a)) === key(path.resolve(b));
function within(root, file) {
  const relative = path.relative(root, file);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function absoluteFolder(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw fail('An absolute project folder is required');
  return path.resolve(value);
}
function checkedDirectory(file, root) {
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink() || !st.isDirectory()) throw fail('Attachment folders must be real directories, not symbolic links or junctions', 403);
  const real = fs.realpathSync.native(file);
  if (root && !within(root, real)) throw fail('Attachment folder is outside the project', 403);
  return real;
}
function childDirectory(parent, name, root) {
  const child = path.join(parent, name);
  try { fs.mkdirSync(child, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return checkedDirectory(child, root);
}

function imageType(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') return 'png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return 'jpg';
  if (bytes.length >= 13 && /^(GIF87a|GIF89a)$/.test(bytes.toString('ascii', 0, 6))) return 'gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return 'webp';
  return null;
}

export function decodeAttachment(data, encoding = 'base64', limit = MAX_ATTACHMENT_BYTES) {
  if (typeof data !== 'string') throw fail('Attachment data must be a string');
  if (encoding !== 'base64' && encoding !== 'utf8') throw fail('Only base64 and utf8 attachment encodings are supported');
  if (encoding === 'utf8') {
    if (Buffer.byteLength(data, 'utf8') > limit) throw fail('Attachments must fit within the 4MB limit', 413);
    return Buffer.from(data, 'utf8');
  }
  if (data.length > Math.ceil(limit / 3) * 4) throw fail('Attachments must fit within the 4MB limit', 413);
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw fail('Attachment base64 data is invalid');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > limit) throw fail('Attachments must fit within the 4MB limit', 413);
  if (bytes.toString('base64') !== data) throw fail('Attachment base64 data is not canonical');
  return bytes;
}

function prepareFile(input, limit) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Each attachment must be a file object');
  const rawName = input.filename ?? input.name ?? 'attachment.txt';
  if (typeof rawName !== 'string' || rawName.length > 1024 || rawName.includes('\0')) throw fail('Attachment filename is invalid');
  const originalName = path.posix.basename(rawName.replace(/\\/g, '/')).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 100) || 'attachment.txt';
  const bytes = decodeAttachment(input.data, input.encoding ?? 'base64', limit);
  const image = imageType(bytes);

  if (EXECUTABLE_EXTENSION.test(originalName)) {
    throw fail('Executable files cannot be attached');
  }

  if (image) {
    // Valid image bytes
  } else {
    if (RASTER_EXTENSION.test(originalName)) {
      throw fail('Image contents do not match a supported PNG, JPEG, GIF or WebP image');
    }
    if (/\.txt$/i.test(originalName)) {
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw fail('Text attachments must contain valid UTF-8'); }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw fail('Binary content is not supported as a text attachment');
    } else if (INERT_WEB_EXTENSION.test(originalName)) {
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw fail('Text attachments must contain valid UTF-8'); }
    }
    // All other filetypes including PDFs, Office docs, archives, audio, video, datasets are allowed
  }

  const namePart = originalName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 70) || 'attachment';
  const ext = path.extname(originalName).toLowerCase();
  let finalSuffix;
  if (image) {
    finalSuffix = `.${image}`;
  } else if (INERT_WEB_EXTENSION.test(originalName) || /\.txt$/i.test(originalName)) {
    finalSuffix = '.txt';
  } else if (ext && /^\.[a-z0-9_-]{1,15}$/.test(ext)) {
    finalSuffix = ext;
  } else {
    finalSuffix = '.bin';
  }

  const filename = `${crypto.randomUUID()}-${namePart}${finalSuffix}`;
  return { filename, originalName, bytes, isImage: !!image };
}

export class AttachmentStore {
  constructor({ getThread, quickRoot = path.join(os.homedir(), 'Conclave'), maxBytes = MAX_ATTACHMENT_BYTES } = {}) {
    if (typeof getThread !== 'function') throw new TypeError('AttachmentStore requires getThread');
    this.getThread = getThread;
    this.quickRoot = absoluteFolder(quickRoot);
    this.maxBytes = Math.min(MAX_ATTACHMENT_BYTES, Math.max(1, maxBytes));
  }

  project({ threadId, cwd } = {}) {
    let thread;
    if (threadId !== undefined && threadId !== null) {
      if (typeof threadId !== 'string' || !threadId.trim()) throw fail('Thread not found', 404);
      try { thread = this.getThread(threadId); } catch { throw fail('Thread not found', 404); }
      if (!thread || typeof thread.cwd !== 'string') throw fail('Thread not found', 404);
      // A caller cannot redirect an existing thread's upload into another folder.
      if (cwd !== undefined && !same(absoluteFolder(cwd), absoluteFolder(thread.cwd))) throw fail('Attachment folder must match the chat project', 403);
      cwd = thread.cwd;
    }
    const requested = absoluteFolder(cwd);
    if (thread?.settings?.quick && within(this.quickRoot, requested) && fs.existsSync(requested)) {
      const rootParent = fs.realpathSync.native(path.dirname(this.quickRoot));
      const quick = checkedDirectory(this.quickRoot, rootParent);
      let current = quick;
      for (const part of path.relative(this.quickRoot, requested).split(path.sep).filter(Boolean)) current = checkedDirectory(path.join(current, part), quick);
      return current;
    }
    if (!fs.existsSync(requested)) {
      if (!thread?.settings?.quick || !within(this.quickRoot, requested) || same(this.quickRoot, requested)) throw fail('Project folder does not exist', 404);
      // Only missing quick-chat directories may be created. Create the quick root
      // and child segments individually, checking every existing component.
      const rootParent = fs.realpathSync.native(path.dirname(this.quickRoot));
      const quick = childDirectory(rootParent, path.basename(this.quickRoot), rootParent);
      const relative = path.relative(this.quickRoot, requested);
      let current = quick;
      for (const part of relative.split(path.sep)) current = childDirectory(current, part, quick);
      return current;
    }
    const real = fs.realpathSync.native(requested);
    if (!fs.statSync(real).isDirectory()) throw fail('Project folder is not a directory');
    return real;
  }

  resolveDirectory(options) {
    const root = this.project(options);
    const privateDir = childDirectory(root, '.conclave', root);
    return childDirectory(privateDir, 'attachments', root);
  }

  verifyDirectory(root, dir) {
    const privateDir = checkedDirectory(path.join(root, '.conclave'), root);
    const real = checkedDirectory(path.join(privateDir, 'attachments'), root);
    if (!same(real, dir)) throw fail('Attachment directory changed while saving', 403);
  }

  upload({ threadId, cwd, files } = {}) {
    // Validate the authoritative thread before decoding or creating directories.
    const root = this.project({ threadId, cwd });
    if (!Array.isArray(files) || !files.length || files.length > 10) throw fail('Choose between 1 and 10 attachments');
    const prepared = files.map(file => prepareFile(file, this.maxBytes));
    if (prepared.reduce((total, file) => total + file.bytes.length, 0) > this.maxBytes) throw fail('Attachments together must fit within the 4MB limit', 413);
    const dir = this.resolveDirectory({ threadId, cwd });
    const saved = [];
    try {
      for (const file of prepared) {
        this.verifyDirectory(root, dir);
        const target = path.join(dir, file.filename);
        let fd;
        try {
          fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
          this.verifyDirectory(root, dir);
          if (!within(root, fs.realpathSync.native(target))) throw fail('Attachment escaped the project folder', 403);
          fs.writeFileSync(fd, file.bytes);
        } finally { if (fd !== undefined) fs.closeSync(fd); }
        saved.push({ filename: file.filename, originalName: file.originalName, path: target,
          size: file.bytes.length, isImage: file.isImage,
          url: file.isImage ? `/api/file/raw?path=${encodeURIComponent(target)}` : null });
      }
    } catch (error) {
      // Roll back this batch only; never remove an arbitrary caller-supplied path.
      this.verifyDirectory(root, dir);
      for (const file of saved) fs.unlinkSync(file.path);
      throw error;
    }
    return { ok: true, files: saved, file: saved[0], dir };
  }

  list(options) {
    const root = this.project(options);
    const dir = this.resolveDirectory(options);
    this.verifyDirectory(root, dir);
    const files = fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile()).slice(0, 200).map(entry => {
      const file = path.join(dir, entry.name);
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > this.maxBytes || !within(root, fs.realpathSync.native(file))) return null;
        const head = Buffer.alloc(Math.min(st.size, 24));
        fs.readSync(fd, head, 0, head.length, 0);
        const isImage = RASTER_EXTENSION.test(entry.name) && (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || /^(GIF87a|GIF89a)$/.test(head.toString('ascii', 0, 6)) || head[0] === 255 && head[1] === 216 || head.toString('ascii', 8, 12) === 'WEBP');
        return { filename: entry.name, path: file, size: st.size, mtime: st.mtime.toISOString(), isImage,
          url: isImage ? `/api/file/raw?path=${encodeURIComponent(file)}` : null };
      } finally { fs.closeSync(fd); }
    }).filter(Boolean).sort((a, b) => b.mtime.localeCompare(a.mtime));
    return { dir, files };
  }
}
