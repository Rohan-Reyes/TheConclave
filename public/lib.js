export const $ = (s, root = typeof document !== 'undefined' ? document : null) => root?.querySelector(s);
export const $$ = (s, root = typeof document !== 'undefined' ? document : null) => root ? [...root.querySelectorAll(s)] : [];

export async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
export function toast(msg, isErr = false) {
  if (typeof document === 'undefined') return;
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, isErr ? 6000 : 2600);
}

export const TOOL_LABEL = { claude: 'Claude Code', antigravity: 'Antigravity', codex: 'Codex', hub: 'Conclave', import: 'Import', mcp: 'MCP' };
export const badge = (tool, extra = '') => `<span class="badge ${esc(tool)}">${esc(TOOL_LABEL[tool] || tool)}${extra ? ' · ' + esc(extra) : ''}</span>`;

export function ago(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const s = (Date.now() - d) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function shortPath(p, keep = 2) {
  if (!p) return '';
  const parts = p.split('\\');
  return parts.length > keep + 1 ? '…\\' + parts.slice(-keep).join('\\') : p;
}

// Small, safe markdown renderer: escapes first, then formats.
export function md(src) {
  const blocks = [];
  let s = String(src ?? '').replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const raw = code.replace(/\n$/, '');
    const l = lang ? lang.trim() : '';
    blocks.push(`<div class="code-block"><div class="code-head"><span class="code-lang">${esc(l || 'code')}</span><button type="button" class="btn-copy-code ghost tiny" data-copy="code" title="Copy code snippet">Copy</button></div><pre><code>${esc(raw)}</code></pre></div>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = esc(s);
  const inline = t => t
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null, para = [], table = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join('<br>'))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.filter(r => !/^\|?\s*:?-{2,}/.test(r)).map(r => r.replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim())));
    out.push('<table>' + rows.map((r, i) => `<tr>${r.map(c => i ? `<td>${c}</td>` : `<th>${c}</th>`).join('')}</tr>`).join('') + '</table>');
    table = [];
  };
  for (const line of s.split('\n')) {
    let m;
    if (/^\u0000\d+\u0000$/.test(line.trim())) { flushPara(); flushList(); flushTable(); out.push(line.trim()); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { flushPara(); flushList(); table.push(line.trim()); continue; } else flushTable();
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); flushList(); out.push(`<h3>${inline(m[2])}</h3>`); continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { flushPara(); if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList(); para.push(line);
  }
  flushPara(); flushList(); flushTable();
  return out.join('\n').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
}

// Highlight search snippets: server marks matches with [[ ]] or [ ].
export function snippet(s) {
  return esc(s).replace(/\[\[(.*?)\]\]/g, '<mark>$1</mark>');
}

export function modal(html, onMount) {
  if (typeof document === 'undefined') return () => {};
  const d = $('#modal');
  if (!d) return () => {};
  $('#modal-body').innerHTML = html;
  d.showModal();
  onMount?.($('#modal-body'), () => d.close());
  return () => d.close();
}

export function renderDiff(lines) {
  if (!lines.some(l => l.op === '+' || l.op === '-')) return '<div class="muted small">No changes.</div>';
  return `<div class="diff">${lines.map(l =>
    `<div class="${l.op === '+' ? 'add' : l.op === '-' ? 'del' : l.op === '~' ? 'gap' : ''}">${l.op === '~' ? '' : esc(l.op) + ' '}${esc(l.text)}</div>`).join('')}</div>`;
}

export async function copy(text) {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return;
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
  catch { toast('Clipboard blocked by the browser', true); }
}

// Global click handler for code copy
if (typeof document !== 'undefined') {
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-copy="code"]');
    if (!btn) return;
    const codeEl = btn.closest('.code-block')?.querySelector('pre > code');
    if (!codeEl) return;
    copy(codeEl.textContent);
    const old = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = old;
      btn.classList.remove('copied');
    }, 1800);
  });
}
