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
