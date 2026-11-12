import { agentAvatar } from './agent-avatar.js';
import { dictation } from './jarvis/api.js';
import { api, esc, ago, md, toast, modal, copy, $, $$ } from '../lib.js';
import { memoryForm } from './memory.js';
import { fileChips, bindFileChips, openWith } from './files.js';
import { planHtml, questionHtml, bindPlanAndQuestions, teamStripHtml, teamDialog } from './plan.js';
import { openShortcuts } from '../app.js';
import { selectionHtml, bindSelection, selectionLabel } from './selection.js';
import { openPlanQuickView } from './plan.js';
import { openRunnerModal } from './runner.js';

const TOOLS = { claude: 'Claude', antigravity: 'Antigravity', codex: 'Codex' };
const TARGETS = { ...TOOLS, council: 'Council' };

// Custom agents (Gemini CLI, Ollama, ...) join the built-in three.
async function loadMembers() {
  const list = await api('/api/members', { cache: 10_000 }).catch(() => []);
  for (const m of list) if (!m.builtin) TOOLS[m.id] = m.label;
  for (const k of Object.keys(TARGETS)) delete TARGETS[k];
  Object.assign(TARGETS, TOOLS, { council: 'Council' });
}
const ACCESS = { read: 'Read-only', ask: 'Ask me', edit: 'Can edit', full: 'Full access' };
const APMODE = { auto: 'Plans run automatically', risk: 'Auto, ask on risky steps', manual: 'I click Run plan' };
const ROUND_LABEL = { 'context-update': 'added details', synthesis: 'verdict', relay: 'handed off', imported: 'earlier session', build: 'builder', review: 'reviewer', fix: 'fix', 'plan-fix': 'plan fix' };
const roundLabel = r => !r ? '' : ROUND_LABEL[r] || (r.startsWith('council-') ? `round ${r.split('-')[1]}` : r.startsWith('step-') ? `step ${r.slice(5)}` : r.startsWith('review-') ? `review ${r.slice(7)}` : r.startsWith('fix-') ? `fix ${r.slice(4)}` : r);
const PHASE = { queued: 'queued', starting: 'starting', thinking: 'thinking', writing: 'writing', tool: 'working' };
const dur = m => {
  if (!m.finished) return '';
  const s = Math.round((new Date(m.finished) - new Date(m.created)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: k => { try { localStorage.removeItem(k); } catch {} }
};
let es = null;
let cleanupThread = null;
let MODELS = null;
const loadModels = async () => { if (!MODELS) MODELS = await api('/api/models', { cache: 10000 }).catch(() => ({})); return MODELS; };

const threadCache = new Map();
let currentRouteGen = 0;
let currentThreadAbortCtrl = null;
let currentHubList = [];
let currentHubDrawList = null;
let currentActiveThreadId = null;
let activePendingAttachments = [];

function fetchThreadData(id, signal) {
  return api(`/api/threads/${id}?limit=60&activity=lazy`, { signal });
}

function mergeThreadMessages(currentList = [], incomingList = [], incomingPage) {
  const currentById = new Map(currentList.map(m => [m.id, m]));
  const incomingById = new Map(incomingList.map(m => [m.id, m]));
  const merged = [];

  const firstIncomingSeq = incomingPage?.firstSeq ?? incomingList[0]?.seq ?? Infinity;
  for (const m of currentList) {
    if (!incomingById.has(m.id) && Number(m.seq) < firstIncomingSeq) {
      merged.push(m);
    }
  }

  for (const inc of incomingList) {
    const cur = currentById.get(inc.id);
    if (!cur) {
      merged.push(inc);
      continue;
    }

    const mergedMsg = { ...inc };

    if (cur.status === 'running') {
      if (inc.status === 'running') {
        if ((cur.content || '').length > (inc.content || '').length) {
          mergedMsg.content = cur.content;
        }
        if ((cur.activity || []).length > (inc.activity || []).length) {
          mergedMsg.activity = cur.activity;
        }
        mergedMsg.phase = cur.phase || inc.phase;
      } else if ((cur.content || '').length > (inc.content || '').length) {
        mergedMsg.content = cur.content;
      }
    }

    if (Array.isArray(cur.activity) && cur.activity.length > 0 && (!inc.activity || inc.activity.length === 0)) {
      mergedMsg.activity = cur.activity;
    }

    if (Array.isArray(cur.files) && cur.files.length > (inc.files?.length || 0)) {
      mergedMsg.files = cur.files;
    }

    merged.push(mergedMsg);
  }

  const lastIncomingSeq = incomingPage?.lastSeq ?? incomingList.at(-1)?.seq ?? -1;
  for (const m of currentList) {
    if (!incomingById.has(m.id) && Number(m.seq) > lastIncomingSeq) {
      merged.push(m);
    }
  }

  merged.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  return merged;
}

function applyThreadSnapshot(current, incoming) {
  const mergedMessages = mergeThreadMessages(current?.messages || [], incoming?.messages || [], incoming?.page);
  return {
    ...incoming,
    messages: mergedMessages,
    page: {
      hasMore: incoming?.page?.hasMore ?? current?.page?.hasMore ?? false,
      firstSeq: mergedMessages[0]?.seq ?? null,
      lastSeq: mergedMessages.at(-1)?.seq ?? null,
      limit: incoming?.page?.limit ?? 60
    }
  };
}

// Prompt Templates & Slash Prompts
export const SLASH_TEMPLATES = [
  {
    cmd: '/plan',
    label: 'Plan',
    desc: 'Propose a structured multi-agent plan for a feature or goal',
    template: `/plan Please propose a structured execution plan for:\n- Goal: \n- Architecture & requirements: \n- Specific constraints: \nLet the team debate trade-offs, identify affected files, and specify assignees.`
  },
  {
    cmd: '/review',
    label: 'Review',
    desc: 'Review recent code and files for bugs, security and regressions',
    template: `/review Please review the recent implementation and files:\n- Focus areas: correctness, edge cases, security, and performance\n- Check against existing patterns in the codebase\n- List any concrete bugs or regressions found`
  },
  {
    cmd: '/debug',
    label: 'Debug',
    desc: 'Investigate an error, stack trace, or unexpected behavior',
    template: `/debug Please investigate and fix this issue:\n- Symptoms / Error log: \n- Expected vs actual behavior: \n- Relevant files or steps to reproduce: `
  },
  {
    cmd: '/explain',
    label: 'Explain',
    desc: 'Explain code architecture, component relationships, or algorithms',
    template: `/explain Please explain the following part of the codebase:\n- Component / File: \n- Key questions: data flow, dependencies, lifecycle, and edge cases`
  },
  {
    cmd: '/tests',
    label: 'Tests',
    desc: 'Generate offline unit and integration tests with edge cases',
    template: `/tests Please generate comprehensive offline tests for:\n- Target module / function: \n- Edge cases to cover: boundary conditions, invalid inputs, failure modes\n- Test framework / runner: node:test`
  }
];

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Layout: the chat list can collapse, and focus mode hides the app nav too.
function applyLayout() {
  if (typeof document === 'undefined') return;
  document.body.classList.toggle('list-collapsed', store.get('cv-list') === 'collapsed');
  document.body.classList.toggle('focus-mode', store.get('cv-focus') === 'on');
}

export async function renderHub(view, params, threadId) {
  const switchStart = performance.now();
  applyLayout();

  const existingLayout = view.querySelector('.cv-layout');
  if (existingLayout) {
    const isSwitchingChat = currentActiveThreadId !== threadId;
    const activeInput = $('#input');
    if (activeInput && currentActiveThreadId && isSwitchingChat) {
      try {
        const prevKey = `conclave:draft:${currentActiveThreadId}`;
        if (activeInput.value.trim() || activePendingAttachments?.length) {
          store.set(prevKey, JSON.stringify({ text: activeInput.value, attachments: activePendingAttachments || [] }));
        } else {
          store.del(prevKey);
        }
      } catch {}
    }

    if (isSwitchingChat) {
      cleanupThread?.();
      cleanupThread = null;
    }

    if (!threadId && currentHubList?.length && !params.get('new') && !params.get('cwd')) {
      const firstActive = currentHubList.find(t => !t.settings?.archived) || currentHubList[0];
      if (firstActive) {
        location.replace('#/hub/' + firstActive.id);
        return;
      }
    }

    $$('#threads a.hub-thread').forEach(a => {
      a.classList.toggle('on', a.getAttribute('href') === `#/hub/${threadId}`);
    });
    if (threadId && !$$('#threads a.hub-thread').some(a => a.getAttribute('href') === `#/hub/${threadId}`)) {
      currentHubDrawList?.($('#tsearch')?.value || '');
    }

    if (!threadId) {
      currentActiveThreadId = null;
      renderWelcome($('#main'), params);
      return;
    }

    // If cold thread, immediately replace old main with loading state so old controls cannot be clicked
    const isWarm = threadCache.has(threadId);
    if (!isWarm) {
      const mainEl = $('#main');
      if (mainEl) {
        mainEl.innerHTML = '<div class="hub-main-loading empty"><span class="dots"><i></i><i></i><i></i></span> Loading chat…</div>';
      }
    }

    loadMembers();
    api('/api/threads', { cache: 3000 }).then(l => {
      currentHubList = l;
      currentHubDrawList?.($('#tsearch')?.value || '');
    }).catch(() => {});

    await renderThread($('#main'), threadId, currentHubList, () => {
      api('/api/threads', { cache: 0 }).then(l => {
        currentHubList = l;
        currentHubDrawList?.($('#tsearch')?.value || '');
      }).catch(() => {});
    }, null, switchStart);
    return;
  }

  cleanupThread?.(); cleanupThread = null;
  es?.close(); es = null;

  const membersPromise = loadMembers();
  const listPromise = api('/api/threads', { cache: 3000 }).catch(() => []);
  const threadPrefetch = threadId ? fetchThreadData(threadId) : null;
  const [_, listData] = await Promise.all([membersPromise, listPromise]);
  let list = listData;

  if (!threadId && list.length && !params.get('new') && !params.get('cwd')) {
    // Pick the first non-archived or first thread
    const firstActive = list.find(t => !t.settings?.archived) || list[0];
    location.replace('#/hub/' + firstActive.id);
    return;
  }

  let showArchived = store.get('cv-archived') === '1';

  view.innerHTML = `
    <div class="cv-layout">
      <div class="hub-list panel">
        <div class="hub-list-head"><b>Conclave chats</b>
          <div class="row" style="gap:4px">
            <button class="small icon-btn" id="newfolder" title="New chat in a project folder"><svg class="ic" style="color:inherit"><use href="#i-folder"/></svg></button>
            <button class="small primary" id="newchat" title="New quick chat (no folder needed)">＋ New</button>
            <button class="small icon-btn" id="collapse" title="Hide chat list (Ctrl+B)">«</button>
            <button class="small icon-btn mobile-close-list" id="close-mobile-list" title="Close chat list">✕</button>
          </div></div>
        ${list.length > 5 ? '<input type="search" class="hub-search" id="tsearch" placeholder="Filter chats…">' : ''}
        <div id="threads"></div>
      </div>
      <button class="list-rail" id="expand" title="Show chat list (Ctrl+B)">»</button>
      <div class="hub-main" id="main"></div>
    </div>`;

  const drawList = f => {
    const filterText = String(f || '').toLowerCase();
    const filtered = currentHubList.filter(t => !filterText || t.title.toLowerCase().includes(filterText));
    const pinned = filtered.filter(t => t.settings?.pinned && !t.settings?.archived);
    const active = filtered.filter(t => !t.settings?.pinned && !t.settings?.archived);
    const archived = filtered.filter(t => t.settings?.archived);

    const renderItem = t => {
      const seamless = typeof t.settings?.sync === 'boolean' ? t.settings.sync : (t.cwd || '').toLowerCase().includes('conclave');
      return `
      <div class="hub-thread-row" style="position:relative">
        <a class="hub-thread ${t.id === currentActiveThreadId ? 'on' : ''} ${t.settings?.pinned ? 'pinned' : ''}" href="#/hub/${t.id}">
          <span class="tgt ${t.target}">${esc(selectionLabel(t,TOOLS))}</span>
          <span class="t">${t.settings?.pinned ? '<span class="pin-badge" title="Pinned">📌</span>' : ''}${esc(t.title)}</span>
          <span class="muted tiny">${seamless ? '<span class="sync-indicator seamless" title="Seamless: synced with Raspberry Pi">☁️</span> ' : '<span class="sync-indicator local" title="Local only">💻</span> '}${t.running ? '<span class="live-dot"></span> working' : (t.otherDeviceWorking ? '<span class="live-dot warn"></span> other device working' : ago(t.updated))} · ${t.n} msgs</span>
        </a>
      </div>`;
    };

    const parts = [];
    if (pinned.length) {
      parts.push(`<div class="hub-section-head"><span>📌 Pinned</span><span>${pinned.length}</span></div>`);
      parts.push(pinned.map(renderItem).join(''));
    }
    if (active.length || !pinned.length) {
      if (pinned.length) parts.push(`<div class="hub-section-head"><span>Chats</span><span>${active.length}</span></div>`);
      parts.push(active.map(renderItem).join('') || '<div class="empty small">No active chats.</div>');
    }
    if (archived.length) {
      parts.push(`
        <button type="button" class="hub-archive-toggle" id="toggle-archived">
          <span>📦 Archived (${archived.length})</span>
          <span>${showArchived ? 'Hide ▲' : 'Show ▼'}</span>
        </button>`);
      if (showArchived) {
        parts.push(archived.map(renderItem).join(''));
      }
    }

    $('#threads').innerHTML = parts.join('');

    $('#toggle-archived')?.addEventListener('click', () => {
      showArchived = !showArchived;
      store.set('cv-archived', showArchived ? '1' : '0');
      drawList($('#tsearch')?.value || '');
    });
  };

  currentHubList = list;
  currentHubDrawList = drawList;
  drawList('');
  $('#tsearch')?.addEventListener('input', e => drawList(e.target.value));
  $('#newchat').onclick = () => quickChat();
  $('#newfolder').onclick = () => newChatDialog(params.get('cwd'));
  const toggleList = () => { store.set('cv-list', document.body.classList.contains('list-collapsed') ? 'open' : 'collapsed'); applyLayout(); };
  $('#collapse').onclick = toggleList;
  $('#expand').onclick = toggleList;
  $('#close-mobile-list')?.addEventListener('click', () => document.body.classList.remove('mobile-list-open'));
  $('#threads')?.addEventListener('click', e => { if (e.target.closest('a.hub-thread')) document.body.classList.remove('mobile-list-open'); });
  window.__cvToggleList = toggleList;

  if (!threadId) return renderWelcome($('#main'), params);
  await renderThread($('#main'), threadId, list, () => {
    api('/api/threads', { cache: 0 }).then(l => { list = l; currentHubList = l; drawList($('#tsearch')?.value || ''); }).catch(() => {});
  }, threadPrefetch, switchStart);
}

function renderWelcome(box, params) {
  const draftKey = 'conclave:draft:welcome';
  box.innerHTML = `<div class="hub-welcome">
    <button type="button" class="mobile-chats-btn" id="welcome-show-chats" style="margin-bottom:12px">← View chat history</button>
    <div class="gx-hello">
      <h1><span class="gx-grad" id="welcome-hello">Hello</span></h1>
      <p>What should the council work on?</p>
    </div>
    <div class="composer panel quick">
      <div class="seg" id="q-target">${selectionHtml({target:'claude'}, TOOLS)}</div>
      <div class="tiny muted">Select one or more agents. Toggle Council to have that selection debate and plan together.</div>
      <textarea id="q-input" rows="3" placeholder="Ask anything to start, or type / for templates. Files go in your Conclave folder."></textarea>
      <div class="row" style="justify-content:space-between;align-items:center;margin-top:4px">
        <div class="row" style="gap:6px">
          <button class="small" id="nc2"><svg class="ic" style="color:inherit"><use href="#i-folder"/></svg> Work in a project folder…</button>
        </div>
        <button class="primary" id="q-send">Start chat</button>
      </div>
    </div>
    <div class="gx-suggest" id="welcome-suggest">
      <button type="button" class="gx-suggestion">Review the latest changes in this project for bugs</button>
      <button type="button" class="gx-suggestion">Plan and build a new feature with the council</button>
      <button type="button" class="gx-suggestion">Explain how this codebase is organized</button>
      <button type="button" class="gx-suggestion">Find and fix failing tests</button>
    </div></div>`;
  api('/api/auth/account').then(acc => {
    const first = String(acc?.username || '').split(/[\s._@-]/)[0];
    const el = $('#welcome-hello'); if (el && first) el.textContent = `Hello, ${first[0].toUpperCase()}${first.slice(1)}`;
  }).catch(() => {});

  const qInput = $('#q-input');
  try {
    const saved = store.get(draftKey);
    if (saved && qInput) qInput.value = saved;
  } catch {}

  qInput?.addEventListener('input', () => {
    if (qInput.value.trim()) store.set(draftKey, qInput.value);
    else store.del(draftKey);
  });

  box.querySelectorAll('.gx-suggestion').forEach(b => b.onclick = () => { qInput.value = b.textContent; qInput.focus(); qInput.dispatchEvent(new Event('input')); });
  const quickSelection = bindSelection($('#q-target'), {target:'claude'}, TOOLS, () => { qInput.focus(); });
  $('#nc2').onclick = () => newChatDialog(params.get('cwd'),quickSelection());
  $('#welcome-show-chats')?.addEventListener('click', () => document.body.classList.add('mobile-list-open'));

  const go = () => {
    const v = qInput.value.trim();
    if (v) {
      store.del(draftKey);
      quickChat(quickSelection(), v);
    }
  };
  $('#q-send').onclick = go;
  qInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      go();
    }
  });
  qInput.focus();
  if (params.get('cwd')) newChatDialog(params.get('cwd'));
}

async function quickChat(selection = {target:'claude'}, firstMessage = '') {
  try {
    const t = await api('/api/threads', { method: 'POST', body: selection });
    if (firstMessage) await api(`/api/threads/${t.id}/messages`, { method: 'POST', body: { text: firstMessage } });
    location.hash = '#/hub/' + t.id;
  } catch (e) { toast(e.message, true); }
}

function newChatDialog(presetCwd, initialSelection = {target:'claude'}) {
  modal(`
    <h2 style="margin:0">New Conclave chat</h2>
    <label class="field">Working folder (optional)<input id="nc-cwd" list="nc-projects" placeholder="Leave empty for a fresh folder under ~/Conclave" value="${esc(presetCwd || '')}"><datalist id="nc-projects"></datalist></label>
    <div class="field">Talk to<div class="seg" id="nc-target">${selectionHtml(initialSelection, TOOLS)}</div></div>
    <div class="modal-actions"><button id="nc-cancel">Cancel</button><button class="primary" id="nc-go">Create</button></div>`, async (root, close) => {
    const projects = await api('/api/projects').catch(() => []);
    $('#nc-projects', root).innerHTML = projects.filter(p => p.exists).map(p => `<option value="${esc(p.path)}">`).join('');
    const selection = bindSelection($('#nc-target',root),initialSelection,TOOLS);
    $('#nc-cancel', root).onclick = close;
    $('#nc-go', root).onclick = async () => {
      const t = await api('/api/threads', { method: 'POST', body: { cwd: $('#nc-cwd', root).value.trim(), ...selection() } });
      close(); location.hash = '#/hub/' + t.id;
    };
  });
}

async function renderThread(box, id, list, onListChanged, preloadedPromise, startTime) {
  const switchStart = startTime || performance.now();
  const isWarm = threadCache.has(id);

  const prevInput = $('#input');
  if (prevInput && currentActiveThreadId && currentActiveThreadId !== id) {
    try {
      const prevKey = `conclave:draft:${currentActiveThreadId}`;
      if (prevInput.value.trim() || activePendingAttachments?.length) {
        store.set(prevKey, JSON.stringify({ text: prevInput.value, attachments: activePendingAttachments || [] }));
      } else {
        store.del(prevKey);
      }
    } catch {}
  }
  currentActiveThreadId = id;

  cleanupThread?.(); cleanupThread = null;
  const routeGen = ++currentRouteGen;
  if (currentThreadAbortCtrl) {
    currentThreadAbortCtrl.abort();
    currentThreadAbortCtrl = null;
  }
  const abortCtrl = new AbortController();
  currentThreadAbortCtrl = abortCtrl;
  let disposed = false;

  const cached = threadCache.get(id);
  let t = cached;
  let selectionControl;

  if (!t) {
    try {
      t = await (preloadedPromise || fetchThreadData(id, abortCtrl.signal));
    } catch (err) {
      if (err.name === 'AbortError' || abortCtrl.signal.aborted) return;
      toast('Failed to load chat: ' + err.message, true);
      box.innerHTML = `<div class="empty">Failed to load chat: ${esc(err.message)}</div>`;
      return;
    }
    if (disposed || routeGen !== currentRouteGen || abortCtrl.signal.aborted) return;
    threadCache.set(id, t);
  } else {
    (preloadedPromise || fetchThreadData(id, abortCtrl.signal)).then(fresh => {
      if (disposed || routeGen !== currentRouteGen || abortCtrl.signal.aborted || !fresh) return;
      t = applyThreadSnapshot(t, fresh);
      threadCache.set(id, t);
      const titleEl = $('#title');
      if (titleEl && titleEl.value !== t.title && document.activeElement !== titleEl) titleEl.value = t.title;
      const cwdEl = $('#cwd');
      if (cwdEl && cwdEl.value !== t.cwd && document.activeElement !== cwdEl) cwdEl.value = t.cwd;
      draw();
      drawChrome();
    }).catch(err => {
      if (err.name !== 'AbortError' && !abortCtrl.signal.aborted) {
        console.warn('Background thread refresh failed:', err);
      }
    });
  }
  let limits = {}, credits = {};
  let pendingAttachments = [];
  let sending = false;
  const draftKey = `conclave:draft:${id}`;
  const attemptKey = `conclave:send-attempt:${id}`;
  let pendingAttempt = null;
  try { pendingAttempt = JSON.parse(store.get(attemptKey) || 'null'); } catch {}

  const isPinned = !!t.settings?.pinned;
  const isArchived = !!t.settings?.archived;
  const isSeamless = typeof t.settings?.sync === 'boolean' ? t.settings.sync : (t.cwd || '').toLowerCase().includes('conclave');

  box.innerHTML = `
    <div class="hub-head">
      <div class="hub-head-info" style="min-width:0;flex:1">
        <div class="row hub-head-row1" style="align-items:center;gap:6px">
          <button type="button" class="mobile-chats-btn" id="btn-mobile-chats" title="View all chats">← Chats</button>
          <input class="title-input" id="title" value="${esc(t.title)}" aria-label="Chat title">
          <span class="reconnect-pill connecting" id="reconnect-pill" title="Connecting to live stream…"><i class="status-dot"></i><span class="status-txt">Connecting…</span></span>
        </div>
        <div class="row small hub-head-sub" style="align-items:center;gap:6px;flex-wrap:wrap">
          <svg class="ic"><use href="#i-folder"/></svg><input id="cwd" class="mono small cwd-input" list="cwd-list" value="${esc(t.cwd)}" aria-label="Working folder" title="Change the folder agents work in"><datalist id="cwd-list"></datalist>
          ${t.settings.quick ? '<span class="chip" title="Quick chat: its own folder under ~/Conclave">quick</span>' : ''}
          <button class="small icon-btn" id="open-cwd" title="Show folder in Explorer">↗</button>
          <button class="small" id="open-plan" title="Quick view of project plans">▤ Plan</button>
          <button class="small" id="open-runner" title="Project tasks and script runner">▶ Runner</button>
          <button class="small" id="open-term" title="Open built-in terminal in this folder">>_ Terminal</button>
          <button class="small chip-sync ${isSeamless ? 'chip-seamless' : 'chip-local'}" id="btn-sync-toggle" title="Click to toggle sync between Seamless (Raspberry Pi synced) and Local Only">${isSeamless ? '☁️ Seamless' : '💻 Local Only'}</button>
          ${isSeamless ? '<button class="small ghost" id="btn-sync-now" title="Synchronize chat messages with Raspberry Pi">🔄 Sync Now</button>' : ''}
          <div class="team-strip" id="team" title="Team: roles and usage. Click to edit."></div>
        </div>
      </div>
      <div class="row hub-head-actions" style="align-items:center;gap:6px">
        <button id="btn-pin" class="icon-btn ${isPinned ? 'active' : ''}" title="${isPinned ? 'Unpin chat' : 'Pin chat to top'}">${isPinned ? '📌' : '📍'}</button>
        <button id="btn-archive" class="icon-btn ${isArchived ? 'active' : ''}" title="${isArchived ? 'Unarchive chat' : 'Archive chat'}">${isArchived ? '📦' : '🗄'}</button>
        <a class="btn icon-btn" href="/api/threads/${id}/export" download title="Export as Markdown">⇩</a>
        <button id="settings" class="icon-btn" title="Chat settings"><svg class="ic" style="color:inherit"><use href="#i-gear"/></svg></button>
        <button id="focus" class="icon-btn" title="Full screen (Ctrl+Shift+F)">⤢</button>
        <button id="del" class="icon-btn danger" title="Delete this chat (each tool keeps its own session)">✕</button>
        <details id="hub-more-actions" class="hub-more-actions">
          <summary class="icon-btn" title="More actions">⋯</summary>
          <div class="hub-more-dropdown">
            <button id="m-btn-pin" class="menu-item" type="button">${isPinned ? '📌 Unpin chat' : '📍 Pin chat'}</button>
            <button id="m-btn-archive" class="menu-item" type="button">${isArchived ? '📦 Unarchive' : '🗄 Archive'}</button>
            <button id="m-btn-sync" class="menu-item" type="button">${isSeamless ? '💻 Switch to Local Only' : '☁️ Switch to Seamless'}</button>
            ${isSeamless ? '<button id="m-btn-sync-now" class="menu-item" type="button">🔄 Sync with Pi</button>' : ''}
            <button id="m-btn-terminal" class="menu-item" type="button">&gt;_ Terminal</button>
            <a id="m-btn-export" class="menu-item" href="/api/threads/${id}/export" download>⇩ Export Markdown</a>
            <button id="m-btn-focus" class="menu-item" type="button">⤢ Full screen</button>
            <button id="m-btn-del" class="menu-item danger" type="button">✕ Delete chat</button>
          </div>
        </details>
      </div>
    </div>
    <div id="onboarding-container"></div>
    <div class="wait-banner" id="remote-working" role="status" aria-live="polite" hidden></div>
    <div class="msgs" id="msgs"></div>
    <div class="wait-banner" id="waiting" hidden></div>
    <div class="queue" id="queue" hidden></div>
    <div id="details-delivery" class="tiny muted" role="status" hidden></div>
    <div class="composer panel" id="composer">
      <div class="drag-overlay"><span>📥 Drop files here to attach</span></div>
      <div class="slash-popover" id="slash-popover" hidden></div>
      <div class="row" style="align-items:center;justify-content:space-between;gap:8px">
        <div class="row" style="gap:8px;align-items:center">
          <div class="seg" id="target" title="Click agent names to add or remove them; Council uses your selection" role="group" aria-label="Agents and council mode">${selectionHtml(t, TOOLS)}</div>
          <select id="model" class="small pick" title="Model for this tool in this chat"></select>
          <select id="effort" class="small pick" title="Reasoning effort"></select>
        </div>
        <div class="row" style="gap:6px;align-items:center">
          <select id="access" class="small pick" title="What agents may do">${Object.entries(ACCESS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <select id="apmode" class="small pick" title="How council plans start">${Object.entries(APMODE).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        </div>
      </div>
      <div class="working" id="working" hidden></div>
      <div class="composer-attachments" id="composer-attachments" hidden></div>
      <textarea id="input" rows="2" placeholder="Message…"></textarea>
      <div class="composer-toolbar">
        <div class="composer-actions-left">
          <input type="file" id="file-input" multiple style="display:none">
          <button type="button" class="template-btn" id="btn-attach" title="Attach file or image (Codex native images, Claude reads paths, Antigravity file paths)"><svg class="ic" style="color:inherit"><use href="#i-folder"/></svg> Attach</button>
          <button type="button" class="template-btn" id="btn-templates" title="Prompt templates (/plan, /review, /debug, ...)">⚡ Templates</button>
          <button type="button" class="template-btn ghost" id="btn-shortcuts" title="Keyboard shortcuts (?)">⌨</button>
          <button type="button" class="template-btn ghost" id="btn-mic" title="Dictate" aria-label="Dictate" aria-pressed="false" hidden>🎙</button>
        </div>
        <span class="hint" id="hint" title="Codex native images, Claude reads paths, Antigravity file paths">Enter send · Shift+Enter newline · / templates</span>
        <div class="composer-actions-right">
          <button id="stop" class="danger" hidden>■ Stop</button>
          <button id="now" hidden title="Add details without stopping the active run (Alt+M or Ctrl+Enter)">＋ Add details</button>
          <button class="primary" id="send">Send</button>
        </div>
      </div>
    </div>`;

  const msgs = $('#msgs');
  const input = $('#input');
  {
    const micBtn = $('#btn-mic');
    const mic = dictation(text => { input.value = (input.value ? input.value + ' ' : '') + text; input.dispatchEvent(new Event('input')); input.focus(); },
      on => { micBtn?.classList.toggle('on', on); micBtn?.setAttribute('aria-pressed', String(on)); });
    if (mic && micBtn) { micBtn.hidden = false; micBtn.onclick = () => mic.toggle(); }
  }
  const composer = $('#composer');
  const attBox = $('#composer-attachments');
  const slashBox = $('#slash-popover');
  const seen = new Set();

  // Onboarding Checklist
  function drawOnboarding() {
    const obBox = $('#onboarding-container');
    if (!obBox) return;
    const dismissed = store.get('cv-onboarding-dismissed') === '1';
    if (dismissed) { obBox.innerHTML = ''; return; }

    const hasFolder = !!(t.cwd && !t.settings?.quick);
    const hasTemplates = t.messages.some(m => /\/(plan|review|debug|explain|tests)/i.test(m.content || ''));
    const distinctTools = new Set(t.messages.filter(m => m.role === 'agent').map(m => m.tool)).size;
    const hasMultiAgent = distinctTools >= 2 || t.messages.some(m => /@(claude|antigravity|codex)/i.test(m.content || ''));
    const hasCouncil = t.target === 'council' || t.messages.some(m => m.round?.startsWith('council-') || m.round === 'synthesis');
    const checkedTeam = store.get('cv-team-checked') === '1';

    const items = [
      { id: 'folder', text: 'Set your project working folder', done: hasFolder, hint: 'Click the folder input in the header' },
      { id: 'templates', text: 'Try a slash template (/plan, /review, /debug)', done: hasTemplates, hint: 'Type / in the message box or click ⚡ Templates' },
      { id: 'multi', text: 'Mention or switch between agents (@claude, @codex, @antigravity)', done: hasMultiAgent, hint: 'Type @codex or click the tool tabs above' },
      { id: 'council', text: 'Try Council mode (debate, build & review)', done: hasCouncil, hint: 'Select Council to let all agents collaborate' },
      { id: 'team', text: 'Inspect team roles & credit meters', done: checkedTeam, hint: 'Click the team strip in the header' }
    ];

    const doneCount = items.filter(x => x.done).length;
    const pct = Math.round(doneCount / items.length * 100);

    obBox.innerHTML = `
      <div class="onboarding-card">
        <details class="onboarding-details" id="ob-details" ${typeof window !== 'undefined' && window.innerWidth > 860 ? 'open' : ''}>
          <summary class="onboarding-header">
            <div class="onboarding-title"><span>🚀 Getting Started with Conclave</span><span class="chip">${doneCount}/${items.length}</span></div>
            <div class="row" style="gap:6px">
              <button class="ghost tiny" id="ob-dismiss" title="Dismiss checklist">✕ Dismiss</button>
            </div>
          </summary>
          <div class="onboarding-progress"><i style="width:${pct}%"></i></div>
          <div class="onboarding-list">
            ${items.map(it => `
              <div class="onboarding-item ${it.done ? 'done' : ''}" data-ob="${it.id}">
                <span class="onboarding-check">${it.done ? '✓' : '○'}</span>
                <span><b>${it.text}</b> <span class="muted tiny">· ${it.hint}</span></span>
              </div>`).join('')}
          </div>
        </details>
      </div>`;

    $('#ob-dismiss')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      store.set('cv-onboarding-dismissed', '1');
      obBox.innerHTML = '';
    });

    $$('.onboarding-item', obBox).forEach(el => {
      el.addEventListener('click', () => {
        const it = el.dataset.ob;
        if (it === 'folder') $('#cwd')?.focus();
        else if (it === 'templates') { $('#btn-templates')?.click(); }
        else if (it === 'multi') { input.value = '@codex '; grow(); input.focus(); }
        else if (it === 'council') { $$('#target button').find(b => b.dataset.v === 'council')?.click(); }
        else if (it === 'team') { $('#team')?.click(); store.set('cv-team-checked', '1'); drawOnboarding(); }
      });
    });
  }

  // Mobile actions menu & Pin/Archive toggles
  $('#btn-mobile-chats')?.addEventListener('click', () => document.body.classList.toggle('mobile-list-open'));
  $('#m-btn-pin')?.addEventListener('click', () => { $('#btn-pin')?.click(); $('#hub-more-actions')?.removeAttribute('open'); });
  $('#m-btn-archive')?.addEventListener('click', () => { $('#btn-archive')?.click(); $('#hub-more-actions')?.removeAttribute('open'); });
  $('#m-btn-sync')?.addEventListener('click', () => { $('#hub-more-actions')?.removeAttribute('open'); $('#btn-sync-toggle')?.click(); });
  $('#m-btn-sync-now')?.addEventListener('click', () => { $('#hub-more-actions')?.removeAttribute('open'); $('#btn-sync-now')?.click(); });
  $('#m-btn-terminal')?.addEventListener('click', () => { $('#hub-more-actions')?.removeAttribute('open'); $('#open-term')?.click(); });
  $('#m-btn-export')?.addEventListener('click', () => $('#hub-more-actions')?.removeAttribute('open'));
  $('#m-btn-focus')?.addEventListener('click', () => { $('#focus')?.click(); $('#hub-more-actions')?.removeAttribute('open'); });
  const mDel = $('#m-btn-del');
  if (mDel) {
    mDel.onclick = async e => {
      e.stopPropagation();
      if (!mDel.dataset.armed) {
        mDel.dataset.armed = '1';
        mDel.textContent = 'Confirm delete?';
        setTimeout(() => { if (mDel) { mDel.dataset.armed = ''; mDel.textContent = '✕ Delete chat'; } }, 3000);
        return;
      }
      $('#hub-more-actions')?.removeAttribute('open');
      await api('/api/threads/' + id, { method: 'DELETE' });
      store.del(draftKey);
      location.hash = '#/hub';
    };
  }
  document.addEventListener('click', e => {
    const more = $('#hub-more-actions');
    if (more && more.hasAttribute('open') && !more.contains(e.target)) {
      more.removeAttribute('open');
    }
  });

  $('#btn-pin').onclick = async () => {
    const cur = !!t.settings?.pinned;
    t = await api('/api/threads/' + id, { method: 'PATCH', body: { settings: { pinned: !cur } } });
    $('#btn-pin').className = `icon-btn ${t.settings.pinned ? 'active' : ''}`;
    $('#btn-pin').textContent = t.settings.pinned ? '📌' : '📍';
    const mPin = $('#m-btn-pin');
    if (mPin) mPin.textContent = t.settings.pinned ? '📌 Unpin chat' : '📍 Pin chat';
    toast(t.settings.pinned ? 'Chat pinned to top' : 'Chat unpinned');
    onListChanged?.();
  };

  $('#btn-archive').onclick = async () => {
    const cur = !!t.settings?.archived;
    t = await api('/api/threads/' + id, { method: 'PATCH', body: { settings: { archived: !cur } } });
    $('#btn-archive').className = `icon-btn ${t.settings.archived ? 'active' : ''}`;
    $('#btn-archive').textContent = t.settings.archived ? '📦' : '🗄';
    const mArc = $('#m-btn-archive');
    if (mArc) mArc.textContent = t.settings.archived ? '📦 Unarchive' : '🗄 Archive';
    toast(t.settings.archived ? 'Chat archived' : 'Chat restored from archive');
    onListChanged?.();
  };

  // Reconnection status
  const pill = $('#reconnect-pill');
  const setConn = (cls, txt) => {
    if (!pill) return;
    pill.className = `reconnect-pill ${cls}`;
    const txtEl = pill.querySelector('.status-txt');
    if (txtEl) txtEl.textContent = txt;
    pill.title = cls === 'connected' ? 'Live stream connected'
      : cls === 'reconnecting' ? 'Reconnecting to live stream…'
      : cls === 'connecting' ? 'Connecting to live stream…'
      : 'Live stream disconnected';
  };
  window.__cvSetConn = setConn;

  // Attachments Handling
  function fileIcon(name = '') {
    if (/\.pdf$/i.test(name)) return '📕';
    if (/\.(zip|tar|gz|7z|rar|bz2|xz)$/i.test(name)) return '📦';
    if (/\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(name)) return '🎵';
    if (/\.(mp4|webm|mov|mkv|avi)$/i.test(name)) return '🎬';
    if (/\.(docx?|odt|rtf)$/i.test(name)) return '📝';
    if (/\.(xlsx?|ods|csv|tsv)$/i.test(name)) return '📊';
    if (/\.(pptx?|odp)$/i.test(name)) return '📑';
    if (/\.(json|ya?ml|toml|xml)$/i.test(name)) return '📋';
    if (/\.(js|ts|py|rs|go|c|cpp|java|sh|ps1|html|css)$/i.test(name)) return '💻';
    return '📄';
  }

  function renderAttachmentChips() {
    if (!pendingAttachments.length) {
      attBox.hidden = true;
      attBox.innerHTML = '';
      return;
    }
    attBox.hidden = false;
    attBox.innerHTML = pendingAttachments.map(a => `
      <div class="att-chip ${a.uploading ? 'uploading' : ''}" data-att-id="${a.id}">
        ${a.previewUrl ? `<img class="att-thumb" src="${esc(a.previewUrl)}" alt="">` : `<span style="font-size:13px">${fileIcon(a.name)}</span>`}
        <span class="att-name" title="${esc(a.name)}">${esc(a.name)}</span>
        <span class="att-size">${formatBytes(a.size)}</span>
        <button type="button" class="att-remove" data-rm-att="${a.id}" title="Remove file">✕</button>
      </div>`).join('');
  }

  attBox.addEventListener('click', e => {
    const b = e.target.closest('[data-rm-att]');
    if (!b) return;
    const aid = b.dataset.rmAtt;
    pendingAttachments = pendingAttachments.filter(x => x.id !== aid);
    renderAttachmentChips();
    saveDraft();
  });

  async function addFiles(files) {
    if (!files || !files.length) return;
    const currentTotal = pendingAttachments.reduce((sum, a) => sum + a.size, 0);
    let addedTotal = 0;
    for (const f of Array.from(files)) {
      if (f.size > 4 * 1024 * 1024) {
        toast(`"${f.name}" exceeds 4MB size limit (${formatBytes(f.size)})`, true);
        continue;
      }
      if (currentTotal + addedTotal + f.size > 4 * 1024 * 1024) {
        toast(`Cannot attach "${f.name}": total attachments exceed 4MB aggregate limit`, true);
        continue;
      }
      addedTotal += f.size;
      const isImg = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(f.name) || f.type.startsWith('image/');
      const reader = new FileReader();
      const p = new Promise(resolve => {
        reader.onload = () => {
          const res = reader.result;
          const b64 = String(res).split(',')[1] || '';
          resolve({
            id: Math.random().toString(36).slice(2),
            name: f.name,
            size: f.size,
            type: f.type || (isImg ? 'image/png' : 'text/plain'),
            isImage: isImg,
            data: b64,
            previewUrl: isImg ? String(res) : null
          });
        };
        reader.onerror = () => { toast(`Could not read ${f.name}`, true); resolve(null); };
        reader.readAsDataURL(f);
      });
      const att = await p;
      if (att) pendingAttachments.push(att);
    }
    renderAttachmentChips();
    saveDraft();
  }

  const fileInput = $('#file-input');
  $('#btn-attach').onclick = () => fileInput.click();
  fileInput.onchange = e => { addFiles(e.target.files); fileInput.value = ''; };

  // Drag and drop into composer
  composer.addEventListener('dragover', e => { e.preventDefault(); composer.classList.add('drag-active'); });
  composer.addEventListener('dragleave', e => { if (!composer.contains(e.relatedTarget)) composer.classList.remove('drag-active'); });
  composer.addEventListener('drop', e => {
    e.preventDefault();
    composer.classList.remove('drag-active');
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  });

  // Paste image or files into textarea
  input.addEventListener('paste', e => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      addFiles(files);
      toast(`Attached ${files.length} item${files.length > 1 ? 's' : ''} from clipboard`);
    }
  });

  // Slash commands / Templates popover
  let selectedSlashIndex = 0;
  function renderSlashMenu(filter = '') {
    const needle = filter.toLowerCase().trim();
    const matches = SLASH_TEMPLATES.filter(s => !needle || s.cmd.includes(needle) || s.label.toLowerCase().includes(needle));
    if (!matches.length) {
      slashBox.hidden = true;
      return;
    }
    if (selectedSlashIndex >= matches.length) selectedSlashIndex = 0;
    slashBox.hidden = false;
    slashBox.innerHTML = matches.map((s, idx) => `
      <div class="slash-item ${idx === selectedSlashIndex ? 'selected' : ''}" data-slash-idx="${idx}">
        <div class="slash-item-head">
          <span class="slash-tag">${esc(s.cmd)}</span>
          <span class="slash-title">${esc(s.label)}</span>
        </div>
        <div class="slash-desc">${esc(s.desc)}</div>
      </div>`).join('');
  }

  function insertTemplate(tpl) {
    slashBox.hidden = true;
    input.value = tpl.template;
    grow();
    input.focus();
    // Position cursor after the first colon or prompt line
    const pos = tpl.template.indexOf(':');
    if (pos >= 0) input.setSelectionRange(pos + 2, pos + 2);
    saveDraft();
  }

  $('#btn-templates').onclick = () => {
    if (!slashBox.hidden) { slashBox.hidden = true; return; }
    selectedSlashIndex = 0;
    renderSlashMenu('');
  };

  $('#btn-shortcuts').onclick = openShortcuts;

  slashBox.addEventListener('click', e => {
    const item = e.target.closest('[data-slash-idx]');
    if (!item) return;
    const idx = Number(item.dataset.slashIdx);
    const visible = SLASH_TEMPLATES.filter(s => {
      const v = input.value.trim().toLowerCase();
      return !v.startsWith('/') || s.cmd.includes(v) || s.label.toLowerCase().includes(v);
    });
    const chosen = visible[idx] || SLASH_TEMPLATES[idx];
    if (chosen) insertTemplate(chosen);
  });

  // Persistent Composer Draft
  function saveDraft() {
    try {
      activePendingAttachments = pendingAttachments;
      if (!input.value.trim() && !pendingAttachments.length) store.del(draftKey);
      else store.set(draftKey, JSON.stringify({ text: input.value, attachments: pendingAttachments }));
    } catch {}
  }

  function loadDraft() {
    try {
      const raw = store.get(draftKey);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.text && !input.value) { input.value = d.text; grow(); }
      if (Array.isArray(d.attachments) && d.attachments.length) {
        pendingAttachments = d.attachments;
        activePendingAttachments = pendingAttachments;
        renderAttachmentChips();
      }
    } catch {}
  }

  function actions(m) {
    if (m.status === 'running') return '';
    const b = [`<button data-act="copy" title="Copy text">Copy</button>`];
    const lastUserMsg = [...t.messages].reverse().find(x => x.role === 'user');
    if (m.role === 'user' && m.id === lastUserMsg?.id && !t.running) {
      b.push(`<button data-act="edit" title="Edit and resend your latest request">Edit & Resend</button>`);
    }
    if (m.role === 'agent') {
      b.push(`<button data-act="mem" title="Save to shared memory">Remember</button>`);
      for (const [k, v] of Object.entries(TOOLS)) if (k !== m.tool) b.push(`<button data-act="review" data-tool="${k}" title="Ask ${v} to review this reply">${v} review</button>`);
      if (m.status !== 'done') b.push(`<button data-act="retry" title="Run this agent again">Retry</button>`);
    }
    return `<div class="actions">${b.join('')}</div>`;
  }

  const lastAct = m => m.activity?.length ? m.activity[m.activity.length - 1] : '';

  function inner(m) {
    const who = m.role === 'user' ? 'You' : m.role === 'system' ? 'Conclave' : TOOLS[m.tool] || m.tool;
    const run = m.status === 'running';
    const phase = run ? (m.phase || (m.content ? 'writing' : 'thinking')) : null;
    const count = m.activityCount ?? m.activity?.length ?? 0;
    const hasLoadedActivity = Array.isArray(m.activity) && m.activity.length > 0;
    const act = count ? `<details class="tool act" data-mid="${m.id}"><summary>⚙ ${count} action${count > 1 ? 's' : ''}</summary><pre>${hasLoadedActivity ? esc(m.activity.join('\n')) : 'Loading actions…'}</pre></details>` : '';
    const body = m.content ? md(m.content) : run ? '' : '';
    const status = run ? `<span class="phase-label phase-${phase}">${PHASE[phase] || 'working'}${phase === 'tool' && lastAct(m) ? ': <span class="mono">' + esc(lastAct(m).slice(0, 80)) + '</span>' : ''}</span>`
      : m.status === 'error' ? '<span style="color:var(--danger)">failed</span>' : m.status === 'stopped' ? 'stopped'
      : new Date(m.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `${actions(m)}
      <div class="who">${m.role === 'agent' ? agentAvatar(m.tool, who, true) : ''}<b>${esc(who)}</b>${m.round ? `<span class="chip">${esc(roundLabel(m.round))}</span>` : ''}
        <span class="meta">${status}${m.role === 'agent' && dur(m) ? ' · ' + dur(m) : ''}</span></div>
      ${act}${run && !m.content ? `<div class="thinking-bar"><span class="dots"><i></i><i></i><i></i></span></div>` : ''}<div class="md">${body}</div>
      ${m.role === 'agent' ? fileChips(m.files, run ? '' : m.content) : ''}
      ${m.changes ? `<button class="changes ${m.changes.reverted ? 'reverted' : ''}" data-act="diff" title="See exactly what this reply changed">± ${m.changes.files} file${m.changes.files === 1 ? '' : 's'} changed <span class="add">+${m.changes.add}</span> <span class="del">−${m.changes.del}</span>${m.changes.reverted ? ' · reverted' : ''}</button>` : ''}
      ${m.error && m.status !== 'done' ? `<div class="small" style="color:var(--danger);white-space:pre-wrap;margin-top:4px">${esc(m.error)}</div>` : ''}`;
  }

  const cls = m => {
    const run = m.status === 'running';
    const phase = run ? (m.phase || (m.content ? 'writing' : 'thinking')) : '';
    return `hm ${m.role} ${m.tool || ''} ${m.round === 'synthesis' ? 'verdict' : ''} ${run ? 'running phase-' + phase : ''} ${seen.has(m.id) ? '' : 'enter'}`;
  };
  const msgHtml = m => `<div class="${cls(m)}" data-id="${m.id}">${inner(m)}</div>`;

  let pendingDraw;
  const patchTimers = new Map();

  // Full redraw: used when messages are added or finish, plans or questions change.
  function draw() {
    if (disposed || !msgs?.isConnected) return;
    clearTimeout(pendingDraw);
    for (const timer of patchTimers.values()) clearTimeout(timer);
    patchTimers.clear();
    const openActs = new Set($$('.hm[data-id]', msgs).filter(el => el.querySelector('details.tool.act')?.open).map(el => el.dataset.id));
    const qInputs = new Map($$('.question[data-qid]', msgs).map(el => {
      const inp = el.querySelector('.q-input');
      return [el.dataset.qid, { value: inp?.value || '', focused: document.activeElement === inp }];
    }));
    const out = [];
    if (t.page?.hasMore) {
      out.push(`
        <div class="load-earlier-wrap" id="load-earlier-wrap" style="text-align:center;padding:8px 0 14px 0;">
          <button type="button" class="btn-load-earlier small ghost" id="btn-load-earlier" title="Load older messages">↑ Load earlier messages</button>
        </div>`);
    }
    const L = t.messages;
    const plansByMsg = new Map((t.plans || []).map(p => [p.message_id, p]));
    let i = 0;
    while (i < L.length) {
      const m = L[i];
      const grouped = m.round && (m.round.startsWith('council-') || m.round === 'review');
      if (grouped) {
        const g = [];
        while (i < L.length && L[i].round === m.round) g.push(L[i++]);
        out.push(g.length > 1 ? `<div class="council-row">${g.map(msgHtml).join('')}</div>` : msgHtml(g[0]));
        continue;
      }
      out.push(msgHtml(m));
      const p = plansByMsg.get(m.id);
      if (p) out.push(planHtml(p, TOOLS));
      i++;
    }
    for (const a of t.approvals || []) out.push(`
      <div class="approval enter" data-approval="${a.id}">
        <div class="who"><span class="q-badge warn">!</span><b>${esc(TOOLS[a.agent] || a.agent)}</b> wants permission</div>
        <pre>${esc(a.summary)}</pre>
        <div class="row" style="gap:6px">
          <button class="primary small" data-decide="allowed">Allow</button>
          <button class="small" data-decide="always" title="Allow ${esc(a.toolName)} for the rest of this chat">Always allow ${esc(a.toolName)}</button>
          <button class="small danger" data-decide="denied">Deny</button>
        </div>
      </div>`);
    for (const q of t.questions || []) out.push(questionHtml(q, TOOLS));
    const atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 140;
    msgs.innerHTML = out.join('') || `<div class="empty">${t.target === 'council'
      ? (t.settings.councilMode === 'build' ? 'The builder builds, the reviewers check the real files, then the builder fixes.' : 'All members answer, review each other, then the lead writes the verdict and a plan the team carries out.')
      : `${selectionLabel(t,TOOLS)} will answer. Switch tools any time below; the next one sees the whole chat.`}</div>`;
    for (const mid of openActs) {
      const det = msgs.querySelector(`.hm[data-id="${mid}"] details.tool.act`);
      if (det) det.open = true;
    }
    for (const [qid, state] of qInputs) {
      const inp = msgs.querySelector(`.question[data-qid="${qid}"] .q-input`);
      if (inp) {
        if (state.value) inp.value = state.value;
        if (state.focused) inp.focus();
      }
    }
    for (const m of L) seen.add(m.id);
    if (atBottom) msgs.scrollTop = msgs.scrollHeight;
    drawChrome();
    drawOnboarding();
  }

  function patch(m) {
    if (disposed || !msgs?.isConnected) return;
    const el = msgs.querySelector(`.hm[data-id="${m.id}"]`);
    if (!el) return draw();
    const actOpen = !!el.querySelector('details.tool.act')?.open;
    const atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 140;
    el.className = cls(m);
    el.innerHTML = inner(m);
    if (actOpen) {
      const det = el.querySelector('details.tool.act');
      if (det) det.open = true;
    }
    if (atBottom) msgs.scrollTop = msgs.scrollHeight;
    drawWorking();
  }

  function drawWorking() {
    if (disposed) return;
    const runningMsgs = t.messages.filter(m => m.status === 'running');
    const w = $('#working');
    if (!w) return;
    w.hidden = !runningMsgs.length;
    if (runningMsgs.length) w.innerHTML = runningMsgs.map(m => {
      const ph = m.phase || (m.content ? 'writing' : 'thinking');
      const phaseTxt = ph === 'queued' ? 'is queued' : ph === 'starting' ? 'is starting' : (PHASE[ph] || 'working');
      return `<span class="work-chip ${esc(m.tool)} ph-${ph}">${agentAvatar(m.tool,TOOLS[m.tool] || m.tool,true)}${esc(TOOLS[m.tool] || m.tool)} ${phaseTxt}${ph === 'tool' && lastAct(m) ? ` <span class="mono tiny">${esc(lastAct(m).slice(0, 50))}</span>` : ''}</span>`;
    }).join('');
    const teamEl = $('#team');
    if (teamEl) teamEl.innerHTML = teamStripHtml(t.team || [], TOOLS, limits, credits, new Set(runningMsgs.map(m => m.tool)));
  }

  function drawChrome() {
    if (disposed || !$('#stop')) return;
    selectionControl?.sync(t);
    const busy = t.running;
    const remote = isSeamless && t.otherDeviceWorking;
    const remoteNote = $('#remote-working');
    remoteNote.hidden = !remote;
    remoteNote.textContent = remote ? `☁️ Other device already working${t.remoteExecutionStatus?.device ? ` (${t.remoteExecutionStatus.device})` : ''}. Your draft stays here until you send it.` : '';
    const delivery=$('#details-delivery'), updates=t.contextUpdates;
    delivery.hidden=!updates?.latest;
    if(updates?.latest){const checked=updates.readers.filter(reader=>reader.cursor>=updates.latest).map(reader=>TOOLS[reader.tool] || reader.tool);delivery.textContent=checked.length ? `Details checked by ${checked.join(', ')}.` : 'Details saved. Available at the next context check or model turn; the active run continues.';}
    $('#stop').hidden = !busy;
    $('#now').hidden = !busy;
    $('#send').textContent = busy ? 'Queue' : 'Send';
    $('#send').title = remote ? 'Other device already working. Your draft will be kept.' : busy ? 'Send after the agents finish (Enter)' : '';
    const w = t.waiting;
    $('#waiting').hidden = !w || busy;
    if (w && !busy) $('#waiting').innerHTML = `⏳ All agents are out of credits. Conclave will continue at <b>${new Date(w.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b>.
      <button class="small" data-wait="resume">Retry now</button><button class="small" data-wait="cancel">Cancel</button>`;
    const q = t.queue || [];
    $('#queue').hidden = !q.length;
    $('#queue').innerHTML = q.map((x, i) => `<div class="queued" data-qid="${x.id}"><span class="chip">${i + 1}</span><span class="qt">${esc(x.text)}</span>
      <button class="small" data-q="edit" title="Pull back into composer to edit">✎ Edit</button>
      <button class="small" data-q="send" title="Add this context without stopping the active run">＋ Add details</button><button class="small icon-btn" data-q="drop" title="Remove">✕</button></div>`).join('')
      + (q.length ? `<div class="tiny muted" style="padding:0 4px">Queued messages send automatically when the agents finish${busy ? '' : ' (paused after Stop: send them yourself)'}.</div>` : '');
    $$('#target button').forEach(b => {
      const out = t.credits?.[b.dataset.v];
      b.classList.toggle('out', !!out);
      b.title = out ? `Out of credits until ${new Date(out.until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}. Conclave hands its turns to the next agent.` : '';
    });
    $('#access').value = t.settings.permission;
    $('#apmode').value = t.settings.approvalMode || 'auto';
    $('#apmode').hidden = t.target !== 'council';
    drawPickers();
    drawWorking();
    $('#input').placeholder = remote ? 'Other device already working… Your draft stays on this device'
      : busy ? 'Agents are working… Enter queues; Alt+M adds details without stopping'
      : t.target === 'council' ? 'Ask the council… (type / for templates)' : `Message ${selectionLabel(t,TOOLS)}… (type / for templates)`;
  }

  draw();
  loadDraft();
  msgs.scrollTop = msgs.scrollHeight;
  const switchDuration = Math.round((performance.now() - switchStart) * 100) / 100;
  const switchMetric = {
    type: isWarm ? 'warm' : 'cold',
    threadId: id,
    durationMs: switchDuration,
    timestamp: Date.now()
  };
  window.__cvLastSwitch = switchMetric;
  window.__cvSwitchMetrics = window.__cvSwitchMetrics || [];
  window.__cvSwitchMetrics.push(switchMetric);
  if (window.__cvSwitchMetrics.length > 30) window.__cvSwitchMetrics.shift();
  Promise.all([
    api('/api/limits', { cache: 5000 }).catch(() => ({})),
    api('/api/credits', { cache: 5000 }).catch(() => ({}))
  ]).then(([l, c]) => {
    if (disposed || routeGen !== currentRouteGen) return;
    limits = l; credits = c; drawWorking();
  });

  bindFileChips(msgs);
  bindPlanAndQuestions(msgs, id, () => refresh());

  msgs.addEventListener('toggle', async e => {
    const det = e.target.closest('details.tool.act');
    if (!det || !det.open) return;
    const mid = det.dataset.mid;
    if (!mid) return;
    const m = t.messages.find(x => x.id === mid);
    if (!m) return;
    if (!m.activity || !m.activity.length) {
      const pre = det.querySelector('pre');
      if (pre) pre.textContent = 'Loading actions…';
      try {
        const res = await api(`/api/threads/${id}/messages/${mid}/activity`);
        m.activity = res.activity || [];
        if (pre) pre.textContent = m.activity.join('\n') || 'No actions recorded.';
      } catch (err) {
        if (pre) pre.textContent = 'Failed to load actions: ' + err.message;
      }
    }
  }, true);

  msgs.addEventListener('click', async e => {
    const loadEarlierBtn = e.target.closest('#btn-load-earlier');
    if (loadEarlierBtn && !loadEarlierBtn.disabled) {
      loadEarlierBtn.disabled = true;
      loadEarlierBtn.textContent = 'Loading earlier messages…';
      const prevScrollHeight = msgs.scrollHeight;
      const prevScrollTop = msgs.scrollTop;
      try {
        const firstSeq = t.page?.firstSeq ?? t.messages[0]?.seq;
        const res = await api(`/api/threads/${id}/messages?before=${firstSeq}&limit=60&activity=lazy`);
        if (disposed || !res?.messages) return;

        const existingIds = new Set(t.messages.map(m => m.id));
        const toPrepend = res.messages.filter(m => !existingIds.has(m.id));
        t.messages = [...toPrepend, ...t.messages];
        t.page = {
          ...t.page,
          hasMore: !!res.hasMore,
          firstSeq: res.firstSeq
        };
        threadCache.set(id, t);
        draw();

        const newScrollHeight = msgs.scrollHeight;
        msgs.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
      } catch (err) {
        toast('Failed to load earlier messages: ' + err.message, true);
        if (loadEarlierBtn) {
          loadEarlierBtn.disabled = false;
          loadEarlierBtn.textContent = '↑ Load earlier messages';
        }
      }
      return;
    }
    const d = e.target.closest('[data-decide]');
    if (d) {
      const aid = d.closest('[data-approval]').dataset.approval;
      d.closest('.approval').classList.add('done');
      api(`/api/approvals/${aid}`, { method: 'POST', body: { decision: d.dataset.decide === 'denied' ? 'denied' : 'allowed', always: d.dataset.decide === 'always' } })
        .catch(err => toast(err.message, true));
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const m = t.messages.find(x => x.id === b.closest('.hm').dataset.id);
    if (!m) return;
    if (b.dataset.act === 'copy') copy(m.content);
    if (b.dataset.act === 'edit') {
      modal(`
        <div class="row" style="justify-content:space-between;align-items:center">
          <h2 style="margin:0">Edit & Resend</h2>
          <button class="icon-btn" id="ed-x">✕</button>
        </div>
        <textarea id="ed-text" rows="4" style="margin:8px 0;width:100%">${esc(m.content)}</textarea>
        <div class="modal-actions">
          <button id="ed-composer">Load into Composer</button>
          <button class="primary" id="ed-resend">Update & Resend</button>
        </div>`, (root, close) => {
        $('#ed-x', root).onclick = close;
        $('#ed-composer', root).onclick = () => {
          input.value = $('#ed-text', root).value;
          grow(); input.focus(); saveDraft(); close();
          toast('Loaded into composer');
        };
        $('#ed-resend', root).onclick = async () => {
          const text = $('#ed-text', root).value.trim();
          if (!text) return toast('Message is empty', true);
          close();
          try {
            await api(`/api/threads/${id}/messages/${m.id}/edit`, { method: 'POST', body: { text } });
            toast('Latest request updated & resent');
            t.running = true;
            drawChrome();
            refresh();
          } catch (err) {
            toast(err.message, true);
          }
        };
      });
    }
    if (b.dataset.act === 'mem') memoryForm({ title: '', body: m.content, type: 'project', scope: t.cwd, tags: m.tool }, () => toast('Saved to shared memory'));
    if (b.dataset.act === 'review') send({ text: `@${b.dataset.tool} Please review ${TOOLS[m.tool]}'s last reply above. Check it against the actual files, list concrete problems, or say it looks right.` });
    if (b.dataset.act === 'diff') diffDialog(id, m, () => refresh());
    if (b.dataset.act === 'retry') api(`/api/threads/${id}/retry`, { method: 'POST', body: { messageId: m.id } }).then(() => { t.running = true; drawChrome(); }, err => toast(err.message, true));
  });

  $('#waiting').addEventListener('click', async e => {
    const b = e.target.closest('[data-wait]');
    if (!b) return;
    await api(`/api/threads/${id}/${b.dataset.wait === 'resume' ? 'resume-waiting' : 'cancel-waiting'}`, { method: 'POST', body: {} }).catch(err => toast(err.message, true));
    refresh();
  });

  $('#queue').addEventListener('click', async e => {
    const b = e.target.closest('[data-q]');
    if (!b) return;
    const qid = b.closest('[data-qid]').dataset.qid;
    const qItem = (t.queue || []).find(x => x.id === qid);
    try {
      if (b.dataset.q === 'drop') {
        await api(`/api/threads/${id}/queue/${qid}`, { method: 'DELETE' });
        refresh();
      } else if (b.dataset.q === 'edit') {
        if (qItem) { input.value = qItem.text; grow(); input.focus(); saveDraft(); }
        await api(`/api/threads/${id}/queue/${qid}`, { method: 'DELETE' });
        refresh();
        toast('Queued message moved back to composer');
      } else {
        b.disabled = true; b.textContent = 'Sending…';
        await api(`/api/threads/${id}/queue/${qid}/details`, { method: 'POST', body: {} });
        refresh();
      }
    } catch (err) { toast(err.message, true); }
  });

  const refresh = async () => {
    if (disposed) return;
    const was = t.running;
    const next = await api(`/api/threads/${id}?limit=60&activity=lazy`, { signal: abortCtrl.signal }).catch(() => null);
    if (disposed || !next || routeGen !== currentRouteGen) return;
    t = applyThreadSnapshot(t, next);
    threadCache.set(id, t);
    draw();
    if (was !== t.running) onListChanged?.();
    if (was && !t.running) notifyDone(t);
  };

  let checkingRemote = false;
  const checkRemote = async () => {
    if (disposed || !isSeamless || checkingRemote) return;
    checkingRemote = true;
    try {
      const state = await api(`/api/sync/lock/${id}`);
      if (disposed) return;
      const previous = t.otherDeviceWorking;
      if (typeof state.otherDeviceWorking === 'boolean') t.otherDeviceWorking = state.otherDeviceWorking;
      t.remoteExecutionStatus = state;
      drawChrome();
      if (previous !== t.otherDeviceWorking) {
        onListChanged?.();
        if (previous && !t.otherDeviceWorking) refresh();
      }
    } catch { /* A failed status check must not clear a known remote claim. */ }
    finally { checkingRemote = false; }
  };
  const remoteTimer = isSeamless ? setInterval(checkRemote, 5000) : null;
  checkRemote();

  const soonDraw = () => { if (disposed) return; clearTimeout(pendingDraw); pendingDraw = setTimeout(draw, 50); };
  const soonPatch = m => {
    if (disposed) return;
    const mid = m.id;
    if (patchTimers.has(mid)) return;
    patchTimers.set(mid, setTimeout(() => {
      patchTimers.delete(mid);
      const cur = t.messages.find(x => x.id === mid) || m;
      patch(cur);
    }, 60));
  };
  cleanupThread = () => {
    disposed = true;
    abortCtrl.abort();
    clearInterval(remoteTimer);
    clearTimeout(pendingDraw);
    for (const timer of patchTimers.values()) clearTimeout(timer);
    patchTimers.clear();
    setConn('disconnected', 'Closed');
    es?.close();
    es = null;
    window.__cvEs = null;
    const sendBtn = $('#send'); if (sendBtn) sendBtn.disabled = true;
    const nowBtn = $('#now'); if (nowBtn) nowBtn.disabled = true;
    const inp = $('#input'); if (inp) inp.disabled = true;
  };

  // Setup EventSource with reconnect handling
  es = location.search.includes('snap') ? { close() {} } : new EventSource(`/api/threads/${id}/events`);
  window.__cvEs = es;
  es.onopen = () => {
    setConn('connected', 'Live');
  };
  es.onerror = () => {
    if (!es || es.readyState === 2) {
      setConn('disconnected', 'Disconnected');
    } else {
      setConn('reconnecting', 'Reconnecting…');
    }
  };
  es.onmessage = ev => {
    setConn('connected', 'Live');
    const e = JSON.parse(ev.data);
    const find = mid => t.messages.find(x => x.id === mid);
    if (e.type === 'hello') {
      const serverLastSeq = Number(e.lastSeq) || 0;
      const localMaxSeq = Math.max(0, ...(t.messages || []).map(m => Number(m.seq) || 0));
      if (serverLastSeq > localMaxSeq) {
        (async () => {
          let cursor = localMaxSeq;
          let changed = false;
          while (!disposed && routeGen === currentRouteGen && cursor < serverLastSeq) {
            const res = await api(`/api/threads/${id}/messages?after=${cursor}&limit=60&activity=lazy`).catch(() => null);
            if (disposed || routeGen !== currentRouteGen || !res?.messages?.length) break;
            for (const msg of res.messages) {
              const idx = t.messages.findIndex(m => m.id === msg.id);
              if (idx >= 0) {
                t.messages[idx] = msg;
              } else {
                t.messages.push(msg);
                changed = true;
              }
              if (Number(msg.seq) > cursor) cursor = Number(msg.seq);
            }
            if (!res.hasMore) break;
          }
          if (changed && !disposed && routeGen === currentRouteGen) {
            t.messages.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
            threadCache.set(id, t);
            soonDraw();
          }
        })();
      }
      return;
    }
    if (e.type === 'message') {
      const idx = t.messages.findIndex(m => m.id === e.message.id);
      if (idx >= 0) { const was = t.messages[idx]; t.messages[idx] = e.message; if (was.status === 'running' && e.message.status === 'running') soonPatch(e.message); else soonDraw(); }
      else { t.messages.push(e.message); soonDraw(); }
    } else if (e.type === 'delta' || e.type === 'activity' || e.type === 'phase') {
      const m = find(e.id); if (!m) return;
      if (e.type === 'delta') { m.content = (m.content || '') + e.text; m.phase = 'writing'; }
      else if (e.type === 'activity') { (m.activity ||= []).push(e.text); }
      else m.phase = e.phase;
      soonPatch(m);
    } else if (e.type === 'file') {
      const m = find(e.id);
      if (m && !(m.files ||= []).some(f => f.path === e.path)) { m.files.push({ path: e.path, action: e.action }); soonPatch(m); }
    } else if (e.type === 'approval') {
      const a = e.approval;
      t.approvals = (t.approvals || []).filter(x => x.id !== a.id);
      if (a.status === 'pending') { t.approvals.push(a); notifyHidden(`${TOOLS[a.agent] || a.agent} needs permission`, a.summary); }
      soonDraw();
    } else if (e.type === 'question') {
      const q = e.question;
      t.questions = (t.questions || []).filter(x => x.id !== q.id);
      if (q.status === 'pending') { t.questions.push(q); notifyHidden(`${TOOLS[q.agent] || q.agent} has a question`, q.question); }
      soonDraw();
    } else if (e.type === 'plan') {
      const p = e.plan;
      t.plans = [p, ...(t.plans || []).filter(x => x.id !== p.id)];
      soonDraw();
    } else if (e.type === 'thread') refresh();
  };

  async function send(body) {
    if (sending || disposed || routeGen !== currentRouteGen) return;
    sending = true;
    try {
      let text = String(body.text || '').trim();
      // A lost response must retry the same logical message, including its
      // already-uploaded attachment paths, instead of starting a second run.
      const source = JSON.stringify({ text, mode: body.mode || '', executePlan: !!body.executePlan, target: t.target, attachments: pendingAttachments.map(a => ({ name: a.name, size: a.size, data: a.data })) });
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
      const fingerprint = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
      if (!pendingAttempt || pendingAttempt.fingerprint !== fingerprint) {
        pendingAttempt = { fingerprint, requestId: crypto.randomUUID() };
        store.set(attemptKey, JSON.stringify(pendingAttempt));
      }
      body.requestId = pendingAttempt.requestId;

      // If attachments exist, upload them first and enrich prompt with canonical project paths
      if (pendingAttempt.uploadedText) body.text = pendingAttempt.uploadedText;
      else if (pendingAttachments.length) {
        const totalBytes = pendingAttachments.reduce((sum, a) => sum + a.size, 0);
        if (totalBytes > 4 * 1024 * 1024) {
          toast(`Total attachments (${formatBytes(totalBytes)}) exceed 4MB limit`, true);
          return;
        }
        toast('Uploading attachments…');
        const uploadRes = await api(`/api/threads/${id}/attachments`, {
          method: 'POST',
          body: { files: pendingAttachments.map(a => ({ name: a.name, data: a.data, encoding: 'base64' })) }
        });
        const saved = uploadRes.files || [uploadRes.file];
        let attMd = '\n\n--- Attachments ---';
        for (const s of saved) {
          if (s.isImage) {
            attMd += `\n- Image: ${s.originalName || s.filename} (canonical path: \`${s.path}\`)\n  ![${s.originalName || s.filename}](${s.url})`;
          } else {
            attMd += `\n- File: ${s.originalName || s.filename} (canonical path: \`${s.path}\`, size: ${formatBytes(s.size)})`;
          }
        }
        text = (text ? text + '\n' : '') + attMd;
        body.text = text;
        pendingAttempt.uploadedText = text;
        store.set(attemptKey, JSON.stringify(pendingAttempt));
      }

      const r = await api(`/api/threads/${id}/messages`, { method: 'POST', body });
      if (r.busy) {
        t.otherDeviceWorking = true;
        t.remoteExecutionStatus = { device: r.device, otherDeviceWorking: true };
        drawChrome();
        saveDraft();
        toast(`⏳ ${r.note || 'Other device already working'}`, true);
        checkRemote();
        return;
      }
      if (r.ok === false) throw new Error(r.note || 'The message was not accepted. Your draft was kept.');
      pendingAttempt = null;
      store.del(attemptKey);
      input.value = '';
      grow();
      pendingAttachments = [];
      activePendingAttachments = [];
      renderAttachmentChips();
      slashBox.hidden = true;
      store.del(draftKey);

      if (r.details) {toast(r.delivery || 'Details already saved');refresh();}
      else if (r.queued) toast(`Queued (#${r.position}). It sends when the agents finish.`);
      else if (r.duplicate) { toast('This message was already accepted.'); refresh(); }
      else { t.running = true; drawChrome(); onListChanged?.(); }
      askNotifyPermission();
      if (r.queued) refresh();
    } catch (e) { toast(e.message, true); }
    finally { sending = false; }
  }

  const grow = () => {
    input.style.height = 'auto';
    const isMobile = (typeof window !== 'undefined') && (window.innerWidth <= 860 || window.innerHeight <= 600);
    const maxH = (typeof window !== 'undefined' && window.innerHeight < 550)
      ? 56
      : isMobile
        ? Math.min(100, Math.floor(window.innerHeight * 0.18))
        : 260;
    input.style.height = Math.max(48, Math.min(input.scrollHeight, maxH)) + 'px';
  };

  input.addEventListener('input', () => {
    grow();
    saveDraft();
    const val = input.value;
    if (val.startsWith('/')) {
      renderSlashMenu(val.slice(1));
    } else {
      slashBox.hidden = true;
    }
  });

  $('#send').onclick = () => {
    if (input.value.trim() || pendingAttachments.length) send({ text: input.value });
  };
  $('#now').onclick = () => {
    if (input.value.trim() || pendingAttachments.length) send({ text: input.value, mode: 'details' });
    else api(`/api/threads/${id}/stop`, { method: 'POST', body: {} });
  };

  input.addEventListener('keydown', e => {
    // Navigate slash popover if visible
    if (!slashBox.hidden) {
      const items = $$('.slash-item', slashBox);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedSlashIndex = (selectedSlashIndex + 1) % items.length;
        items.forEach((it, idx) => it.classList.toggle('selected', idx === selectedSlashIndex));
        items[selectedSlashIndex]?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedSlashIndex = (selectedSlashIndex - 1 + items.length) % items.length;
        items.forEach((it, idx) => it.classList.toggle('selected', idx === selectedSlashIndex));
        items[selectedSlashIndex]?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const sel = items[selectedSlashIndex];
        if (sel) sel.click();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        slashBox.hidden = true;
        return;
      }
    }

    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    if ((e.ctrlKey || e.metaKey) && t.running) $('#now').click(); else $('#send').click();
  });

  $('#stop').onclick = () => api(`/api/threads/${id}/stop`, { method: 'POST', body: {} }).then(() => toast('Stopping…'));

  selectionControl = bindSelection($('#target'),t,TOOLS,async selection => {
    t = { ...t, ...(await api('/api/threads/' + id, {method:'PATCH',body:selection})) };
    drawChrome(); input.focus(); onListChanged?.();
  });

  const saveSettings = async patchData => {
    t = await api('/api/threads/' + id, { method: 'PATCH', body: { settings: patchData } });
    draw();
  };
  $('#access').onchange = e => saveSettings({ permission: e.target.value }).then(() => toast(`Agents: ${ACCESS[e.target.value]}`));
  $('#apmode').onchange = e => saveSettings({ approvalMode: e.target.value }).then(() => toast(APMODE[e.target.value]));
  $('#title').onchange = e => api('/api/threads/' + id, { method: 'PATCH', body: { title: e.target.value } }).then(() => {
    const el = $('.hub-thread.on .t'); if (el) el.textContent = e.target.value;
    onListChanged?.();
  });
  $('#cwd').onchange = e => api('/api/threads/' + id, { method: 'PATCH', body: { cwd: e.target.value } }).then(() => toast('Folder updated'));
  $('#open-cwd').onclick = () => openWith(t.cwd, 'folder');
  $('#open-plan').onclick = () => openPlanQuickView(t.plans || [], TOOLS);
  $('#open-runner').onclick = () => openRunnerModal(t.cwd, text => { input.value = (input.value ? input.value + '\n\n' : '') + text; grow(); input.focus(); saveDraft(); });
  $('#open-term').onclick = () => { location.hash = '#/terminal?cwd=' + encodeURIComponent(t.cwd || ''); };
  $('#btn-sync-toggle').onclick = async () => {
    const nextSync = !isSeamless;
    try {
      const res = await api('/api/threads/' + id + '/sync', {
        method: 'PATCH',
        body: { sync: nextSync }
      });
      t.settings.sync = res.sync;
      toast(res.sync ? '☁️ Seamless Sync enabled (synced with Raspberry Pi)' : '💻 Switched to Local Only (this machine only)');
      onListChanged?.();
      renderThread(box, id, list, onListChanged);
    } catch (e) {
      toast('Failed to update sync mode: ' + e.message, true);
    }
  };
  if ($('#btn-sync-now')) {
    $('#btn-sync-now').onclick = async () => {
      const btn = $('#btn-sync-now');
      btn.disabled = true;
      btn.textContent = '🔄 Syncing…';
      try {
        const res = await api('/api/sync/thread/' + id, { method: 'POST', body: {} });
        toast(`Synced! Pushed ${res.pushedMessages} messages, Pi added ${res.remoteInserted}`);
      } catch (e) {
        toast('Sync failed: ' + e.message, true);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Sync Now'; }
      }
    };
  }
  $('#team').onclick = () => teamDialog(t, TOOLS, saveSettings);
  $('#focus').onclick = toggleFocus;
  $('#del').onclick = async () => {
    const b = $('#del');
    if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = 'Delete?'; setTimeout(() => { b.dataset.armed = ''; b.textContent = '✕'; }, 3000); return; }
    await api('/api/threads/' + id, { method: 'DELETE' });
    store.del(draftKey);
    location.hash = '#/hub';
  };
  $('#settings').onclick = () => settingsDialog(t, saveSettings);
  api('/api/projects', { cache: 10000 }).then(ps => {
    if (disposed || routeGen !== currentRouteGen) return;
    const el = $('#cwd-list');
    if (el) el.innerHTML = ps.filter(p => p.exists).map(p => `<option value="${esc(p.path)}">`).join('');
  }).catch(() => {});

  // Model + effort for the selected tool (saved per chat).
  function drawPickers() {
    if (disposed) return;
    const m = MODELS?.[t.target];
    const ms = $('#model'), ef = $('#effort');
    if (!ms || !ef) return;
    ms.hidden = ef.hidden = !m;
    if (!m) return;
    const cur = t.settings.models?.[t.target] || '';
    const opts = m.models.some(x => x.id === cur) ? m.models : [...m.models, { id: cur, label: cur }];
    const msHtml = opts.map(x => `<option value="${esc(x.id)}" ${x.id === cur ? 'selected' : ''}>${esc(x.label)}</option>`).join('');
    if (ms.dataset.sig !== msHtml) { ms.innerHTML = msHtml; ms.dataset.sig = msHtml; }
    else if (ms.value !== cur) ms.value = cur;
    const model = m.models.find(x => x.id === cur);
    const efforts = model?.efforts?.length ? model.efforts : m.efforts;
    const ce = t.settings.efforts?.[t.target] || '';
    const efHtml = `<option value="">effort: default</option>` + efforts.map(x => `<option value="${x}" ${x === ce ? 'selected' : ''}>effort: ${x}</option>`).join('');
    if (ef.dataset.sig !== efHtml) { ef.innerHTML = efHtml; ef.dataset.sig = efHtml; }
    else if (ef.value !== ce) ef.value = ce;
  }
  const savePick = async () => {
    const models = { ...(t.settings.models || {}), [t.target]: $('#model').value };
    const efforts = { ...(t.settings.efforts || {}), [t.target]: $('#effort').value };
    for (const o of [models, efforts]) for (const k of Object.keys(o)) if (!o[k]) delete o[k];
    await saveSettings({ models, efforts });
    toast(`${TARGETS[t.target]}: ${$('#model').selectedOptions[0]?.textContent || 'default'}${$('#effort').value ? ', effort ' + $('#effort').value : ''}`);
  };
  $('#model').onchange = savePick;
  $('#effort').onchange = savePick;
  loadModels().then(() => {
    if (disposed || routeGen !== currentRouteGen) return;
    drawPickers();
  });
  input.focus();
}

function toggleFocus() {
  store.set('cv-focus', document.body.classList.contains('focus-mode') ? 'off' : 'on');
  applyLayout();
}
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', e => {
    if (!location.hash.startsWith('#/hub')) return;
    if(e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase()==='m' && !e.repeat && !document.querySelector('dialog[open]')){
      const input=$('#input');if(!input)return;e.preventDefault();
      if(input.value.trim())$('#now')?.click();else {input.focus();toast('Type details, then press Alt+M to add them without stopping the run.');}
      return;
    }

  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); toggleFocus(); }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); window.__cvToggleList?.(); }
  if (e.key === 'Escape') {
    const pop = $('#slash-popover');
    if (pop && !pop.hidden) { pop.hidden = true; return; }
    if (document.body.classList.contains('focus-mode') && !document.querySelector('dialog[open]')) toggleFocus();
  }
  });
}

// What one reply changed, with undo.
async function diffDialog(threadId, m, onDone) {
  let d;
  try { d = await api(`/api/threads/${threadId}/messages/${m.id}/diff`); } catch (e) { toast(e.message, true); return; }
  const html = d.diff.split('\n').map(l => {
    const c = l.startsWith('diff --git') ? 'fh' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l) ? 'meta' : '';
    return `<div class="${c}">${esc(l) || ' '}</div>`;
  }).join('');
  modal(`
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div><h2 style="margin:0">Changes by ${esc(TOOLS[m.tool] || m.tool)}</h2>
        <div class="muted small">${d.files} file${d.files === 1 ? '' : 's'} · <span style="color:var(--ok)">+${d.add}</span> <span style="color:var(--danger)">−${d.del}</span> · <span class="mono tiny">${esc(d.root)}</span>${d.reverted ? ' · <b>reverted</b>' : ''}</div></div>
      <button class="icon-btn" id="df-x">✕</button>
    </div>
    <div class="diff full">${html}</div>
    <div class="modal-actions">
      <span class="muted tiny" style="margin-right:auto">Revert applies the reverse patch. It stops safely if those lines changed again.</span>
      <button id="df-copy">Copy patch</button>
      ${d.reverted ? '' : '<button class="danger" id="df-revert">Revert these changes</button>'}
    </div>`, (root, close) => {
    $('#df-x', root).onclick = close;
    $('#df-copy', root).onclick = () => copy(d.diff);
    $('#df-revert', root)?.addEventListener('click', async e => {
      const b = e.target;
      if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = 'Click again to revert'; return; }
      try { await api(`/api/threads/${threadId}/messages/${m.id}/revert`, { method: 'POST', body: {} }); toast('Reverted'); close(); onDone?.(); }
      catch (err) { toast(err.message, true); }
    });
  });
}

// Desktop notifications when the tab is in the background.
function askNotifyPermission() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}
function notifyHidden(title, body) {
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(title, { body: String(body || '').slice(0, 140) });
}
function notifyDone(t) {
  const last = [...t.messages].reverse().find(m => m.role === 'agent');
  notifyHidden(`Conclave: ${t.title}`, last ? `${TOOLS[last.tool] || last.tool}: ${last.content.slice(0, 120)}` : 'Agents finished');
}

function settingsDialog(t, save) {
  const s = t.settings;
  const fbs = { enabled: true, order: ['claude', 'antigravity', 'codex'], otherModel: true, waitForReset: true, ...(s.fallback || {}) };
  const sel = (id, opts, v) => `<select id="${id}">${Object.entries(opts).map(([k, l]) => `<option value="${k}" ${k === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  modal(`
    <h2 style="margin:0">Chat settings</h2>
    <fieldset><legend>Access</legend>
      <label class="field">What agents may do${sel('s-perm', { read: 'Read-only: look and answer, change nothing', ask: 'Ask me: Claude asks here before risky actions', edit: 'Edit files in the working folder', full: 'Full access: no limits at all (careful)' }, s.permission)}</label>
      <label class="field">Terminal${sel('s-shell', { direct: 'Direct: agents run shell commands themselves (no sandbox, no prompts)', sandboxed: "Sandboxed: each tool's own limits and prompts" }, s.shell || 'direct')}</label>
      <label class="field">Council plans${sel('s-apmode', APMODE, s.approvalMode || 'auto')}</label>
      <label class="small check"><input type="checkbox" id="s-relay" ${s.autoRelay ? 'checked' : ''}> Agents may hand work to each other with @mentions (max 4 hand-offs per message)</label>
    </fieldset>
    <fieldset><legend>Council</legend>
      <div class="muted small">Members and the lead are set in <b>Team</b> (click the team strip in the header).</div>
      <div class="row">
        <label class="field grow">Mode${sel('s-mode', { debate: 'Debate → verdict → plan', build: 'Build & review: builder builds, reviewers check, builder fixes' }, s.councilMode)}</label>
        <label class="field grow">Review rounds${sel('s-rounds', { 0: 'None: answers + verdict', 1: '1 round', 2: '2 rounds' }, s.rounds)}</label>
      </div>
      <label class="field">During debate agents may${sel('s-cperm', { read: 'Only read (recommended)', edit: 'Edit files (parallel edits can clash)' }, s.councilPermission)}</label>
    </fieldset>
    <fieldset><legend>When an agent runs out of credits or stalls</legend>
      <label class="small check"><input type="checkbox" id="f-on" ${fbs.enabled ? 'checked' : ''}> Hand its turn to the next agent automatically</label>
      <div class="small muted">Takeover order (top first):</div>
      <ol class="fb-order" id="f-order">${fbs.order.map(k => `<li data-k="${k}"><span>${esc(TOOLS[k] || k)}</span><button class="small icon-btn" data-up title="Move up">↑</button><button class="small icon-btn" data-rm title="Remove">✕</button></li>`).join('')}</ol>
      <div class="row" style="gap:6px;align-items:center"><select id="f-add" class="small"><option value="">Add agent…</option>${Object.entries(TOOLS).filter(([k]) => !fbs.order.includes(k)).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
      <label class="small check"><input type="checkbox" id="f-model" ${fbs.otherModel ? 'checked' : ''}> Antigravity: switch between its Gemini and Claude/GPT quota first</label>
      <label class="small check"><input type="checkbox" id="f-wait" ${fbs.waitForReset ? 'checked' : ''}> If everyone is out, wait and continue automatically when the first one resets</label>
    </fieldset>
    <fieldset><legend>Limits</legend>
      <div class="row">
        <label class="field grow">Time limit per reply (minutes)<input id="s-timeout" type="number" min="1" max="240" value="${s.timeoutMin}"></label>
        <label class="field grow">Stalled after (minutes without output)<input id="s-stall" type="number" min="1" max="60" value="${s.stallMin || 4}"></label>
      </div>
    </fieldset>
    <div class="modal-actions"><button id="s-cancel">Cancel</button><button class="primary" id="s-save">Save</button></div>`, (root, close) => {
    $('#s-cancel', root).onclick = close;
    const ord = $('#f-order', root);
    ord.addEventListener('click', e => {
      const li = e.target.closest('li'); if (!li) return;
      if (e.target.closest('[data-up]') && li.previousElementSibling) ord.insertBefore(li, li.previousElementSibling);
      if (e.target.closest('[data-rm]')) li.remove();
    });
    $('#f-add', root).onchange = e => {
      const k = e.target.value; if (!k) return;
      ord.insertAdjacentHTML('beforeend', `<li data-k="${k}"><span>${esc(TOOLS[k] || k)}</span><button class="small icon-btn" data-up title="Move up">↑</button><button class="small icon-btn" data-rm title="Remove">✕</button></li>`);
      e.target.selectedOptions[0].remove(); e.target.value = '';
    };
    $('#s-save', root).onclick = async () => {
      await save({
        permission: $('#s-perm', root).value, shell: $('#s-shell', root).value, approvalMode: $('#s-apmode', root).value,
        autoRelay: $('#s-relay', root).checked, councilMode: $('#s-mode', root).value, rounds: Number($('#s-rounds', root).value),
        councilPermission: $('#s-cperm', root).value,
        timeoutMin: Math.max(1, Number($('#s-timeout', root).value) || 20), stallMin: Math.max(1, Number($('#s-stall', root).value) || 4),
        fallback: { enabled: $('#f-on', root).checked, order: $$('#f-order li', root).map(li => li.dataset.k), otherModel: $('#f-model', root).checked, waitForReset: $('#f-wait', root).checked },
      });
      close(); toast('Settings saved');
    };
  });
}

export function leaveHub() {
  const activeInput = $('#input');
  if (activeInput && currentActiveThreadId) {
    try {
      const prevKey = `conclave:draft:${currentActiveThreadId}`;
      if (activeInput.value.trim() || activePendingAttachments?.length) {
        store.set(prevKey, JSON.stringify({ text: activeInput.value, attachments: activePendingAttachments || [] }));
      } else {
        store.del(prevKey);
      }
    } catch {}
  }
  currentActiveThreadId = null;
  cleanupThread?.(); cleanupThread = null;
  es?.close(); es = null;
  if (typeof document !== 'undefined') document.body.classList.remove('focus-mode', 'list-collapsed', 'mobile-list-open');
}
