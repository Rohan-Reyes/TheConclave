import { renderHome } from './views/home.js';
import { renderChats } from './views/chats.js';
import { renderChat } from './views/chat.js';
import { renderMemory } from './views/memory.js';
import { renderProjects, renderProject } from './views/projects.js';
import { renderConfig } from './views/config.js';
import { renderHub, leaveHub } from './views/hub.js';
import { api, toast, modal, $ } from './lib.js';
import { openPalette } from './views/palette.js';
import { renderUsage } from './views/usage.js';
import { renderRunner } from './views/runner.js';
import { renderFiles } from './views/files.js';

const routes = [
  [/^\/?$/, 'home', renderHome],
  [/^\/chats$/, 'chats', renderChats],
  [/^\/chat\/(.+)$/, 'chats', renderChat],
  [/^\/memory$/, 'memory', renderMemory],
  [/^\/projects$/, 'projects', renderProjects],
  [/^\/project\/(.+)$/, 'projects', renderProject],
  [/^\/runner$/, 'projects', renderRunner],
  [/^\/files$/, 'files', renderFiles],
  [/^\/config$/, 'config', renderConfig],
  [/^\/usage$/, 'usage', renderUsage],
  [/^\/hub$/, 'hub', renderHub],
  [/^\/hub\/(.+)$/, 'hub', renderHub],
];

async function route() {
  if (typeof window === 'undefined') return;
  const hash = location.hash.slice(1) || '/';
  const [p, qs] = hash.split('?');
  const params = new URLSearchParams(qs || '');
  const view = $('#view');
  if (!view) return;
  leaveHub();
  document.body.classList.toggle('is-hub', p.startsWith('/hub'));
  for (const [re, nav, fn] of routes) {
    const m = p.match(re);
    if (!m) continue;
    document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === nav));
    view.innerHTML = '<div class="empty">Loading…</div>';
    try { await fn(view, params, ...m.slice(1).map(decodeURIComponent)); }
    catch (e) { view.innerHTML = `<div class="empty">Error: ${e.message}</div>`; }
    window.scrollTo(0, 0);
    return;
  }
  view.innerHTML = '<div class="empty">Not found</div>';
}

async function refreshIndexState() {
  try {
    const s = await api('/api/stats');
    const n = s.chats.reduce((a, c) => a + c.n, 0);
    const el = $('#index-state');
    if (el) el.textContent = `${n} chats · ${s.memories} memories`;
  } catch {}
}

export function openShortcuts() {
  modal(`
    <div class="row" style="justify-content:space-between;align-items:center">
      <h2 style="margin:0">Keyboard shortcuts</h2>
      <button class="icon-btn" id="sc-close">✕</button>
    </div>
    <table class="shortcuts-table">
      <tr><td><kbd>Ctrl</kbd> + <kbd>Enter</kbd></td><td>Send message immediately (or <b>Send now</b> while agents work)</td></tr>
      <tr><td><kbd>Enter</kbd></td><td>Send message (or queue when agents work)</td></tr>
      <tr><td><kbd>Shift</kbd> + <kbd>Enter</kbd></td><td>New line in composer</td></tr>
      <tr><td><kbd>Ctrl</kbd> + <kbd>K</kbd></td><td>Quick search palette (chats, projects, memories)</td></tr>
      <tr><td><kbd>Ctrl</kbd> + <kbd>B</kbd></td><td>Toggle chat sidebar list</td></tr>
      <tr><td><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>F</kbd></td><td>Toggle focus mode (distraction-free full screen)</td></tr>
      <tr><td><kbd>/</kbd> (at start of line)</td><td>Slash command templates menu (/plan, /review, /debug, ...)</td></tr>
      <tr><td><kbd>Esc</kbd></td><td>Close modals, dismiss popovers, exit focus mode</td></tr>
      <tr><td><kbd>?</kbd></td><td>Show this keyboard shortcuts cheat sheet</td></tr>
    </table>
    <div class="modal-actions"><button class="primary" id="sc-ok">Got it</button></div>`, (root, close) => {
    $('#sc-close', root).onclick = close;
    $('#sc-ok', root).onclick = close;
  });
}

if (typeof window !== 'undefined') {
  api('/api/auth/status').then(state => {
    if (!state.enabled || !state.authenticated) return;
    const button = document.createElement('button');
    button.className = 'ghost small'; button.textContent = 'Sign out';
    button.onclick = async () => {
      try { await api('/api/auth/logout', { method: 'POST', body: {} }); location.replace('/login'); }
      catch (e) { toast(e.message, true); }
    };
    document.querySelector('.nav-foot .row')?.append(button);
  }).catch(() => {});
  $('#reindex')?.addEventListener('click', async () => {
    const b = $('#reindex'); b.disabled = true; b.textContent = '↻ Scanning…';
    try {
      const r = await api('/api/reindex', { method: 'POST', body: {} });
      toast(`Scan done: ${r.changed} changed in ${(r.lastDurationMs / 1000).toFixed(1)}s`);
      refreshIndexState(); route();
    } catch (e) { toast(e.message, true); }
    b.disabled = false; b.textContent = '↻ Re-scan';
  });

  // Theme toggle: system → dark → light → system
  const themes = ['', 'dark', 'light'];
  function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
  let theme = '';
  try { theme = localStorage.getItem('hub-theme') || ''; } catch {}
  const themeLabel = () => {
    const el = $('#theme-label');
    if (el) el.textContent = theme ? theme[0].toUpperCase() + theme.slice(1) : 'System';
  };
  applyTheme(theme); themeLabel();
  $('#theme')?.addEventListener('click', () => {
    theme = themes[(themes.indexOf(theme) + 1) % themes.length];
    applyTheme(theme); themeLabel();
    try { localStorage.setItem('hub-theme', theme); } catch {}
  });

  $('#shortcuts-btn')?.addEventListener('click', openShortcuts);
  $('#open-search')?.addEventListener('click', openPalette);

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (!document.querySelector('dialog.palette')) openPalette();
    } else if (e.key === '?' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      openShortcuts();
    }
  });

  window.addEventListener('hashchange', route);
  route();
  refreshIndexState();
  setInterval(refreshIndexState, 60_000);
}
