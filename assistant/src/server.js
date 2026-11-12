import {externalStatus,saveExternal,removeExternal,readExternal,sendDiscord} from './external-services.js';
import {modelSettings,switchModel} from './model-settings.js';
import { telegramSchema, telegramStatus, configureTelegram, queueTelegram, TelegramLogin } from './telegram.js';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { readFileSync, unlinkSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { openDb, id, audit, transaction } from './db.js';
import { credential, sessionHash, passwordHash, passwordMatches } from './security.js';
import { interpretSchedule } from './scheduling.js';
import { getSecret, setSecret, beginOAuth, finishOAuth, modelReply, weather, readEmail, readCalendar } from './integrations.js';
import { handlePasskeys } from './webauthn.js';
import { handlePush } from './push.js';
import { cliInventory } from './cli-model.js';
import { companionSchema, companionOwner, companionDevice } from './companion.js';
import { memoryGraph, mergedMemoryGraph, relevantMemories, recordActivity, categoryIds } from './memory-graph.js';
import { importMemoryDocument, previewMemoryImport } from './memory-import.js';

const assets = new Map(['index.html', 'app.js', 'dashboard.js', 'theme.js', 'shell.css', 'style.css', 'manifest.webmanifest', 'sw.js', 'icon.svg'].map(name => [
  `/${name}`, { body: readFileSync(new URL(`../public/${name}`, import.meta.url)), type: name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : 'application/manifest+json' }
]));
assets.set('/webauthn.js', { body: readFileSync(new URL('../../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js', import.meta.url)), type: 'text/javascript' });
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
function str(value, max = 1000) { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, `Expected text of 1–${max} characters`); return value.trim(); }
function sign(value, secret) { return createHmac('sha256', secret).update(value).digest('base64url'); }
function equal(a, b) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
async function body(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') fail(415, 'JSON required');
  let data = ''; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) fail(413, 'Request too large'); data += chunk; }
  try { const value = JSON.parse(data || '{}'); if (!value || Array.isArray(value) || typeof value !== 'object') fail(400, 'JSON object required'); return value; }
  catch { fail(400, 'Invalid JSON object'); }
}

export function createApp({ db = openDb(), origin = process.env.APP_ORIGIN || 'http://127.0.0.1:3210', secret = process.env.SESSION_SECRET, encryptionKey = process.env.TOKEN_ENCRYPTION_KEY, sharedIdentity, globalInstructions = () => '', syncSharedMemory = () => {}, codingSnapshot = null, telegramLoginOptions = {} } = {}) {
  if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) throw new Error('SESSION_SECRET must be a generated 32-byte hex value. Run npm run setup.');
  if (!encryptionKey || !/^[a-f0-9]{64}$/i.test(encryptionKey)) throw new Error('TOKEN_ENCRYPTION_KEY must be an independent generated 32-byte hex value.');
  if (secret === encryptionKey) throw new Error('Session and encryption keys must be independent');
  const originUrl = new URL(origin);
  companionSchema(db);
  telegramSchema(db);
  const telegramLogin = new TelegramLogin(db, encryptionKey, telegramLoginOptions);
  if (originUrl.origin !== origin || (originUrl.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(originUrl.hostname))) throw new Error('APP_ORIGIN must be an exact HTTPS origin or local loopback origin');
  const secure = originUrl.protocol === 'https:';
  const cookieName = secure ? '__Host-jarvis' : 'jarvis_local';
  const cookie = (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const dummyPassword = passwordHash(credential());
  function newSession(req, res, label = 'Browser') {
    const now = Date.now(), token = credential(), session = sessionHash(token, secret), device = id();
    transaction(db, () => {
      db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(session, String(req.headers['user-agent'] || 'Browser').slice(0, 200), now, now, now + 7 * 86400_000);
      db.prepare('INSERT INTO devices VALUES(?,?,?,?,?,NULL)').run(device, session, String(label).slice(0, 80), '["inbox"]', now);
      audit(db, 'login.succeeded', device);
    });
    res.setHeader('Set-Cookie', cookie(token, 7 * 86400));
  }
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', sharedIdentity ? 'SAMEORIGIN' : 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors ${sharedIdentity ? "'self'" : "'none'"}; base-uri 'none'; form-action 'self'`);
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      // Do not trust arbitrary forwarded IP/host headers from the internet.
      if (req.headers.host !== originUrl.host) fail(403, 'Host not allowed');
      const url = new URL(req.url, origin), path = url.pathname, method = req.method;
      if (!path.startsWith('/api/')) {
        if (method !== 'GET') fail(405, 'Method not allowed');
        const asset = assets.get(path === '/' ? '/index.html' : path);
        if (!asset) fail(404, 'Not found');
        res.writeHead(200, { 'Content-Type': `${asset.type}; charset=utf-8` }); res.end(asset.body); return;
      }
      if (method !== 'GET' && !path.startsWith('/api/companion/') && req.headers.origin !== origin) fail(403, 'Origin not allowed');
      if (sharedIdentity && (path === '/api/login' || path.startsWith('/api/passkeys') || path === '/api/account/password' || path === '/api/logout' || (path.startsWith('/api/devices/') && method === 'DELETE'))) fail(409, 'Manage sign-in, sessions and security in Conclave Settings');
      const b = method !== 'GET' ? await body(req) : {};
      if (path.startsWith('/api/companion/')) { if (method!=='POST') fail(405,'POST required'); json(companionDevice(db,path,b,req.headers.authorization,secret)); return; }
      if (path === '/api/health' && method === 'GET') { json({ status: 'ok', mode: 'local-foundation' }); return; }
      if (path === '/api/login' && method === 'POST') {
        const now = Date.now(), key = 'owner';
        const attempts = db.prepare('SELECT * FROM login_attempts WHERE key=?').get(key);
        if (attempts && now - attempts.window_at < 15 * 60_000 && attempts.failures >= 5) { res.setHeader('Retry-After', '900'); fail(429, 'Too many attempts. Try again in 15 minutes.'); }
        const owner = db.prepare('SELECT * FROM owner WHERE id=1').get();
        const matches = passwordMatches(b.password, owner?.password || dummyPassword);
        if (!owner || b.username !== owner.username || !matches) {
          db.prepare('INSERT INTO login_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET failures=CASE WHEN ?-window_at>=900000 THEN 1 ELSE failures+1 END,window_at=CASE WHEN ?-window_at>=900000 THEN ? ELSE window_at END').run(key, now, now, now, now);
          audit(db, 'login.failed'); fail(401, 'Invalid username or password');
        }
        db.prepare('DELETE FROM login_attempts WHERE key=?').run(key);
        newSession(req, res, b.device_name); json({ ok: true }); return;
      }
      if (path.startsWith('/api/passkeys/login/') && method === 'POST') {
        const result = await handlePasskeys(db, path, b, origin, null);
        if (result.authenticated) newSession(req, res, 'Passkey browser');
        json(result); return;
      }
      const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      let sessionId = token ? sessionHash(token, secret) : '';
      if (sharedIdentity) {
        const identity = sharedIdentity(req);
        if (!identity) fail(401, 'Conclave sign-in required');
        sessionId = sessionHash(identity.id, secret);
        const now = Date.now();
        if (!db.prepare('SELECT id FROM sessions WHERE id=?').get(sessionId)) {
          transaction(db, () => {
            db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(sessionId, 'Conclave browser', now, now, identity.expires);
            db.prepare('INSERT INTO devices VALUES(?,?,?,?,?,NULL)').run(id(), sessionId, String(req.headers['user-agent'] || 'Conclave browser').slice(0,80), '["inbox"]', now);
          });
        }
        db.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(identity.expires, sessionId);
      }
      const session = db.prepare('SELECT * FROM sessions WHERE id=? AND expires_at>?').get(sessionId, Date.now());
      if (!session) fail(401, 'Please log in');
      db.prepare('UPDATE sessions SET last_seen=? WHERE id=?').run(Date.now(), sessionId);
      db.prepare('UPDATE devices SET last_seen=? WHERE session_id=?').run(Date.now(), sessionId);
      if (path === '/api/telegram' && method==='GET') {json({...telegramStatus(db,encryptionKey),login:telegramLogin.status()});return;}
      // Owner-only browser login. Codes/passwords pass straight to the bridge and are never persisted or logged.
      if (path === '/api/telegram/login/start' && method==='POST') {json(await telegramLogin.start(b));return;}
      if (path === '/api/telegram/login/code' && method==='POST') {json(await telegramLogin.code(b));return;}
      if (path === '/api/telegram/login/password' && method==='POST') {json(await telegramLogin.password(b));return;}
      if (path === '/api/telegram/login' && method==='DELETE') {json(telegramLogin.cancel());return;}
      if (path === '/api/telegram/config' && method==='POST') {json(configureTelegram(db,encryptionKey,b));return;}
      if (path === '/api/telegram/outbox' && method==='POST') {json(queueTelegram(db,encryptionKey,b),202);return;}
      if (path === '/api/telegram' && method==='DELETE') {db.prepare("DELETE FROM secrets WHERE key='config:telegram'").run();db.prepare("UPDATE telegram_outbox SET state='cancelled' WHERE state='queued'").run();audit(db,'telegram.disconnected');json({ok:true});return;}
      if(path.startsWith('/api/memories') || path==='/api/messages')syncSharedMemory();
      if (path.startsWith('/api/passkeys')) { json(await handlePasskeys(db, path, b, origin, sessionId, method)); return; }
      if (path.startsWith('/api/push')) { json(await handlePush(db, path, b, sessionId, encryptionKey, method)); return; }
      if (path.startsWith('/api/companions')) { json(companionOwner(db,path,b,secret,method)); return; }
      if (/^\/api\/oauth\/(google|microsoft)\/callback$/.test(path) && method === 'GET') {
        await finishOAuth(db, path.split('/')[3], url, sessionId, origin, encryptionKey);
        res.writeHead(303, { Location: '/assistant/#connections' }); res.end(); return;
      }
      if (path === '/api/me' && method === 'GET') {
        json({ username: sharedIdentity ? sharedIdentity(req).username : db.prepare('SELECT username FROM owner').get().username, timezone: process.env.APP_TIMEZONE || 'Asia/Manila', capabilities: { passkeys: true, push: true, oauth: true, companions: false, liveModel: true } }); return;
      }
      if (path === '/api/logout' && method === 'POST') { db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId); res.setHeader('Set-Cookie', cookie('', 0)); json({ ok: true }); return; }
      if (path === '/api/account/password' && method === 'POST') {
        const owner = db.prepare('SELECT * FROM owner').get();
        if (!passwordMatches(b.current_password, owner.password)) fail(403, 'Current password is incorrect');
        const hash = passwordHash(b.password);
        transaction(db, () => { db.prepare('UPDATE owner SET password=?').run(hash); db.prepare('DELETE FROM sessions WHERE id!=?').run(sessionId); audit(db, 'account.password_changed'); });
        if(process.env.INITIAL_OWNER_PASSWORD_FILE){try{unlinkSync(process.env.INITIAL_OWNER_PASSWORD_FILE);}catch(e){if(e.code!=='ENOENT')console.error('Initial credential file cleanup failed; remove it privately.');}}
        json({ ok: true }); return;
      }
      if (path === '/api/notes' && method === 'GET') { json(db.prepare('SELECT * FROM notes ORDER BY updated_at DESC').all()); return; }
      if (path === '/api/notes' && method === 'POST') {
        const title = str(b.title, 160), content = str(b.content, 20000), noteId = b.id ? str(b.id, 80) : id();
        if (b.id && !db.prepare('SELECT id FROM notes WHERE id=?').get(noteId)) fail(404, 'Note not found');
        db.prepare('INSERT INTO notes VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,updated_at=excluded.updated_at').run(noteId,title,content,Date.now());
        audit(db,'note.saved',noteId); json({id:noteId},201); return;
      }
      if (path.startsWith('/api/notes/') && method === 'DELETE') { const noteId=path.split('/').at(-1); db.prepare('DELETE FROM notes WHERE id=?').run(noteId); audit(db,'note.deleted',noteId); json({ok:true}); return; }
      if (path === '/api/conversations' && method === 'GET') { json(db.prepare('SELECT * FROM conversations ORDER BY created_at DESC LIMIT 100').all()); return; }
      if (path === '/api/conversations' && method === 'POST') {
        const item = { id: id(), title: str(b.title || 'New conversation', 100), created_at: Date.now() };
        db.prepare('INSERT INTO conversations VALUES(?,?,?)').run(item.id, item.title, item.created_at); json(item, 201); return;
      }
      if (path === '/api/messages' && method === 'GET') {
        const query = url.searchParams.get('q');
        json(query ? db.prepare('SELECT * FROM messages WHERE instr(lower(content),lower(?))>0 ORDER BY created_at DESC LIMIT 100').all(query.slice(0, 200)) : db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,id LIMIT 1000').all(url.searchParams.get('conversation'))); return;
      }
      if (path === '/api/messages' && method === 'POST') {
        const content = str(b.content, 12000), conversation = str(b.conversation_id, 64);
        if (!db.prepare('SELECT id FROM conversations WHERE id=?').get(conversation)) fail(404, 'Conversation not found');
        db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(id(), conversation, 'user', content, 'user', Date.now());
        const asked = relevantMemories(db, content); recordActivity(db, asked, 'chat');
        const answer = await modelReply(db, encryptionKey, conversation, asked.map(h => h.id), globalInstructions());
        db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(id(), conversation, 'assistant', answer, 'model', Date.now());
        const answered = relevantMemories(db, answer).filter(h => !asked.some(a => a.id === h.id)); recordActivity(db, answered, 'answer');
        json({ ok: true, memory_ids: [...asked, ...answered].map(h => h.id) }); return;
      }
      if (path === '/api/memories' && method === 'GET') { json(db.prepare('SELECT * FROM memories ORDER BY updated_at DESC').all()); return; }
      if (path === '/api/memories/graph' && method === 'GET') {
        if (url.searchParams.get('merged') !== '1') { json(memoryGraph(db)); return; }
        const includeLocal = url.searchParams.get('include_local') === '1';
        const updatedSince = Math.max(0, Number(url.searchParams.get('updated_since')) || 0);
        let coding = null;
        if (codingSnapshot && url.searchParams.get('coding') !== '0') { try { coding = codingSnapshot(); } catch { coding = null; } }
        json(mergedMemoryGraph(db, { coding, includeLocal, updatedSince })); return;
      }
      if (path === '/api/memories/activity' && method === 'GET') {
        const since = Math.max(Number(url.searchParams.get('since')) || 0, Date.now() - 864e5);
        const after = Number(url.searchParams.get('after')) || 0;
        const events = db.prepare('SELECT id,memory_id,source,score,created_at FROM memory_activity WHERE created_at>=? AND id>? ORDER BY id LIMIT 500').all(since, after);
        json({ now: Date.now(), cursor: events.at(-1)?.id || after, events }); return;
      }
      if (/^\/api\/memories\/[\w-]{1,64}\/access$/.test(path) && method === 'POST') {
        const target = path.split('/')[3]; if (!db.prepare('SELECT id FROM memories WHERE id=?').get(target)) fail(404, 'Memory not found');
        recordActivity(db, [{ id: target, score: 1 }], 'viewed'); json({ ok: true }); return;
      }
      if (path === '/api/memories' && method === 'POST') {
        if(b.id && db.prepare('SELECT source FROM memories WHERE id=?').get(b.id)?.source==='conclave-shared')fail(409,'Edit shared coding memories in Conclave Memory');
        const content = str(b.content, 4000), memoryId = b.id ? str(b.id, 64) : id();
        if (b.category !== undefined && b.category !== null && b.category !== '' && !categoryIds.includes(b.category)) fail(400, 'Unknown memory category');
        const category = b.category === undefined ? undefined : (b.category || null);
        db.prepare('INSERT INTO memories(id,content,updated_at,category) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at' + (category === undefined ? '' : ',category=excluded.category')).run(memoryId, content, Date.now(), category ?? null); audit(db, 'memory.saved', memoryId); json({ id: memoryId }); return;
      }
      if (path === '/api/memories/import' && method === 'POST') {
        json(importMemoryDocument(db, b.name, b.content), 201); return;
      }
      if (path === '/api/memories/import/preview' && method === 'POST') { json(previewMemoryImport(db, b.name, b.content)); return; }
      if (path.startsWith('/api/memories/') && method === 'DELETE') { const target = path.split('/').at(-1); transaction(db, () => { db.prepare('DELETE FROM memory_activity WHERE memory_id=?').run(target); db.prepare('DELETE FROM memories WHERE id=?').run(target); audit(db, 'memory.deleted', target); }); json({ ok: true }); return; }
      if (path === '/api/schedules/preview' && method === 'POST') {
        const title = str(b.title, 200), original_text = str(b.text, 500), timezone = str(b.timezone || 'Asia/Manila', 100);
        if (!['skip', 'catch_up'].includes(b.missed_policy)) fail(400, 'Choose skip or catch_up');
        let interpreted; try { interpreted = interpretSchedule(original_text, timezone); } catch (e) { fail(400, e.message); }
        if (!['reminder','briefing','rain_alert','email_send'].includes(b.kind || 'reminder')) fail(400, 'Choose a supported automation');
        interpreted.rule.kind = b.kind || 'reminder';
        if (b.kind === 'email_send') {
          if (b.authorize_automatic !== true) fail(400, 'Individually authorize this exact recurring email before previewing');
          if (!['google','microsoft'].includes(b.provider) || db.prepare("SELECT permission FROM connections WHERE provider=? AND status='connected'").get(b.provider)?.permission!=='prepare') fail(409,'Connect a provider with prepare-for-approval permission');
          const recipients = str(b.recipients,1000), subject = str(b.subject,200), message = str(b.body,12000);
          if (/[\r\n]/.test(recipients+subject) || !recipients.split(',').every(x=>/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(x.trim()))) fail(400,'Invalid email headers');
          interpreted.rule.action = { provider:b.provider,recipients,subject,body:message };
        }
        const data = { title, original_text, ...interpreted, missed_policy: b.missed_policy, expires: Date.now() + 5 * 60_000, session: sessionId };
        const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
        json({ ...data, session: undefined, preview_token: `${payload}.${sign(payload, secret)}` }); return;
      }
      if (path === '/api/schedules' && method === 'POST') {
        const [payload, signature] = str(b.preview_token, 6000).split('.');
        if (!signature || !equal(sign(payload, secret), signature)) fail(400, 'Invalid schedule preview');
        const preview = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (preview.session !== sessionId || preview.expires < Date.now() || preview.next_run <= Date.now()) fail(400, 'Preview expired; preview the schedule again');
        const target = b.id ? str(b.id, 64) : id();
        let savedId = target;
        transaction(db, () => {
          const used = db.prepare('SELECT schedule_id FROM consumed_previews WHERE token=?').get(signature);
          if (used) { savedId=used.schedule_id; return; }
          if (preview.rule.kind==='email_send') {
            const a=preview.rule.action, draft=id();
            db.prepare('INSERT INTO drafts VALUES(?,?,?,?,?,?)').run(draft,a.recipients,a.subject,a.body,'[]',Date.now());
            preview.rule.action = { provider:a.provider,draft_id:draft };
          }
          if (b.id) {
            if (!db.prepare('SELECT id FROM schedules WHERE id=?').get(target)) fail(404, 'Schedule not found');
            db.prepare("UPDATE jobs SET state='cancelled' WHERE schedule_id=? AND state='queued'").run(target);
            db.prepare("UPDATE schedules SET title=?,original_text=?,rule=?,timezone=?,next_run=?,status='active',missed_policy=? WHERE id=?").run(preview.title, preview.original_text, JSON.stringify(preview.rule), preview.timezone, preview.next_run, preview.missed_policy, target);
          } else db.prepare("INSERT INTO schedules VALUES(?,?,?,?,?,?,'active',?,?)").run(target, preview.title, preview.original_text, JSON.stringify(preview.rule), preview.timezone, preview.next_run, preview.missed_policy, Date.now());
          audit(db, b.id ? 'schedule.edited' : 'schedule.created', target);
          if (preview.rule.kind==='email_send') audit(db,'schedule.exact_email_authorized',target);
          db.prepare('INSERT INTO consumed_previews VALUES(?,?,?)').run(signature,target,Date.now());
        }); json({ id: savedId }, 201); return;
      }
      if (path === '/api/schedules' && method === 'GET') { json(db.prepare('SELECT * FROM schedules ORDER BY next_run').all()); return; }
      if (path.startsWith('/api/schedules/') && method === 'PATCH') {
        const target = path.split('/').at(-1); if (!['active', 'paused', 'cancelled'].includes(b.status)) fail(400, 'Invalid status');
        transaction(db, () => {
          if (!db.prepare('SELECT id FROM schedules WHERE id=?').get(target)) fail(404, 'Schedule not found');
          db.prepare('UPDATE schedules SET status=? WHERE id=?').run(b.status, target);
          if (b.status !== 'active') db.prepare("UPDATE jobs SET state='cancelled' WHERE schedule_id=? AND state='queued'").run(target);
          audit(db, `schedule.${b.status}`, target);
        }); json({ ok: true }); return;
      }
      if (path === '/api/jobs' && method === 'GET') { json(db.prepare('SELECT id,schedule_id,occurrence_at,kind,state,attempts,error,completed_at FROM jobs ORDER BY occurrence_at DESC LIMIT 100').all()); return; }
      if (path === '/api/inbox' && method === 'GET') {
        json({ proposals: db.prepare("SELECT * FROM proposals WHERE state='pending' ORDER BY created_at DESC LIMIT 100").all(), notifications: db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100').all(), approvals: db.prepare('SELECT a.id,a.state,a.job_id,j.kind,d.recipients,d.subject,d.body,d.attachments FROM approvals a JOIN drafts d ON d.id=a.draft_id JOIN jobs j ON j.id=a.job_id ORDER BY a.created_at DESC LIMIT 100').all(), uncertain: db.prepare("SELECT id,kind,state,error FROM jobs WHERE state='uncertain'").all() }); return;
      }
      if (path.startsWith('/api/proposals/') && method === 'POST') {
        const target = path.split('/').at(-1);
        if (!['confirm','reject'].includes(b.decision)) fail(400, 'Choose confirm or reject');
        transaction(db, () => {
          const proposal = db.prepare("SELECT * FROM proposals WHERE id=? AND state='pending'").get(target);
          if (!proposal) fail(409, 'Proposal missing or already decided');
          const p = JSON.parse(proposal.payload);
          if (b.decision === 'confirm') {
            if (p.next_run <= Date.now()) fail(400, 'Proposed time is past. Ask for a new preview.');
            db.prepare("INSERT INTO schedules VALUES(?,?,?,?,?,?,'active','catch_up',?)").run(id(),p.title,p.original_text,JSON.stringify(p.rule),p.timezone,p.next_run,Date.now());
          }
          db.prepare('UPDATE proposals SET state=? WHERE id=?').run(b.decision === 'confirm' ? 'confirmed' : 'rejected', target); audit(db, `proposal.${b.decision}`, target);
        }); json({ ok:true }); return;
      }
      if (path === '/api/calendar/prepare' && method === 'POST') {
        if (!['google', 'microsoft'].includes(b.provider)) fail(400, 'Choose a provider');
        if (db.prepare("SELECT permission FROM connections WHERE provider=? AND status='connected'").get(b.provider)?.permission !== 'prepare') fail(409, 'Connect with prepare-for-approval permission first');
        const event = { title: str(b.title, 200), start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString(), timezone: str(b.timezone || 'Asia/Manila', 100) };
        if (Date.parse(event.end) <= Date.parse(event.start)) fail(400, 'Event end must follow start');
        const now = Date.now(), draft = id(), job = id(), approval = id();
        transaction(db, () => {
          db.prepare('INSERT INTO drafts VALUES(?,?,?,?,?,?)').run(draft, '', event.title, JSON.stringify(event, null, 2), '[]', now);
          db.prepare("INSERT INTO jobs(id,occurrence_at,kind,payload,state,available_at) VALUES(?,?,?,?,'waiting_for_approval',?)").run(job, now, 'calendar_create', JSON.stringify({ draft_id: draft, provider: b.provider }), now);
          db.prepare("INSERT INTO approvals VALUES(?,?,?,'pending',?)").run(approval, draft, job, now); audit(db, 'calendar.prepared', draft);
        }); json({ id: approval }, 201); return;
      }
      if (/^\/api\/jobs\/[^/]+\/reconcile$/.test(path) && method === 'POST') {
        if (!['completed', 'failed'].includes(b.resolution)) fail(400, 'Confirm whether the provider performed the action');
        transaction(db, () => {
          const target = path.split('/')[3];
          const changed = db.prepare("UPDATE jobs SET state=?,error='Manually reconciled by owner',completed_at=? WHERE id=? AND state='uncertain'").run(b.resolution, Date.now(), target);
          if (!changed.changes) fail(409, 'Job is not uncertain'); audit(db, `job.reconciled.${b.resolution}`, target);
        }); json({ ok: true }); return;
      }
      if (path.startsWith('/api/notifications/') && method === 'PATCH') { db.prepare('UPDATE notifications SET read_at=? WHERE id=?').run(Date.now(), path.split('/').at(-1)); json({ ok: true }); return; }
      if (path === '/api/drafts' && method === 'POST') {
        const recipients = str(b.recipients, 1000), subject = str(b.subject, 200), message = str(b.body, 12000);
        if (/[\r\n]/.test(recipients) || /[\r\n]/.test(subject)) fail(400, 'Email headers cannot contain line breaks');
        if (!['google', 'microsoft'].includes(b.provider)) fail(400, 'Choose an email provider');
        const connection = db.prepare("SELECT * FROM connections WHERE provider=? AND status='connected'").get(b.provider);
        if (connection?.permission !== 'prepare') fail(409, 'Connect the provider with prepare-for-approval permission first');
        if (!recipients.split(',').every(x => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(x.trim()))) fail(400, 'Enter comma-separated email addresses');
        const now = Date.now(), draft = id(), job = id(), approval = id();
        transaction(db, () => {
          db.prepare('INSERT INTO drafts VALUES(?,?,?,?,?,?)').run(draft, recipients, subject, message, '[]', now);
          db.prepare("INSERT INTO jobs(id,occurrence_at,kind,payload,state,available_at) VALUES(?,?,?,?,'waiting_for_approval',?)").run(job, now, 'email_send', JSON.stringify({ draft_id: draft, provider: b.provider }), now);
          db.prepare("INSERT INTO approvals VALUES(?,?,?,'pending',?)").run(approval, draft, job, now); audit(db, 'draft.prepared', draft);
        }); json({ id: approval }, 201); return;
      }
      if (path.startsWith('/api/approvals/') && method === 'POST') {
        if (!['approved', 'rejected'].includes(b.decision)) fail(400, 'Invalid approval decision');
        transaction(db, () => {
          const approval = db.prepare("SELECT * FROM approvals WHERE id=? AND state='pending'").get(path.split('/').at(-1));
          if (!approval) fail(409, 'Approval already decided or missing');
          if (b.decision === 'approved' && Date.now()-approval.created_at>86400_000) fail(409,'Draft approval expired after 24 hours. Prepare a fresh draft.');
          db.prepare('UPDATE approvals SET state=? WHERE id=?').run(b.decision, approval.id);
          const job=db.prepare('SELECT payload FROM jobs WHERE id=?').get(approval.job_id);
          const payload={...JSON.parse(job.payload),expires_at:Date.now()+15*60_000};
          db.prepare("UPDATE jobs SET state=?,available_at=?,payload=? WHERE id=? AND state='waiting_for_approval'").run(b.decision === 'approved' ? 'queued' : 'cancelled', Date.now(), JSON.stringify(payload), approval.job_id);
          audit(db, `draft.${b.decision}`, approval.draft_id);
        }); json({ ok: true }); return;
      }
      if(path==='/api/services' && method==='GET'){json(externalStatus(db,encryptionKey));return;}
      if(/^\/api\/services\/(github|notion|discord)$/.test(path)){const provider=path.split('/').at(-1);if(method==='POST'){json(saveExternal(db,encryptionKey,provider,b));return;}if(method==='DELETE'){json(removeExternal(db,provider));return;}}
      if(/^\/api\/services\/(github|notion|discord)\/read$/.test(path) && method==='POST'){json(await readExternal(db,encryptionKey,path.split('/')[3],b));return;}
      if(path==='/api/services/discord/send' && method==='POST'){json(await sendDiscord(db,encryptionKey,b));return;}
      if(path==='/api/model' && method==='GET'){json(modelSettings(db,encryptionKey));return;}
      if(path==='/api/model' && method==='POST'){json(switchModel(db,encryptionKey,b));return;}
      if (path === '/api/connections' && method === 'GET') {
        json(['google', 'microsoft', 'weather', 'model'].map(provider => {
          const config = getSecret(db, `config:${provider}`, encryptionKey);
          return { provider, permission: 'read', status: 'not_connected', ...(db.prepare('SELECT provider,permission,status,updated_at FROM connections WHERE provider=?').get(provider)), configured: Boolean(config), callback: `${origin}/assistant/api/oauth/${provider}/callback`, model: provider === 'model' ? config?.model : undefined, model_provider: provider === 'model' ? config?.provider : undefined };
        })); return;
      }
      if (path === '/api/connections/cli' && method === 'GET') { json(await cliInventory()); return; }
      if (path === '/api/connections' && method === 'POST') {
        if (!['google', 'microsoft', 'model', 'weather'].includes(b.provider)) fail(400, 'Unknown provider');
        let config;
        if (['google', 'microsoft'].includes(b.provider)) config = { client_id: str(b.client_id, 500), client_secret: str(b.client_secret, 2000), tenant: str(b.tenant || 'common', 200) };
        if (b.provider === 'model') {
          switchModel(db,encryptionKey,{provider:b.model_provider,model:String(b.model || ''),api_key:b.api_key});
          json({ok:true});return;
        }
        if (b.provider === 'weather') {
          if (b.accept_terms !== true) fail(400, 'Confirm eligible personal use and Open-Meteo terms');
          config = { latitude: Number(b.latitude), longitude: Number(b.longitude), name: str(b.name, 100) };
          if (!Number.isFinite(config.latitude) || !Number.isFinite(config.longitude) || Math.abs(config.latitude)>90 || Math.abs(config.longitude)>180) fail(400, 'Invalid coordinates');
        }
        transaction(db, () => {
          setSecret(db, `config:${b.provider}`, config, encryptionKey);
          db.prepare("INSERT INTO connections VALUES(?,'read',?,NULL,?) ON CONFLICT(provider) DO UPDATE SET status=excluded.status,token_cipher=NULL,updated_at=excluded.updated_at").run(b.provider, ['model', 'weather'].includes(b.provider) ? 'configured' : 'not_connected', Date.now());
          audit(db, 'connection.configured', b.provider);
        }); json({ ok: true }); return;
      }
      if (/^\/api\/connections\/(google|microsoft)\/authorize$/.test(path) && method === 'POST') { json({ url: beginOAuth(db, path.split('/')[3], b.permission, sessionId, origin, encryptionKey) }); return; }
      if (/^\/api\/connections\/(google|microsoft|model|weather)$/.test(path) && method === 'DELETE') {
        const provider = path.split('/').at(-1);
        transaction(db, () => { db.prepare('DELETE FROM connections WHERE provider=?').run(provider); db.prepare('DELETE FROM secrets WHERE key=?').run(`config:${provider}`); if(provider==='model')db.prepare("DELETE FROM secrets WHERE key LIKE 'config:model:%'").run(); audit(db, 'connection.disconnected', provider); }); json({ ok: true }); return;
      }
      if (path === '/api/email' && method === 'GET') { json(await readEmail(db, url.searchParams.get('provider'), encryptionKey, url.searchParams.get('q') || '')); return; }
      if (path === '/api/calendar' && method === 'GET') { json(await readCalendar(db, url.searchParams.get('provider'), encryptionKey)); return; }
      if (path === '/api/today' && method === 'GET') {
        const connections = db.prepare("SELECT provider FROM connections WHERE status='connected' AND provider IN ('google','microsoft')").all();
        const safe = async fn => { try { return { data: await fn() }; } catch (e) { return { error: e.status ? e.message : 'Provider unavailable' }; } };
        const results = await Promise.all(connections.map(async ({provider}) => ({ provider, email: await safe(() => readEmail(db, provider, encryptionKey)), calendar: await safe(() => readCalendar(db, provider, encryptionKey)) })));
        json({ weather: await safe(() => weather(db, getSecret(db, 'config:weather', encryptionKey))), connections: results, reminders: db.prepare("SELECT * FROM schedules WHERE status='active' ORDER BY next_run LIMIT 10").all() }); return;
      }
      if (path === '/api/devices' && method === 'GET') {
        json(db.prepare('SELECT d.id,d.name,d.capabilities,d.last_seen,d.revoked_at,s.expires_at FROM devices d LEFT JOIN sessions s ON s.id=d.session_id ORDER BY d.last_seen DESC').all().map(d => ({ ...d, current: db.prepare('SELECT session_id FROM devices WHERE id=?').get(d.id).session_id === sessionId, connection_state: d.revoked_at || !d.expires_at || d.expires_at < Date.now() ? 'revoked' : Date.now() - d.last_seen < 120_000 ? 'recently_seen' : 'offline' }))); return;
      }
      if (path.startsWith('/api/devices/') && method === 'DELETE') {
        transaction(db, () => {
          const target = db.prepare('SELECT * FROM devices WHERE id=?').get(path.split('/').at(-1));
          if (!target) fail(404, 'Device not found');
          // Detach before deleting the session so the revoked device remains visible in history.
          db.prepare('UPDATE devices SET session_id=NULL,revoked_at=? WHERE id=?').run(Date.now(), target.id);
          if (target.session_id) db.prepare('DELETE FROM sessions WHERE id=?').run(target.session_id);
          audit(db, 'device.revoked', target.id);
        }); json({ ok: true }); return;
      }
      if (path === '/api/settings' && method === 'GET') { json(Object.fromEntries(db.prepare('SELECT * FROM settings').all().map(x => [x.key, x.value]))); return; }
      if (path === '/api/settings' && method === 'POST') {
        if (!['home_location', 'notification_fallback'].includes(b.key)) fail(400, 'Unknown setting');
        const value = str(b.value, 200); db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(b.key, value); json({ ok: true }); return;
      }
      if (path === '/api/audit' && method === 'GET') { json(db.prepare('SELECT * FROM audit ORDER BY created_at DESC LIMIT 100').all()); return; }
      fail(404, 'Not found');
    } catch (error) { json({ error: error.status ? error.message : 'Internal error; private details omitted' }, error.status || 500); }
  });
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDb(), server = createApp({ db });
  const port = Number(process.env.PORT || 3210);
  server.listen(port, '127.0.0.1', () => console.log(`Jarvis API bound to 127.0.0.1:${port}. Run the worker separately.`));
  const servers=[server];
  if(process.env.LAN_ORIGIN){
    const origin=new URL(process.env.LAN_ORIGIN);
    if(origin.protocol!=='https:'||!process.env.LAN_TLS_KEY||!process.env.LAN_TLS_CERT)throw new Error('LAN access requires HTTPS and separate TLS key/certificate paths');
    const lanApp=createApp({db,origin:origin.origin});
    const lan=createSecureServer({key:readFileSync(process.env.LAN_TLS_KEY),cert:readFileSync(process.env.LAN_TLS_CERT)},lanApp.listeners('request')[0]);
    lan.listen(Number(origin.port||443),origin.hostname,()=>console.log(`Jarvis LAN HTTPS bound to ${origin.hostname}:${origin.port||443}`));servers.push(lan);
  }
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {await Promise.all(servers.map(s=>new Promise(resolve=>s.close(resolve))));db.close();process.exit(0);});
}
