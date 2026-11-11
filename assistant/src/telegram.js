import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { id, audit } from './db.js';
import { getSecret, setSecret, modelReply } from './integrations.js';

export function telegramSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_outbox(id TEXT PRIMARY KEY,kind TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,error TEXT,completed_at INTEGER);
    CREATE TABLE IF NOT EXISTS telegram_seen(account TEXT NOT NULL,message_id INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(account,message_id));`);
}
export function telegramStatus(db,key) {
  telegramSchema(db);const config=getSecret(db,'config:telegram',key);
  const health=db.prepare("SELECT value FROM settings WHERE key='telegram:health'").get()?.value;
  return {api_id:config?.api_id || null,configured:!!config?.session,enabled:!!config?.enabled,calls_enabled:!!config?.calls_enabled,notifications:!!config?.notifications,owner_id:config?.owner_id || null,health:health?JSON.parse(health):{state:'not_connected'},outbox:db.prepare('SELECT id,kind,state,created_at,error,completed_at FROM telegram_outbox ORDER BY created_at DESC LIMIT 20').all()};
}
export function configureTelegram(db,key,input) {
  const previous=getSecret(db,'config:telegram',key) || {};
  for(const flag of ['enabled','calls_enabled','notifications'])if(input[flag]!==undefined && typeof input[flag]!=='boolean')throw new Error('Telegram flags must be boolean');
  const config={...previous,...Object.fromEntries(['enabled','calls_enabled','notifications'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]]))};
  const replacing = ['api_id','api_hash','session','owner_id'].some(k=>input[k]!==undefined && input[k]!=='');
  if (replacing) {
    const apiId = input.api_id === '' || input.api_id === undefined ? previous.api_id : Number(input.api_id);
    const ownerId = input.owner_id === '' || input.owner_id === undefined ? previous.owner_id : Number(input.owner_id);
    const hash = input.api_hash || previous.api_hash;
    const session = input.session || previous.session;
    if (!Number.isSafeInteger(apiId) || apiId <= 0) throw new Error('Enter a valid Telegram API ID');
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error('Enter your positive numeric Telegram owner ID');
    if (typeof hash !== 'string' || !/^[a-f0-9]{32}$/i.test(hash)) throw new Error('API hash must be 32 hexadecimal characters');
    if (typeof session !== 'string' || !/^1[A-Za-z0-9_=-]{100,2048}$/.test(session)) throw new Error('Enter an authorized Telethon StringSession; API credentials alone cannot log in');
    telegramSchema(db);
    db.prepare("UPDATE telegram_outbox SET state='cancelled',error='Telegram credentials changed' WHERE state='queued'").run();
    Object.assign(config,{api_id:apiId,api_hash:hash,session,owner_id:ownerId,enabled:false,calls_enabled:false,notifications:false});
  }
  if(!config.session)throw new Error('Authorize the userbot privately with npm run telegram:setup first');
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
  constructor(config,{python=process.env.TELEGRAM_PYTHON || 'python3'}={}) {
    this.pending=new Map();this.closed=false;
    this.ready=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});
    this.child=spawn(python,[fileURLToPath(new URL('../telegram/userbot.py',import.meta.url))],{stdio:['pipe','pipe','ignore'],env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8'}});
    this.child.stdin.on('error',()=>{});this.child.once('error',()=>this.fail());this.child.once('exit',()=>this.fail());
    const lines=createInterface({input:this.child.stdout});lines.on('line',line=>{
      let result;try{result=JSON.parse(line);}catch{return;}
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
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(requestId);reject(new Error('Telegram outcome is uncertain; inspect Telegram before retrying'));},op==='call'?150000:35000);this.pending.set(requestId,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id:requestId,op,...payload})+'\n');});
  }
  close(){this.fail();}
}
export class TelegramWorker {
  constructor(db,key,{bridgeFactory=config=>new TelegramBridge(config),reply=modelReply,instructions=()=>''}={}){this.db=db;this.key=key;this.bridgeFactory=bridgeFactory;this.reply=reply;this.instructions=instructions;this.active=new Set();this.lastPoll=0;telegramSchema(db);db.prepare("UPDATE telegram_outbox SET state='uncertain',error='Worker restarted during delivery' WHERE state='running'").run();}
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
            const conversationId='telegram-'+account.slice(0,32);db.prepare('INSERT OR IGNORE INTO conversations VALUES(?,?,?)').run(conversationId,'Telegram owner chat',Date.now());
            db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(id(),conversationId,'user',message.text,'telegram-owner',Date.now());
            const answer=await this.reply(db,this.key,conversationId,[],this.instructions());
            db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(id(),conversationId,'assistant',answer,'model',Date.now());
            queueTelegram(db,this.key,{kind:'message',text:answer.slice(0,3800),request_id:'reply-'+account.slice(0,12)+'-'+message.id});
          }
          db.prepare("UPDATE telegram_seen SET state='completed' WHERE account=? AND message_id=?").run(account,message.id);
        }catch{db.prepare("UPDATE telegram_seen SET state='failed' WHERE account=? AND message_id=?").run(account,message.id);audit(db,'telegram.inbound_failed');}
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
