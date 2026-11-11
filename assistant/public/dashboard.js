// Dashboard: memory mind map. Loaded after app.js and shares its helpers (api, el, card, button, form, field, actions, toast, date, render).
const CATEGORY_COLORS = { jarvis: '#7be1c2', preference: '#f5b971', people: '#f28fad', work: '#6fd6b4', routine: '#8ab4ff', health: '#9be27b', places: '#ffd86b', tech: '#b79bff', finance: '#5fd3e8', education: '#ff9f7a', general: '#9fb0bb' };
const CATEGORY_LIGHT = {jarvis:'#285dbc',preference:'#986013',people:'#b4386a',work:'#14745a',routine:'#315fba',health:'#417817',places:'#876300',tech:'#7444ba',finance:'#096c80',education:'#b34222',general:'#52616b'};
const SOURCE_LABELS = { chat: 'mentioned in chat', answer: 'used in an answer', viewed: 'opened' };
const GRAPH_DEFAULTS = { linkLength: 90, repel: 900, gravity: 0.02, related: true, labels: true, spin: false, hidden: [] };
const lit = new Map(); // memory id -> client timestamp when it lit up
const litChannel = 'BroadcastChannel' in window ? new BroadcastChannel('jarvis-memory') : null;
function lightUp(ids, at = Date.now()) { for (const memoryId of ids) lit.set(memoryId, Math.max(lit.get(memoryId) || 0, at)); }
if (litChannel) litChannel.onmessage = e => { if (Array.isArray(e.data?.ids)) lightUp(e.data.ids); };
function announceMemories(ids) { if (!ids?.length) return; lightUp(ids); litChannel?.postMessage({ ids }); }

async function dashboard() {
  let saved = {}; try { saved = JSON.parse(localStorage.getItem('jarvis-graph') || '{}'); } catch {}
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  const clamp = (v, min, max, fallback) => Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Number(v))) : fallback;
  const opts = { ...GRAPH_DEFAULTS, linkLength: clamp(saved.linkLength, 30, 260, 90), repel: clamp(saved.repel, 50, 3000, 900), gravity: clamp(saved.gravity, 0, .1, .02), hidden: Array.isArray(saved.hidden) ? saved.hidden.filter(c => Object.hasOwn(CATEGORY_COLORS, c)) : [] };
  for (const key of ['related', 'labels', 'spin']) if (typeof saved[key] === 'boolean') opts[key] = saved[key];
  if (saved.spin === undefined && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) opts.spin = false;
  const persist = () => { try { localStorage.setItem('jarvis-graph', JSON.stringify(opts)); } catch {} };
  const wrap = el('div', undefined, 'dash'), stage = el('section', undefined, 'dash-stage'), side = el('div', undefined, 'dash-side');
  const canvas = document.createElement('canvas'); canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', '3D memory map: Conclave at the centre, memories grouped by category and topic');
  const hud = el('div', undefined, 'dash-hud'), zoomBar = el('div', undefined, 'dash-zoom');
  stage.append(canvas, hud, zoomBar); wrap.append(stage, side); root.append(wrap);

  const toolbar = el('div', undefined, 'memory-toolbar');
  const summary = el('span', 'Your linked memory', 'memory-summary');
  const listPanel = el('section', undefined, 'card memory-list'); listPanel.hidden = true;
  const mode = button('List view', async () => { listPanel.hidden = !listPanel.hidden; stage.hidden = !listPanel.hidden; mode.textContent = listPanel.hidden ? 'List view' : '3D view'; if (listPanel.hidden) resize(); });
  const refresh = button('Refresh memories', async () => { await render(); });
  toolbar.append(summary, mode, refresh); root.insertBefore(toolbar, wrap); stage.after(listPanel);
  const graph = await api('/memories/graph');
  const fingerprint = data => JSON.stringify(data.nodes.map(n => [n.id,n.content,n.category,n.topic,n.updated_at]));
  const initialFingerprint = fingerprint(graph);
  summary.textContent = `${graph.nodes.filter(n => n.type === 'memory').length} memories · relationships show categories, topics and inferred similarities`;

  const nodes = graph.nodes.map((n, i) => {
    const angle = i * 2.399963, r = n.type === 'jarvis' ? 0 : n.type === 'category' ? 140 : 220 + (i % 7) * 18;
    const vertical = 1 - 2 * (i + .5) / graph.nodes.length, ring = Math.sqrt(1 - vertical * vertical);
    return { ...n, x: Math.cos(angle) * ring * r, y: vertical * r, z: Math.sin(angle) * ring * r, vx: 0, vy: 0, vz: 0, color: CATEGORY_COLORS[n.type === 'jarvis' ? 'jarvis' : n.category] || '#9fb0bb' };
  });
  const byId = new Map(nodes.map(n => [n.id, n]));
  const links = graph.links.map(l => ({ ...l, s: byId.get(l.source), t: byId.get(l.target) })).filter(l => l.s && l.t);
  const center = byId.get('jarvis'); if (!center) throw new Error('The memory graph is missing its Conclave hub'); center.fixed = true;
  const visible = n => n.type === 'jarvis' || !opts.hidden.includes(n.category);
  const linkVisible = l => visible(l.s) && visible(l.t) && (opts.related || l.kind !== 'related');
  const radius = n => n.type === 'jarvis' ? 24 : n.type === 'topic' ? 8 + Math.min(5, Math.sqrt(n.count || 1)) : n.type === 'category' ? 12 + Math.min(8, Math.sqrt(n.count || 1) * 2) : 5 + Math.min(6, Math.sqrt(n.access_count || 0) * 1.4);
  const glow = n => { const at = lit.get(n.id); if (!at) return 0; const age = Date.now() - at; return age < 2000 ? 1 : Math.max(0, 1 - (age - 2000) / 14000); };
  let alpha = 1, view = { x: 0, y: 0, k: 1 }, selected = null, hover = null, drag = null, query = '', frame, running = true, frames = 0;
  const memoryNodes = nodes.filter(n => n.type === 'memory'), categoryNodes = nodes.filter(n => n.type === 'category'), topicNodes = nodes.filter(n => n.type === 'topic');
  const matches = n => !query || `${n.content || ''} ${n.topic || ''} ${graph.categories[n.category] || ''}`.toLowerCase().includes(query);

  function renderList() {
    listPanel.replaceChildren();
    for (const n of memoryNodes.filter(n => visible(n) && matches(n))) {
      const entry = button(n.label, async () => { choose(n); focus(n); detail.scrollIntoView({block:'nearest',behavior:'smooth'}); });
      entry.append(el('small', `${graph.categories[n.category]} · ${n.source || 'Personal memory'}`));
      listPanel.append(entry);
    }
    if (!listPanel.children.length) listPanel.append(el('p','No memories match these filters.'));
  }
  // ----- controls -----
  const controls = card('Map controls', null, side);
  const slider = (labelText, key, min, max, step, fmt = v => v) => {
    const l = el('label', undefined, 'range'), head = el('span', labelText), value = el('output', String(fmt(opts[key]))), input = document.createElement('input');
    Object.assign(input, { type: 'range', min, max, step, value: opts[key] }); input.setAttribute('aria-label', labelText);
    input.oninput = () => { opts[key] = Number(input.value); value.textContent = fmt(opts[key]); alpha = Math.max(alpha, 0.6); persist(); };
    head.append(value); l.append(head, input); controls.append(l);
  };
  slider('Link length', 'linkLength', 30, 260, 5, v => `${v}px`);
  slider('Repel force', 'repel', 50, 3000, 50);
  slider('Pull to centre', 'gravity', 0, 0.1, 0.005, v => Number(v).toFixed(3));
  const toggle = (labelText, key) => { const l = el('label', undefined, 'check'), c = document.createElement('input'); c.type = 'checkbox'; c.checked = opts[key]; c.onchange = () => { opts[key] = c.checked; alpha = Math.max(alpha, 0.4); persist(); }; l.append(c, labelText); controls.append(l); };
  toggle('Slowly rotate', 'spin'); toggle('Links between related memories', 'related'); toggle('Memory labels', 'labels');
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Find a memory…'; search.setAttribute('aria-label', 'Find a memory'); controls.append(search);
  const searchResults = el('div'); searchResults.setAttribute('aria-live', 'polite'); controls.append(searchResults);
  search.oninput = () => {
    query = search.value.trim().toLowerCase(); searchResults.replaceChildren(); renderList();
    if (!query) return;
    const found = memoryNodes.filter(matches); searchResults.append(el('p', `${found.length} matching memor${found.length === 1 ? 'y' : 'ies'}`, 'muted'));
    for (const n of found.slice(0, 12)) searchResults.append(button(n.label, async () => { if (opts.hidden.includes(n.category)) { opts.hidden = opts.hidden.filter(c => c !== n.category); updateChips(); persist(); } choose(n); focus(n); }));
  };
  actions(controls, [
    button('Re-arrange', async () => { for (const n of nodes) if (!n.fixed) { n.x += (Math.random() - .5) * 200; n.y += (Math.random() - .5) * 200; n.z += (Math.random() - .5) * 200; } alpha = 1; lastInput = Date.now(); }),
    button('Fit', async () => fit()),
    button('Reset', async () => { try { localStorage.removeItem('jarvis-graph'); } catch {} await render(); }, 'subtle')
  ]);

  const legend = card('Categories', 'Tap a category to hide or show it.', side), chips = el('div', undefined, 'legend'); legend.append(chips);
  function updateChips() { for (const chip of chips.children) { const off = opts.hidden.includes(chip.dataset.category); chip.classList.toggle('off', off); chip.setAttribute('aria-pressed', String(!off)); } }
  for (const n of categoryNodes) {
    const chip = el('button', undefined, 'chip'); chip.type = 'button'; const dot = el('i'); dot.style.background = n.color; chip.append(dot, `${n.label} · ${n.count}`);
    chip.dataset.category = n.category; chip.classList.toggle('off', opts.hidden.includes(n.category)); chip.setAttribute('aria-pressed', String(!opts.hidden.includes(n.category)));
    chip.onclick = () => { opts.hidden = opts.hidden.includes(n.category) ? opts.hidden.filter(c => c !== n.category) : [...opts.hidden, n.category]; updateChips(); renderList(); alpha = Math.max(alpha, 0.5); persist(); };
    chips.append(chip);
  }
  if (!chips.children.length) chips.append(el('p', 'Categories appear once you save memories.', 'muted'));

  const add = card('Add a memory', 'Save a fact or useful context. Inferred connections remain labelled separately.', side);
  const addForm = form(add, 'Save memory', async (b,f) => { await api('/memories',{content:b.content}); f.reset(); await render(); });
  const addText = field(addForm, 'Memory', 'content', 'textarea'); addText.maxLength=4000; addText.rows=2; addForm.addButton();
  // ----- ask Jarvis from the map -----
  const ask = card('Ask Jarvis', 'Chat here and watch the memories it draws on light up.', side);
  const answer = el('div', undefined, 'dash-answer'); answer.hidden = true;
  const askForm = form(ask, 'Ask ↑', async (b, f) => {
    if (!conversation) conversation = await jarvisConversation();
    center.pulse = Date.now(); answer.hidden = false; answer.textContent = 'Thinking…';
    try {
      const r = await api('/messages', { conversation_id: conversation, content: b.content }); announceMemories(r.memory_ids); center.pulse = Date.now(); f.reset();
      const last = (await api(`/messages?conversation=${conversation}`)).at(-1); answer.textContent = last?.content || ''; if (last?.role === 'assistant') { speakReply(last.content); answer.append(button('Read aloud', () => speakReply(last.content, true))); }
      answer.append(el('small', r.memory_ids?.length ? `Drew on ${r.memory_ids.length} memor${r.memory_ids.length === 1 ? 'y' : 'ies'}.` : 'No saved memory matched this conversation.', 'muted'));
    } catch (e) { answer.textContent = e.message; throw e; }
  });
  const askText = field(askForm, 'Message', 'content', 'textarea'); askText.rows = 2; askText.maxLength = 12000; askForm.addButton(); voiceControls(askForm, askText); ask.append(answer);

  const detail = card(null, null, side);
  const feed = card('Recent activity', null, side), feedList = el('div', undefined, 'feed'); feed.append(feedList);
  if (!nodes.some(n => n.type === 'memory')) {
    const e = el('div', undefined, 'dash-empty'); e.append(el('h2', 'No memories yet'), el('p', 'Add facts or import a Markdown file in Settings → Personal memory. They appear here, grouped by category.'));
    const a = el('a', 'Open memory settings →'); a.href = '#settings'; e.append(a); stage.append(e);
  }

  function showDetail(n) {
    detail.replaceChildren(el('h2', n.type === 'memory' ? 'Memory' : n.label));
    if (n.type !== 'memory') { detail.append(el('p', n.type === 'topic' ? `${n.count} phrases imported from this section.` : n.type === 'jarvis' ? 'The centre of your map. Memories light up when Jarvis reads, uses or you open them — on any of your devices. Select a memory to read or recategorise it.' : `${n.count} memor${n.count === 1 ? 'y' : 'ies'} in this category.`, 'muted')); return; }
    const badge = el('span', graph.categories[n.category], 'tag'); badge.style.borderColor = n.color; badge.style.color = n.color;
    detail.append(badge, el('p', n.content, 'memory-text'), el('small', `Used ${n.access_count || 0}× · ${n.last_accessed ? `last ${date(n.last_accessed)}` : 'not used yet'} · updated ${date(n.updated_at)}`, 'muted'));
    let metadata = n.metadata || {}; if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { metadata = {}; } }
    const lineNum = metadata.source_line || metadata.line || metadata.line_start;
    const provenance = [n.source && `Source: ${n.source}`, metadata.kind && `Type: ${metadata.kind}`, lineNum && `Line: ${lineNum}`].filter(Boolean);
    if (provenance.length) detail.append(el('p', provenance.join(' · '), 'muted'));
    if (metadata.qualification) detail.append(el('p', `Context: ${String(metadata.qualification).replaceAll('_', ' ')}`, 'muted'));
    if (metadata.kind && metadata.kind !== 'fact') detail.append(el('p', 'This imported statement retains its source context; it is not a verified present-day fact.', 'muted'));
    if(n.source==='conclave-shared'){const link=el('a','Edit in shared Conclave Memory →');link.href='/#/memory';detail.append(link);return;}
    const editor = el('textarea', undefined, 'memory-detail-editor'); editor.value=n.content; editor.maxLength=4000; editor.setAttribute('aria-label','Edit selected memory'); detail.append(editor);
    const related = links.filter(l => l.kind === 'related' && (l.s === n || l.t === n));
    if (related.length) {
      detail.append(el('h3','Inferred similarities'));
      detail.append(el('p','Shared keywords suggest these links; they are not confirmed facts.','muted'));
      for (const edge of related) { const other=edge.s===n?edge.t:edge.s; detail.append(button(other.label,async()=>{choose(other);focus(other);})); }
    }
    const row = el('div', undefined, 'inline-select'), s = document.createElement('select'); s.setAttribute('aria-label', 'Category');
    const auto = el('option', `Automatic (${graph.categories[n.category]})`); auto.value = ''; s.append(auto);
    for (const [v, t] of Object.entries(graph.categories)) { const o = el('option', t); o.value = v; s.append(o); }
    s.value = n.auto ? '' : n.category;
    row.append(s, button('Save', async () => { await api('/memories', { id: n.id, content: editor.value, category: s.value || null }); toast('Memory updated'); await render(); }));
    detail.append(row);
    actions(detail, [button('Delete memory', async () => { if (!confirm('Delete this memory?')) return; await api(`/memories/${n.id}`,undefined,'DELETE'); await render(); }, 'danger')]);
  }
  function choose(n) {
    selected = n; showDetail(n);
    if (n.type === 'memory') { lightUp([n.id]); n.access_count = (n.access_count || 0) + 1; n.last_accessed = Date.now(); api(`/memories/${n.id}/access`, {}).catch(() => {}); }
  }
  function addFeed(events) {
    for (const ev of events) {
      const n = byId.get(ev.memory_id); if (!n) continue;
      const row = el('button', undefined, 'feed-row'); row.type = 'button'; const dot = el('i'); dot.style.background = n.color;
      const text = el('span'); text.append(el('b', n.label), el('small', `${SOURCE_LABELS[ev.source] || ev.source} · ${date(ev.created_at)}`));
      row.append(dot, text); row.onclick = () => { choose(n); focus(n); };
      feedList.prepend(row);
    }
    feedList.querySelector('.empty')?.remove();
    while (feedList.children.length > 25) feedList.lastChild.remove();
    if (!feedList.children.length) feedList.append(el('p', 'Nothing yet. Chat with Jarvis and the memories it uses will appear here.', 'empty'));
  }

  // ----- live activity from every device -----
  let since = 0, cursor = 0, polling = false;
  async function poll(initial = false) {
    if (polling || !running) return; polling = true;
    try {
      const r = await api(`/memories/activity?${!initial && cursor ? `after=${cursor}` : `since=${initial ? Date.now() - 6e5 : since}`}`); if (!running) return; since = r.now; cursor = r.cursor ?? cursor;
      for (const ev of r.events) {
        lightUp([ev.memory_id], Date.now() - (r.now - ev.created_at));
        const n = byId.get(ev.memory_id); if (n && !initial && ev.source !== 'viewed') { n.access_count = (n.access_count || 0) + 1; n.last_accessed = ev.created_at; }
      }
      if (r.events.length && !initial) center.pulse = Date.now();
      addFeed(r.events);
    } catch {} finally { polling = false; }
  }
  let checking = false;
  const updateTimer = setInterval(async () => {
    if (checking || document.hidden || !stage.isConnected) return;
    checking = true;
    try { const latest = await api('/memories/graph'); if (running && fingerprint(latest) !== initialFingerprint) { refresh.textContent='New changes · refresh map'; summary.textContent=`${latest.nodes.filter(n=>n.type==='memory').length} saved memories · updates available`; } } catch {} finally { checking=false; }
  }, 15000);
  await poll(true); const timer = setInterval(() => { if (!stage.isConnected) dispose(); else if (!document.hidden) poll(); }, 3000);

  // ----- 3D physics -----
  // A Barnes–Hut octree keeps phrase-sized imports interactive instead of doing N² repulsion every frame.
  function repulsion(live) {
    if (live.length < 2) return;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const n of live) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); minZ = Math.min(minZ, n.z); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); maxZ = Math.max(maxZ, n.z); }
    const cell = (x, y, z, size) => ({ x, y, z, size, points: [], children: null, mass: 0, cx: 0, cy: 0, cz: 0 });
    const tree = cell(minX - .5, minY - .5, minZ - .5, Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1) + 1);
    function insert(c, n, depth = 0) {
      const oldMass = c.mass++; c.cx = (c.cx * oldMass + n.x) / c.mass; c.cy = (c.cy * oldMass + n.y) / c.mass; c.cz = (c.cz * oldMass + n.z) / c.mass;
      if (!c.children && (c.points.length < 6 || depth > 15)) { c.points.push(n); return; }
      const childFor = point => { const half = c.size / 2, ix = point.x >= c.x + half ? 1 : 0, iy = point.y >= c.y + half ? 1 : 0, iz = point.z >= c.z + half ? 1 : 0, index = ix + iy * 2 + iz * 4; return c.children[index] ||= cell(c.x + ix * half, c.y + iy * half, c.z + iz * half, half); };
      if (!c.children) { c.children = Array(8); for (const point of c.points) insert(childFor(point), point, depth + 1); c.points = []; }
      insert(childFor(n), n, depth + 1);
    }
    for (const n of live) insert(tree, n);
    const apply = (n, x, y, z, mass) => { let dx = x - n.x, dy = y - n.y, dz = z - n.z, d2 = dx * dx + dy * dy + dz * dz; if (d2 < .001) { dx = .1; dy = .07; dz = -.09; d2 = .023; } const d = Math.sqrt(d2), force = Math.min(30, opts.repel * alpha * mass / Math.max(16, d2)) / d; n.vx -= dx * force; n.vy -= dy * force; n.vz -= dz * force; };
    for (const n of live) {
      if (n.fixed) continue;
      const stack = [tree];
      while (stack.length) {
        const c = stack.pop(); if (!c.mass) continue;
        if (!c.children) { for (const point of c.points) if (point !== n) apply(n, point.x, point.y, point.z, 1); continue; }
        const d2 = (c.cx - n.x) ** 2 + (c.cy - n.y) ** 2 + (c.cz - n.z) ** 2;
        const contains = n.x >= c.x && n.x <= c.x + c.size && n.y >= c.y && n.y <= c.y + c.size && n.z >= c.z && n.z <= c.z + c.size;
        if (!contains && c.size * c.size < .5 * d2) apply(n, c.cx, c.cy, c.cz, c.mass);
        else for (const child of c.children) if (child) stack.push(child);
      }
    }
  }
  function tick() {
    const live = nodes.filter(visible); repulsion(live);
    for (const l of links) {
      if (!linkVisible(l)) continue;
      const rest = opts.linkLength * ({ hub: 1.8, 'topic-hub': 1.3, related: 0.9, topic: 0.6 }[l.kind] || 0.75), k = l.kind === 'related' ? 0.02 * (l.strength || 0.3) : l.kind === 'hub' ? 0.08 : l.kind === 'topic' ? 0.05 : 0.06;
      const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, dz = l.t.z - l.s.z, d = Math.hypot(dx, dy, dz) || 1, f = (d - rest) * k * alpha;
      l.s.vx += dx / d * f; l.s.vy += dy / d * f; l.s.vz += dz / d * f; l.t.vx -= dx / d * f; l.t.vy -= dy / d * f; l.t.vz -= dz / d * f;
    }
    for (const n of live) {
      if (n.fixed) { n.x = n.y = n.z = n.vx = n.vy = n.vz = 0; continue; }
      if (n === drag?.node) { n.vx = n.vy = n.vz = 0; continue; }
      const pull = opts.gravity * alpha * (n.type === 'memory' ? 0.15 : 1); n.vx -= n.x * pull; n.vy -= n.y * pull; n.vz -= n.z * pull;
      for (const key of ['vx', 'vy', 'vz']) n[key] = Math.max(-40, Math.min(40, n[key] * 0.82));
      n.x += n.vx; n.y += n.vy; n.z += n.vz;
    }
    alpha = Math.max(0.03, alpha * 0.992);
  }

  // ----- camera and rendering -----
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Your browser could not create the memory-map canvas');
  let width = 0, height = 0, dpr = 1, lastInput = 0, lastFrame = Date.now();
  const cam = { yaw: 0.6, pitch: -0.35, distance: 900 }, FOV = 900;
  canvas.style.touchAction = 'none'; canvas.tabIndex = 0; canvas.setAttribute('aria-description', 'Drag empty space to orbit; Shift-drag or right-drag to pan. Drag a node to reposition it. Use the search results to select memories with the keyboard. Arrow keys orbit; plus and minus zoom; Home fits the map.');
  const resize = () => { const r = stage.getBoundingClientRect(); dpr = Math.min(2, window.devicePixelRatio || 1); width = r.width; height = r.height; canvas.width = Math.max(1, width * dpr); canvas.height = Math.max(1, height * dpr); canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; };
  const observer = new ResizeObserver(resize); observer.observe(stage); resize();
  function project(n) {
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const x1 = n.x * cy - n.z * sy, z1 = n.x * sy + n.z * cy, y2 = n.y * cp - z1 * sp, z2 = n.y * sp + z1 * cp;
    n.projected = cam.distance + z2 > 60;
    const s = FOV / Math.max(60, cam.distance + z2) * view.k;
    n.sx = width / 2 + x1 * s + view.x * view.k; n.sy = height / 2 + y2 * s + view.y * view.k; n.depth = z2; n.scale = s;
  }
  // Convert a screen-space drag into a world-space move along the camera plane.
  function screenDelta(dx, dy, s) {
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch), ax = dx / s, ay = dy / s;
    const z1 = -ay * sp, y = ay * cp; return [ax * cy + z1 * sy, y, -ax * sy + z1 * cy];
  }
  let paletteMode;
  function draw() {
    const now = Date.now(); const css = getComputedStyle(document.documentElement), themeBg = css.getPropertyValue('--bg').trim() || '#151514', themeText = css.getPropertyValue('--muted').trim() || '#9b978e', themeLine = css.getPropertyValue('--line').trim() || '#33322f'; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    const light = css.colorScheme === 'light';
    if (paletteMode !== light) {
      paletteMode=light;
      for(const n of nodes) n.color=(light?CATEGORY_LIGHT:CATEGORY_COLORS)[n.type==='jarvis'?'jarvis':n.category] || '#64748b';
      for(const chip of chips.children) if(chip.querySelector('i')) chip.querySelector('i').style.background=(light?CATEGORY_LIGHT:CATEGORY_COLORS)[chip.dataset.category];
    }
    const elapsed = Math.min(50, now - lastFrame); lastFrame = now;
    if (opts.spin && !drag && now - lastInput > 2500) cam.yaw += 0.0016 * elapsed / 16.67;
    for (const [memoryId, at] of lit) if (now - at > 20000) lit.delete(memoryId);
    for (const n of nodes) project(n);
    const heat = new Map();
    for (const n of nodes) if (n.type === 'memory') { const g = glow(n); if (g > 0) { heat.set(n.id, g); for (const hub of [`category:${n.category}`, n.topic && `topic:${n.topic.toLowerCase()}`]) if (hub) heat.set(hub, Math.max(heat.get(hub) || 0, g)); } }
    if (heat.size) heat.set('jarvis', Math.max(...heat.values()));
    const live = nodes.filter(n => visible(n) && n.projected), depths = live.map(n => n.depth), near = Math.min(...depths), far = Math.max(...depths), fog = n => 1 - 0.65 * ((n.depth - near) / ((far - near) || 1));
    const selectedPeers = new Set(selected ? links.filter(l=>l.s===selected||l.t===selected).flatMap(l=>[l.s.id,l.t.id]) : []);
    const sorted = links.filter(l => linkVisible(l) && l.s.projected && l.t.projected).sort((a, b) => (b.s.depth + b.t.depth) - (a.s.depth + a.t.depth));
    for (const l of sorted) {
      const g = l.kind === 'related' ? Math.min(heat.get(l.s.id) || 0, heat.get(l.t.id) || 0) : (heat.get(l.t.id) || 0);
      ctx.beginPath(); ctx.moveTo(l.s.sx, l.s.sy); ctx.lineTo(l.t.sx, l.t.sy);
      const depthAlpha = (fog(l.s) + fog(l.t)) / 2;
      if (g > 0.02) { ctx.strokeStyle = l.t.color; ctx.globalAlpha = (0.35 + g * 0.65) * depthAlpha; ctx.lineWidth = 1.5 + g * 2; ctx.setLineDash([6, 6]); ctx.lineDashOffset = -now / 40; }
      else { ctx.strokeStyle = l.kind === 'related' ? '#5b6f7c' : l.kind === 'topic' ? `${l.s.color}` : themeLine; ctx.globalAlpha = (l.kind === 'related' ? 0.3 : l.kind === 'topic' ? 0.22 : 0.7) * depthAlpha; ctx.lineWidth = l.kind === 'hub' ? 1.6 : 1; ctx.setLineDash(l.kind === 'related' ? [2, 4] : []); }
      if(selected && !selectedPeers.has(l.s.id) && !selectedPeers.has(l.t.id)) ctx.globalAlpha *= .15;
      ctx.stroke();
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    const pulse = center.pulse ? Math.max(0, 1 - (now - center.pulse) / 4000) : 0;
    const labelCandidates = [];
    for (const n of live.sort((a, b) => b.depth - a.depth)) {
      if (n.sx < -150 || n.sy < -70 || n.sx > width + 150 || n.sy > height + 70) continue;
      const s = n.scale; let r = radius(n) * s;
      const g = n.type === 'jarvis' ? Math.max(pulse, (heat.get('jarvis') || 0) * 0.7) : n.type === 'memory' ? (heat.get(n.id) || 0) : (heat.get(n.id) || 0) * 0.7;
      const match = query && n.type === 'memory' && matches(n);
      ctx.globalAlpha = (query && !match && n.type === 'memory' ? 0.2 : 1) * (g > 0.05 ? 1 : fog(n));
      if (g > 0) {
        const halo = r + (6 + g * 14) * s + Math.sin(now / (n.type === 'jarvis' ? 250 : 180)) * 3 * g;
        const grad = ctx.createRadialGradient(n.sx, n.sy, r * 0.5, n.sx, n.sy, halo); grad.addColorStop(0, `${n.color}cc`); grad.addColorStop(1, `${n.color}00`);
        ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(n.sx, n.sy, halo, 0, Math.PI * 2); ctx.fill(); r += g * 2.5 * s;
      }
      ctx.beginPath(); ctx.arc(n.sx, n.sy, Math.max(1.5, r), 0, Math.PI * 2);
      if (n.type === 'jarvis') { const grad = ctx.createRadialGradient(n.sx - r / 4, n.sy - r / 4, 2, n.sx, n.sy, r); grad.addColorStop(0, light ? '#c8ddff' : '#c2d9ff'); grad.addColorStop(1, n.color); ctx.fillStyle = grad; }
      else if (n.type === 'memory') { const grad = ctx.createRadialGradient(n.sx - r / 3, n.sy - r / 3, 0, n.sx, n.sy, r); grad.addColorStop(0, g > 0.05 ? '#ffffff' : `${n.color}`); grad.addColorStop(1, g > 0.05 ? n.color : `${n.color}77`); ctx.fillStyle = grad; }
      else ctx.fillStyle = css.getPropertyValue('--panel').trim();
      ctx.fill(); ctx.lineWidth = n === selected || match ? 3 : n.type === 'category' ? 2.5 : n.type === 'topic' ? 1.5 : 0.8; ctx.strokeStyle = n === selected || match ? css.getPropertyValue('--text').trim() : n.color;
      if (n.type === 'topic') ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
      if (n.type === 'jarvis') { ctx.fillStyle = '#0d151c'; ctx.font = `700 ${Math.max(9, 15 * s)}px Inter,Segoe UI,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('C', n.sx, n.sy + 1); }
      const labelled = n.type === 'jarvis' || n.type === 'category' || (n.type === 'topic' && s > 0.55) || (opts.labels && n.type === 'memory' && s > 0.65) || g > 0.05 || n === hover || n === selected || match;
      if (labelled) labelCandidates.push({ n, r, g, match, opacity: ctx.globalAlpha });
      ctx.globalAlpha = 1;
    }
    // Keep dense phrase maps legible: selected/active labels first, then hubs, then nearby memories.
    const priority = ({n,g,match}) => n === selected || n === hover ? 100 : g > .05 || match ? 90 : n.type === 'jarvis' ? 80 : n.type === 'category' ? 70 : n.type === 'topic' ? 60 : 0;
    labelCandidates.sort((a,b) => priority(b) - priority(a) || a.n.depth - b.n.depth);
    const occupied = new Set(); let labelsDrawn = 0;
    for (const candidate of labelCandidates) {
      const {n,r,g,opacity} = candidate, s = n.scale;
      const size = Math.max(9, Math.min(15, (n.type === 'memory' ? 11 : n.type === 'topic' ? 11.5 : 12.5) * Math.sqrt(s)));
      ctx.font = `${n.type === 'memory' ? 500 : 650} ${size}px Inter,Segoe UI,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const text = n.type === 'jarvis' ? 'Conclave' : n.label, tw = ctx.measureText(text).width, y = n.sy + r + 4;
      const cells = []; for (let x = Math.floor((n.sx - tw / 2 - 3) / 24); x <= Math.floor((n.sx + tw / 2 + 3) / 24); x++) for (let row = Math.floor(y / 18); row <= Math.floor((y + size + 3) / 18); row++) cells.push(`${x}:${row}`);
      if (priority(candidate) < 90 && (labelsDrawn > 90 || cells.some(c => occupied.has(c)))) continue;
      for (const cell of cells) occupied.add(cell); labelsDrawn++;
      ctx.globalAlpha = opacity; ctx.lineWidth = 3; ctx.strokeStyle = themeBg; ctx.strokeText(text, n.sx, y); ctx.fillStyle = n.type === 'memory' && !(g > .05) ? themeText : n.color; ctx.fillText(text, n.sx, y);
    }
    ctx.globalAlpha = 1;
    const active = memoryNodes.filter(n => (heat.get(n.id) || 0) > 0.05).length;
    hud.textContent = `${memoryNodes.length} memories · ${categoryNodes.length} categories · ${topicNodes.length} topics${active ? ` · ${active} lit` : ''} · drag to orbit`;
    canvas.dataset.yaw = cam.yaw.toFixed(5); canvas.dataset.pitch = cam.pitch.toFixed(5); canvas.dataset.zoom = view.k.toFixed(5); canvas.dataset.panX = view.x.toFixed(2); canvas.dataset.panY = view.y.toFixed(2); canvas.dataset.visible = String(live.length); canvas.dataset.frames = String(++frames);
  }
  function loop() { if (!running) return; if (!stage.isConnected) { dispose(); return; } if (!document.hidden) { tick(); draw(); } frame = requestAnimationFrame(loop); }
  function fit() {
    const live = nodes.filter(visible); if (!live.length || !width) return;
    const extent = Math.max(...live.map(n => Math.hypot(n.x, n.y, n.z))) + 40; cam.distance = Math.max(900, extent * 1.6); view.x = view.y = 0;
    const projectedExtent = extent * FOV / Math.sqrt(cam.distance * cam.distance - extent * extent); view.k = Math.max(.1, Math.min(5, Math.min(width, height) / (projectedExtent * 2 + 60)));
  }
  function focus(n) { project(n); view.x -= (n.sx - width / 2) / view.k; view.y -= (n.sy - height / 2) / view.k; view.k = Math.max(view.k, 1.1); lastInput = Date.now(); }
  const zoom = factor => { view.k = Math.max(0.1, Math.min(5, view.k * factor)); lastInput = Date.now(); };
  zoomBar.append(button('+', async () => zoom(1.25)), button('−', async () => zoom(0.8)), button('⤢', async () => fit()));
  zoomBar.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-label', ['Zoom in', 'Zoom out', 'Fit map'][i]));

  // ----- interaction: drag to orbit, shift/right-drag or two fingers to pan, wheel/pinch to zoom -----
  const pick = (sx, sy) => { let best = null, bestDepth = Infinity; for (const n of nodes) { if (!visible(n) || !n.projected || n.sx === undefined) continue; if (Math.hypot(n.sx - sx, n.sy - sy) < radius(n) * n.scale + 7 && n.depth < bestDepth) { best = n; bestDepth = n.depth; } } return best; };
  const pointers = new Map(); let pinch = null;
  const local = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.oncontextmenu = e => e.preventDefault();
  canvas.onpointerdown = e => {
    canvas.focus({preventScroll:true}); canvas.setPointerCapture(e.pointerId); const [sx, sy] = local(e); pointers.set(e.pointerId, [sx, sy]); lastInput = Date.now();
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, k: view.k, mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2, vx: view.x, vy: view.y }; drag = null; return; }
    const pan = e.shiftKey || e.button === 2, node = pan ? null : pick(sx, sy); drag = { node: node?.fixed ? null : node, picked: node, sx, sy, lx: sx, ly: sy, pan, moved: false };
  };
  canvas.onpointermove = e => {
    const [sx, sy] = local(e); if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [sx, sy]);
    if (pinch && pointers.size === 2) { const [a, b] = [...pointers.values()]; view.k = Math.max(0.1, Math.min(5, pinch.k * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d)); view.x = pinch.vx + ((a[0] + b[0]) / 2 - pinch.mx) / view.k; view.y = pinch.vy + ((a[1] + b[1]) / 2 - pinch.my) / view.k; lastInput = Date.now(); return; }
    if (!drag) { hover = pick(sx, sy); canvas.style.cursor = hover ? 'pointer' : 'grab'; return; }
    const dx = sx - drag.lx, dy = sy - drag.ly; drag.lx = sx; drag.ly = sy; lastInput = Date.now();
    if (Math.hypot(sx - drag.sx, sy - drag.sy) > 4) drag.moved = true;
    if (drag.node) { const [wx, wy, wz] = screenDelta(dx, dy, drag.node.scale || 1); drag.node.x += wx; drag.node.y += wy; drag.node.z += wz; alpha = Math.max(alpha, 0.3); }
    else if (drag.pan) { view.x += dx / view.k; view.y += dy / view.k; canvas.style.cursor = 'move'; }
    else { cam.yaw += dx * 0.006; cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch - dy * 0.006)); canvas.style.cursor = 'grabbing'; }
  };
  canvas.onpointerup = canvas.onpointercancel = e => {
    pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null;
    if (e.type !== 'pointercancel' && drag && !drag.moved && drag.picked) choose(drag.picked);
    drag = null; if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (pointers.size === 1) { const [sx,sy] = [...pointers.values()][0]; drag = {node:null,picked:null,sx,sy,lx:sx,ly:sy,pan:false,moved:true}; }
  };
  canvas.onwheel = e => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.12 : 0.89); };
  canvas.ondblclick = e => { const [x,y] = local(e), node = pick(x,y); node ? focus(node) : fit(); };
  canvas.onkeydown = e => {
    if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','_','Home'].includes(e.key)) return;
    e.preventDefault(); lastInput = Date.now();
    if (e.key === 'ArrowLeft') cam.yaw -= .1; if (e.key === 'ArrowRight') cam.yaw += .1;
    if (e.key === 'ArrowUp') cam.pitch = Math.min(1.45,cam.pitch + .1); if (e.key === 'ArrowDown') cam.pitch = Math.max(-1.45,cam.pitch - .1);
    if (e.key === '+' || e.key === '=') zoom(1.2); if (e.key === '-' || e.key === '_') zoom(1/1.2); if (e.key === 'Home') fit();
  };

  for (let i = 0; i < Math.min(80,Math.max(12,Math.floor(20000/nodes.length))); i++) tick();
  alpha = 0.4; resize(); fit(); showDetail(center); renderList(); loop();
  function dispose() {
    if (!running) return; running = false; cancelAnimationFrame(frame); clearInterval(timer); clearInterval(updateTimer); observer.disconnect(); pointers.clear(); drag = pinch = null;
    canvas.onpointerdown = canvas.onpointermove = canvas.onpointerup = canvas.onpointercancel = canvas.onwheel = canvas.oncontextmenu = canvas.onkeydown = canvas.ondblclick = null;
  }
  return dispose;
}
