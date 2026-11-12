import {modelCommand} from './model-settings.js';
import { relevantMemories, recordActivity } from './memory-graph.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { id, audit } from './db.js';
import { getSecret, setSecret, modelReply } from './integrations.js';

export const TELEGRAM_VOICES=['en-US-AndrewMultilingualNeural','en-GB-RyanNeural','en-US-AvaMultilingualNeural','fil-PH-AngeloNeural','fil-PH-BlessicaNeural'];
export function telegramSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_outbox(id TEXT PRIMARY KEY,kind TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,error TEXT,completed_at INTEGER);
    CREATE TABLE IF NOT EXISTS telegram_seen(account TEXT NOT NULL,message_id INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(account,message_id));`);
}
export function telegramStatus(db,key) {
  telegramSchema(db);const config=getSecret(db,'config:telegram',key);
  const health=db.prepare("SELECT value FROM settings WHERE key='telegram:health'").get()?.value;
  return {voice:config?.voice || TELEGRAM_VOICES[0],voice_choices:TELEGRAM_VOICES,voice_error:JSON.parse(db.prepare("SELECT value FROM settings WHERE key='telegram:voice:last_error'").get()?.value || '{}'),voice_health:JSON.parse(db.prepare("SELECT value FROM settings WHERE key='telegram:voice'").get()?.value || '{}'),conversation_enabled:!!config?.conversation_enabled,conversation_ready:!!process.env.TELEGRAM_STT_MODEL,api_id:config?.api_id || null,has_api_hash:!!config?.api_hash,app_file:!!appCredentialsFile(),account_id:config?.account_id || null,checklist:telegramChecklist(config),configured:!!config?.session,enabled:!!config?.enabled,calls_enabled:!!config?.calls_enabled,notifications:!!config?.notifications,owner_id:config?.owner_id || null,health:health?JSON.parse(health):{state:'not_connected'},outbox:db.prepare('SELECT id,kind,state,created_at,error,completed_at FROM telegram_outbox ORDER BY created_at DESC LIMIT 20').all()};
}
export function configureTelegram(db,key,input) {
  const previous=getSecret(db,'config:telegram',key) || {};
  for(const flag of ['enabled','calls_enabled','notifications','conversation_enabled'])if(input[flag]!==undefined && typeof input[flag]!=='boolean')throw new Error('Telegram flags must be boolean');
  const config={...previous,...Object.fromEntries(['enabled','calls_enabled','notifications','conversation_enabled'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]]))};
  if(input.voice!==undefined){if(!TELEGRAM_VOICES.includes(input.voice))throw new Error('Choose a supported neural voice');config.voice=input.voice;}
  const replacing = ['api_id','api_hash','session','owner_id'].some(k=>input[k]!==undefined && input[k]!=='');
  if (replacing) {
    const apiId = input.api_id === '' || input.api_id === undefined ? previous.api_id : Number(input.api_id);
    const ownerId = input.owner_id === '' || input.owner_id === undefined ? previous.owner_id : Number(input.owner_id);
    const hash = input.api_hash || previous.api_hash;
    const session = input.session || previous.session || null;
    if (!Number.isSafeInteger(apiId) || apiId <= 0) throw new Error('Enter a valid Telegram API ID');
    if (ownerId !== undefined && ownerId !== null && (!Number.isSafeInteger(ownerId) || ownerId <= 0)) throw new Error('Enter your positive numeric Telegram owner ID');
    if (typeof hash !== 'string' || !/^[a-f0-9]{32}$/i.test(hash)) throw new Error('API hash must be 32 hexadecimal characters');
    if (session !== null && (typeof session !== 'string' || !/^1[A-Za-z0-9_=-]{100,2048}$/.test(session))) throw new Error('Enter an authorized Telethon StringSession; API credentials alone cannot log in');
    telegramSchema(db);
    db.prepare("UPDATE telegram_outbox SET state='cancelled',error='Telegram credentials changed' WHERE state='queued'").run();
    Object.assign(config,{api_id:apiId,api_hash:hash,session,owner_id:ownerId ?? null,enabled:false,calls_enabled:false,notifications:false,conversation_enabled:false});
    if (input.session) delete config.account_id; // a pasted session's account is unknown until it connects
  }
  const enabling=['enabled','calls_enabled','notifications','conversation_enabled'].some(k=>config[k]===true);
  if(!config.session && (enabling || !replacing))throw new Error('Authorize the userbot first: log in below or run npm run telegram:setup on the server');
  if(enabling && !config.owner_id)throw new Error('Add your numeric Telegram owner ID before enabling delivery');
  if(config.conversation_enabled && (!config.calls_enabled || !process.env.TELEGRAM_STT_MODEL))throw new Error('Enable calls and install the local speech model before conversational calls');
  if(config.conversation_enabled && config.account_id===config.owner_id)throw new Error('Conversational calls require a separate userbot account');
  setSecret(db,'config:telegram',config,key);audit(db,'telegram.settings_changed');return {ok:true};
}
export function queueTelegram(db,key,input) {
  telegramSchema(db);const config=getSecret(db,'config:telegram',key);
  if(!config?.enabled)throw new Error('Enable the authorized Telegram connection first');
  if(!['message','call'].includes(input.kind))throw new Error('Choose message or call');
  if(input.kind==='call' && !config.calls_enabled)throw new Error('Enable outbound calls first');
  if(typeof input.text!=='string' || !input.text.trim() || input.text.length>(input.kind==='call'?800:3800))throw new Error('Enter a message within the displayed length limit');
  const requestId=input.request_id || id();if(!/^[\w-]{8,100}$/.test(requestId))throw new Error('Invalid request ID');
  db.prepare("INSERT OR IGNORE INTO telegram_outbox VALUES(?,?,?,'queued',?,NULL,NULL)").run(requestId,input.kind,input.text.trim(),Date.now());
  audit(db,'telegram.action_queued',requestId);return {ok:true,id:requestId};
}
export class TelegramBridge {
  constructor(config,{python=process.env.TELEGRAM_PYTHON || 'python3',onVoiceTurn,onVoiceState}={}) {
    this.pending=new Map();this.closed=false;
    this.ready=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});
    this.child=spawn(python,[fileURLToPath(new URL('../telegram/userbot.py',import.meta.url))],{stdio:['pipe','pipe','ignore'],env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',...(process.env.TELEGRAM_STT_MODEL?{TELEGRAM_STT_MODEL:process.env.TELEGRAM_STT_MODEL}:{})}});
    this.child.stdin.on('error',()=>{});this.child.once('error',()=>this.fail());this.child.once('exit',()=>this.fail());
    const lines=createInterface({input:this.child.stdout});lines.on('line',line=>{
      let result;try{result=JSON.parse(line);}catch{return;}
      if(result.event==='voice_state'){if(['connecting','listening','thinking','speaking','closed','error','speech_unavailable'].includes(result.state))onVoiceState?.(result.state,{stage:typeof result.stage==='string'?result.stage.slice(0,30):undefined,error:typeof result.error==='string'?result.error.slice(0,60):undefined});return;}
      if(result.event==='voice_turn'){
        if(!onVoiceTurn || typeof result.turn_id!=='string' || typeof result.text!=='string' || result.text.length>2000)return;
        Promise.resolve().then(()=>onVoiceTurn(result.text)).catch(()=> 'I could not prepare a reply. Please check the model connection in Conclave.').then(text=>{if(!this.closed)return this.request('voice_answer',{turn_id:result.turn_id,text:String(text).slice(0,2400)});}).catch(()=>{});return;
      }
      if(result.ready){this.readyResolve(result);return;}if(result.fatal){this.fail();return;}
      const waiter=this.pending.get(result.id);if(!waiter)return;clearTimeout(waiter.timer);this.pending.delete(result.id);
      result.error?waiter.reject(new Error('Telegram operation failed: '+result.error)):waiter.resolve(result.result);
    });
    this.child.stdin.write(JSON.stringify(config)+'\n');
    this.startupTimer=setTimeout(()=>this.fail(),30000);this.ready.then(()=>clearTimeout(this.startupTimer),()=>clearTimeout(this.startupTimer));
  }
  fail(){if(this.closed)return;this.closed=true;this.readyReject(new Error('Telegram bridge unavailable; check account authorization and installed dependencies'));for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Telegram connection interrupted; reconcile before retrying'));}this.pending.clear();this.child.kill();}
  async request(op,payload={}) {
    await this.ready;if(this.closed)throw new Error('Telegram connection closed');const requestId=id();
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(requestId);reject(new Error('Telegram outcome is uncertain; inspect Telegram before retrying'));},op==='call'?300000:35000);this.pending.set(requestId,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id:requestId,op,...payload})+'\n');});
  }
  close(){this.fail();}
}
export class TelegramWorker {
  constructor(db,key,{bridgeFactory=config=>new TelegramBridge(config,{onVoiceTurn:text=>this.voiceReply(text),onVoiceState:(state,detail)=>this.voiceState(state,detail)}),reply=modelReply,instructions=()=>''}={}){this.db=db;this.key=key;this.bridgeFactory=bridgeFactory;this.reply=reply;this.instructions=instructions;this.active=new Set();this.lastPoll=0;telegramSchema(db);db.prepare("UPDATE telegram_outbox SET state='uncertain',error='Worker restarted during delivery' WHERE state='running'").run();}
  voiceState(state,detail={}){
    const value=JSON.stringify({state,...detail,at:Date.now()});
    this.db.prepare("INSERT INTO settings VALUES('telegram:voice',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value);
    if(detail.error)this.db.prepare("INSERT INTO settings VALUES('telegram:voice:last_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value);
  }
  async voiceReply(text){
    const config=getSecret(this.db,'config:telegram',this.key);if(!config?.enabled || !config?.conversation_enabled || !config?.calls_enabled)throw new Error('Voice conversation disabled');
    let conversation=this.db.prepare("SELECT id FROM conversations WHERE title='Jarvis' ORDER BY created_at LIMIT 1").get();
    if(!conversation){conversation={id:id()};this.db.prepare('INSERT INTO conversations VALUES(?,?,?)').run(conversation.id,'Jarvis',Date.now());}
    this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(id(),conversation.id,'user',text,'telegram-voice-owner',Date.now());
    const hits=relevantMemories(this.db,text);recordActivity(this.db,hits,'chat');
    const answer=await this.reply(this.db,this.key,conversation.id,hits.map(h=>h.id),this.instructions()+'\nYou are speaking on a phone call. Reply briefly in plain spoken language. Ask for confirmation of uncertain transcriptions before consequential actions.');
    this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(id(),conversation.id,'assistant',answer,'telegram-voice-model',Date.now());
    return answer;
  }
  health(state){if(this.healthState===state)return;this.healthState=state;this.db.prepare("INSERT INTO settings VALUES('telegram:health',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({state,at:Date.now()}));}
  async tick() {
    const db=this.db,config=getSecret(db,'config:telegram',this.key);
    const fingerprint=config?createHash('sha256').update(JSON.stringify(config)).digest('hex'):'';
    if(fingerprint!==this.fingerprint){this.bridge?.close();this.bridge=null;this.fingerprint=fingerprint;this.lastPoll=0;this.retryAt=0;}
    if(!config?.enabled){this.health(config?.session?'disabled':'not_configured');return;}
    if(!this.bridge && Date.now()<(this.retryAt || 0))return;
    try {
      if(!this.bridge){this.bridge=this.bridgeFactory(config);await this.bridge.ready;this.health('connected');}
      for(const job of db.prepare("SELECT * FROM telegram_outbox WHERE state='queued' ORDER BY created_at LIMIT 5").all()){
        if(this.active.has(job.kind))continue;const claimed=db.prepare("UPDATE telegram_outbox SET state='running' WHERE id=? AND state='queued'").run(job.id);if(!claimed.changes)continue;
        this.active.add(job.kind);const bridge=this.bridge;
        bridge.request(job.kind==='call'?'call':'send',{text:job.text}).then(()=>db.prepare("UPDATE telegram_outbox SET state='completed',completed_at=? WHERE id=?").run(Date.now(),job.id),()=>db.prepare("UPDATE telegram_outbox SET state='uncertain',error='Check Telegram before retrying',completed_at=? WHERE id=?").run(Date.now(),job.id)).finally(()=>this.active.delete(job.kind));
      }
      if(Date.now()-this.lastPoll<15000)return;this.lastPoll=Date.now();
      const account=createHash('sha256').update(config.session+config.owner_id).digest('hex'),cursorKey='telegram:cursor:'+account;
      let cursor=db.prepare('SELECT value FROM settings WHERE key=?').get(cursorKey)?.value;
      const page=await this.bridge.request('poll',{after:Number(cursor || 0)});
      // First connection establishes a watermark; old inbox content never triggers work.
      if(cursor!==undefined){for(const message of page.messages){
        const taken=db.prepare("INSERT OR IGNORE INTO telegram_seen VALUES(?,?,'processing')").run(account,message.id);if(!taken.changes)continue;
        try {
          if(message.text.startsWith('/call ')){queueTelegram(db,this.key,{kind:'call',text:message.text.slice(6),request_id:'incoming-call-'+account.slice(0,12)+'-'+message.id});}
          else {
            const existing=db.prepare("SELECT id FROM conversations WHERE title='Jarvis' ORDER BY created_at LIMIT 1").get();
            const conversationId=existing?.id || id();db.prepare('INSERT OR IGNORE INTO conversations VALUES(?,?,?)').run(conversationId,'Jarvis',Date.now());
            db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(id(),conversationId,'user',message.text,'telegram-owner',Date.now());
            const answer=modelCommand(db,this.key,message.text) || await this.reply(db,this.key,conversationId,[],this.instructions());
            db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(id(),conversationId,'assistant',answer,'model',Date.now());
            queueTelegram(db,this.key,{kind:'message',text:answer.slice(0,3800),request_id:'reply-'+account.slice(0,12)+'-'+message.id});
          }
          db.prepare("UPDATE telegram_seen SET state='completed' WHERE account=? AND message_id=?").run(account,message.id);
        }catch{
          try{queueTelegram(db,this.key,{kind:'message',text:'I could not prepare a reply. Use /model to check or change the model, or check Connectors in Conclave.',request_id:'error-'+account.slice(0,12)+'-'+message.id});}catch{}
          db.prepare("UPDATE telegram_seen SET state='failed' WHERE account=? AND message_id=?").run(account,message.id);audit(db,'telegram.inbound_failed');}
      }}
      db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(cursorKey,String(page.latest));
      if(config.notifications){const watermarkKey='telegram:notifications:'+account;const watermark=db.prepare('SELECT value FROM settings WHERE key=?').get(watermarkKey)?.value;
        if(watermark){for(const n of db.prepare('SELECT * FROM notifications WHERE created_at>? ORDER BY created_at LIMIT 30').all(Number(watermark)))queueTelegram(db,this.key,{kind:'message',text:(n.title+'\n'+n.body).slice(0,3800),request_id:'notification-'+n.id});}
        db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(watermarkKey,String(Date.now()));
      }
    }catch{this.health('connection_error');this.bridge?.close();this.bridge=null;this.retryAt=Date.now()+60000;}
  }
  close(){this.bridge?.close();}
}

// ---------- Browser login (phone -> code -> optional 2FA password) ----------
// The phone number, login code and password are passed to the Python bridge over stdin only. They are
// never stored, logged or audited. Only the resulting StringSession is saved, encrypted, via setSecret.

export function appCredentialsFile(file = process.env.CONCLAVE_TELEGRAM_APP_FILE || join(homedir(), '.config/conclave/telegram-app.json')) {
  try {
    if (statSync(file).mode & 0o077) return null; // must be private to the owner
    const app = JSON.parse(readFileSync(file, 'utf8'));
    const apiId = Number(app.api_id);
    return Number.isSafeInteger(apiId) && apiId > 0 && /^[a-f0-9]{32}$/i.test(app.api_hash || '') ? { api_id: apiId, api_hash: app.api_hash } : null;
  } catch { return null; }
}

export function telegramChecklist(config, app = appCredentialsFile()) {
  const ownerId = config?.owner_id || null, accountId = config?.account_id || null;
  return [
    { id: 'app', label: 'Telegram API ID and hash', done: !!(config?.api_id && config?.api_hash) || !!app, hint: 'From my.telegram.org → API development tools.' },
    { id: 'owner', label: 'Your numeric Telegram user ID', done: !!ownerId, hint: 'Message @userinfobot on Telegram to get it.' },
    { id: 'session', label: 'Logged-in userbot session', done: !!config?.session, hint: 'Use “Log in the userbot” below (or npm run telegram:setup on the server).' },
    { id: 'separate', label: 'Separate userbot account for calls', done: !!(accountId && ownerId && accountId !== ownerId), optional: true,
      hint: accountId && ownerId && accountId === ownerId ? 'The userbot is your own account: chat works via Saved Messages, but it cannot call you.' : 'Calls need a second Telegram account (another phone number) logged in as the userbot.' },
    { id: 'enabled', label: 'Delivery enabled', done: !!config?.enabled, hint: 'Turn on chat, calls or notifications below.' },
  ];
}

const LOGIN_TTL_MS = 10 * 60e3, START_LIMIT = 5, START_WINDOW_MS = 60 * 60e3, STEP_LIMIT = 8;
export class TelegramLogin {
  constructor(db, key, { spawnBridge = defaultLoginBridge, now = () => Date.now(), app = () => appCredentialsFile() } = {}) {
    this.db = db; this.key = key; this.spawnBridge = spawnBridge; this.now = now; this.app = app; this.starts = []; this.active = null;
  }
  status() { const a = this.active; return a && !this.expired() ? { login_id: a.id, step: a.step, expires_at: a.expires } : null; }
  expired() { if (this.active && this.now() > this.active.expires) { this.cancel('expired'); return true; } return !this.active; }
  cancel(reason = 'cancelled') { const a = this.active; if (!a) return { ok: true }; this.active = null; a.bridge.close(); if (reason !== 'completed') audit(this.db, 'telegram.login_' + reason); return { ok: true }; }

  async start(input = {}) {
    const now = this.now();
    this.starts = this.starts.filter(t => now - t < START_WINDOW_MS);
    if (this.starts.length >= START_LIMIT) throw Object.assign(new Error('Too many login attempts. Try again in an hour.'), { status: 429 });
    const phone = String(input.phone || '').replace(/[\s()-]/g, '');
    if (!/^\+?[1-9]\d{6,15}$/.test(phone)) throw Object.assign(new Error('Enter the userbot phone number in international format, e.g. +639171234567'), { status: 400 });
    const previous = getSecret(this.db, 'config:telegram', this.key) || {};
    const fileApp = this.app();
    const apiId = input.api_id ? Number(input.api_id) : previous.api_id || fileApp?.api_id;
    const apiHash = input.api_hash || previous.api_hash || fileApp?.api_hash;
    if (!Number.isSafeInteger(apiId) || apiId <= 0 || typeof apiHash !== 'string' || !/^[a-f0-9]{32}$/i.test(apiHash)) throw Object.assign(new Error('Enter the Telegram API ID and 32-character API hash first'), { status: 400 });
    let ownerId = previous.owner_id || null;
    if (input.owner_id !== undefined && input.owner_id !== '') { ownerId = Number(input.owner_id); if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw Object.assign(new Error('Enter your positive numeric Telegram owner ID'), { status: 400 }); }
    this.cancel('replaced');
    this.starts.push(now);
    const bridge = this.spawnBridge();
    const a = this.active = { id: id(), bridge, step: 'starting', steps: 0, expires: now + LOGIN_TTL_MS, apiId, apiHash, ownerId };
    audit(this.db, 'telegram.login_started');
    bridge.send({ api_id: apiId, api_hash: apiHash, phone });
    return this.advance(a);
  }
  async code(input = {}) { return this.answer(input, 'code', /^\d{4,8}$/, 'Enter the numeric login code Telegram sent'); }
  async password(input = {}) { return this.answer(input, 'password', /^[\s\S]{1,256}$/, 'Enter the two-step verification password'); }
  async answer(input, kind, pattern, message) {
    const a = this.active;
    if (this.expired() || !a || a.id !== input.login_id) throw Object.assign(new Error('This login has expired. Start again.'), { status: 409 });
    if (a.step !== kind) throw Object.assign(new Error(`Telegram is waiting for the ${a.step}`), { status: 409 });
    const value = String(input[kind] ?? '').trim();
    if (!pattern.test(kind === 'password' ? String(input[kind] ?? '') : value)) throw Object.assign(new Error(message), { status: 400 });
    if (++a.steps > STEP_LIMIT) { this.cancel('failed'); throw Object.assign(new Error('Too many attempts. Start the login again.'), { status: 429 }); }
    a.step = 'waiting';
    a.bridge.send(kind === 'password' ? { password: String(input.password) } : { code: value });
    return this.advance(a);
  }
  async advance(a) {
    let msg;
    try { msg = await a.bridge.next(); }
    catch { if (this.active === a) this.cancel('failed'); throw Object.assign(new Error('Telegram login bridge stopped. Check the server Telegram environment and try again.'), { status: 502 }); }
    if (this.active !== a) throw Object.assign(new Error('This login was cancelled'), { status: 409 });
    if (msg.step === 'code' || msg.step === 'password') {
      a.step = msg.step;
      return { login_id: a.id, step: msg.step, ...(msg.error ? { error: friendlyLoginError(msg.error) } : {}) };
    }
    if (msg.step === 'done' && typeof msg.session === 'string' && /^1[A-Za-z0-9_=-]{100,2048}$/.test(msg.session)) {
      const previous = getSecret(this.db, 'config:telegram', this.key) || {};
      telegramSchema(this.db);
      this.db.prepare("UPDATE telegram_outbox SET state='cancelled',error='Telegram credentials changed' WHERE state='queued'").run();
      const accountId = Number(msg.account_id) || null;
      setSecret(this.db, 'config:telegram', { ...previous, api_id: a.apiId, api_hash: a.apiHash, owner_id: a.ownerId, session: msg.session, account_id: accountId, enabled: false, calls_enabled: false, notifications: false, conversation_enabled: false }, this.key);
      this.active = null; a.bridge.close(); audit(this.db, 'telegram.login_completed');
      return { step: 'done', account_id: accountId, same_as_owner: !!(accountId && a.ownerId && accountId === a.ownerId) };
    }
    const error = friendlyLoginError(msg.error || msg.fatal || 'LoginFailed');
    if (this.active === a) this.cancel('failed');
    throw Object.assign(new Error(error), { status: 400 });
  }
}

function friendlyLoginError(code) {
  return ({
    PhoneNumberInvalidError: 'Telegram rejected that phone number.', PhoneNumberBannedError: 'That phone number is banned by Telegram.',
    PhoneNumberFloodError: 'Telegram is limiting login attempts for this number. Try later.', FloodWaitError: 'Telegram asked us to wait before trying again. Try later.',
    ApiIdInvalidError: 'The Telegram API ID or hash is invalid.', PhoneCodeInvalidError: 'That code is not correct. Check Telegram and try again.',
    PhoneCodeExpiredError: 'That code expired. Start the login again.', PasswordHashInvalidError: 'That two-step password is not correct.',
    TooManyAttempts: 'Too many incorrect attempts. Start the login again.', LoginCancelled: 'Login cancelled.',
  })[code] || 'Telegram login failed. Start again.';
}

// Spawns `userbot.py --login`; credentials go over stdin only. stderr is discarded.
export function defaultLoginBridge({ python = process.env.TELEGRAM_PYTHON || 'python3' } = {}) {
  const child = spawn(python, [fileURLToPath(new URL('../telegram/userbot.py', import.meta.url)), '--login'], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' } });
  const queue = [], waiters = []; let closed = false;
  const push = v => { const w = waiters.shift(); w ? (clearTimeout(w.t), v instanceof Error ? w.reject(v) : w.resolve(v)) : queue.push(v); };
  createInterface({ input: child.stdout }).on('line', line => { try { push(JSON.parse(line)); } catch {} });
  const end = () => { if (closed) return; closed = true; while (waiters.length) { const w = waiters.shift(); clearTimeout(w.t); w.reject(new Error('closed')); } };
  child.once('exit', end); child.once('error', end); child.stdin.on('error', () => {});
  return {
    send: obj => { if (!closed) child.stdin.write(JSON.stringify(obj) + '\n'); },
    next: () => queue.length ? Promise.resolve(queue.shift()).then(v => v instanceof Error ? Promise.reject(v) : v) : closed ? Promise.reject(new Error('closed')) : new Promise((resolve, reject) => { const w = { resolve, reject, t: setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(new Error('timeout')); }, 90000) }; waiters.push(w); }),
    close: () => { end(); try { child.stdin.end(); } catch {} child.kill(); },
  };
}
