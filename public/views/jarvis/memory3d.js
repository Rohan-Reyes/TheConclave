// 3D memory map: Jarvis memories, notes and schedules plus Conclave coding context in one graph.
// three.js + 3d-force-graph (vendored, MIT) load only when this page opens. List view is the
// accessible fallback and the default when WebGL is unavailable.
import { esc, toast } from '../../lib.js';
import { japi, fmtDate } from './api.js';

const CATS = {
  preference: ['Preferences', '♥', '#f5b971'], people: ['People', '☺', '#f28fad'], work: ['Work & projects', '◆', '#4fc3a1'],
  routine: ['Routines & schedule', '◷', '#8ab4ff'], health: ['Health', '✚', '#7fcf5f'], places: ['Places', '⌂', '#f2c94c'],
  tech: ['Devices & tech', '⚙', '#b79bff'], finance: ['Finance', '₱', '#45c4dc'], education: ['School & competitions', '✎', '#ff9f7a'],
  general: ['General', '•', '#9fb0bb'],
};
const TYPES = {
  jarvis: ['Jarvis', '✺', '#7b8cff'], category: ['Category', '●', null], topic: ['Topic', '#', null], group: ['Group', '▣', '#8892a6'],
  note: ['Note', '✎', '#e0a96d'], schedule: ['Schedule', '◷', '#8ab4ff'], project: ['Coding project', '▤', '#5aa9e6'], chat: ['Chat', '💬', '#a78bfa'],
};
const NODE_CAP = 1500;
const LIT_MS = 10 * 60e3;

let state = null;
export function leaveMemory3d() {
  if (!state) return;
  clearInterval(state.poll); document.removeEventListener('visibilitychange', state.onVis);
  state.themeObs?.disconnect(); state.resizeObs?.disconnect();
  try { state.graph?._destructor?.(); } catch {}
  state.graph = null; state = null;
}

const prefersReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function lowPowerDevice() {
  const mem = navigator.deviceMemory, cores = navigator.hardwareConcurrency;
  return !!(navigator.connection?.saveData || (mem && mem <= 4) || (cores && cores <= 4) || matchMedia('(max-width: 700px)').matches);
}
function webglAvailable() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}
let libPromise;
function loadLib() {
  if (window.ForceGraph3D) return Promise.resolve(window.ForceGraph3D);
  return (libPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = '/vendor/3d-force-graph.min.js'; s.async = true;
    s.onload = () => window.ForceGraph3D ? resolve(window.ForceGraph3D) : reject(new Error('3D library failed to initialise'));
    s.onerror = () => { libPromise = null; reject(new Error('Could not load the 3D library')); };
    document.head.append(s);
  }));
}

const idOf = v => (v && typeof v === 'object') ? v.id : v;
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const catOf = n => CATS[n.category] ? n.category : 'general';
function colorOf(n) {
  if (n.type === 'memory' || n.type === 'category' || n.type === 'topic') return CATS[catOf(n)][2];
  return TYPES[n.type]?.[2] || '#9fb0bb';
}
function iconOf(n) { return n.type === 'memory' || n.type === 'category' ? CATS[catOf(n)][1] : (TYPES[n.type]?.[1] || '•'); }
function kindLabel(n) {
  if (n.type === 'memory') return `${n.origin === 'conclave' ? 'Coding memory' : 'Memory'} · ${CATS[catOf(n)][0]}`;
  if (n.type === 'category') return 'Category';
  return TYPES[n.type]?.[0] || n.type;
}
const editable = n => n.type === 'memory' && n.origin === 'jarvis' && n.source !== 'conclave-shared';

export async function renderMemory3d(root, params) {
  leaveMemory3d();
  const low = lowPowerDevice(), reduced = prefersReduced(), gl = webglAvailable();
  const s = state = {
    nodes: new Map(), links: new Map(), lit: new Map(), filters: new Set(), query: '', selected: null, mergeFrom: null,
    includeLocal: params?.get('local') === '1', view: gl ? (params?.get('view') || '3d') : 'list', since: 0, cursor: 0,
    paused: false, low, reduced, gl, graph: null,
  };
  root.innerHTML = `
    <div class="m3-page">
      <div class="m3-toolbar">
        <div class="m3-search"><input type="search" id="m3-q" placeholder="Search memories, projects, notes…" aria-label="Search the memory map"></div>
        <div class="m3-seg" role="group" aria-label="View">
          <button type="button" data-view="3d" ${gl ? '' : 'disabled title="WebGL is not available on this device"'}>3D</button>
          <button type="button" data-view="list">List</button>
        </div>
        <label class="m3-check"><input type="checkbox" id="m3-local"> Show Local Only projects</label>
        <span class="m3-status" id="m3-status" role="status" aria-live="polite"></span>
      </div>
      <div class="m3-chips" id="m3-chips" aria-label="Filter by category"></div>
      <div class="m3-body">
        <div class="m3-stage" id="m3-stage"><div class="empty">Loading memory map…</div></div>
        <div class="m3-list" id="m3-list" hidden></div>
        <aside class="m3-panel" id="m3-panel" hidden aria-label="Selected item"></aside>
      </div>
    </div>`;
  const $ = sel => root.querySelector(sel);
  $('#m3-local').checked = s.includeLocal;

  // ---------- data ----------
  const graphUrl = since => `/memories/graph?merged=1${s.includeLocal ? '&include_local=1' : ''}${since ? `&updated_since=${since}` : ''}`;
  function applyFull(g) {
    s.nodes.clear(); s.links.clear();
    for (const n of g.nodes) s.nodes.set(n.id, { ...n });
    for (const l of g.links) addLink(l);
    s.since = g.generated_at; s.excluded = g.excluded_local || 0;
  }
  function addLink(l) { const a = idOf(l.source), b = idOf(l.target); s.links.set(`${a}→${b}`, { source: a, target: b, kind: l.kind, strength: l.strength }); }
  function applyIncremental(g) {
    const keep = new Set(g.ids);
    let changed = g.nodes.length > 0;
    for (const id of [...s.nodes.keys()]) if (!keep.has(id)) { s.nodes.delete(id); changed = true; }
    for (const n of g.nodes) { const old = s.nodes.get(n.id); s.nodes.set(n.id, old ? Object.assign(old, n) : { ...n }); }
    for (const [k, l] of s.links) if (!s.nodes.has(l.source) || !s.nodes.has(l.target)) s.links.delete(k);
    for (const l of g.links) addLink(l);
    s.since = g.generated_at; s.excluded = g.excluded_local || 0;
    return changed;
  }
  async function loadFull() { applyFull(await japi(graphUrl(0))); }
  async function pollActivity(initial = false) {
    const since = Date.now() - LIT_MS;
    const r = await japi(`/memories/activity?since=${since}&after=${initial ? 0 : s.cursor}`);
    s.cursor = r.cursor || s.cursor;
    for (const e of r.events) s.lit.set(e.memory_id, Math.max(s.lit.get(e.memory_id) || 0, e.created_at));
    for (const [id, at] of s.lit) if (at < since) s.lit.delete(id);
    return r.events.length > 0;
  }

  // ---------- visible subset (filters, search, node cap) ----------
  const matches = n => {
    if (s.filters.size) {
      const key = n.type === 'memory' || n.type === 'category' || n.type === 'topic' ? `cat:${catOf(n)}` : `type:${n.type}`;
      if (!s.filters.has(key) && n.type !== 'jarvis' && n.type !== 'group') return false;
    }
    if (s.query) return `${n.label} ${n.content || ''} ${n.path || ''}`.toLowerCase().includes(s.query);
    return true;
  };
  function visible() {
    let list = [...s.nodes.values()].filter(matches);
    if (s.query) { // keep hubs so search results stay anchored
      const ids = new Set(list.map(n => n.id));
      for (const l of s.links.values()) { if (ids.has(l.target) && s.nodes.has(l.source) && !ids.has(l.source)) { const src = s.nodes.get(l.source); if (['jarvis', 'group', 'category', 'project'].includes(src.type)) { ids.add(src.id); list.push(src); } } }
    }
    let capped = 0;
    if (list.length > NODE_CAP) {
      const hubs = list.filter(n => n.type !== 'memory' && n.type !== 'chat' && n.type !== 'note');
      const rest = list.filter(n => !hubs.includes(n)).sort((a, b) => (s.lit.has(b.id) - s.lit.has(a.id)) || ((b.updated || 0) - (a.updated || 0)));
      capped = list.length - NODE_CAP;
      list = [...hubs, ...rest.slice(0, Math.max(0, NODE_CAP - hubs.length))];
    }
    const ids = new Set(list.map(n => n.id));
    const links = [...s.links.values()].filter(l => ids.has(l.source) && ids.has(l.target)).map(l => ({ ...l }));
    return { nodes: list, links, capped };
  }

  // ---------- chips ----------
  function renderChips() {
    const counts = new Map();
    for (const n of s.nodes.values()) {
      if (n.type === 'memory') counts.set(`cat:${catOf(n)}`, (counts.get(`cat:${catOf(n)}`) || 0) + 1);
      else if (['note', 'schedule', 'project', 'chat'].includes(n.type)) counts.set(`type:${n.type}`, (counts.get(`type:${n.type}`) || 0) + 1);
    }
    const chip = (key, label, icon, color) => `<button type="button" class="m3-chip ${s.filters.has(key) ? 'on' : ''}" data-key="${key}" aria-pressed="${s.filters.has(key)}"><i style="background:${color}"></i>${icon} ${esc(label)} <span>${counts.get(key)}</span></button>`;
    const html = [];
    for (const [k, [label, icon, color]] of Object.entries(CATS)) if (counts.has(`cat:${k}`)) html.push(chip(`cat:${k}`, label, icon, color));
    for (const t of ['note', 'schedule', 'project', 'chat']) if (counts.has(`type:${t}`)) html.push(chip(`type:${t}`, TYPES[t][0] + 's', TYPES[t][1], TYPES[t][2]));
    if (s.filters.size) html.push('<button type="button" class="m3-chip clear" data-key="">Clear filters</button>');
    $('#m3-chips').innerHTML = html.join('');
  }
  $('#m3-chips').addEventListener('click', e => {
    const b = e.target.closest('[data-key]'); if (!b) return;
    if (!b.dataset.key) s.filters.clear(); else s.filters.has(b.dataset.key) ? s.filters.delete(b.dataset.key) : s.filters.add(b.dataset.key);
    refresh();
  });

  // ---------- status ----------
  function renderStatus(capped = 0) {
    const mem = [...s.nodes.values()].filter(n => n.type === 'memory').length;
    const parts = [`${mem} memories`, `${s.nodes.size} items`];
    if (s.lit.size) parts.push(`${s.lit.size} used recently`);
    if (capped) parts.push(`${capped} hidden (low-power cap)`);
    if (s.excluded && !s.includeLocal) parts.push(`${s.excluded} Local Only project${s.excluded === 1 ? '' : 's'} hidden`);
    if (s.low) parts.push('low-power mode');
    $('#m3-status').textContent = parts.join(' · ');
  }

  // ---------- list view ----------
  function renderList() {
    const { nodes } = visible();
    const items = nodes.filter(n => !['jarvis', 'group', 'category'].includes(n.type))
      .sort((a, b) => (s.lit.has(b.id) - s.lit.has(a.id)) || ((b.updated || 0) - (a.updated || 0)));
    $('#m3-list').innerHTML = items.length ? `<ul class="m3-items">${items.slice(0, 600).map(n => `
      <li><button type="button" class="m3-item ${s.selected === n.id ? 'sel' : ''} ${s.lit.has(n.id) ? 'lit' : ''}" data-id="${esc(n.id)}">
        <i class="m3-ico" style="background:${colorOf(n)}">${iconOf(n)}</i>
        <span class="m3-item-main"><b>${esc(n.label)}</b><small>${esc(kindLabel(n))}${n.origin === 'conclave' ? ' · Conclave' : ''}${n.updated ? ' · ' + esc(fmtDate(n.updated)) : ''}</small></span>
        ${s.lit.has(n.id) ? '<span class="m3-lit">used</span>' : ''}
      </button></li>`).join('')}</ul>${items.length > 600 ? `<p class="muted small">Showing 600 of ${items.length}. Refine the search to see more.</p>` : ''}` : '<div class="empty">Nothing matches.</div>';
  }
  $('#m3-list').addEventListener('click', e => { const b = e.target.closest('[data-id]'); if (b) select(b.dataset.id, true); });

  // ---------- details panel ----------
  function neighbours(id) {
    const out = [];
    for (const l of s.links.values()) { if (l.source === id && s.nodes.has(l.target)) out.push(s.nodes.get(l.target)); else if (l.target === id && s.nodes.has(l.source)) out.push(s.nodes.get(l.source)); }
    return out;
  }
  function renderPanel() {
    const p = $('#m3-panel'), n = s.nodes.get(s.selected);
    if (!n) { p.hidden = true; return; }
    p.hidden = false;
    const near = neighbours(n.id).slice(0, 12);
    p.innerHTML = `
      <div class="m3-panel-head"><i class="m3-ico" style="background:${colorOf(n)}">${iconOf(n)}</i>
        <div><div class="m3-kind">${esc(kindLabel(n))} · ${n.origin === 'conclave' ? 'Conclave' : 'Jarvis'}${n.local_only ? ' · Local Only' : ''}</div><h2>${esc(n.label)}</h2></div>
        <button type="button" class="icon-btn ghost" id="m3-close" aria-label="Close details">✕</button></div>
      ${s.lit.has(n.id) ? `<p class="m3-litnote">Used in a recent answer · ${esc(fmtDate(s.lit.get(n.id)))}</p>` : ''}
      ${editable(n) ? `<textarea id="m3-edit" rows="6" aria-label="Edit memory">${esc(n.content || '')}</textarea>
        <label class="m3-field">Category <select id="m3-cat">${Object.entries(CATS).map(([k, [l]]) => `<option value="${k}" ${k === catOf(n) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <div class="m3-actions"><button type="button" class="primary small" id="m3-save">Save</button>
          <button type="button" class="small" id="m3-merge">${s.mergeFrom === n.id ? 'Cancel merge' : 'Merge…'}</button>
          <button type="button" class="small danger" id="m3-del">Delete</button></div>
        ${s.mergeFrom === n.id ? '<p class="muted small">Now select the memory to merge into this one.</p>' : ''}`
        : `${n.content ? `<div class="m3-content">${esc(n.content)}</div>` : ''}
        ${n.path ? `<div class="m3-content mono small">${esc(n.path)}</div>` : ''}
        ${n.next_run ? `<p class="muted small">Next run ${esc(fmtDate(n.next_run))} · ${esc(n.status || '')}</p>` : ''}
        <p class="muted small">${n.source === 'conclave-shared' || n.read_only ? 'Coding memories are edited in Conclave Memory.' : ''}</p>
        <div class="m3-actions">${openLink(n)}</div>`}
      ${s.mergeFrom && s.mergeFrom !== n.id && editable(n) ? `<div class="m3-merge-box"><p>Merge “${esc(s.nodes.get(s.mergeFrom)?.label || '')}” into this memory? The other memory is deleted after its text is appended here.</p>
        <button type="button" class="primary small" id="m3-merge-go">Merge</button> <button type="button" class="small" id="m3-merge-cancel">Cancel</button></div>` : ''}
      ${n.updated ? `<p class="muted small">Updated ${esc(fmtDate(n.updated))}</p>` : ''}
      ${near.length ? `<h3>Connected</h3><div class="m3-near">${near.map(m => `<button type="button" class="m3-chip" data-near="${esc(m.id)}"><i style="background:${colorOf(m)}"></i>${esc(m.label)}</button>`).join('')}</div>` : ''}`;
    p.querySelector('#m3-close').onclick = () => select(null);
    p.querySelectorAll('[data-near]').forEach(b => b.onclick = () => select(b.dataset.near, true));
    p.querySelector('#m3-save')?.addEventListener('click', () => act(async () => {
      const content = p.querySelector('#m3-edit').value.trim(); if (!content) throw new Error('Memory text is required');
      await japi('/memories', { id: n.id, content, category: p.querySelector('#m3-cat').value });
      toast('Memory saved');
    }));
    p.querySelector('#m3-del')?.addEventListener('click', () => act(async () => {
      if (!confirm('Delete this memory? This cannot be undone.')) return false;
      await japi(`/memories/${encodeURIComponent(n.id)}`, {}, 'DELETE'); s.selected = null; toast('Memory deleted');
    }));
    p.querySelector('#m3-merge')?.addEventListener('click', () => { s.mergeFrom = s.mergeFrom === n.id ? null : n.id; renderPanel(); });
    p.querySelector('#m3-merge-cancel')?.addEventListener('click', () => { s.mergeFrom = null; renderPanel(); });
    p.querySelector('#m3-merge-go')?.addEventListener('click', () => act(async () => {
      const from = s.nodes.get(s.mergeFrom); if (!from) throw new Error('The memory to merge no longer exists');
      const content = `${n.content || ''}\n${from.content || ''}`.trim().slice(0, 4000);
      await japi('/memories', { id: n.id, content });
      await japi(`/memories/${encodeURIComponent(from.id)}`, {}, 'DELETE');
      s.mergeFrom = null; toast('Memories merged');
    }));
  }
  function openLink(n) {
    if (n.type === 'chat') return `<a class="btn small" href="#/hub/${encodeURIComponent(n.id.slice(5))}">Open chat</a>`;
    if (n.type === 'project') return `<a class="btn small" href="#/hub?cwd=${encodeURIComponent(n.path)}">New chat in project</a>`;
    if (n.type === 'schedule') return '<a class="btn small" href="#/automations">Open tasks</a>';
    if (n.type === 'note') return '<a class="btn small" href="#/assistant-notes">Open notes</a>';
    if (n.origin === 'conclave' || n.source === 'conclave-shared') return '<a class="btn small" href="#/memory">Open Conclave Memory</a>';
    return '';
  }
  async function act(fn) {
    const buttons = [...$('#m3-panel').querySelectorAll('button')]; buttons.forEach(b => b.disabled = true);
    try { if (await fn() !== false) { await loadFull(); refresh(); } }
    catch (e) { toast(e.message, true); }
    finally { buttons.forEach(b => b.disabled = false); }
  }

  // ---------- 3D ----------
  async function ensureGraph() {
    if (s.graph || s.view !== '3d') return;
    const ForceGraph3D = await loadLib();
    if (state !== s) return;
    const stage = $('#m3-stage'); stage.innerHTML = '';
    const g = s.graph = ForceGraph3D({ controlType: 'orbit', rendererConfig: { antialias: !s.low, powerPreference: s.low ? 'low-power' : 'default', alpha: false } })(stage);
    g.backgroundColor(cssVar('--bg') || '#111317')
      .showNavInfo(false)
      .nodeId('id')
      .nodeLabel(n => `<div class="m3-tip"><b>${esc(iconOf(n))} ${esc(n.label)}</b><br><small>${esc(kindLabel(n))}</small></div>`)
      .nodeColor(n => s.selected === n.id ? '#ffffff' : s.lit.has(n.id) ? '#ffd54a' : colorOf(n))
      .nodeVal(n => n.type === 'jarvis' ? 18 : n.type === 'group' || n.type === 'category' ? 7 : n.type === 'project' ? 5 : s.lit.has(n.id) ? 5 : 1.6)
      .nodeOpacity(0.92)
      .nodeResolution(s.low ? 6 : 12)
      .linkColor(l => l.kind === 'related' ? cssVar('--accent') || '#79a6ff' : cssVar('--line-strong') || '#3a414b')
      .linkOpacity(0.35)
      .linkWidth(l => l.kind === 'related' ? 0.6 : 0)
      .linkDirectionalParticles(l => (!s.low && !s.reduced && (s.lit.has(idOf(l.source)) || s.lit.has(idOf(l.target)))) ? 2 : 0)
      .linkDirectionalParticleSpeed(0.006)
      .cooldownTicks(s.reduced ? 60 : s.low ? 120 : 300)
      .warmupTicks(s.reduced ? 80 : 0)
      .onEngineStop(() => { if (!s.fitted && s.graph) { s.fitted = true; s.graph.zoomToFit(s.reduced ? 0 : 600, 40); } })
      .onNodeClick(n => select(n.id, false))
      .onBackgroundClick(() => select(null));
    if (s.low) g.renderer().setPixelRatio(1);
    sizeGraph();
    s.resizeObs = new ResizeObserver(sizeGraph); s.resizeObs.observe(stage);
    s.themeObs = new MutationObserver(() => { s.graph?.backgroundColor(cssVar('--bg') || '#111317'); s.graph?.linkColor(s.graph.linkColor()); });
    s.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  function sizeGraph() { const st = $('#m3-stage'); if (s.graph && st) s.graph.width(st.clientWidth).height(st.clientHeight); }
  let lastKey = '';
  function pushGraph() {
    if (!s.graph) return 0;
    const { nodes, links, capped } = visible();
    const key = nodes.map(n => n.id).join('|') + '#' + links.length;
    if (key !== lastKey) {
      // Reuse existing node objects so positions survive refreshes.
      const prev = new Map(s.graph.graphData().nodes.map(n => [n.id, n]));
      s.graph.graphData({ nodes: nodes.map(n => Object.assign(prev.get(n.id) || {}, n)), links });
      lastKey = key;
    } else s.graph.nodeColor(s.graph.nodeColor());
    return capped;
  }
  function focusNode(id) {
    const n = s.graph?.graphData().nodes.find(x => x.id === id); if (!n || n.x === undefined) return;
    const d = 90, r = Math.hypot(n.x, n.y, n.z) || 1, k = 1 + d / r;
    s.graph.cameraPosition({ x: n.x * k, y: n.y * k, z: n.z * k }, n, s.reduced ? 0 : 900);
  }

  // ---------- orchestration ----------
  function select(id, focus) {
    if (id && s.mergeFrom && s.mergeFrom !== id && !editable(s.nodes.get(id) || {})) toast('Only Jarvis memories can be merged', true);
    s.selected = id && s.nodes.has(id) ? id : null;
    renderPanel(); if (s.view === 'list') renderList(); else { s.graph?.nodeColor(s.graph.nodeColor()); if (focus && s.selected) focusNode(s.selected); }
  }
  function refresh() {
    renderChips();
    root.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === s.view)));
    $('#m3-stage').hidden = s.view !== '3d'; $('#m3-list').hidden = s.view !== 'list';
    let capped = 0;
    if (s.view === '3d') capped = pushGraph(); else renderList();
    renderStatus(capped); renderPanel();
  }
  root.querySelectorAll('[data-view]').forEach(b => b.onclick = async () => {
    s.view = b.dataset.view;
    try { await ensureGraph(); } catch (e) { toast(e.message, true); s.view = 'list'; }
    refresh(); if (s.view === '3d') sizeGraph();
  });
  let qTimer;
  $('#m3-q').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { s.query = e.target.value.trim().toLowerCase(); refresh(); }, 180); });
  $('#m3-local').onchange = async e => { s.includeLocal = e.target.checked; try { await loadFull(); } catch (err) { toast(err.message, true); } refresh(); };

  s.onVis = () => {
    if (!s.graph) return;
    if (document.hidden) { s.graph.pauseAnimation(); s.paused = true; } else if (s.paused) { s.graph.resumeAnimation(); s.paused = false; }
  };
  document.addEventListener('visibilitychange', s.onVis);

  try { await Promise.all([loadFull(), pollActivity(true).catch(() => {})]); }
  catch (e) { $('#m3-stage').innerHTML = `<div class="empty">Could not load memories: ${esc(e.message)}</div>`; return; }
  if (state !== s) return;
  if (s.view === '3d') { try { await ensureGraph(); } catch (e) { toast(e.message, true); s.view = 'list'; } }
  if (state !== s) return;
  refresh();

  s.poll = setInterval(async () => {
    if (document.hidden || state !== s) return;
    try {
      const [g, lit] = await Promise.all([japi(graphUrl(s.since)), pollActivity()]);
      if (state !== s) return;
      if (applyIncremental(g) || lit) refresh();
    } catch { /* transient: next tick retries */ }
  }, s.low ? 30000 : 15000);
}
