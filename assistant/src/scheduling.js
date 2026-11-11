import { DateTime, IANAZone } from 'luxon';
import { id, transaction } from './db.js';
import { sendEmail, createCalendarEvent, getSecret, readEmail, readCalendar, weather } from './integrations.js';

export function nextOccurrence(rule, zone, after) {
  if (rule.type === 'once') return null;
  let date = DateTime.fromMillis(after, { zone }).startOf('day');
  for (let i = 0; i < 370; i++, date = date.plus({ days: 1 })) {
    if (rule.type === 'weekdays' && date.weekday > 5) continue;
    const candidate = date.set({ hour: rule.hour, minute: rule.minute });
    if (candidate.toMillis() > after) return candidate.toMillis();
  }
  throw new Error('No next occurrence');
}
export function interpretSchedule(text, zone = 'Asia/Manila', now = Date.now()) {
  if (!IANAZone.isValidZone(zone)) throw new Error('Use a valid IANA timezone');
  text = String(text).trim().toLowerCase().replace(/^remind me\s+/, '');
  let rule, at;
  const match = text.match(/^(tomorrow|every weekday|every day) at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?\.?$/);
  if (match) {
    let hour = Number(match[2]), minute = Number(match[3] || 0);
    if (minute > 59 || hour > (match[4] ? 12 : 23) || (match[4] && hour < 1)) throw new Error('Invalid time');
    if (match[4]) hour = hour % 12 + (match[4] === 'pm' ? 12 : 0);
    if (match[1] === 'tomorrow') {
      rule = { type: 'once' };
      at = DateTime.fromMillis(now, { zone }).plus({ days: 1 }).set({ hour, minute, second: 0, millisecond: 0 });
    } else {
      rule = { type: match[1] === 'every weekday' ? 'weekdays' : 'daily', hour, minute };
      at = DateTime.fromMillis(nextOccurrence(rule, zone, now), { zone });
    }
  } else {
    if (!/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}$/.test(text)) throw new Error('Use “tomorrow at 9 AM”, “every weekday at 7 AM”, “every day at 7 AM”, or YYYY-MM-DDTHH:mm');
    at = DateTime.fromISO(text.toUpperCase(), { zone }); rule = { type: 'once' };
    // Reject DST gaps instead of silently moving a requested wall time.
    if (at.toFormat("yyyy-MM-dd'T'HH:mm").toLowerCase() !== text) throw new Error('This local time does not exist in the selected timezone');
  }
  if (!at.isValid || at.toMillis() <= now) throw new Error('Schedule must be in the future');
  return { rule, timezone: zone, next_run: at.toMillis(), interpreted: at.toFormat('cccc, dd LLL yyyy, HH:mm ZZZZ'), utc: at.toUTC().toISO() };
}

export function materialize(db, now = Date.now()) {
  return transaction(db, () => {
    const due = db.prepare("SELECT * FROM schedules WHERE status='active' AND next_run<=? LIMIT 100").all(now);
    for (const s of due) {
      const rule = JSON.parse(s.rule);
      let occurrence = s.next_run, next = nextOccurrence(rule, s.timezone, occurrence);
      // Coalesce missed recurrences; do not replay an unbounded backlog.
      while (next !== null && next <= now) { occurrence = next; next = nextOccurrence(rule, s.timezone, occurrence); }
      if (s.missed_policy === 'catch_up' || now - occurrence < 60_000) {
        db.prepare("INSERT OR IGNORE INTO jobs(id,schedule_id,occurrence_at,kind,payload,state,available_at) VALUES(?,?,?,?,?,'queued',?)")
          .run(id(), s.id, occurrence, rule.kind || 'reminder', JSON.stringify({ title: s.title, timezone: s.timezone, ...(rule.action || {}), ...(rule.kind==='email_send' ? { expires_at: occurrence + 15 * 60_000 } : {}) }), now);
      }
      db.prepare('UPDATE schedules SET next_run=?,status=? WHERE id=?').run(next ?? occurrence, next === null ? 'completed' : 'active', s.id);
    }
    return due.length;
  });
}

export function recover(db, now = Date.now()) {
  db.prepare("UPDATE jobs SET state='uncertain',error='Lease expired during external action; reconcile before any further action',lease_until=NULL WHERE state='running' AND lease_until<=? AND kind IN ('email_send','calendar_create')").run(now);
  db.prepare("UPDATE jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END, available_at=?,lease_until=NULL,error='Worker lease expired' WHERE state='running' AND lease_until<=? AND kind NOT IN ('email_send','calendar_create')").run(now + 1000, now);
}
export function claim(db, now = Date.now()) {
  return db.prepare(`UPDATE jobs SET state='running', attempts=attempts+1, lease_until=? WHERE id=(SELECT id FROM jobs WHERE state='queued' AND available_at<=? ORDER BY available_at LIMIT 1) AND state='queued' RETURNING *`).get(now + 30_000, now);
}
export async function execute(db, job, now = Date.now(), key = process.env.TOKEN_ENCRYPTION_KEY) {
  if (['email_send', 'calendar_create'].includes(job.kind)) {
    const payload = JSON.parse(job.payload);
    if (!payload.expires_at || payload.expires_at <= now) {
      db.prepare("UPDATE jobs SET state='failed',error='Approval/action expired before execution; prepare a fresh action',lease_until=NULL WHERE id=? AND state='running' AND attempts=?").run(job.id,job.attempts);
      return;
    }
    const draft = db.prepare('SELECT * FROM drafts WHERE id=?').get(payload.draft_id);
    if (!draft) throw new Error('Draft not found');
    // No database transaction spans network I/O. The running lease is extended by tick.
    if (job.kind === 'email_send') await sendEmail(db, payload.provider, key, draft);
    else await createCalendarEvent(db, payload.provider, key, JSON.parse(draft.body), job.id);
    transaction(db, () => {
      const current = db.prepare('SELECT state,attempts FROM jobs WHERE id=?').get(job.id);
      if (current?.state !== 'running' || current.attempts !== job.attempts) return;
      db.prepare("INSERT INTO notifications VALUES(?,?,?,?,?,NULL)").run(id(), job.id, job.kind === 'email_send' ? 'Email accepted by provider' : 'Calendar event created', 'The approved action was accepted. Email acceptance is not a delivery guarantee.', now);
      db.prepare("UPDATE jobs SET state='completed',completed_at=?,lease_until=NULL WHERE id=?").run(now, job.id);
    });
    return;
  }
  const payload = JSON.parse(job.payload);
  let summary;
  if (job.kind === 'briefing' || job.kind === 'rain_alert') {
    const location = getSecret(db, 'config:weather', key);
    const forecast = location ? await weather(db, location) : null;
    const lines = [];
    if (forecast?.current) lines.push(`${forecast.location}: ${forecast.current.temperature_2m}°C, precipitation ${forecast.current.precipitation} mm; weather time ${forecast.current.time} UTC.`);
    if (job.kind === 'rain_alert') {
      if (!forecast?.hourly) throw new Error('Weather location is not configured');
      const index = forecast.hourly.time.findIndex(t=>Date.parse(`${t}Z`)>=now);
      const probability = Math.max(...forecast.hourly.precipitation_probability.slice(Math.max(0,index),Math.max(0,index)+6));
      lines.push(`Maximum rain probability over the next six hours: ${probability}%.`);
    } else {
      for (const {provider} of db.prepare("SELECT provider FROM connections WHERE status='connected' AND provider IN ('google','microsoft')").all()) {
        const events = await readCalendar(db,provider,key,new Date(now).toISOString(),new Date(now+86400_000).toISOString());
        const email = await readEmail(db,provider,key,provider==='google'?'is:unread newer_than:1d':'');
        lines.push(`${provider} calendar for next 24 hours: ${events.length ? events.map(e=>`${e.title} (${e.start})`).join('; ') : 'No events'}.`);
        lines.push(`${provider} recent email: ${email.length ? email.slice(0,5).map(e=>`${e.subject} — ${e.sender}`).join('; ') : 'No messages'}.`);
      }
      if (!lines.length) throw new Error('Connect calendar/email or weather before running a briefing');
    }
    summary = lines.join('\n');
  }
  transaction(db, () => {
    const current = db.prepare('SELECT state,attempts FROM jobs WHERE id=?').get(job.id);
    if (current?.state !== 'running' || current.attempts !== job.attempts) return;
    db.prepare('INSERT OR IGNORE INTO notifications VALUES(?,?,?,?,?,NULL)').run(id(), job.id, payload.title, summary || `Reminder · ${payload.timezone}`, now);
    db.prepare("UPDATE jobs SET state='completed',completed_at=?,lease_until=NULL WHERE id=?").run(now, job.id);
  });
}
export async function tick(db, now = Date.now(), key = process.env.TOKEN_ENCRYPTION_KEY) {
  materialize(db, now); recover(db, now);
  for (let i = 0; i < 50; i++) {
    const job = claim(db, now); if (!job) break;
    const heartbeat = setInterval(() => db.prepare("UPDATE jobs SET lease_until=? WHERE id=? AND state='running' AND attempts=?").run(Date.now() + 30_000, job.id, job.attempts), 10_000);
    try { await execute(db, job, now, key); }
    catch {
      db.prepare("UPDATE jobs SET state=?,available_at=?,error=?,lease_until=NULL WHERE id=? AND state='running'").run(
        ['email_send', 'calendar_create'].includes(job.kind) ? 'uncertain' : job.attempts >= 3 ? 'failed' : 'queued',
        now + 1000 * 2 ** job.attempts, 'Execution failed; private payload omitted', job.id);
    } finally { clearInterval(heartbeat); }
  }
}
