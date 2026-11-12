import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../assistant/src/db.js';
import {setSecret} from '../assistant/src/integrations.js';
import {telegramStatus,queueTelegram,configureTelegram,TelegramWorker} from '../assistant/src/telegram.js';
const key='ad'.repeat(32),config={api_id:12345,api_hash:'synthetic-hash',session:'synthetic-session',owner_id:123456,enabled:true,calls_enabled:false};
test('Telegram is off until privately authorized; secret credentials never enter status responses',()=>{
 const db=openDb(':memory:');let starts=0;const worker=new TelegramWorker(db,key,{bridgeFactory:()=>{starts++;}});
 assert.throws(()=>configureTelegram(db,key,{enabled:true}),/Authorize/);assert.throws(()=>queueTelegram(db,key,{kind:'message',text:'Hello'}),/Enable/);
 setSecret(db,'config:telegram',config,key);const status=JSON.stringify(telegramStatus(db,key));assert.doesNotMatch(status,/synthetic-session|synthetic-hash/);
 assert.throws(()=>queueTelegram(db,key,{kind:'call',text:'Hello'}),/calls/);assert.throws(()=>configureTelegram(db,key,{enabled:'yes'}),/boolean/);db.close();
});
test('owner messages are deduplicated, historical messages are ignored and deliveries are not blindly retried',async()=>{
 const db=openDb(':memory:');setSecret(db,'config:telegram',config,key);let latest=10,replies=0,sends=0;
 const bridge={ready:Promise.resolve({account_id:234567}),close(){},async request(op){if(op==='poll')return {latest,messages:[{id:latest,text:'Owner task'}]};sends++;return {message_id:30};}};
 const worker=new TelegramWorker(db,key,{bridgeFactory:()=>bridge,reply:async()=>{replies++;return 'Prepared response';}});
 await worker.tick();assert.equal(replies,0);latest=11;worker.lastPoll=0;await worker.tick();assert.equal(replies,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,2);
 await worker.tick();await new Promise(r=>setImmediate(r));assert.equal(sends,1);worker.lastPoll=0;await worker.tick();assert.equal(replies,1);
 db.prepare("INSERT INTO telegram_outbox VALUES('uncertain-fixture','message','fixture','running',?,NULL,NULL)").run(Date.now());new TelegramWorker(db,key,{bridgeFactory:()=>bridge});assert.equal(db.prepare("SELECT state FROM telegram_outbox WHERE id='uncertain-fixture'").get().state,'uncertain');worker.close();db.close();
});
test('credential editing encrypts secrets, disables delivery and cancels old queued destinations',()=>{
 const db=openDb(':memory:');
 const input={api_id:'12345',api_hash:'ab'.repeat(16),session:'1'+'A'.repeat(352),owner_id:'123456'};
 configureTelegram(db,key,input);
 let status=telegramStatus(db,key);assert.equal(status.configured,true);assert.equal(status.enabled,false);assert.equal(status.api_id,12345);
 assert.ok(!JSON.stringify(status).includes(input.session));assert.ok(!JSON.stringify(status).includes(input.api_hash));
 configureTelegram(db,key,{enabled:true});queueTelegram(db,key,{kind:'message',text:'old destination',request_id:'old-owner-message'});
 configureTelegram(db,key,{owner_id:654321});
 assert.equal(telegramStatus(db,key).enabled,false);
 assert.equal(db.prepare('SELECT state FROM telegram_outbox WHERE id=?').get('old-owner-message').state,'cancelled');
 assert.throws(()=>configureTelegram(db,key,{api_hash:'invalid'}),/32 hexadecimal/);
 assert.throws(()=>configureTelegram(db,key,{owner_id:-100}),/positive numeric/);
 db.close();
});
test('voice conversations use the existing Jarvis chat and require explicit permissions',async()=>{
 const db=openDb(':memory:');const voiceConfig={...config,calls_enabled:true,conversation_enabled:true};setSecret(db,'config:telegram',voiceConfig,key);
 db.prepare('INSERT INTO conversations VALUES(?,?,?)').run('existing-jarvis','Jarvis',Date.now());
 let used;const worker=new TelegramWorker(db,key,{reply:async(db,key,id,memories,instructions)=>{used={id,instructions};return 'Your next task is ready.';}});
 assert.equal(await worker.voiceReply('What is my next task?'),'Your next task is ready.');assert.equal(used.id,'existing-jarvis');assert.match(used.instructions,/uncertain transcriptions/);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?').get('existing-jarvis').n,2);
 setSecret(db,'config:telegram',{...voiceConfig,conversation_enabled:false},key);await assert.rejects(()=>worker.voiceReply('No permission'),/disabled/);db.close();
});
test('voice diagnostics keep bounded numerical metrics and exclude speech, audio and credentials',async()=>{
 const {sanitizeVoiceMetric}=await import('../assistant/src/telegram.js');
 const db=openDb(':memory:');const worker=new TelegramWorker(db,key,{bridgeFactory:()=>null});
 const metric={name:'recognition_window',call_id:'a'.repeat(32),elapsed_ms:5000,rms_mean:200.25,rms_max:350,threshold_rms:450,chunks:40,bytes:16000,queue_depth:0,turn:1};
 for(let i=0;i<65;i++)worker.voiceMetric({...metric,turn:i,text:'private transcript',session:'secret-session',audio:'raw-audio',api_hash:'private-key',unexpected:'hidden'});
 const status=telegramStatus(db,key);assert.equal(status.voice_metrics.length,60);assert.equal(status.voice_metrics[0].turn,5);assert.equal(status.voice_metrics.at(-1).rms_mean,200.25);
 assert.doesNotMatch(JSON.stringify(status.voice_metrics),/private transcript|secret-session|raw-audio|private-key|hidden/);
 assert.equal(sanitizeVoiceMetric({...metric,call_id:'owner phone number'}),null);assert.equal(sanitizeVoiceMetric({...metric,name:'arbitrary sensitive text'}),null);
 const normalized=sanitizeVoiceMetric({...metric,rms_mean:Infinity,elapsed_ms:-1});assert.ok(!('rms_mean' in normalized));assert.ok(!('elapsed_ms' in normalized));db.close();
});
test('voice metrics tolerate SQLite write failure and recover on the next event',()=>{
 const db=openDb(':memory:');const worker=new TelegramWorker(db,key,{bridgeFactory:()=>null});let writesFail=true;
 worker.db={prepare(sql){if(writesFail && sql.includes("INSERT INTO settings VALUES('telegram:voice:metrics'"))throw new Error('SQLITE_BUSY private details');return db.prepare(sql);}};
 const metric={name:'model',call_id:'a'.repeat(32),elapsed_ms:25,outcome:'ok'};
 assert.doesNotThrow(()=>worker.voiceMetric(metric));assert.equal(telegramStatus(db,key).voice_metrics.length,0);
 writesFail=false;worker.voiceMetric(metric);assert.equal(telegramStatus(db,key).voice_metrics.length,1);db.close();
});
test('throwing diagnostic callbacks cannot stop bridge readiness or request replies',async()=>{
 const {TelegramBridge}=await import('../assistant/src/telegram.js');
 const {EventEmitter}=await import('node:events');const {PassThrough}=await import('node:stream');
 const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>child.emit('exit',0);
 child.stdin.on('data',chunk=>{const msg=JSON.parse(chunk.toString());if(msg.id)child.stdout.write(JSON.stringify({id:msg.id,result:{ok:true}})+'\n');});
 const bridge=new TelegramBridge(config,{spawnProcess:()=>child,onVoiceMetric:()=>{throw new Error('private diagnostics failure');},onVoiceState:()=>Promise.reject(new Error('private state failure'))});
 try{
  assert.doesNotThrow(()=>child.stdout.write(JSON.stringify({event:'voice_metric',name:'model',call_id:'a'.repeat(32),elapsed_ms:10})+'\n'));
  assert.doesNotThrow(()=>child.stdout.write(JSON.stringify({event:'voice_state',state:'listening'})+'\n'));
  child.stdout.write(JSON.stringify({ready:true})+'\n');await bridge.ready;await new Promise(r=>setImmediate(r));
  assert.deepEqual(await bridge.request('poll'),{ok:true});assert.equal(bridge.closed,false);
 }finally{bridge.close();child.stdin.destroy();child.stdout.destroy();}
});
