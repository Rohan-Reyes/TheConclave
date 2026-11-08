import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-exclusive-'));
process.env.AGENT_HUB_DB = path.join(temp, 'test.db');
process.env.AGENT_HUB_DATA_DIR = path.join(temp, 'data');
process.env.HOME = temp; process.env.USERPROFILE = temp;
const T = await import('../src/agents/threads.js');
const D = await import('../src/agents/drivers.js');
const { SyncService } = await import('../src/sync.js');
const { getDb } = await import('../src/db.js');
const fake = path.join(temp, 'fake.mjs');
const count = path.join(temp, 'turns');
fs.writeFileSync(fake, `import fs from 'node:fs'; for await(const c of process.stdin){} fs.appendFileSync(${JSON.stringify(count)},'turn'+String.fromCharCode(10)); await new Promise(r=>setTimeout(r,100)); console.log('finished');`);
D.saveAgent({ id: 'exclusive-fake', name: 'Exclusive fake', command: process.execPath, args: [fake], input: 'stdin' });
const coordinator = new SyncService({ device: 'rasp-pi', remoteOrigin: '' });
const chat = sync => T.createThread({ cwd: temp, target: 'exclusive-fake', settings: { sync, permission: 'read', autoRelay: false, fallback: { enabled: false } } });
const turns = () => fs.existsSync(count) ? fs.readFileSync(count, 'utf8').trim().split('\n').length : 0;
async function idle(id) {
  for (let i=0;i<200;i++) {
    if (!T.getThread(id).running && !coordinator.getLock(id).busy) return;
    await new Promise(r=>setTimeout(r,10));
  }
  assert.fail('Run did not finish');
}
after(()=> { T.setLockProvider(null); getDb().close(); fs.rmSync(temp,{recursive:true,force:true}); });

test('same-instance race and lost-response replay run one fake agent only', async()=> {
  T.setLockProvider(coordinator);
  const t=chat(true), before=turns();
  const results=await Promise.all([T.sendMessage(t.id,'one message',{requestId:'stable-request-123'}),T.sendMessage(t.id,'one message',{requestId:'stable-request-123'})]);
  assert.equal(results.filter(r=>r.ok).length,1);
  await idle(t.id);
  assert.equal(turns(),before+1);
  const replay=await T.sendMessage(t.id,'one message',{requestId:'stable-request-123'});
  assert.equal(replay.ok,true); assert.equal(replay.duplicate,true);
  assert.equal(turns(),before+1);
  assert.equal(T.getThread(t.id).messages.filter(m=>m.role==='user').length,1);
});

test('laptop and Pi use one HTTP coordinator; same-device duplicate cannot take ownership',async()=> {
  const app=express();app.use(express.json());
  app.post('/api/sync/lock/:id',(req,res)=>res.json(coordinator.handleRemoteLockRequest(req.params.id,req.body)));
  app.delete('/api/sync/lock/:id',(req,res)=>res.json(coordinator.handleRemoteUnlock(req.params.id,req.body)));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const laptop=new SyncService({ device:'laptop',remoteOrigin:`http://127.0.0.1:${server.address().port}` });
  laptop.getRemoteCookie=async()=> 'offline-fixture';
  const t=chat(true);
  try {
    const held=await laptop.acquireLock(t.id,'laptop-stable-123');assert.equal(held.acquired,true);
    const other=await coordinator.acquireLock(t.id,'pi-stable-request');assert.equal(other.acquired,false);assert.equal(other.device,'laptop');
    assert.equal((await laptop.acquireLock(t.id,'laptop-stable-123')).acquired,false);
    T.setLockProvider(coordinator);
    const before=turns();const rejected=await T.sendMessage(t.id,'must not run',{requestId:'pi-stable-request'});
    assert.equal(rejected.busy,true);assert.equal(turns(),before);
    assert.equal((await coordinator.checkRemoteBusy(t.id)).otherDeviceWorking,true);
    await laptop.releaseLock(t.id,held);
    assert.equal((await laptop.acquireLock(t.id,'laptop-stable-123')).duplicate,true);
  } finally { await new Promise(r=>server.close(r)); }
});

test('unreachable Pi fails closed while Local Only messages still run',async()=> {
  const laptop=new SyncService({device:'laptop',remoteOrigin:''});T.setLockProvider(laptop);
  const t=chat(true),before=turns();
  await assert.rejects(T.sendMessage(t.id,'must stay unstarted',{requestId:'offline-request-123'}),/coordination is unavailable/);
  assert.equal(turns(),before);assert.equal(T.getThread(t.id).messages.length,0);
  const local=chat(false);await T.sendMessage(local.id,'independent local work',{requestId:'local-request-123'});
  await idle(local.id);assert.equal(turns(),before+1);
});

test('Run plan cannot bypass a remote claim or steal a pending local submission', async()=> {
  T.setLockProvider(coordinator);
  const t=chat(true);T.updateThread(t.id,{settings:{permission:'edit'}});
  const id='exclusive-plan-test';
  const steps=[{id:'1',title:'fake step',owner:'exclusive-fake',kind:'read',status:'queued',dependsOn:[],files:[],effort:1}];
  getDb().prepare('INSERT INTO plans(id,thread_id,status,steps,created,updated) VALUES(?,?,?,?,?,?)').run(id,t.id,'proposed',JSON.stringify(steps),new Date().toISOString(),new Date().toISOString());
  const held=coordinator.claims.acquire({threadId:t.id,requestId:'remote-plan-request',device:'laptop'});
  const before=turns(); T.runPlan(t.id,id);
  for(let i=0;i<100 && T.getThread(t.id).running;i++) await new Promise(r=>setTimeout(r,10));
  assert.equal(turns(),before); assert.equal(T.getPlan(id).status,'proposed');
  coordinator.claims.finish({threadId:t.id,token:held.token});
  let release;
  const pending=new Promise(r=>{release=r;});
  const delayed={isSeamless:()=>true,acquireLock:async()=>{await pending;return coordinator.acquireLock(t.id,'delayed-plan-request');},releaseLock:(...args)=>coordinator.releaseLock(...args)};
  T.setLockProvider(delayed);
  const sending=T.sendMessage(t.id,'pending submit',{requestId:'delayed-request-123'});
  assert.throws(()=>T.runPlan(t.id,id),/already working/);
  release();await sending;await idle(t.id);
  assert.equal(turns(),before+1);
});

test('queued message survives a peer taking ownership before dispatch',async()=> {
  let attempts=0;
  const provider={
    isSeamless:()=>true,
    acquireLock:async(id,requestId)=> ++attempts===1 ? {acquired:true,requestId,token:'first-owner'} : {acquired:false,busy:true,device:'laptop',note:'(other device already working)'},
    releaseLock:async()=>({ok:true}),
  };
  T.setLockProvider(provider);const t=chat(true),before=turns();
  await T.sendMessage(t.id,'first',{requestId:'queue-first-request'});
  assert.equal((await T.sendMessage(t.id,'second',{requestId:'queue-second-request'})).queued,true);
  for(let i=0;i<200;i++) {
    if(!T.getThread(t.id).running && attempts>=2 && T.getThread(t.id).queue.length) break;
    await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(T.getThread(t.id).queue[0].requestId,'queue-second-request');
  assert.equal(turns(),before+1);
});

test('same-device stale claim is automatically reclaimed when local executor is not running', async() => {
  T.setLockProvider(coordinator);
  const t = chat(true);
  // Stale claim left from prior crash or interrupted turn on this device
  coordinator.claims.acquire({ threadId: t.id, requestId: 'stale-prior-request', device: 'rasp-pi' });
  assert.equal(coordinator.getLock(t.id).busy, true);
  // Now current device (rasp-pi) sends a new message while no local job is running
  const before = turns();
  const res = await T.sendMessage(t.id, 'reclaimed message', { requestId: 'fresh-request-456' });
  assert.equal(res.ok, true);
  await idle(t.id);
  assert.equal(turns(), before + 1);
});
