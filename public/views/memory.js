import { api, esc, badge, ago, md, toast, modal, $ } from '../lib.js';

const TYPES = ['user', 'feedback', 'project', 'reference'];

// Shared add/edit dialog (also used from the chat page).
export function memoryForm(m = {}, onSaved) {
  const editing = !!m.id;
  modal(`
    <h2 style="margin:0">${editing ? 'Edit memory' : 'New memory'}</h2>
    <label class="field">Title<input id="m-title" value="${esc(m.title || '')}" placeholder="One-line summary"></label>
    <div class="row">
      <label class="field grow">Type<select id="m-type">${TYPES.map(t => `<option ${t === (m.type || 'reference') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="field grow" style="flex-basis:340px">Scope (global, or a project folder)<input id="m-scope" value="${esc(m.scope || 'global')}"></label>
    </div>
    <label class="field">Body (markdown)<textarea id="m-body" rows="12">${esc(m.body || '')}</textarea></label>
    <label class="field">Tags (comma separated)<input id="m-tags" value="${esc(m.tags || '')}"></label>
    <div class="modal-actions">
      ${editing ? '<button class="danger" id="m-del" style="margin-right:auto">Delete</button>' : ''}
      <button id="m-cancel">Cancel</button><button class="primary" id="m-save">Save</button>
    </div>`, (root, close) => {
    $('#m-cancel', root).onclick = close;
    $('#m-save', root).onclick = async () => {
      const body = { title: $('#m-title', root).value, type: $('#m-type', root).value, scope: $('#m-scope', root).value, body: $('#m-body', root).value, tags: $('#m-tags', root).value };
      try {
        const saved = editing ? await api('/api/memories/' + m.id, { method: 'PUT', body }) : await api('/api/memories', { method: 'POST', body });
        close(); onSaved?.(saved);
      } catch (e) { toast(e.message, true); }
    };
    if (editing) $('#m-del', root).onclick = async () => {
      if (!$('#m-del', root).dataset.armed) { $('#m-del', root).dataset.armed = 1; $('#m-del', root).textContent = 'Click again to delete'; return; }
      await api('/api/memories/' + m.id, { method: 'DELETE' });
      close(); onSaved?.(null);
    };
    $('#m-title', root).focus();
  });
}

export async function renderMemory(view, params) {
  const state = { q: params.get('q') || '', type: '', scope: '' };
  view.innerHTML = `
    <div class="head">
      <div><h1>Memory</h1><div class="muted">One memory shared by Claude Code, Antigravity and Codex through the <span class="mono">agent-hub-memory</span> MCP server</div></div>
      <div class="row"><button id="import" title="Copy your ~/.claude memory files in (the originals are not changed)">⇣ Import Claude memories</button><button class="primary" id="new">＋ New memory</button></div>
    </div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search memories…" value="${esc(state.q)}">
      <select id="type"><option value="">All types</option>${TYPES.map(t => `<option>${t}</option>`).join('')}</select>
      <select id="scope"><option value="">All scopes</option><option value="global">Global only</option></select>
    </div>
    <div class="split">
      <div class="panel list" id="list"></div>
      <div class="panel pad sticky" id="detail"><div class="muted small">Select a memory to read it.</div></div>
    </div>`;

  let rows = [];
  async function load() {
    const qs = new URLSearchParams();
    for (const k of ['q', 'type', 'scope']) if (state[k]) qs.set(k, state[k]);
    rows = await api('/api/memories?' + qs);
    $('#list').innerHTML = rows.map(m => `
      <a class="item" href="javascript:void 0" data-id="${m.id}">
        <span class="chip">${esc(m.type)}</span>
        <div style="min-width:0">
          <div class="title">${esc(m.title)}</div>
          <div class="sub">${m.scope === 'global' ? 'global' : esc(m.scope)}${m.tags ? ' · ' + esc(m.tags) : ''}</div>
        </div>
        <span class="muted tiny">${ago(m.updated)}</span>
      </a>`).join('') || `<div class="empty">No memories yet. Import your Claude memory files or add one.</div>`;
  }
  function show(m) {
    $('#detail').innerHTML = `
      <div class="row" style="align-items:center;margin-bottom:8px"><span class="chip">${esc(m.type)}</span>${badge(m.source_tool)}<span class="muted tiny">updated ${ago(m.updated)}</span></div>
      <h3>${esc(m.title)}</h3>
      <div class="muted tiny mono" style="margin-bottom:8px">${esc(m.scope)}</div>
      <div class="md small">${md(m.body)}</div>
      <div class="row" style="margin-top:12px"><button id="edit">Edit</button></div>`;
    $('#edit').onclick = () => memoryForm(m, async saved => { await load(); saved ? show(saved) : ($('#detail').innerHTML = '<div class="muted small">Deleted.</div>'); });
  }
  $('#list').addEventListener('click', e => {
    const a = e.target.closest('[data-id]');
    if (a) show(rows.find(r => r.id === a.dataset.id));
  });
  let t;
  $('#q').addEventListener('input', e => { state.q = e.target.value; clearTimeout(t); t = setTimeout(load, 200); });
  $('#type').addEventListener('change', e => { state.type = e.target.value; load(); });
  $('#scope').addEventListener('change', e => { state.scope = e.target.value; load(); });
  $('#new').onclick = () => memoryForm({}, async saved => { await load(); if (saved) show(saved); toast('Memory saved'); });
  $('#import').onclick = async () => {
    try {
      const r = await api('/api/memories/import', { method: 'POST', body: {} });
      toast(`Imported: ${r.added} new, ${r.updated} updated, ${r.skipped} unchanged`);
      load();
    } catch (e) { toast(e.message, true); }
  };
  await load();
}
