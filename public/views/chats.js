import { api, esc, badge, ago, shortPath, snippet, $ } from '../lib.js';

export async function renderChats(view, params) {
  const state = {
    q: params.get('q') || '', tool: params.get('tool') || '', project: params.get('project') || '',
    from: params.get('from') || '', to: params.get('to') || '',
  };
  const projects = await api('/api/projects');
  view.innerHTML = `
    <div class="head"><div><h1>Chats</h1><div class="muted">Every session from every tool, newest first</div></div></div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search all transcripts…" value="${esc(state.q)}" autofocus>
      <select id="tool">
        <option value="">All tools</option>
        <option value="claude">Claude Code</option><option value="antigravity">Antigravity</option><option value="codex">Codex</option>
      </select>
      <select id="project" style="max-width:260px">
        <option value="">All projects</option>
        ${projects.map(p => `<option value="${esc(p.path)}">${esc(p.isHome ? '~ (home folder)' : p.name)} (${p.total})</option>`).join('')}
      </select>
      <input type="date" id="from" value="${esc(state.from)}" title="From">
      <input type="date" id="to" value="${esc(state.to)}" title="To">
    </div>
    <div class="panel list" id="results"></div>
    <div style="text-align:center;margin-top:12px"><button id="more" hidden>Load more</button></div>`;
  $('#tool').value = state.tool;
  $('#project').value = state.project;

  let offset = 0;
  const PAGE = 60;
  async function load(reset) {
    if (reset) offset = 0;
    const qs = new URLSearchParams({ limit: PAGE, offset });
    for (const k of ['q', 'tool', 'project', 'from', 'to']) if (state[k]) qs.set(k, state[k]);
    const rows = await api('/api/chats?' + qs);
    const html = rows.map(c => `
      <a class="item" href="#/chat/${encodeURIComponent(c.id)}">
        ${badge(c.tool, c.variant === 'ide' ? 'IDE' : c.variant === 'sdk' ? 'SDK' : '')}
        <div style="min-width:0">
          <div class="title">${esc(c.title)}</div>
          <div class="sub">${esc(shortPath(c.project || c.cwd, 3))} · ${c.msg_count} messages</div>
          ${c.snippet ? `<div class="snippet">${snippet(c.snippet)}</div>` : ''}
        </div>
        <span class="muted tiny" title="${esc(c.updated)}">${ago(c.updated)}</span>
      </a>`).join('');
    const box = $('#results');
    if (reset) box.innerHTML = html || '<div class="empty">No chats match.</div>';
    else box.insertAdjacentHTML('beforeend', html);
    offset += rows.length;
    $('#more').hidden = rows.length < PAGE;
    // Keep filters in the URL so back/forward and links work.
    const q2 = new URLSearchParams(Object.entries(state).filter(([, v]) => v));
    history.replaceState(null, '', '#/chats' + (q2.toString() ? '?' + q2 : ''));
  }

  let t;
  $('#q').addEventListener('input', e => { state.q = e.target.value; clearTimeout(t); t = setTimeout(() => load(true), 220); });
  for (const k of ['tool', 'project', 'from', 'to']) $('#' + k).addEventListener('change', e => { state[k] = e.target.value; load(true); });
  $('#more').addEventListener('click', () => load(false));
  await load(true);
}
