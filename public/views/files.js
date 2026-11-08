import { api, esc, toast, modal, copy, $ } from '../lib.js';

const ICON = { created: '＋', edited: '✎', deleted: '−', mentioned: '·' };
const base = p => p.split(/[\\/]/).pop();

// Chips under a reply: files the agent touched or named, plus links it gave.
export function fileChips(files = [], content = '') {
  const links = [...new Set((String(content).match(/https?:\/\/[^\s)<>"'`\]]+/g) || []).map(u => u.replace(/[.,;:]+$/, '')))].slice(0, 8);
  if (!files.length && !links.length) return '';
  return `<div class="chips">${files.map(f => `
      <button class="fchip ${f.action}" data-file="${esc(f.path)}" title="${esc(f.action)}: ${esc(f.path)}"><span class="fi">${ICON[f.action] || '·'}</span>${esc(base(f.path))}</button>`).join('')}
    ${links.map(u => `<a class="fchip link" href="${esc(u)}" target="_blank" rel="noopener" title="${esc(u)}"><span class="fi">↗</span>${esc(u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 48))}</a>`).join('')}
    ${files.length > 1 ? `<button class="fchip ghost" data-folder="${esc(files[0].path)}" title="Show in Explorer">📂 folder</button>` : ''}
  </div>`;
}

export function bindFileChips(root) {
  root.addEventListener('click', e => {
    const f = e.target.closest('[data-file]');
    if (f) { e.preventDefault(); previewFile(f.dataset.file); }
    const d = e.target.closest('[data-folder]');
    if (d) { e.preventDefault(); openWith(d.dataset.folder, 'folder'); }
  });
}

export function openWith(p, how) {
  return api('/api/open', { method: 'POST', body: { path: p, with: how } }).then(() => toast(how === 'code' ? 'Opening in VS Code' : 'Opened'), e => toast(e.message, true));
}

export async function previewFile(p) {
  let f;
  try { f = await api('/api/file?path=' + encodeURIComponent(p)); }
  catch (e) { toast(`${base(p)}: ${e.message}`, true); return; }
  const body = f.kind === 'image' ? `<div class="fprev-img"><img src="/api/file/raw?path=${encodeURIComponent(f.path)}" alt="${esc(base(f.path))}"></div>`
    : f.kind === 'text' ? `<pre class="fprev">${esc(f.text)}${f.truncated ? '\n\n… (file truncated at 512 KB)' : ''}</pre>`
    : f.kind === 'dir' ? `<div class="list panel">${f.entries.map(x => `<div class="item" style="grid-template-columns:auto 1fr">${x.dir ? '📁' : '📄'}<span class="mono small">${esc(x.name)}</span></div>`).join('')}</div>`
    : `<div class="empty">Binary file (${(f.size / 1024).toFixed(1)} KB). Open it with its app.</div>`;
  modal(`
    <div class="row" style="justify-content:space-between;align-items:flex-start;gap:12px">
      <div style="min-width:0"><h2 style="margin:0;overflow-wrap:anywhere">${esc(base(f.path))}</h2>
        <div class="mono tiny muted" style="overflow-wrap:anywhere">${esc(f.path)}${f.size != null ? ` · ${(f.size / 1024).toFixed(1)} KB · ${new Date(f.mtime).toLocaleString()}` : ''}</div></div>
      <button id="fp-x" class="icon-btn" title="Close">✕</button>
    </div>
    ${body}
    <div class="modal-actions">
      <button id="fp-copy">Copy path</button>
      <button id="fp-folder">Show in folder</button>
      ${f.kind !== 'dir' ? '<button id="fp-open">Open</button>' : ''}
      <button class="primary" id="fp-code">Open in VS Code</button>
    </div>`, (root, close) => {
    $('#fp-x', root).onclick = close;
    $('#fp-copy', root).onclick = () => copy(f.path);
    $('#fp-folder', root).onclick = () => openWith(f.path, 'folder');
    $('#fp-open', root)?.addEventListener('click', () => openWith(f.path, 'default'));
    $('#fp-code', root).onclick = () => openWith(f.path, 'code');
  });
}



export async function renderFiles(view, params) {
  let folder = params.get('path') || '';
  let opened = null;
  let dirty = false;
  const join = name => [folder, name].filter(Boolean).join('/');
  const safeName = name => !!name && !/[\\/]/.test(name) && name !== '.' && name !== '..';
  view.innerHTML = `<style>
    .files-layout{display:grid;grid-template-columns:minmax(240px,1fr) minmax(0,2fr);gap:16px}.files-tools,.files-crumbs{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}.files-list{max-height:65vh;overflow:auto}.files-entry{display:flex;gap:8px;align-items:center;padding:8px;border-bottom:1px solid var(--border)}.files-entry>button:first-child{flex:1;text-align:left;overflow-wrap:anywhere;min-width:0}.files-editor{width:100%;box-sizing:border-box;min-height:45vh;resize:vertical;font-family:monospace;tab-size:2}.files-path{overflow-wrap:anywhere}.files-status{min-height:1.5em}.files-upload{position:absolute;width:1px;height:1px;opacity:0}
    @media(max-width:700px){.files-layout{grid-template-columns:1fr}.files-list{max-height:35vh}.files-tools button,.files-entry button{min-height:44px}.files-editor{font-size:16px}}
  </style><div class="head"><div><h1>Files</h1><p class="muted">Upload files, manage folders and edit UTF-8 text in your workspace.</p></div></div>
    <div class="tiny muted files-path" id="files-root"></div><div class="files-crumbs" id="files-crumbs" aria-label="Folder breadcrumb"></div>
    <div class="files-tools"><button id="files-upload-btn">Upload files</button><input class="files-upload" id="files-upload" type="file" multiple aria-label="Choose files to upload"><button id="files-new-folder">New folder</button><button id="files-new-file">New text file</button><button id="files-refresh">Refresh</button><a class="btn" id="files-chat" href="#/hub">Chat in this folder</a></div>
    <div role="status" class="files-status small" id="files-status"></div>
    <div class="files-layout"><div class="panel files-list" id="files-list"></div><div class="panel pad"><div class="files-tools"><strong class="files-path" id="files-open-name">Text editor</strong><button id="files-save" disabled>Save</button><button id="files-reload" disabled>Reload</button></div><textarea id="files-editor" class="files-editor" aria-label="File contents" spellcheck="false" disabled placeholder="Choose a text file to edit"></textarea><p class="tiny muted">Edits are limited to 512 KB. Saving detects changes made since you opened the file.</p></div></div>`;
  const status = (message, error = false) => { const el = $('#files-status', view); el.textContent = message; el.style.color = error ? 'var(--danger)' : ''; };
  const guard = fn => async (...args) => { try { await fn(...args); } catch (e) { status(e.message, true); toast(e.message, true); } };
  const abandon = () => !dirty || window.confirm('Discard your unsaved file edits?');
  async function openFile(file) {
    if (!abandon()) return;
    const data = await api('/api/files/content?path=' + encodeURIComponent(file));
    opened = data; dirty = false;
    $('#files-open-name', view).textContent = data.path;
    $('#files-editor', view).disabled = false; $('#files-editor', view).value = data.text;
    $('#files-save', view).disabled = true; $('#files-reload', view).disabled = false;
    status(`Opened ${data.path}`);
  }
  async function load() {
    const data = await api('/api/files?path=' + encodeURIComponent(folder));
    folder = data.path;
    $('#files-root', view).textContent = data.root;
    $('#files-chat', view).href = '#/hub?new=1&cwd=' + encodeURIComponent(data.root.replace(/[\\/]$/, '') + (folder ? '/' + folder : ''));
    const parts = folder.split('/').filter(Boolean);
    $('#files-crumbs', view).innerHTML = `<button data-folder="">Workspace</button>${parts.map((part, i) => `<span>/</span><button data-folder="${esc(parts.slice(0, i + 1).join('/'))}">${esc(part)}</button>`).join('')}`;
    $('#files-crumbs', view).querySelectorAll('[data-folder]').forEach(b => b.onclick = guard(async () => { folder = b.dataset.folder; await load(); }));
    $('#files-list', view).innerHTML = data.entries.map(e => `<div class="files-entry"><button data-open="${esc(e.path)}" data-dir="${e.directory ? '1' : ''}" ${e.blocked ? 'disabled title="Symbolic link blocked"' : ''}>${e.blocked ? '↗' : e.directory ? '📁' : '📄'} ${esc(e.name)}${e.blocked ? ' (link unavailable)' : ''}</button>${e.blocked ? '' : `<button class="small" data-rename="${esc(e.path)}" aria-label="Rename ${esc(e.name)}">Rename</button>`}</div>`).join('') || '<div class="empty">Empty folder. Upload a file or create a folder.</div>';
    $('#files-list', view).querySelectorAll('[data-open]').forEach(b => b.onclick = guard(async () => { if (b.dataset.dir) { folder = b.dataset.open; await load(); } else await openFile(b.dataset.open); }));
    $('#files-list', view).querySelectorAll('[data-rename]').forEach(b => b.onclick = guard(async () => {
      if (opened && dirty && !abandon()) return;
      const old = b.dataset.rename;
      const name = window.prompt('New name', old.split('/').pop());
      if (name === null) return;
      if (!safeName(name)) throw new Error('Enter a name without path separators');
      const destination = join(name);
      await api('/api/files/rename', { method: 'POST', body: { path: old, destination } });
      if (opened?.path === old || opened?.path.startsWith(old + '/')) {
        opened = null; dirty = false; $('#files-editor', view).value = ''; $('#files-editor', view).disabled = true;
        $('#files-save', view).disabled = true; $('#files-reload', view).disabled = true; $('#files-open-name', view).textContent = 'Text editor';
      }
      await load(); status('Renamed successfully');
    }));
    if (data.truncated) status('Showing the first 2,000 entries.');
  }
  $('#files-editor', view).oninput = () => { dirty = true; $('#files-save', view).disabled = !opened; status('Unsaved changes'); };
  $('#files-save', view).onclick = guard(async () => {
    if (!opened) return;
    const button = $('#files-save', view); button.disabled = true;
    try { opened = await api('/api/files/content', { method: 'PUT', body: { path: opened.path, etag: opened.etag, text: $('#files-editor', view).value } }); dirty = false; status('Saved'); }
    finally { button.disabled = !dirty; }
  });
  $('#files-reload', view).onclick = guard(async () => { if (opened) await openFile(opened.path); });
  $('#files-refresh', view).onclick = guard(load);
  $('#files-new-folder', view).onclick = guard(async () => {
    const name = window.prompt('Folder name'); if (name === null) return;
    if (!safeName(name)) throw new Error('Enter a folder name without path separators');
    await api('/api/files/folder', { method: 'POST', body: { path: join(name) } }); await load(); status('Folder created');
  });
  $('#files-new-file', view).onclick = guard(async () => {
    if (!abandon()) return;
    const name = window.prompt('File name', 'notes.txt'); if (name === null) return;
    if (!safeName(name)) throw new Error('Enter a file name without path separators');
    await api('/api/files/upload', { method: 'POST', body: { path: join(name), base64: '' } }); dirty = false; await load(); await openFile(join(name));
  });
  $('#files-upload-btn', view).onclick = () => $('#files-upload', view).click();
  $('#files-upload', view).onchange = guard(async e => {
    const files = [...e.target.files];
    try {
      for (const file of files) {
        if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name}: uploads are limited to 4 MB per file`);
        const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
        await api('/api/files/upload', { method: 'POST', body: { path: join(file.name), base64 } });
      }
      status(`Uploaded ${files.length} file${files.length === 1 ? '' : 's'}`);
    } finally { e.target.value = ''; await load(); }
  });
  await load();
}
