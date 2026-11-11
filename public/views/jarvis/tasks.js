// Jarvis Today + Tasks & automations (ported from the former /assistant app).
import { api, ctx, toast, date, el, button, card, field, select, form, item, tag, actions, empty, grid, checkbox, render, mountPage } from './ui.js';

let editingSchedule = null, preview = null;

export const renderTasks = (view, params) => mountPage(view, 'Tasks & automations', tasks, params);
export const renderToday = view => mountPage(view, 'Today', today);

async function tasks(params) {
  const editId = params?.get('edit');
  const [schedules, jobs] = await Promise.all([api('/schedules'), api('/jobs')]);
  if (editId && editingSchedule?.id !== editId) editingSchedule = schedules.find(s => s.id === editId) || null;

  const c = card(editingSchedule ? 'Edit reminder' : 'Make time for what matters', `Preview the interpreted schedule before saving. Default timezone: ${ctx.me.timezone}.`);
  const box = el('div', undefined, 'jx-preview'); box.hidden = true;
  const f = form(c, 'Preview schedule →', async b => {
    preview = await api('/schedules/preview', { ...b, authorize_automatic: b.authorize_automatic === 'on' });
    box.replaceChildren(el('h3', preview.title), el('p', `${preview.interpreted} · ${preview.timezone}`), el('p', `UTC: ${preview.utc} · Missed runs: ${preview.missed_policy}`, 'muted'));
    if (preview.rule.kind === 'email_send') { const a = preview.rule.action; box.append(el('p', `Authorize this exact email at every occurrence. To: ${a.recipients} · Subject: ${a.subject}`), el('pre', a.body), el('p', 'Attachments: none. Each occurrence expires after 15 minutes.', 'muted')); }
    box.hidden = false;
    box.append(button(editingSchedule ? 'Confirm update' : 'Confirm & save', async () => {
      await api('/schedules', { preview_token: preview.preview_token, id: editingSchedule?.id });
      editingSchedule = null; preview = null; toast('Schedule saved');
      if (editId) location.hash = '/automations'; else await render();
    }, 'primary'));
  });
  field(f, 'Reminder', 'title', 'text', editingSchedule?.title || '');
  const kind = select(f, 'Action', 'kind', [['reminder', 'Reminder'], ['briefing', 'Calendar, email & weather briefing'], ['rain_alert', 'Six-hour rain forecast report'], ['email_send', 'Send this exact email automatically']], editingSchedule ? JSON.parse(editingSchedule.rule).kind : 'reminder');
  const text = field(f, 'When', 'text', 'text', editingSchedule?.original_text || ''); text.placeholder = 'Every weekday at 7 AM';
  field(f, 'Timezone (IANA)', 'timezone', 'text', editingSchedule?.timezone || ctx.me.timezone);
  select(f, 'If a run was missed', 'missed_policy', [['catch_up', 'Deliver one latest missed reminder'], ['skip', 'Skip reminders missed by more than a minute']], editingSchedule?.missed_policy);
  const emailFields = el('div'); f.append(emailFields);
  select(emailFields, 'Email provider', 'provider', [['google', 'Gmail'], ['microsoft', 'Outlook']]);
  field(emailFields, 'Exact recipients', 'recipients'); field(emailFields, 'Exact subject', 'subject'); field(emailFields, 'Exact final message', 'body', 'textarea');
  checkbox(emailFields, 'authorize_automatic', 'I authorize this exact email to be sent automatically at each confirmed occurrence.');
  const showEmailFields = () => { const email = kind.value === 'email_send'; emailFields.hidden = !email; emailFields.querySelectorAll('input,textarea,select').forEach(i => { i.disabled = !email; i.required = email && i.type !== 'checkbox'; }); };
  kind.onchange = showEmailFields; showEmailFields();
  f.append(el('p', 'Also accepts: tomorrow at 9 AM · every day at 7 AM · 2026-12-15T09:00', 'muted'));
  if (editingSchedule) f.append(button('Cancel editing', async () => { editingSchedule = null; preview = null; if (editId) location.hash = '/automations'; else await render(); }, 'ghost'));
  f.addButton(); c.append(box);

  const list = card('Your reminders', null);
  for (const s of schedules) {
    const d = item(list, s.title, `${s.original_text} · ${s.timezone} · Next ${date(s.next_run)}`); d.append(tag(s.status));
    if (s.status === 'cancelled') continue;
    actions(d, [
      button('Edit', async () => { editingSchedule = s; preview = null; await render(); window.scrollTo({ top: 0 }); }),
      button(s.status === 'paused' ? 'Resume' : 'Pause', async () => { await api(`/schedules/${s.id}`, { status: s.status === 'paused' ? 'active' : 'paused' }, 'PATCH'); await render(); }),
      button('Cancel', async () => { if (!confirm(`Cancel “${s.title}”?`)) return; await api(`/schedules/${s.id}`, { status: 'cancelled' }, 'PATCH'); await render(); }, 'danger'),
    ]);
  }
  if (!schedules.length) empty(list, 'Your reminders will appear here.');
  const history = card('Execution history', 'Durable records shared across your devices.');
  for (const j of jobs) { const d = item(history, `${j.kind.replaceAll('_', ' ')} · ${date(j.occurrence_at)}`, j.error || `Attempts: ${j.attempts}`); d.append(tag(j.state)); }
  if (!jobs.length) empty(history, 'No executions yet. The worker processes saved schedules.');
}

async function today() {
  const data = await api('/today'), g = grid();
  const w = card('Weather', null, g), weather = data.weather.data;
  if (data.weather.error) w.append(el('p', data.weather.error, 'jx-error'));
  else if (weather?.status === 'connected') {
    w.append(el('p', weather.location), el('div', `${weather.current.temperature_2m}°`, 'jx-temp'), el('p', `Precipitation: ${weather.current.precipitation} mm · Humidity: ${weather.current.relative_humidity_2m}%`), el('p', `Observation/model time: ${weather.current.time} UTC · Retrieved ${date(weather.fetched_at)}`, 'muted'));
    for (let i = 0; i < weather.daily.time.length; i++) item(w, weather.daily.time[i], `${weather.daily.temperature_2m_min[i]}–${weather.daily.temperature_2m_max[i]}° · Rain probability ${weather.daily.precipitation_probability_max[i]}%`);
    const a = el('a', weather.attribution); a.href = 'https://open-meteo.com/'; a.target = '_blank'; a.rel = 'noreferrer'; w.append(a);
  } else empty(w, 'Set your home coordinates in Connectors to get a live forecast.');
  const r = card('Coming up', 'Your next active reminders.', g);
  for (const s of data.reminders) item(r, s.title, `${date(s.next_run)} · ${s.timezone}`);
  if (!data.reminders.length) empty(r, 'No active reminders.');
  for (const source of data.connections) {
    const c = card(`${source.provider} · Calendar`, null, g), e = card(`${source.provider} · Email`, null, g);
    if (source.calendar.error) empty(c, source.calendar.error);
    for (const event of source.calendar.data || []) item(c, event.title || 'Untitled event', `${event.start} → ${event.end}`);
    if (!source.calendar.data?.length && !source.calendar.error) empty(c, 'No events in the next seven days.');
    if (source.email.error) empty(e, source.email.error);
    for (const m of source.email.data || []) item(e, m.subject || '(No subject)', `${m.sender} · ${m.preview}`);
    if (!source.email.data?.length && !source.email.error) empty(e, 'No messages found.');
  }
  if (!data.connections.length) { const c = card('Connect your day', 'Connect Google or Microsoft in Connectors to see your calendar and email here.', g); const a = el('a', 'Open Connectors →'); a.href = '#/connectors'; c.append(a); }
  const events = card('Create a calendar commitment', 'Prepare the exact event for review in Inbox. Times use this device’s local timezone.');
  const f = form(events, 'Prepare for approval', async b => {
    await api('/calendar/prepare', { ...b, start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString(), timezone: ctx.me.timezone });
    toast('Event prepared. Review it in Inbox.'); location.hash = '/assistant-inbox';
  });
  select(f, 'Calendar provider', 'provider', [['google', 'Google Calendar'], ['microsoft', 'Outlook Calendar']]); field(f, 'Title', 'title'); field(f, 'Starts (device local time)', 'start', 'datetime-local'); field(f, 'Ends (device local time)', 'end', 'datetime-local'); f.addButton();
}
