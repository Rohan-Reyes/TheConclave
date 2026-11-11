import { api, esc, badge, ago, md, toast, copy, $, $$ } from '../lib.js';
import { memoryForm } from './memory.js';

export async function renderChat(view, params, id) {
  const { chat, messages } = await api('/api/chats/' + encodeURIComponent(id));
  const opts = { thinking: false, tools: true, system: false };
  try { Object.assign(opts, JSON.parse(localStorage.getItem('hub-chat-opts') || '{}')); } catch {}

  view.innerHTML = `
    <div class="head">
      <div style="min-width:0">
        <div class="row" style="align-items:center;margin-bottom:6px">${badge(chat.tool, chat.variant || '')}<span class="muted small">${esc(new Date(chat.started || chat.updated).toLocaleString())} → ${ago(chat.updated)}</span></div>
        <h1 style="overflow-wrap:anywhere">${esc(chat.title)}</h1>
        <div class="muted small mono" style="overflow-wrap:anywhere">${esc(chat.cwd || '')}${chat.project && chat.project !== chat.cwd ? ` · project: <a href="#/project/${encodeURIComponent(chat.project)}">${esc(chat.project)}</a>` : ''}</div>
      </div>
      <div class="row">
        <button class="primary" id="resume" title="Open a terminal and continue this session">▶ Resume in ${chat.tool === 'claude' ? 'Claude' : chat.tool === 'codex' ? 'Codex' : 'Antigravity'}</button>
        <button id="cont" title="Keep talking to this session here, and bring the other tools in">💬 Continue in Hub</button>
        <button id="handoff" title="Copy a summary you can paste into another tool">⇄ Hand off</button>
        <button id="savemem" title="Select text in the transcript first">＋ Save to memory</button>
      </div>
    </div>
    <div class="toolbar small">
      <label><input type="checkbox" id="o-tools"> tool calls</label>
      <label><input type="checkbox" id="o-thinking"> thinking</label>
      <label><input type="checkbox" id="o-system"> system messages</label>
      <span class="muted">· ${messages.length} entries · <span class="mono">${esc(chat.source_path)}</span></span>
    </div>
    <div class="transcript" id="tx"></div>`;

  function draw() {
    const out = [];
    for (const m of messages) {
      if (m.kind === 'thinking') { if (opts.thinking) out.push(`<details class="tool"><summary>💭 thinking</summary><div class="md small">${md(m.text)}</div></details>`); continue; }
      if (m.kind === 'tool_call') { if (opts.tools) out.push(`<details class="tool"><summary>⚙ ${esc(m.name || 'tool')}</summary><pre>${esc(m.text)}</pre></details>`); continue; }
      if (m.kind === 'tool_result') { if (opts.tools) out.push(`<details class="tool${m.error ? ' err' : ''}"><summary>↳ result${m.error ? ' (error)' : ''} · ${m.text.length} chars</summary><pre>${esc(m.text)}</pre></details>`); continue; }
      if (m.role === 'system' && !opts.system) continue;
      out.push(`<div class="msg ${m.role}"><div class="who"><b>${m.role}</b><span>${m.at ? esc(new Date(m.at).toLocaleTimeString()) : ''}</span></div><div class="md">${md(m.text)}</div></div>`);
    }
    $('#tx').innerHTML = out.join('') || '<div class="empty">No visible messages.</div>';
  }
  for (const k of Object.keys(opts)) {
    const el = $('#o-' + k);
    el.checked = opts[k];
    el.addEventListener('change', () => { opts[k] = el.checked; try { localStorage.setItem('hub-chat-opts', JSON.stringify(opts)); } catch {} draw(); });
  }
  draw();

  $('#resume').addEventListener('click', async () => {
    try { const r = await api(`/api/chats/${encodeURIComponent(id)}/resume`, { method: 'POST', body: {} }); toast(`Opened terminal in ${r.cwd}`); }
    catch (e) { toast(e.message, true); }
  });
  $('#cont').addEventListener('click', async () => {
    try { const t = await api(`/api/chats/${encodeURIComponent(id)}/continue`, { method: 'POST', body: {} }); location.hash = '#/hub/' + t.id; }
    catch (e) { toast(e.message, true); }
  });
  $('#handoff').addEventListener('click', async () => {
    const { markdown } = await api(`/api/chats/${encodeURIComponent(id)}/handoff`);
    copy(markdown);
  });
  $('#savemem').addEventListener('click', () => {
    const sel = String(window.getSelection() || '').trim();
    memoryForm({
      title: '', body: sel || '', type: 'project',
      scope: chat.project && !/^[A-Z]:\\Users\\[^\\]+$/.test(chat.project) ? chat.project : 'global',
      tags: chat.tool,
    }, () => toast('Saved to shared memory'));
  });
}
