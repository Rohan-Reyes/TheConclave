import { api, esc, badge, $, $$ } from '../lib.js';

// Ctrl+K: search chats, hub chats, memories and projects from anywhere.
export function openPalette() {
  const d = document.createElement('dialog');
  d.className = 'palette';
  d.innerHTML = `<input placeholder="Search chats, memories, projects…" autofocus><div class="pal-results"><div class="empty small">Type to search everything.</div></div>`;
  document.body.appendChild(d);
  d.showModal();
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', e => { if (e.target === d) d.close(); });
  const input = $('input', d), box = $('.pal-results', d);
  let sel = 0, t;
  const items = () => $$('.pal-item', box);
  const mark = () => items().forEach((el, i) => el.classList.toggle('sel', i === sel));
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 150); });
  input.addEventListener('keydown', e => {
    const n = items().length;
    if (e.key === 'ArrowDown') { sel = Math.min(n - 1, sel + 1); mark(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); mark(); e.preventDefault(); }
    else if (e.key === 'Enter' && n) { items()[sel].click(); }
  });
  box.addEventListener('click', e => { if (e.target.closest('.pal-item')) setTimeout(() => d.close(), 0); });

  async function run() {
    const q = input.value.trim();
    if (!q) { box.innerHTML = '<div class="empty small">Type to search everything.</div>'; return; }
    const r = await api('/api/search?q=' + encodeURIComponent(q));
    const group = (title, rows, fn) => rows.length ? `<div class="pal-group">${title}</div>${rows.map(fn).join('')}` : '';
    box.innerHTML = [
      group('Conclave chats', r.threads, x => `<a class="pal-item" href="#/hub/${x.id}"><span class="tgt ${x.target}">${esc(x.target)}</span><span class="t">${esc(x.title)}</span></a>`),
      group('Chat history', r.chats, x => `<a class="pal-item" href="#/chat/${encodeURIComponent(x.id)}">${badge(x.tool)}<span class="t">${esc(x.title)}</span></a>`),
      group('Memories', r.memories, x => `<a class="pal-item" href="#/memory?q=${encodeURIComponent(q)}"><span class="chip">${esc(x.type)}</span><span class="t">${esc(x.title)}</span></a>`),
      group('Projects', r.projects, x => `<a class="pal-item" href="#/project/${encodeURIComponent(x.path)}"><span class="chip">${x.total}</span><span class="t">${esc(x.name)} <span class="muted tiny">${esc(x.path)}</span></span></a>`),
    ].join('') || '<div class="empty small">No matches.</div>';
    sel = 0; mark();
  }
}
