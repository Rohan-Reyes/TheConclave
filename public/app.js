import { renderAssistant, leaveAssistant } from './views/assistant.js';
import { renderHome } from './views/home.js';
import { renderChats } from './views/chats.js';
import { renderChat } from './views/chat.js';
import { renderMemory } from './views/memory.js';
import { renderProjects, renderProject } from './views/projects.js';
import { renderConfig } from './views/config.js';
import { renderHub, leaveHub } from './views/hub.js';
import { api, toast, modal, $, $$ } from './lib.js';
import { openPalette } from './views/palette.js';
import { renderUsage } from './views/usage.js';
import { renderRunner } from './views/runner.js';
import { renderFiles } from './views/files.js';
import { renderTerminal } from './views/terminal.js';
import { renderSettings, SHORTCUTS } from './views/settings.js';

const routes = [
  [/^\/(management|mind|connectors|automations|telegram|assistant-notes|assistant-inbox|assistant-settings)$/, 'assistant', renderAssistant],
  [/^\/?$/, 'home', renderHome],
  [/^\/chats$/, 'chats', renderChats],
  [/^\/chat\/(.+)$/, 'chats', renderChat],
  [/^\/memory$/, 'memory', renderMemory],
  [/^\/projects$/, 'projects', renderProjects],
  [/^\/project\/(.+)$/, 'projects', renderProject],
  [/^\/runner$/, 'projects', renderRunner],
  [/^\/files$/, 'files', renderFiles],
  [/^\/terminal$/, 'terminal', renderTerminal],
  [/^\/config$/, 'config', renderConfig],
  [/^\/usage$/, 'usage', renderUsage],
  [/^\/settings$/, 'settings', renderSettings],
  [/^\/hub$/, 'hub', renderHub],
  [/^\/hub\/(.+)$/, 'hub', renderHub],
];

const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

function setActiveNav(nav) {
  $$('[data-nav]').forEach(a => {
    const on = a.dataset.nav === nav;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const title = $(`.nav-groups [data-nav="${nav}"]`)?.dataset.title || 'Conclave';
  const el = $('#page-title'); if (el) el.textContent = title;
  document.title = title === 'Conclave' ? 'Conclave' : `${title} · Conclave`;
}

async function route() {
  if (typeof window === 'undefined') return;
  const hash = location.hash.slice(1) || '/';
  const [p, qs] = hash.split('?');
  const params = new URLSearchParams(qs || '');
  const view = $('#view');
  if (!view) return;
  leaveHub();
  leaveAssistant();
  closeDrawer();
  closeAccountMenu();
  document.body.classList.toggle('is-hub', p.startsWith('/hub'));
  for (const [re, nav, fn] of routes) {
    const m = p.match(re);
    if (!m) continue;
    setActiveNav(nav === 'assistant' ? m[1] : nav);
    view.innerHTML = '<div class="empty">Loading…</div>';
    try { await fn(view, params, ...m.slice(1).map(decodeURIComponent)); }
    catch (e) { view.innerHTML = `<div class="empty">Error: ${e.message}</div>`; }
    window.scrollTo(0, 0);
    return;
  }
  setActiveNav('');
  view.innerHTML = '<div class="empty">Page not found. <a href="#/">Go to Overview</a></div>';
}

async function refreshIndexState() {
  try {
    const s = await api('/api/stats');
    const n = s.chats.reduce((a, c) => a + c.n, 0);
    const el = $('#index-state');
    if (el) el.textContent = `${n} chats indexed · ${s.memories} memories`;
  } catch {}
}

export function openShortcuts() {
  modal(`
    <div class="row" style="justify-content:space-between;align-items:center">
      <h2 style="margin:0">Keyboard shortcuts</h2>
      <button class="icon-btn ghost" id="sc-close" aria-label="Close">✕</button>
    </div>
    <div class="shortcut-list">${SHORTCUTS.map(([k, d]) => `<span>${k}</span><span>${d}</span>`).join('')}</div>
    <div class="modal-actions"><button class="primary" id="sc-ok">Got it</button></div>`, (root, close) => {
    $('#sc-close', root).onclick = close;
    $('#sc-ok', root).onclick = close;
  });
}

// ---------- shell: drawer (phones), collapsible sidebar (desktop), account menu
function openDrawer() {
  document.body.classList.add('drawer-open');
  $('#scrim').hidden = false;
  $('#open-drawer')?.setAttribute('aria-expanded', 'true');
  ($('.nav-groups a.active') || $('.nav-groups a'))?.focus({ preventScroll: true });
}
function closeDrawer() {
  if (!document.body.classList.contains('drawer-open')) return;
  document.body.classList.remove('drawer-open');
  $('#scrim').hidden = true;
  $('#open-drawer')?.setAttribute('aria-expanded', 'false');
}
function closeAccountMenu() {
  const m = $('#account-menu'); if (!m || m.hidden) return;
  m.hidden = true; $('#account-btn').setAttribute('aria-expanded', 'false');
}

// Theme: system → dark → light
const themes = ['', 'dark', 'light'];
export function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  store.set('hub-theme', t || '');
  const el = $('#theme-label'); if (el) el.textContent = t ? t[0].toUpperCase() + t.slice(1) : 'System';
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--panel').trim() || '#14161a';
}

export async function signOut() {
  try { await api('/api/auth/logout', { method: 'POST', body: {} }); location.replace('/login'); }
  catch (e) { toast(e.message, true); }
}

if (typeof window !== 'undefined') {
  applyTheme(store.get('hub-theme') || '');
  if (store.get('cv-sidebar') === 'collapsed') document.body.classList.add('sidebar-collapsed');

  $('#open-drawer')?.addEventListener('click', openDrawer);
  $('#tab-more')?.addEventListener('click', openDrawer);
  $('#scrim')?.addEventListener('click', closeDrawer);
  $('#sidebar')?.addEventListener('click', e => { if (e.target.closest('a[href]')) closeDrawer(); });
  $('#collapse-sidebar')?.addEventListener('click', () => {
    const on = document.body.classList.toggle('sidebar-collapsed');
    store.set('cv-sidebar', on ? 'collapsed' : 'open');
  });

  $('#account-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    const m = $('#account-menu'); m.hidden = !m.hidden;
    $('#account-btn').setAttribute('aria-expanded', String(!m.hidden));
    if (!m.hidden) m.querySelector('a, button')?.focus();
  });
  document.addEventListener('click', e => { if (!e.target.closest('#account-menu, #account-btn')) closeAccountMenu(); });
  $('#account-menu')?.addEventListener('click', e => { if (e.target.closest('a')) closeAccountMenu(); });

  $('#theme')?.addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || '';
    applyTheme(themes[(themes.indexOf(cur) + 1) % themes.length]);
  });
  $('#reindex')?.addEventListener('click', async () => {
    const b = $('#reindex'); b.disabled = true; b.textContent = 'Scanning…';
    try {
      const r = await api('/api/reindex', { method: 'POST', body: {} });
      toast(`Scan done: ${r.changed} changed in ${(r.lastDurationMs / 1000).toFixed(1)}s`);
      refreshIndexState(); route();
    } catch (e) { toast(e.message, true); }
    b.disabled = false; b.textContent = 'Re-scan chat history';
  });
  $('#shortcuts-btn')?.addEventListener('click', () => { closeAccountMenu(); openShortcuts(); });
  $('#sign-out')?.addEventListener('click', signOut);
  $('#open-search')?.addEventListener('click', openPalette);
  $('#open-search-mobile')?.addEventListener('click', openPalette);

  // Who is signed in (when sign-in is enabled for this server).
  api('/api/auth/status').then(state => {
    if (!state.enabled) return;
    return api('/api/auth/account').then(acc => {
      $('#account-name').textContent = acc.username;
      $('#account-sub').textContent = location.host;
      $('#account-avatar').textContent = (acc.username || '?')[0].toUpperCase();
      $('#sign-out').hidden = false;
      $('#menu-security').hidden = false;
    });
  }).catch(() => {});

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (!document.querySelector('dialog.palette')) openPalette();
    } else if (e.key === 'Escape') {
      closeDrawer(); closeAccountMenu();
    } else if (e.key === '?' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && !document.activeElement?.isContentEditable && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      openShortcuts();
    }
  });

  window.addEventListener('hashchange', route);
  route();
  refreshIndexState();
  api('/api/version').then(v=>{ const badge=$('.version-badge'); if(badge && /^\d+\.\d+\.\d+$/.test(v.version)) badge.textContent='v'+v.version; }).catch(()=>{});
  setInterval(refreshIndexState, 60_000);
}
