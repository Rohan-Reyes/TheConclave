let activeDictation;
function speakReply(content, manual = false) {
  if (!('speechSynthesis' in window)) return;
  if (!manual && localStorage.getItem('jarvis-read-replies') !== 'yes') return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(content);
  utterance.lang = localStorage.getItem('jarvis-speech-language') || 'en-PH';
  utterance.onerror = e => { if (!['canceled', 'interrupted'].includes(e.error)) toast('Speech playback failed. Try Read aloud.'); };
  speechSynthesis.speak(utterance);
}
function voiceControls(parent, input) {
  const row = el('div', undefined, 'voice-controls');
  const language = document.createElement('select'); language.setAttribute('aria-label', 'Speech language');
  for (const [value, label] of [['en-PH', 'English (Philippines)'], ['fil-PH', 'Filipino'], ['en-US', 'English (US)']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; language.append(option);
  }
  language.value = localStorage.getItem('jarvis-speech-language') || 'en-PH';
  language.onchange = () => { activeDictation?.abort(); localStorage.setItem('jarvis-speech-language', language.value); };
  row.append(language);
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const status = el('span', '', 'muted'); status.setAttribute('role', 'status');
  const mic = button('Dictate', () => {
    if (activeDictation) { activeDictation.stop(); return; }
    window.speechSynthesis?.cancel();
    const recognition = new Recognition(); activeDictation = recognition;
    recognition.lang = language.value; recognition.interimResults = false; recognition.continuous = false;
    recognition.onstart = () => { mic.textContent = 'Stop microphone'; mic.setAttribute('aria-pressed', 'true'); status.textContent = 'Listening…'; };
    recognition.onresult = event => {
      const text = Array.from(event.results).filter(result => result.isFinal).map(result => result[0].transcript).join(' ');
      input.value = (input.value + (input.value ? ' ' : '') + text).slice(0, input.maxLength > 0 ? input.maxLength : 12000);
      input.dispatchEvent(new Event('input', { bubbles: true })); status.textContent = 'Dictation added. Review before sending.';
    };
    recognition.onerror = event => { status.textContent = `Microphone: ${event.error}. Check permission or type your message.`; };
    recognition.onend = () => { if (activeDictation === recognition) activeDictation = null; mic.textContent = 'Dictate'; mic.setAttribute('aria-pressed', 'false'); if (status.textContent === 'Listening…') status.textContent = 'Microphone stopped.'; };
    try { recognition.start(); } catch (error) { activeDictation = null; status.textContent = error.message; }
  });
  mic.disabled = !Recognition || !window.isSecureContext;
  mic.setAttribute('aria-pressed', 'false');
  row.append(mic);
  const label = el('label'); const auto = document.createElement('input'); auto.type = 'checkbox'; auto.checked = localStorage.getItem('jarvis-read-replies') === 'yes';
  auto.disabled = !('speechSynthesis' in window);
  auto.onchange = () => { localStorage.setItem('jarvis-read-replies', auto.checked ? 'yes' : 'no'); if (!auto.checked) window.speechSynthesis?.cancel(); };
  label.append(auto, ' Speak replies'); row.append(label, button('Stop audio', () => window.speechSynthesis?.cancel()), status);
  parent.append(row, el('p', Recognition ? 'Dictation uses your browser’s speech service and may send audio to its provider. Nothing sends until you press Send.' : 'Dictation is unavailable in this browser. Try Chrome or Edge; you can still type.', 'muted'));
}
const $ = s => document.querySelector(s);
document.querySelectorAll('nav a span').forEach(icon=>icon.setAttribute('aria-hidden','true'));
const root = $('#content');
const titles = { management: 'Management', dashboard: 'Dashboard', chat: 'Chat', notes: 'Notes & coding tasks', today: 'Today', tasks: 'Tasks & Automations', inbox: 'Inbox', connections: 'Connections', telegram: 'Telegram', devices: 'Devices', settings: 'Settings' };
let me, conversation, dashboardCleanup, editingSchedule, preview, renderVersion = 0;
const date = n => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: me?.timezone || 'Asia/Manila' }).format(new Date(n));
function toast(text) { $('#toast').textContent = text; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').hidden = true, 6500); }
async function api(path, data, method = data === undefined ? 'GET' : 'POST') {
  const response = await fetch(`/assistant/api${path}`, { method, credentials: 'same-origin', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (response.status === 401 && path !== '/login') { $('#shell').hidden = true; $('#login').hidden = false; }
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
function el(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
function button(text, action, style = '') { const b = el('button', text, style); b.type = 'button'; b.onclick = async () => { b.disabled = true; try { await action(); } catch (e) { toast(e.message); } finally { b.disabled = false; } }; return b; }
function card(title, description, target = root) { const c = el('section', undefined, 'card'); if (title) c.append(el('h2', title)); if (description) c.append(el('p', description)); target.append(c); return c; }
function field(form, label, name, type = 'text', value = '', required = true) {
  const l = el('label', label), input = document.createElement(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input');
  if (!['textarea', 'select'].includes(type)) input.type = type;
  input.name = name; input.value = value; input.required = required;
  if (type === 'password') input.autocomplete = 'off';
  l.append(input); form.append(l); return input;
}
function select(form, label, name, options, value) { const s = field(form, label, name, 'select'); for (const [v,t] of options) { const o = el('option', t); o.value = v; s.append(o); } if (value) s.value = value; return s; }
function form(target, submitText, action) {
  const f = document.createElement('form'), b = el('button', submitText, 'primary'); b.type = 'submit';
  f.onsubmit = async e => { e.preventDefault(); b.disabled = true; try { await action(Object.fromEntries(new FormData(f)), f); } catch (error) { toast(error.message); } finally { b.disabled = false; } };
  f.addButton = () => { const a = el('div', undefined, 'actions'); a.append(b); f.append(a); }; target.append(f); return f;
}
function item(target, title, description) { const d = el('div', undefined, 'list-item'); d.append(el('h3', title)); if (description) d.append(el('p', description)); target.append(d); return d; }
function tag(text) { return el('span', text.replaceAll('_', ' '), `tag ${text}`); }
function actions(target, buttons) { const d = el('div', undefined, 'actions'); d.append(...buttons); target.append(d); }
function empty(target, text) { target.append(el('p', text, 'empty')); }

// Management: one dedicated Jarvis chat beside scheduled tasks, approvals and execution history.
async function jarvisConversation() {
  const chats = await api('/conversations');
  const found = chats.find(c => c.title === 'Jarvis');
  return found ? found.id : (await api('/conversations', { title: 'Jarvis' })).id;
}
async function management() {
  const layout = el('div', undefined, 'management-layout'), chatCol = el('section', undefined, 'card management-chat'), side = el('div', undefined, 'management-side');
  root.append(layout); layout.append(chatCol, side);
  const id = await jarvisConversation();
  chatCol.append(el('h2', 'Jarvis'), el('p', 'One ongoing conversation for running your life: ask Jarvis to schedule, remind, brief or follow up.', 'muted'));
  const messages = el('div', undefined, 'chat-body'); chatCol.append(messages);
  const show = data => {
    messages.replaceChildren();
    if (!data.length) messages.append(el('p', 'Say hello to Jarvis. Try “remind me every weekday at 7 AM to review my calendar”.', 'empty'));
    for (const m of data) { const d = el('article', undefined, `message ${m.role}`); d.append(el('small', `${m.role === 'user' ? 'You' : 'Jarvis'} · ${date(m.created_at)}`), el('div', m.content)); if (m.role === 'assistant') d.append(button('Read aloud', () => speakReply(m.content, true))); messages.append(d); }
    messages.scrollTop = messages.scrollHeight;
  };
  show(await api(`/messages?conversation=${id}`));
  const composer = form(chatCol, 'Send ↑', async (b, f) => {
    const pending = el('article', b.content, 'message user'); messages.append(pending); messages.scrollTop = messages.scrollHeight;
    const r = await api('/messages', { conversation_id: id, content: b.content }); f.reset(); announceMemories(r.memory_ids);
    const data = await api(`/messages?conversation=${id}`); show(data); const reply = data.at(-1); if (reply?.role === 'assistant') speakReply(reply.content);
    await renderSide();
  }); composer.className = 'composer';
  const text = field(composer, 'Message Jarvis', 'content', 'textarea'); text.placeholder = 'Ask Jarvis…'; text.maxLength = 12000;
  text.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); composer.requestSubmit(); } };
  composer.addButton(); voiceControls(composer, text);
  async function renderSide() {
    const [schedules, jobs, inbox] = await Promise.all([api('/schedules'), api('/jobs'), api('/inbox').catch(() => ({ approvals: [] }))]);
    side.replaceChildren();
    const pending = (inbox.approvals || []).filter(a => a.state === 'pending');
    if (pending.length) { const a = card(`Awaiting approval (${pending.length})`, null, side); for (const p of pending.slice(0, 5)) item(a, p.subject, p.kind.replaceAll('_', ' ')); actions(a, [button('Open inbox', () => { location.hash = 'inbox'; })]); }
    const active = schedules.filter(s => s.status !== 'cancelled');
    const list = card(`Scheduled tasks (${active.length})`, null, side);
    for (const s of active) {
      const d = item(list, s.title, `${s.original_text} · Next ${date(s.next_run)}`); d.append(tag(s.status));
      actions(d, [
        button(s.status === 'paused' ? 'Resume' : 'Pause', async () => { await api(`/schedules/${s.id}`, { status: s.status === 'paused' ? 'active' : 'paused' }, 'PATCH'); await renderSide(); }),
        button('Edit', async () => { editingSchedule = s; location.hash = 'tasks'; }),
        button('Cancel', async () => { await api(`/schedules/${s.id}`, { status: 'cancelled' }, 'PATCH'); await renderSide(); }, 'danger'),
      ]);
    }
    if (!active.length) empty(list, 'No scheduled tasks yet. Ask Jarvis or add one.');
    actions(list, [button('+ New scheduled task', () => { editingSchedule = null; location.hash = 'tasks'; }, 'primary')]);
    const history = card('Recent runs', null, side);
    for (const j of jobs.slice(0, 8)) { const d = item(history, `${j.kind.replaceAll('_', ' ')} · ${date(j.occurrence_at)}`, j.error || null); d.append(tag(j.state)); }
    if (!jobs.length) empty(history, 'No runs yet.');
  }
  await renderSide();
  const timer = setInterval(() => { if (!document.hidden) renderSide().catch(() => {}); }, 30000);
  return () => clearInterval(timer);
}

async function chat() {
  const layout = el('div', undefined, 'chat-layout'), list = el('div', undefined, 'conversation-list'), main = el('section'); root.append(layout); layout.append(list, main);
  const chats = await api('/conversations');
  list.append(button('+ New conversation', async () => { const c = await api('/conversations', { title: `Conversation · ${new Date().toLocaleDateString()}` }); conversation = c.id; await render(); }, 'primary'));
  if (!conversation && chats[0]) conversation = chats[0].id;
  for (const c of chats) list.append(button(c.title, async () => { conversation = c.id; await render(); }, c.id === conversation ? 'selected' : ''));
  const search = el('div', undefined, 'search-row'), searchInput = document.createElement('input'); searchInput.placeholder = 'Search all conversations'; searchInput.setAttribute('aria-label', 'Search conversations'); search.append(searchInput, button('Search', async () => { const messages = await api(`/messages?q=${encodeURIComponent(searchInput.value)}`); display(messages); })); main.append(search);
  const messages = el('div', undefined, 'chat-body'); main.append(messages);
  function display(data) {
    messages.replaceChildren();
    if (!data.length) {
      const welcome = el('div', undefined, 'empty'); welcome.append(el('div', 'J', 'brand-orb'), el('div', 'HERE TO HELP YOU MAKE ROOM', 'eyebrow'), el('h2', 'What’s on your mind?'), el('p', 'A quiet place to think, plan and keep track. Connect a model on Connections, then start a conversation.')); messages.append(welcome);
    }
    for (const m of data) { const d = el('article', undefined, `message ${m.role}`); d.append(el('small', `${m.role === 'user' ? 'You' : 'Conclave'} · ${m.provenance} · ${date(m.created_at)}`), el('div', m.content)); if (m.role === 'assistant') d.append(button('Read aloud', () => speakReply(m.content, true))); messages.append(d); }
    messages.scrollTop = messages.scrollHeight;
  }
  display(conversation ? await api(`/messages?conversation=${conversation}`) : []);
  const composer = form(main, 'Send message ↑', async (b, f) => {
    if (!conversation) { const c = await api('/conversations', { title: b.content.slice(0, 60) }); conversation = c.id; }
    try { const r = await api('/messages', { conversation_id: conversation, content: b.content }); announceMemories(r.memory_ids); const reply = (await api(`/messages?conversation=${conversation}`)).at(-1); if (reply?.role === 'assistant') speakReply(reply.content); if (r.memory_ids?.length) toast(`Conclave drew on ${r.memory_ids.length} memor${r.memory_ids.length === 1 ? 'y' : 'ies'}. They are lit on the Dashboard.`); f.reset(); } finally { await render(); }
  }); composer.className = 'composer';
  const text = field(composer, 'Message Conclave', 'content', 'textarea'); text.placeholder = 'Think it through with Conclave…'; text.maxLength = 12000;
  composer.addButton(); voiceControls(composer, text); composer.append(el('p', 'Your conversations persist across sessions. External actions use the approval inbox.', 'muted'));
}
async function today() {
  root.append(el('p', 'A little clarity for the day ahead. Live information from your connected accounts.'));
  const data = await api('/today'), grid = el('div', undefined, 'grid'); root.append(grid);
  const w = card('Outside your window', null, grid), weather = data.weather.data;
  if (data.weather.error) w.append(el('p', data.weather.error, 'error-text'));
  else if (weather?.status === 'connected') {
    w.append(el('p', weather.location), el('div', `${weather.current.temperature_2m}°`, 'temperature'), el('p', `Precipitation: ${weather.current.precipitation} mm · Humidity: ${weather.current.relative_humidity_2m}%`), el('p', `Observation/model time: ${weather.current.time} UTC · Retrieved ${date(weather.fetched_at)}`, 'muted'));
    for (let i=0;i<weather.daily.time.length;i++) item(w, weather.daily.time[i], `${weather.daily.temperature_2m_min[i]}–${weather.daily.temperature_2m_max[i]}° · Rain probability ${weather.daily.precipitation_probability_max[i]}%`);
    const a = el('a', weather.attribution); a.href = 'https://open-meteo.com/'; a.target = '_blank'; a.rel = 'noreferrer'; w.append(a);
  } else empty(w, 'Set your home coordinates in Connections to get a live forecast.');
  const r = card('Coming up', 'Your next active reminders.', grid);
  for (const s of data.reminders) item(r, s.title, `${date(s.next_run)} · ${s.timezone}`);
  if (!data.reminders.length) empty(r, 'No active reminders. Make some room for what matters.');
  for (const source of data.connections) {
    const c = card(`${source.provider} · Calendar`, null, grid), e = card(`${source.provider} · Email`, null, grid);
    if (source.calendar.error) empty(c, source.calendar.error);
    for (const event of source.calendar.data || []) item(c, event.title || 'Untitled event', `${event.start} → ${event.end}`);
    if (!source.calendar.data?.length && !source.calendar.error) empty(c, 'No events in the next seven days.');
    if (source.email.error) empty(e, source.email.error);
    for (const m of source.email.data || []) item(e, m.subject || '(No subject)', `${m.sender} · ${m.preview}`);
    if (!source.email.data?.length && !source.email.error) empty(e, 'No messages found.');
  }
  if (!data.connections.length) card('Connect your day', 'Connect Google or Microsoft on the Connections page to see your calendar and email here.', grid);
  const events = card('Create a calendar commitment', 'Prepare the exact event for review in Inbox. Times entered here use your device’s local timezone.');
  const f = form(events, 'Prepare for approval', async b => { await api('/calendar/prepare', { ...b, start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString(), timezone: me.timezone }); toast('Event prepared. Review it in Inbox.'); location.hash = 'inbox'; });
  select(f, 'Calendar provider', 'provider', [['google', 'Google Calendar'], ['microsoft', 'Outlook Calendar']]); field(f, 'Title', 'title'); field(f, 'Starts (device local time)', 'start', 'datetime-local'); field(f, 'Ends (device local time)', 'end', 'datetime-local'); f.addButton();
}
async function tasks() {
  const c = card(editingSchedule ? 'Edit reminder' : 'Make time for what matters', 'Preview the interpreted schedule before saving. Default timezone: Asia/Manila.');
  const f = form(c, 'Preview schedule →', async b => {
    preview = await api('/schedules/preview', {...b,authorize_automatic:b.authorize_automatic==='on'}); box.replaceChildren(el('h3', preview.title), el('p', `${preview.interpreted} · ${preview.timezone}`), el('p', `UTC: ${preview.utc} · Missed runs: ${preview.missed_policy}`, 'muted'));
    if (preview.rule.kind==='email_send') { const a=preview.rule.action; box.append(el('p',`Authorize this exact email at every occurrence. To: ${a.recipients} · Subject: ${a.subject}`),el('pre',a.body),el('p','Attachments: none. Each occurrence expires after 15 minutes.','muted')); }
    box.hidden = false;
    box.append(button(editingSchedule ? 'Confirm update' : 'Confirm & save', async () => { await api('/schedules', { preview_token: preview.preview_token, id: editingSchedule?.id }); editingSchedule = null; preview = null; toast('Schedule saved'); await render(); }, 'primary'));
  });
  field(f, 'Reminder', 'title', 'text', editingSchedule?.title || '');
  const kind=select(f, 'Action', 'kind', [['reminder','Reminder'],['briefing','Calendar, email & weather briefing'],['rain_alert','Six-hour rain forecast report'],['email_send','Send this exact email automatically']], editingSchedule ? JSON.parse(editingSchedule.rule).kind : 'reminder');
  const text = field(f, 'When', 'text', 'text', editingSchedule?.original_text || ''); text.placeholder = 'Every weekday at 7 AM';
  field(f, 'Timezone (IANA)', 'timezone', 'text', editingSchedule?.timezone || me.timezone);
  select(f, 'If a run was missed', 'missed_policy', [['catch_up', 'Deliver one latest missed reminder'], ['skip', 'Skip reminders missed by more than a minute']], editingSchedule?.missed_policy);
  const emailFields=el('div'); f.append(emailFields);
  select(emailFields,'Email provider','provider',[['google','Gmail'],['microsoft','Outlook']]);
  field(emailFields,'Exact recipients','recipients'); field(emailFields,'Exact subject','subject'); field(emailFields,'Exact final message','body','textarea');
  const authorization=el('label',undefined,'check-label'),checkbox=document.createElement('input'); checkbox.type='checkbox'; checkbox.name='authorize_automatic'; authorization.append(checkbox,document.createTextNode('I authorize this exact email to be sent automatically at each confirmed occurrence.')); emailFields.append(authorization);
  const showEmailFields=()=>{ const email=kind.value==='email_send'; emailFields.hidden=!email; emailFields.querySelectorAll('input,textarea,select').forEach(input=>{input.disabled=!email;input.required=email;}); }; kind.onchange=showEmailFields; showEmailFields();
  f.append(el('p', 'Also accepts: tomorrow at 9 AM · every day at 7 AM · 2026-12-15T09:00', 'muted')); f.addButton();
  const box = el('div', undefined, 'preview'); box.hidden = true; c.append(box);
  const [schedules, jobs] = await Promise.all([api('/schedules'), api('/jobs')]);
  const list = card('Your reminders', null);
  for (const s of schedules) {
    const d = item(list, s.title, `${s.original_text} · ${s.timezone} · Next ${date(s.next_run)}`); d.append(tag(s.status));
    actions(d, [button('Edit', async () => { editingSchedule = s; await render(); }), button(s.status === 'paused' ? 'Resume' : 'Pause', async () => { await api(`/schedules/${s.id}`, { status: s.status === 'paused' ? 'active' : 'paused' }, 'PATCH'); await render(); }), button('Cancel', async () => { await api(`/schedules/${s.id}`, { status: 'cancelled' }, 'PATCH'); await render(); }, 'danger')]);
  }
  if (!schedules.length) empty(list, 'Your reminders will appear here.');
  const history = card('Execution history', 'Durable records shared across your devices.');
  for (const j of jobs) { const d = item(history, `${j.kind.replaceAll('_',' ')} · ${date(j.occurrence_at)}`, j.error || `Attempts: ${j.attempts}`); d.append(tag(j.state)); }
  if (!jobs.length) empty(history, 'No executions yet. The separate worker processes saved schedules.');
}
async function inbox() {
  const data = await api('/inbox');
  for (const proposal of data.proposals) {
    const p = JSON.parse(proposal.payload), c = card(p.title, `${p.interpreted} · ${p.timezone}`);
    c.append(el('p', `UTC: ${p.utc} · ${p.original_text} · Missed runs: deliver one latest occurrence`, 'muted'));
    actions(c, [button('Confirm & save schedule', async () => { await api(`/proposals/${proposal.id}`, { decision:'confirm' }); toast('Reminder scheduled'); await render(); }, 'primary'), button('Reject proposal', async () => { await api(`/proposals/${proposal.id}`, { decision:'reject' }); await render(); })]);
  }
  for (const u of data.uncertain) {
    const c = card('Action needs reconciliation', `${u.kind}: ${u.error}`);
    c.append(el('p', 'Check the provider’s Sent folder or calendar before recording the outcome. This action will not be automatically retried.'));
    actions(c, [button('Provider performed the action', async () => { await api(`/jobs/${u.id}/reconcile`, { resolution: 'completed' }); await render(); }), button('Confirmed not performed', async () => { await api(`/jobs/${u.id}/reconcile`, { resolution: 'failed' }); await render(); })]);
  }
  const approvals = card('Your approval matters', 'Review the final contents before authorizing an external action.');
  for (const a of data.approvals) {
    const d = item(approvals, a.subject, a.kind === 'email_send' ? `To: ${a.recipients}` : 'Calendar event');
    d.append(el('pre', a.body), el('p', `Attachments: ${JSON.parse(a.attachments).length ? a.attachments : 'None'}`, 'muted'), tag(a.state));
    if (a.state === 'pending') actions(d, [button(a.kind === 'email_send' ? 'Approve sending email' : 'Approve creating event', async () => { await api(`/approvals/${a.id}`, { decision: 'approved' }); toast('Approved and queued for the worker'); await render(); }, 'primary'), button('Reject', async () => { await api(`/approvals/${a.id}`, { decision: 'rejected' }); await render(); }, 'danger')]);
  }
  if (!data.approvals.length) empty(approvals, 'Nothing awaiting your approval.');
  const notifications = card('Results & reminders', 'Inbox notifications persist even when push is unavailable.');
  for (const n of data.notifications) { const d = item(notifications, n.title, n.body); d.append(el('small', date(n.created_at))); if (!n.read_at) actions(d, [button('Mark read', async () => { await api(`/notifications/${n.id}`, {}, 'PATCH'); await render(); })]); }
  if (!data.notifications.length) empty(notifications, 'You’re all caught up.');
  const compose = card('Prepare an email', 'The draft is saved locally, then reviewed here before the worker sends it through your connected account.');
  const f = form(compose, 'Save draft for approval', async (b,f) => { await api('/drafts', b); f.reset(); toast('Draft saved for review'); await render(); });
  select(f, 'From connected provider', 'provider', [['google', 'Gmail'], ['microsoft', 'Outlook']]); field(f, 'Recipients (comma-separated)', 'recipients'); field(f, 'Subject', 'subject'); field(f, 'Final message', 'body', 'textarea'); f.addButton();
}
async function connections() {
  root.append(el('div', 'Connect only what you need. Credentials are encrypted on the server and never returned to this page. Remote messages and websites cannot grant permissions.', 'notice'));
  const telegramLink=el('a','Telegram userbot →');telegramLink.href='#telegram';root.append(telegramLink);
  const list = await api('/connections'), grid = el('div', undefined, 'grid'); root.append(grid);
  for (const p of list) {
    const title = { google: 'Google Workspace', microsoft: 'Microsoft Outlook', weather: 'Open-Meteo Weather', model: 'Model provider' }[p.provider];
    const c = card(title, null, grid); c.append(tag(p.status));
    if (p.provider === 'google' || p.provider === 'microsoft') {
      c.append(el('p', 'Email search, calendar commitments and approved sending. Authorize your own account with OAuth.'));
      const details = document.createElement('details'); if (!p.configured) details.open = true; details.append(el('summary', p.configured ? 'Replace application credentials' : 'Set up OAuth application')); c.append(details);
      details.append(el('p', 'Register this exact callback in the provider’s developer console:', 'muted'), el('p', p.callback, 'code'));
      const link = el('a', p.provider === 'google' ? 'Open Google Cloud Console ↗' : 'Open Microsoft Entra portal ↗'); link.href = p.provider === 'google' ? 'https://console.cloud.google.com/apis/credentials' : 'https://entra.microsoft.com/'; link.target = '_blank'; link.rel = 'noreferrer'; details.append(link);
      const f = form(details, 'Save encrypted credentials', async (b,f) => { await api('/connections', { ...b, provider: p.provider }); f.reset(); toast('Credentials stored. Continue with account authorization.'); await render(); });
      field(f, 'Application / Client ID', 'client_id'); field(f, 'Client secret', 'client_secret', 'password'); if (p.provider === 'microsoft') field(f, 'Tenant (common, consumers, organizations or tenant ID)', 'tenant', 'text', 'common');
      if (p.provider === 'google') f.append(el('p', 'Enable Gmail API and Google Calendar API. Configure the OAuth consent screen and add your owner account as a test user if required.', 'muted')); f.addButton();
      const authorize = form(c, 'Connect account →', async b => { const result = await api(`/connections/${p.provider}/authorize`, b); location.assign(result.url); });
      select(authorize, 'Conclave permission', 'permission', [['read', 'Read email & calendar'], ['prepare', 'Read + prepare actions for individual approval']], p.permission); authorize.addButton();
    } else if (p.provider === 'model') {
      c.append(el('p', p.model_provider ? `Configured: ${p.model_provider} · ${p.model || 'CLI default model'}` : 'Connect an API account or an existing server CLI login to enable assistant responses.'));
      const f = form(c, 'Save model connection', async (b,f) => { await api('/connections', { ...b, provider: 'model' }); f.reset(); toast('Model configuration saved'); await render(); });
      const provider = select(f, 'Provider', 'model_provider', [['openai', 'OpenAI API'], ['anthropic', 'Anthropic API'],['claude-cli','Claude Code CLI · existing server login'],['codex-cli','Codex CLI · existing server login'],['antigravity-cli','Antigravity CLI · existing server login']], p.model_provider);
      const model = field(f, 'Model ID (optional for CLI default)', 'model', 'text', p.model || ''), apiKey = field(f, 'API key (API providers only)', 'api_key', 'password'); model.autocomplete = 'off'; apiKey.autocomplete = 'new-password';
      const updateFields = () => { const cli = provider.value.endsWith('-cli'); model.required = !cli; apiKey.required = !cli; apiKey.parentElement.hidden = cli; }; provider.onchange = updateFields; updateFields(); f.addButton();
      actions(c, [button('Check CLIs on this server', async () => { const inventory = await api('/connections/cli'); inventoryBox.replaceChildren(); for (const i of inventory) item(inventoryBox, i.label || i.provider, i.installed ? `${i.version} · ${i.note}` : (i.note || 'Not found on the agent bridge')); })]);
      const inventoryBox = el('div'); c.append(inventoryBox);
      c.append(el('p', 'Chat text and selected personal memory are sent to this provider. API billing belongs to your account.', 'muted'));
    } else {
      c.append(el('p', 'Current conditions and a three-day forecast, cached for 15 minutes. No API key is needed for eligible personal use.'));
      const f = form(c, 'Connect weather', async b => { await api('/connections', { ...b, provider: 'weather', accept_terms: b.accept_terms === 'on' }); toast('Weather location saved'); await render(); });
      field(f, 'Location name', 'name'); const lat = field(f, 'Latitude', 'latitude', 'number'); lat.min = -90; lat.max = 90; lat.step = 'any'; const lon = field(f, 'Longitude', 'longitude', 'number'); lon.min = -180; lon.max = 180; lon.step = 'any';
      const l = el('label', undefined, 'check-label'), check = document.createElement('input'); check.type = 'checkbox'; check.name = 'accept_terms'; check.required = true; l.append(check, document.createTextNode('I use this privately for noncommercial purposes and accept the Open-Meteo terms. ')); const a = el('a', 'Read terms ↗'); a.href = 'https://open-meteo.com/en/terms'; a.target = '_blank'; a.rel = 'noreferrer'; l.append(a); f.append(l); f.addButton();
    }
    if (p.configured || p.status === 'connected') actions(c, [button('Disconnect & remove local credentials', async () => { await api(`/connections/${p.provider}`, {}, 'DELETE'); toast('Local credentials removed. You can also revoke access in your provider account.'); await render(); }, 'danger')]);
  }
}
async function devices() {
  const c = card('Your devices', 'Every browser login has its own revocable session. “Recently seen” means an authenticated request arrived within two minutes.');
  for (const d of await api('/devices')) {
    const row = item(c, `${d.name}${d.current ? ' · this device' : ''}`, `Last seen ${date(d.last_seen)} · Capabilities: ${JSON.parse(d.capabilities).join(', ')}`); row.append(tag(d.connection_state));
    row.append(el('p', 'Manage browser access in Conclave Settings → Security.', 'muted'));
  }
  const companions = await api('/companions'), enrollment = card('Enroll a companion', 'Optional Windows/Linux agent. It connects outbound with its own revocable credential. Selected-file access and allowlisted commands also require local interactive confirmation. Clipboard access is not enabled.');
  const f=form(enrollment,'Generate unique device credential',async b=>{
    const capabilities=['notify',...(b.read_file==='on'?['read_file']:[]),...(b.command==='on'?['command']:[])];
    const result=await api('/companions',{name:b.name,capabilities});
    secretBox.replaceChildren(el('p','Save this credential privately on the companion. It is shown once; it cannot be retrieved later.'));
    const text=document.createElement('textarea');text.readOnly=true;text.setAttribute('aria-label','One-time companion configuration');text.value=JSON.stringify({origin:location.origin+'/assistant',token:result.token,capabilities,allowed_roots:[],commands:{}},null,2);secretBox.append(text);
    actions(secretBox,[button('Copy configuration',async()=>{await navigator.clipboard.writeText(text.value);toast('Copied. Save it in a private config file outside the repository.');})]);
    secretBox.append(el('p','Run: node companion/agent.mjs /private/path/companion.json. Enroll another credential if this one is lost.','muted'));
  });field(f,'Companion name','name');
  for(const [name,label]of [['read_file','Allow selected-file requests (requires local allowed roots)'],['command','Allow command requests (requires local command allowlist)']]){const l=el('label',undefined,'check-label'),input=document.createElement('input');input.type='checkbox';input.name=name;l.append(input,document.createTextNode(label));f.append(l);}f.addButton();const secretBox=el('div');enrollment.append(secretBox);
  const list=card('Companion connections','Queued work expires after five minutes. Interrupted work becomes uncertain and is never silently replayed.');
  for(const d of companions){const row=item(list,d.name,`Capabilities: ${JSON.parse(d.capabilities).join(', ')} · Last seen: ${d.last_seen?date(d.last_seen):'Never'}`);row.append(tag(d.revoked_at?'revoked':d.last_seen&&Date.now()-d.last_seen<30000?'recently_seen':'offline'));if(!d.revoked_at)actions(row,[button('Revoke companion',async()=>{await api(`/companions/${d.id}`,{},'DELETE');await render();},'danger')]);}
  if(!companions.length)empty(list,'No companion has been enrolled. The PWA works without one.');
  if(companions.some(d=>!d.revoked_at)){
    const work=card('Request a local capability','Only an explicitly enrolled capability and a local allowlist can execute.');
    const q=form(work,'Queue request (expires in 5 minutes)',async b=>{await api('/companions/work',b);toast('Request queued');await render();});
    select(q,'Companion','device_id',companions.filter(d=>!d.revoked_at).map(d=>[d.id,d.name]));select(q,'Capability','kind',[['notify','Notification'],['read_file','Read a selected file'],['command','Run a local allowlisted command ID']]);
    field(q,'Notification title','title','text','Conclave',false);field(q,'Notification body','body','text','',false);field(q,'Selected absolute file path (file requests)','path','text','',false);field(q,'Local command ID (command requests)','command_id','text','',false);q.addButton();
  }
  const results=await api('/companions/work');if(results.length){const history=card('Companion results');for(const r of results){const d=item(history,`${r.kind} · ${date(r.created_at)}`,r.result||`Expires ${date(r.expires_at)}`);d.append(tag(r.state));}}
}
async function settings() {
  const grid = el('div', undefined, 'grid'); root.append(grid);
  const memories = card('Personal memory', 'Facts you choose to keep. Edit or remove them at any time.', grid);
  const f = form(memories, 'Remember this', async (b,f) => { await api('/memories', b); f.reset(); await render(); }); field(f, 'A preference or fact', 'content', 'textarea'); f.addButton();
  const upload = field(memories, 'Import memory phrases (.md or .txt, max 50 KB)', 'memory_file', 'file', '', false); upload.accept = '.md,.txt,text/markdown,text/plain';
  const importPreview = el('div'); memories.append(importPreview);
  upload.onchange = async () => {
    importPreview.replaceChildren();
    try {
      const file = upload.files[0]; if (!file) return; if (file.size > 50_000) throw new Error('Use a file smaller than 50 KB');
      const content = await file.text(), request = { name: file.name, content }, result = await api('/memories/import/preview', request);
      importPreview.className = 'preview'; importPreview.append(el('h3', `${result.new_memories} new memory nodes`), el('p', `${result.total_phrases} phrases · ${result.skipped_duplicates} duplicates · ${Object.keys(result.topics).length} topics`), el('p', 'Source context stays with every imported statement. Plans, estimates and hypothetical templates are labeled separately.', 'muted'));
      for (const [kind,count] of Object.entries(result.kinds)) importPreview.append(tag(`${kind}: ${count}`));
      for (const phrase of result.phrases.slice(0,8)) item(importPreview, phrase.topic || 'General', phrase.content);
      actions(importPreview, [button('Import these memory nodes', async () => { const saved = await api('/memories/import', request); toast(`Imported ${saved.imported} nodes; ${saved.skipped_duplicates} duplicates skipped`); await render(); }, 'primary'), button('Cancel import', async () => { importPreview.replaceChildren(); importPreview.className = ''; upload.value = ''; })]);
    } catch(e) { toast(e.message); }
  };
  for (const m of await api('/memories')) {
    const d = item(memories, m.topic || 'Remembered fact', null), edit = document.createElement('textarea'); edit.value = m.content; edit.setAttribute('aria-label', 'Edit remembered fact'); d.append(edit);
    if (m.source) { let metadata = {}; try { metadata = JSON.parse(m.metadata || '{}'); } catch {} d.append(el('p', `${metadata.kind || 'statement'} · ${m.source}${metadata.source_line ? ` · line ${metadata.source_line}` : ''}`, 'muted')); }
    actions(d, [button('Save edit', async () => { await api('/memories', { id: m.id, content: edit.value }); toast('Memory updated'); }), button('Forget', async () => { await api(`/memories/${m.id}`, {}, 'DELETE'); await render(); }, 'danger')]);
  }
  const security = card('Account & passkeys', 'Password changes revoke other browser sessions.', grid);
  const accountLink = document.createElement('a'); accountLink.href = '/#/settings?tab=security'; accountLink.textContent = 'Manage Conclave account, passkeys and sessions'; security.append(accountLink);
  const push = card('Notifications', 'Inbox delivery is always available. Web Push requires browser support and permission; on iOS use an installed Home Screen web app.', grid);
  const pf = form(push, 'Enable push on this device', async b => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser does not support Web Push. Use the persistent Inbox.');
    if (await Notification.requestPermission() !== 'granted') throw new Error('Notification permission was not granted. Inbox remains available.');
    const { public_key } = await api('/push/setup', b), reg = await navigator.serviceWorker.ready;
    const bytes = Uint8Array.from(atob(public_key.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
    const subscription = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    await api('/push/subscribe', { subscription: subscription.toJSON() }); toast('Web Push enabled');
  }); field(pf, 'Push service contact (mailto:you@example.com)', 'contact'); pf.addButton();
  actions(push, [button('Disable push on this device', async () => { await api('/push/subscribe', {}, 'DELETE'); const reg = await navigator.serviceWorker?.ready; const sub = await reg?.pushManager.getSubscription(); await sub?.unsubscribe(); toast('Push disabled; Inbox remains available'); })]);
  const privacy = card('Privacy & audit', 'Private credentials are encrypted separately from conversation content. Protect your server backups and encryption key.', grid);
  const log = await api('/audit'); for (const a of log.slice(0, 15)) item(privacy, a.event.replaceAll('.', ' · '), date(a.created_at));
  actions(privacy, [button('Sign out', async () => { await fetch('/api/auth/logout', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'}); location.assign('/login'); })]);
}
async function render() {
  activeDictation?.abort();
  const version = ++renderVersion, page = Object.hasOwn(titles, location.hash.slice(1)) ? location.hash.slice(1) : 'chat';
  $('#page-title').textContent = titles[page]; document.title = `${titles[page]} · Conclave`;
  document.querySelectorAll('[data-page]').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  dashboardCleanup?.(); dashboardCleanup = null; root.replaceChildren(); document.body.classList.toggle('wide', page === 'dashboard' || page === 'management');
  try { const cleanup = await ({management,dashboard,chat,notes,today,tasks,inbox,connections,telegram,devices,settings}[page])(); if (typeof cleanup === 'function') { if (version === renderVersion) dashboardCleanup = cleanup; else cleanup(); } } catch (e) { if (version === renderVersion) { root.append(el('p', e.message, 'error-text')); toast(e.message); } }
}
async function boot() {
  try { me = await api('/me'); $('#login').hidden = true; $('#shell').hidden = false; $('#owner-label').textContent = me.username; $('#zone').textContent = me.timezone; await render(); }
  catch { location.assign('/login'); }
}
$('#login-form').onsubmit = async e => { e.preventDefault(); const b = e.target.querySelector('button[type=submit]'); b.disabled = true; try { await api('/login', Object.fromEntries(new FormData(e.target))); e.target.reset(); await boot(); } catch(error) { toast(error.message); } finally { b.disabled = false; } };
$('#passkey-login').onclick = async () => { try { const data = await api('/passkeys/login/options', {}); const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: data.options }); await api('/passkeys/login/verify', { response, challenge_id: data.challenge_id }); await boot(); } catch(e) { toast(e.message); } };
$('#logout').onclick = async () => { await fetch('/api/auth/logout', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'}); location.assign('/login'); };
window.addEventListener('hashchange', () => { if (me) render(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/assistant/sw.js').catch(() => {});
boot();

async function notes() {
  root.append(el('p','Keep notes here, then prepare a coding request for the workspace. Sending it remains your choice.'));
  const grid = el('div', undefined, 'grid'); root.append(grid);
  const create = card('New note', null, grid);
  const f = form(create, 'Save note', async b => { await api('/notes',b); await render(); });
  field(f,'Title','title'); const input = field(f,'Note or task','content','textarea'); input.maxLength=20000; voiceControls(f,input); f.addButton();
  for (const note of await api('/notes')) {
    const c = card(note.title,null,grid), edit=document.createElement('textarea'); edit.value=note.content; edit.setAttribute('aria-label',note.title); c.append(edit);
    actions(c,[button('Save',async()=>{await api('/notes',{id:note.id,title:note.title,content:edit.value});toast('Note saved');}),button('Prepare coding request',()=>{
      const key='conclave:draft:welcome';
      if(localStorage.getItem(key) && !confirm('Replace the existing unsent coding draft with this note?')) return;
      localStorage.setItem(key,`Task: ${note.title}\n\n${edit.value}\n\nSource: Conclave note ${note.id}\nReview the scope and workspace before starting.`);
      location.assign('/#/hub?new=1');
    }),button('Delete',async()=>{if(!confirm('Delete this note?'))return;await api(`/notes/${note.id}`,{},'DELETE');await render();},'danger')]);
  }
}

async function telegram() {
  const status=await api('/telegram');
  const c=card('Telegram userbot','Chat with Conclave from your allowed Telegram account. Session credentials are stored encrypted and never shown here.');
  c.append(tag(status.configured?status.health.state:'Authorization required'));
  c.append(el('p','Authorize privately on the server with npm run telegram:setup. A Telegram API ID/hash, userbot login code, optional two-step password, and your numeric owner ID are required.','muted'));
  if(!status.configured)return;
  c.append(el('p',`Allowed owner: ${status.owner_id}. In Saved Messages on the same account, prefix requests with /conclave. A separate userbot account can receive ordinary private messages from this owner.`));
  const f=form(c,'Save Telegram settings',async b=>{await api('/telegram/config',{enabled:b.enabled==='on',calls_enabled:b.calls_enabled==='on',notifications:b.notifications==='on'});toast('Telegram settings saved');await render();});
  for(const [name,label] of [['enabled','Enable owner-only Telegram chat'],['calls_enabled','Allow outbound spoken-message calls'],['notifications','Send new reminder and automation notifications']]){const l=el('label',undefined,'check-label'),input=document.createElement('input');input.type='checkbox';input.name=name;input.checked=!!status[name];l.append(input,document.createTextNode(label));f.append(l);}f.addButton();
  c.append(el('p','Calls require a userbot account different from your own account. Calls speak the supplied message; two-way voice conversation is not enabled. Chat replies use your connected assistant model.','muted'));
  const send=card('Contact me','Only your configured owner account can be contacted. /call followed by a message also requests a spoken call from Telegram.');
  const compose=form(send,'Queue for delivery',async(b,f)=>{await api('/telegram/outbox',{...b,request_id:crypto.randomUUID()});f.reset();toast('Queued; delivery runs in the background');await render();});
  select(compose,'Action','kind',[['message','Send message'],['call','Call and speak this message']]);const text=field(compose,'Message (calls: 800 characters maximum)','text','textarea');text.maxLength=3800;compose.addButton();
  const history=card('Delivery history','Uncertain actions are not automatically retried. Check Telegram before requesting another delivery.');for(const job of status.outbox)item(history,`${job.kind} · ${job.state}`,`${date(job.created_at)}${job.error?' · '+job.error:''}`);
  actions(c,[button('Disconnect Telegram',async()=>{await api('/telegram',{},'DELETE');await render();},'danger')]);
}
