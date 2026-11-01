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
