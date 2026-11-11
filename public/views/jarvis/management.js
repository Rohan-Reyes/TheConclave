// Jarvis Management: one ongoing Jarvis chat beside scheduled tasks, approvals and recent runs.
import { esc, md, toast } from '../../lib.js';
import { japi, jarvisMe, fmtDate, dictation } from './api.js';

let timer, mic;
export function leaveManagement() { clearInterval(timer); timer = null; mic?.stop(); mic = null; }

const SUGGESTIONS = [
  'What is on my schedule today?',
  'Remind me every weekday at 7 AM to review my calendar',
  'Summarize my unread important email',
  'Give me a morning briefing with the weather',
];

async function jarvisConversation() {
  const chats = await japi('/conversations');
  const found = chats.find(c => c.title === 'Jarvis');
  return found ? found.id : (await japi('/conversations', { title: 'Jarvis' })).id;
}

export async function renderManagement(root) {
  leaveManagement();
  const [me, id] = await Promise.all([jarvisMe(), jarvisConversation()]);
  const tz = me.timezone;
  const first = String(me.username || '').split(/[\s._@-]/)[0];
  const name = first ? first[0].toUpperCase() + first.slice(1) : '';
  root.innerHTML = `
    <div class="gx-page jarvis-mgmt">
      <section class="gx-chat" aria-label="Jarvis chat">
        <div class="gx-scroll" id="j-msgs" aria-live="polite"></div>
        <form class="gx-composer" id="j-form">
          <textarea id="j-input" rows="1" maxlength="12000" placeholder="Ask Jarvis" aria-label="Message Jarvis"></textarea>
          <div class="gx-composer-bar">
            <div class="gx-composer-left">
              <a class="gx-chip-btn" href="#/automations" title="Open tasks & automations">＋ Task</a>
              <a class="gx-chip-btn" href="#/mind" title="Open 3D memory">Memory</a>
            </div>
            <div class="gx-composer-right">
              <button type="button" class="gx-icon" id="j-mic" title="Dictate" aria-label="Dictate" hidden>🎙</button>
              <button type="submit" class="gx-send" id="j-send" aria-label="Send">↑</button>
            </div>
          </div>
        </form>
      </section>
      <aside class="gx-side" id="j-side" aria-label="Scheduled tasks and approvals"><div class="empty">Loading…</div></aside>
    </div>`;
  const msgs = root.querySelector('#j-msgs'), form = root.querySelector('#j-form'), input = root.querySelector('#j-input'), send = root.querySelector('#j-send'), side = root.querySelector('#j-side');

  const greet = () => `<div class="gx-hello">
      <h1><span class="gx-grad">Hello${name ? ', ' + esc(name) : ''}</span></h1>
      <p>What should Jarvis take care of?</p>
      <div class="gx-suggest">${SUGGESTIONS.map(s => `<button type="button" class="gx-suggestion">${esc(s)}</button>`).join('')}</div>
    </div>`;
  const show = data => {
    msgs.innerHTML = data.length ? data.map(m => m.role === 'user'
      ? `<div class="gx-msg user"><div class="gx-bubble">${esc(m.content)}</div></div>`
      : `<div class="gx-msg ai"><div class="gx-avatar" aria-hidden="true">J</div><div class="gx-body md">${md(m.content)}<div class="gx-meta">${esc(fmtDate(m.created_at, tz))}</div></div></div>`).join('') : greet();
    msgs.querySelectorAll('.gx-suggestion').forEach(b => b.onclick = () => { input.value = b.textContent; autosize(); input.focus(); });
    msgs.scrollTop = msgs.scrollHeight;
  };
  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 220) + 'px'; };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });

  show(await japi(`/messages?conversation=${id}`));

  form.onsubmit = async e => {
    e.preventDefault();
    const content = input.value.trim(); if (!content || send.disabled) return;
    send.disabled = true; input.value = ''; autosize();
    msgs.querySelector('.gx-hello')?.remove();
    msgs.insertAdjacentHTML('beforeend', `<div class="gx-msg user"><div class="gx-bubble">${esc(content)}</div></div><div class="gx-msg ai pending"><div class="gx-avatar" aria-hidden="true">J</div><div class="gx-body"><span class="gx-typing"><i></i><i></i><i></i></span></div></div>`);
    msgs.scrollTop = msgs.scrollHeight;
    try {
      const r = await japi('/messages', { conversation_id: id, content });
      show(await japi(`/messages?conversation=${id}`));
      if (r.memory_ids?.length) toast(`Jarvis drew on ${r.memory_ids.length} memor${r.memory_ids.length === 1 ? 'y' : 'ies'}`);
      renderSide().catch(() => {});
    } catch (err) {
      msgs.querySelector('.gx-msg.pending')?.remove(); input.value = content; autosize(); toast(err.message, true);
    } finally { send.disabled = false; input.focus(); }
  };

  mic = dictation(text => { input.value = (input.value ? input.value + ' ' : '') + text; autosize(); input.focus(); },
    on => { const b = root.querySelector('#j-mic'); if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); } });
  if (mic) { const b = root.querySelector('#j-mic'); b.hidden = false; b.onclick = () => mic.toggle(); }

  async function renderSide() {
    const [schedules, jobs, inbox] = await Promise.all([japi('/schedules'), japi('/jobs'), japi('/inbox').catch(() => ({ approvals: [] }))]);
    if (!side.isConnected) return;
    const pending = (inbox.approvals || []).filter(a => a.state === 'pending');
    const active = schedules.filter(s => s.status !== 'cancelled');
    side.innerHTML = `
      ${pending.length ? `<section class="gx-card"><h2>Awaiting approval <span class="gx-count">${pending.length}</span></h2>
        ${pending.slice(0, 5).map(p => `<div class="gx-row"><div><b>${esc(p.subject)}</b><div class="muted small">${esc(p.kind.replaceAll('_', ' '))}</div></div></div>`).join('')}
        <a class="gx-link" href="#/assistant-inbox">Review in inbox →</a></section>` : ''}
      <section class="gx-card"><div class="gx-card-head"><h2>Scheduled tasks <span class="gx-count">${active.length}</span></h2><a class="gx-chip-btn" href="#/automations">＋ New</a></div>
        ${active.length ? active.map(s => `<div class="gx-row" data-id="${esc(s.id)}">
          <div class="gx-row-main"><b>${esc(s.title)}</b><div class="muted small">${esc(s.original_text)} · next ${esc(fmtDate(s.next_run, tz))}</div></div>
          <span class="gx-state ${esc(s.status)}">${esc(s.status)}</span>
          <div class="gx-row-actions">
            <button type="button" class="small ghost" data-act="toggle">${s.status === 'paused' ? 'Resume' : 'Pause'}</button>
            <button type="button" class="small ghost danger" data-act="cancel">Cancel</button>
          </div></div>`).join('') : '<p class="muted small">No scheduled tasks yet. Ask Jarvis to remind you of something.</p>'}
      </section>
      <section class="gx-card"><h2>Recent runs</h2>
        ${jobs.length ? jobs.slice(0, 8).map(j => `<div class="gx-row"><div class="gx-row-main"><b>${esc(j.kind.replaceAll('_', ' '))}</b><div class="muted small">${esc(fmtDate(j.occurrence_at, tz))}${j.error ? ' · ' + esc(j.error) : ''}</div></div><span class="gx-state ${esc(j.state)}">${esc(j.state)}</span></div>`).join('') : '<p class="muted small">No runs yet.</p>'}
      </section>`;
    side.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
      const row = b.closest('[data-id]'), s = active.find(x => x.id === row.dataset.id); if (!s) return;
      if (b.dataset.act === 'cancel' && !confirm(`Cancel “${s.title}”?`)) return;
      b.disabled = true;
      try {
        const status = b.dataset.act === 'cancel' ? 'cancelled' : s.status === 'paused' ? 'active' : 'paused';
        await japi(`/schedules/${encodeURIComponent(s.id)}`, { status }, 'PATCH');
        await renderSide();
      } catch (err) { toast(err.message, true); b.disabled = false; }
    });
  }
  await renderSide().catch(err => { side.innerHTML = `<div class="empty">${esc(err.message)}</div>`; });
  timer = setInterval(() => { if (!document.hidden && side.isConnected) renderSide().catch(() => {}); }, 30000);
  input.focus();
}
