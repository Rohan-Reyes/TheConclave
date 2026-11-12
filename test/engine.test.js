import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-engine-test-'));
process.env.AGENT_HUB_DB = path.join(temp, 'test.db');
const { getDb, now, newId } = await import('../src/db.js');
const T = await import('../src/agents/threads.js');
const D = await import('../src/agents/drivers.js');
const F = await import('../src/agents/failover.js');
const fake = path.join(temp, 'fake.mjs');
fs.writeFileSync(fake, `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
let p=''; for await (const c of process.stdin) p+=c;
const role=process.argv[2];
const task=p.split('--- Your task now ---').at(-1);
if(task.includes('parallel-question-fixture') && role==='ea') {
  console.log('\u0060\u0060\u0060conclave-question\\n'+JSON.stringify({question:'Choose a fixture option?',options:['yes','no']})+'\\n\u0060\u0060\u0060');process.exit(0);
}
if(task.includes('parallel-question-fixture') && role==='eb') {
  fs.writeFileSync('eb.started','yes');
  for(let i=0;i<300 && !fs.existsSync('release-processes');i++)await new Promise(r=>setTimeout(r,10));
}
if(task.includes('bounded-slot-fixture')) {
  fs.appendFileSync('process-trace.jsonl',JSON.stringify({role,event:'start'})+'\\n');
  fs.writeFileSync(role+'.started','yes');
  for(let i=0;i<300 && !fs.existsSync('release-processes');i++) await new Promise(r=>setTimeout(r,10));
  fs.appendFileSync('process-trace.jsonl',JSON.stringify({role,event:'end'})+'\\n');
}
if(task.includes('capture-initial-fixture')) {
  fs.writeFileSync(role+'.prompt',p);
  console.log('PEER_REPLY_MARKER_'+role);process.exit(0);
}
if(task.includes('one-fails-fixture') && role==='ea') {console.error('fixture launch failure');process.exit(2);}
if(task.includes('dedup-relay-fixture')) {
  fs.writeFileSync(role+'.prompt',p);
  if(role==='ec')console.log('COMBINED_REVIEW_DONE');else {console.log(role.toUpperCase()+'_INITIAL_COMPLETED');console.log('@ec please review the combined answers');}process.exit(0);
}
if(task.includes('hop-relay-fixture')) {
  const chain=['ea','eb','ec','ed','ee','ef'];const next=chain[chain.indexOf(role)+1];
  console.log(next?'@'+next+' continue':'finished chain');process.exit(0);
}

if(task.includes('capture-global-fixture'))fs.writeFileSync('captured-global.json',JSON.stringify({prompt:p,credential:process.env.FIXTURE_ACCESS==='synthetic-fixture-value',master:!!process.env.TOKEN_ENCRYPTION_KEY}));
if (task.includes('detached-grandchild')) {
  const sleeper=spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{stdio:'inherit'});
  fs.writeFileSync('grandchild.pid',String(sleeper.pid));
  console.log('spawned grandchild and exiting');
  process.exit(0);
}
if (task.includes('slow-chat')) {
  await new Promise(r=>setTimeout(r,220));
}
if (task.includes('crash-turn')) {
  console.error('fatal crash during generation');
  process.exit(2);
}
if (task.includes('same-agent-lock')) {
  const lock=fs.openSync('agent-turn.lock','wx');
  fs.appendFileSync('agent-turn-order.txt',role+' start\\n');
  await new Promise(r=>setTimeout(r,180));
  fs.appendFileSync('agent-turn-order.txt',role+' end\\n');
  fs.closeSync(lock); fs.unlinkSync('agent-turn.lock');
}
if (task.includes('parallel-read-check')) {
  fs.writeFileSync(role+'.ready','ready');
  const other=role==='ea'?'eb':'ea';
  for(let i=0;i<150 && !fs.existsSync(other+'.ready');i++) await new Promise(r=>setTimeout(r,20));
  if(!fs.existsSync(other+'.ready')) { console.error('independent read did not start concurrently'); process.exit(3); }
}
if (role==='quota') { fs.writeFileSync('partial.txt','valid partial work'); console.error('usage limit, try again in 2 hours'); process.exit(1); }
if (role==='reviewfail') { console.error('review failed'); process.exit(1); }
if (task.includes('REVIEW of plan step')) { console.log('LGTM verified'); process.exit(0); }
if (task.includes('ask-before-building') && !task.includes('The user answered')) {
  console.log('\u0060\u0060\u0060conclave-question\\n'+JSON.stringify({question:'Which color?',options:['blue','green']})+'\\n\u0060\u0060\u0060'); process.exit(0);
}
if (task.includes('slow-writer')) {
  const lock=fs.openSync('writer.lock','wx');
  fs.appendFileSync('order.txt',role+' start\\n');
  await new Promise(r=>setTimeout(r,180));
  fs.appendFileSync('order.txt',role+' end\\n'); fs.closeSync(lock); fs.unlinkSync('writer.lock');
}
if (task.includes('takeover-check')) {
  if(fs.readFileSync('partial.txt','utf8')!=='valid partial work' || !task.includes('Inspect the current files')) process.exit(2);
  fs.appendFileSync('partial.txt','; completed');
}
console.log(role+' finished');
`);
for (const id of ['ea', 'eb', 'ec', 'ed', 'ee', 'ef', 'quota', 'reviewfail']) D.saveAgent({ id, name: id, command: process.execPath, args: [fake, id], input: 'stdin' });
const dirs = [];
function chat(settings = {}, cwd) {
  cwd ||= fs.mkdtempSync(path.join(temp, 'project-')); dirs.push(cwd);
  return T.createThread({ cwd, target: 'ea', settings: { members: ['ea', 'eb'], chair: 'ea', autoRelay: false, permission: 'edit', shell: 'sandboxed', fallback: { enabled: false }, ...settings } });
}
function plan(thread, steps, status = 'proposed') {
  const id = newId();
  steps = steps.map((s, i) => ({ id: String(i+1), title: 'step', detail: '', owner: 'ea', files: [], dependsOn: [], kind: 'build', review: null, effort: 2, assignee: null, status: 'queued', attempts: 0, ...s }));
  getDb().prepare('INSERT INTO plans (id,thread_id,status,steps,created,updated) VALUES (?,?,?,?,?,?)').run(id, thread.id, status, JSON.stringify(steps), now(), now());
  return T.getPlan(id);
}
async function idle(id) {
  for (let i=0;i<300;i++) { if (!T.getThread(id).running) return T.getThread(id); await new Promise(r=>setTimeout(r,20)); }
  throw new Error('Agent did not finish');
}
after(async () => { for (const row of getDb().prepare('SELECT id FROM threads').all()) T.stopThread(row.id); getDb().close(); fs.rmSync(temp,{recursive:true,force:true}); });

test('plan controls reject a different chat ID', () => {
  const a=chat(), b=chat(), p=plan(a,[{}]);
  for(const action of [() => T.runPlan(b.id,p.id),() => T.pausePlan(b.id,p.id),() => T.cancelPlan(b.id,p.id),() => T.stepAction(b.id,p.id,'1','skip')]) assert.throws(action, e=>e.status===404);
  assert.equal(T.getPlan(p.id).status,'proposed');
});

test('run is idempotently guarded while active and after completion', async () => {
  const t=chat(), p=plan(t,[{}]); T.runPlan(t.id,p.id);
  assert.throws(()=>T.runPlan(t.id,p.id),e=>e.status===409);
  await idle(t.id); assert.equal(T.getPlan(p.id).status,'done');
  assert.throws(()=>T.runPlan(t.id,p.id),e=>e.status===409);
});

test('cancel expires questions and a late answer cannot restart the task', async () => {
  const t=chat(), p=plan(t,[{title:'ask-before-building'}]); T.runPlan(t.id,p.id);
  const th=await idle(t.id), q=th.questions[0]; assert.ok(q); assert.equal(T.getPlan(p.id).status,'paused');
  T.cancelPlan(t.id,p.id);
  assert.throws(()=>T.answerQuestion(q.id,'blue'),e=>e.status===409);
  assert.equal(T.getPlan(p.id).status,'cancelled'); assert.equal(T.getPlan(p.id).steps[0].status,'skipped');
  assert.throws(()=>T.stepAction(t.id,p.id,'1','retry'),e=>e.status===409);
});

test('one answer resumes its own waiting task and duplicate answers are rejected', async () => {
  const t=chat(), p=plan(t,[{title:'ask-before-building'}]); T.runPlan(t.id,p.id);
  const th=await idle(t.id), q=th.questions[0];
  T.answerQuestion(q.id,'green'); assert.throws(()=>T.answerQuestion(q.id,'blue'),e=>e.status===409);
  await idle(t.id); assert.equal(T.getPlan(p.id).status,'done'); assert.equal(T.getPlan(p.id).steps[0].answer,'green');
});

test('an answer submitted during the question event is not lost', async () => {
  const t=chat(), p=plan(t,[{title:'ask-before-building'}]);
  const off=T.onThreadEvent(t.id,e=> { if(e.type==='question' && e.question.status==='pending') T.answerQuestion(e.question.id,'blue'); });
  try { T.runPlan(t.id,p.id); await idle(t.id); assert.equal(T.getPlan(p.id).status,'done'); }
  finally { off(); }
});

test('a superseded question cannot resume its old task', async () => {
  const t=chat(), p=plan(t,[{title:'ask-before-building'}]); T.runPlan(t.id,p.id);
  const th=await idle(t.id), q=th.questions[0];
  getDb().prepare("UPDATE plans SET status='superseded' WHERE id=?").run(p.id);
  assert.throws(()=>T.answerQuestion(q.id,'blue'),e=>e.status===409);
  assert.equal(T.getQuestion(q.id).status,'expired'); assert.equal(T.getThread(t.id).running,false);
});

test('questions validate plan, step, thread and requesting agent', () => {
  const a=chat(), b=chat(), p=plan(a,[{status:'running',assignee:'ea'}],'running');
  assert.throws(()=>T.createQuestion({threadId:b.id,planId:p.id,stepId:'1',agent:'ea',question:'x'}),e=>e.status===404);
  assert.throws(()=>T.createQuestion({threadId:a.id,planId:p.id,stepId:'1',agent:'eb',question:'x'}),e=>e.status===409);
  assert.throws(()=>T.createQuestion({threadId:a.id,planId:p.id,stepId:'missing',agent:'ea',question:'x'}),e=>e.status===409);
});

test('writers in separate chats using the same folder are serialized', async () => {
  const a=chat(), b=chat({},a.cwd), p=plan(a,[{title:'slow-writer',owner:'ea'}]), q=plan(b,[{title:'slow-writer',owner:'eb'}]);
  T.runPlan(a.id,p.id); T.runPlan(b.id,q.id); await Promise.all([idle(a.id),idle(b.id)]);
  assert.equal(T.getPlan(p.id).status,'done'); assert.equal(T.getPlan(q.id).status,'done');
  const lines=fs.readFileSync(path.join(a.cwd,'order.txt'),'utf8').trim().split('\n');
  assert.match(lines[0],/start$/); assert.match(lines[1],/end$/); assert.match(lines[2],/start$/); assert.match(lines[3],/end$/);
});

test('read and write steps assigned to one agent do not overlap its native turn', async () => {
  const t=chat(), p=plan(t,[{title:'same-agent-lock',owner:'ea',kind:'read'},{title:'same-agent-lock',owner:'ea',kind:'build'}]);
  T.runPlan(t.id,p.id); await idle(t.id);
  assert.equal(T.getPlan(p.id).status,'done');
  assert.ok(T.getPlan(p.id).steps.every(s=>s.status==='done'));
  assert.deepEqual(fs.readFileSync(path.join(t.cwd,'agent-turn-order.txt'),'utf8').trim().split('\n'),['ea start','ea end','ea start','ea end']);
});

test('different agents can still perform independent reads concurrently', async () => {
  const t=chat(), p=plan(t,[{title:'parallel-read-check',owner:'ea',kind:'read'},{title:'parallel-read-check',owner:'eb',kind:'read'}]);
  T.runPlan(t.id,p.id); await idle(t.id);
  assert.equal(T.getPlan(p.id).status,'done');
  assert.ok(T.getPlan(p.id).steps.every(s=>s.status==='done'));
});

test('access tightened while waiting for the agent turn prevents a write snapshot', async () => {
  const t=chat(), p=plan(t,[{title:'same-agent-lock',owner:'ea',kind:'read'},{title:'same-agent-lock',owner:'ea',kind:'build'}]);
  let tightened=false;
  const off=T.onThreadEvent(t.id,e=> {
    if(!tightened && e.type==='message' && e.message.round==='step-1' && e.message.status==='running') {
      tightened=true; T.updateThread(t.id,{settings:{permission:'read'}});
    }
  });
  try {
    T.runPlan(t.id,p.id); const result=await idle(t.id);
    assert.ok(tightened); assert.equal(T.getPlan(p.id).status,'done');
    assert.equal(result.messages.find(m=>m.round==='step-2').changes,null);
  } finally { off(); }
});

test('quota takeover preserves partial edits and records the actual assignee', async () => {
  const t=chat({members:['quota','eb'],chair:'quota',fallback:{enabled:true,order:['quota','eb'],otherModel:false,waitForReset:false}});
  const p=plan(t,[{owner:'quota',title:'takeover-check'}]); T.runPlan(t.id,p.id); await idle(t.id);
  assert.equal(T.getPlan(p.id).status,'done'); assert.equal(T.getPlan(p.id).steps[0].assignee,'eb');
  assert.equal(fs.readFileSync(path.join(t.cwd,'partial.txt'),'utf8'),'valid partial work; completed'); F.clearExhausted('quota');
});

test('a quota fallback owns the task before asking a question mid-turn', async () => {
  const t=chat({members:['quota','eb'],chair:'quota',fallback:{enabled:true,order:['quota','eb'],otherModel:false,waitForReset:false}});
  const p=plan(t,[{owner:'quota',title:'takeover-check'}]);
  let question=null, failure=null;
  const off=T.onThreadEvent(t.id,e=> {
    if(e.type==='message' && e.message.role==='agent' && e.message.tool==='eb' && e.message.status==='running') {
      try {
        assert.equal(T.getPlan(p.id).steps[0].assignee,'eb');
        question=T.createQuestion({threadId:t.id,messageId:e.message.id,planId:p.id,stepId:'1',agent:'eb',question:'Keep the partial work?',options:['yes','no'],via:'tool'});
        T.answerQuestion(question.id,'yes');
      } catch(error) { failure=error; }
    }
  });
  try {
    T.runPlan(t.id,p.id); await idle(t.id);
    assert.ifError(failure); assert.ok(question); assert.equal(T.getQuestion(question.id).status,'answered');
    assert.equal(T.getPlan(p.id).status,'done'); assert.equal(T.getPlan(p.id).steps[0].assignee,'eb');
  } finally { off(); F.clearExhausted('quota'); }
});

test('a failed required review leaves the step failed', async () => {
  const t=chat({members:['ea','reviewfail']}), p=plan(t,[{review:'reviewfail'}]); T.runPlan(t.id,p.id); await idle(t.id);
  assert.equal(T.getPlan(p.id).steps[0].status,'failed'); assert.equal(T.getPlan(p.id).status,'paused');
});

test('read-only chats cannot run a plan and settings reject unsupported values', () => {
  const t=chat({permission:'read'}), p=plan(t,[{}]); assert.throws(()=>T.runPlan(t.id,p.id),/read-only/);
  assert.throws(()=>T.updateThread(t.id,{settings:{permission:'root'}}),/Invalid permission/);
  assert.throws(()=>T.updateThread(t.id,{settings:{approvalMode:'yes'}}),/Invalid approvalMode/);
});

test('edit and resend accepts only the latest user turn and preserves reply history', async () => {
  const t=chat(); await T.sendMessage(t.id,'first request'); await idle(t.id);
  await T.sendMessage(t.id,'second request'); const th=await idle(t.id);
  const users=th.messages.filter(m=>m.role==='user'), oldReplies=th.messages.filter(m=>m.role==='agent');
  await assert.rejects(T.editLastUserMessage(t.id,users[0].id,'obsolete'),e=>e.status===409);
  await T.editLastUserMessage(t.id,users[1].id,'revised request'); await idle(t.id);
  const edited=T.getThread(t.id);
  assert.equal(edited.messages.find(m=>m.id===users[1].id).content,'revised request');
  assert.ok(oldReplies.every(m=>edited.messages.some(n=>n.id===m.id)));
  assert.equal(edited.messages.filter(m=>m.role==='user').length,2);
});

test('a child process that spawns a background grandchild holding stdio pipes finishes cleanly without stalling', async () => {
  const t=chat();
  const t0=Date.now();
  await T.sendMessage(t.id,'detached-grandchild');
  const done=await idle(t.id);
  const elapsed=Date.now()-t0;
  const gpid=Number(fs.readFileSync(path.join(t.cwd,'grandchild.pid'),'utf8').trim());
  try { process.kill(gpid); } catch {}
  assert.ok(elapsed < 2500, `Expected turn to settle before 4s grandchild exit, took ${elapsed}ms`);
  assert.equal(done.running,false);
  const reply=done.messages.find(m=>m.role==='agent');
  assert.equal(reply.status,'done');
  assert.match(reply.content,/spawned grandchild and exiting/);
});

test('chatting during generation queues messages in order and Send now interrupts cleanly even across workspace locks', async () => {
  const t=chat();
  await T.sendMessage(t.id,'slow-chat first');
  const q1=await T.sendMessage(t.id,'queued-one');
  const q2=await T.sendMessage(t.id,'queued-two');
  assert.equal(q1.queued,true); assert.equal(q1.position,1);
  assert.equal(q2.queued,true); assert.equal(q2.position,2);
  const afterQueue=await idle(t.id);
  assert.equal(afterQueue.running,false);
  assert.equal(afterQueue.queue.length,0);
  const userTexts=afterQueue.messages.filter(m=>m.role==='user').map(m=>m.content);
  assert.deepEqual(userTexts,['slow-chat first','queued-one','queued-two']);

  // Now verify mode:'now' interrupts a turn waiting on a workspace writer lock without 15s timeout
  const other=chat({},t.cwd);
  await T.sendMessage(other.id,'slow-writer hold');
  await new Promise(r=>setTimeout(r,30));
  await T.sendMessage(t.id,'slow-writer queued-behind-lock');
  await new Promise(r=>setTimeout(r,30));
  const nowRes=await T.sendMessage(t.id,'urgent-now',{mode:'now'});
  assert.equal(nowRes.ok,true);
  const [doneT,doneOther]=await Promise.all([idle(t.id),idle(other.id)]);
  assert.equal(doneT.running,false);
  assert.equal(doneOther.running,false);
  assert.equal(doneT.messages.filter(m=>m.role==='user').at(-1).content,'urgent-now');
  assert.equal(doneT.messages.filter(m=>m.role==='agent').at(-1).status,'done');
});

test('failures during generation clear busy state and mark message as error', async () => {
  const t=chat();
  await T.sendMessage(t.id,'crash-turn');
  const done=await idle(t.id);
  assert.equal(done.running,false);
  const reply=done.messages.find(m=>m.role==='agent');
  assert.equal(reply.status,'error');
  assert.match(reply.error,/fatal crash during generation/);
});

test('interrupted sessions recover cleanly on startup via recoverStale', () => {
  const t=chat();
  const p=plan(t,[{status:'running',assignee:'ea'},{status:'queued'}],'running');
  const mid=newId();
  getDb().prepare('INSERT INTO thread_messages (id,thread_id,role,tool,content,status,created) VALUES (?,?,?,?,?,?,?)')
    .run(mid,t.id,'agent','ea','partial stream','running',now());
  const q=T.createQuestion({threadId:t.id,messageId:mid,planId:p.id,stepId:'1',agent:'ea',question:'Still there?',via:'tool'});
  assert.equal(T.getQuestion(q.id).status,'pending');

  T.recoverStale({ autoResume: false });

  const recovered=T.getThread(t.id);
  assert.equal(recovered.running,false);
  const msg=recovered.messages.find(x=>x.id===mid);
  assert.equal(msg.status,'stopped');
  assert.equal(msg.error,'Hub restarted');
  assert.ok(msg.finished);
  const recPlan=T.getPlan(p.id);
  assert.equal(recPlan.status,'paused');
  // A build step that was mid-edit is not replayed blindly: it waits for Retry or Skip.
  assert.equal(recPlan.steps[0].status,'failed');
  assert.match(recPlan.steps[0].error,/Interrupted by a Conclave restart/);
  assert.equal(recPlan.steps[1].status,'queued');
  assert.equal(T.getQuestion(q.id).status,'expired');
});

test('restart: a plan whose interrupted step was mid-edit stays paused and is not auto-resumed', () => {
  const t=chat({ approvalMode: 'auto' });
  const p=plan(t,[{status:'done',assignee:'ea'},{status:'running',assignee:'ea',kind:'build'},{status:'queued'}],'running');
  T.recoverStale({ autoResume: true, resumeDelayMs: 60_000 });
  assert.equal(T.resumeScheduled(),0);
  const rec=T.getPlan(p.id);
  assert.equal(rec.status,'paused');
  assert.equal(rec.steps[0].status,'done', 'completed steps keep their checkpoint');
  assert.equal(rec.steps[1].status,'failed');
  assert.ok(T.getThread(t.id).messages.some(m=>m.role==='system' && /marked failed so its edits and commands aren't repeated/.test(m.content)));
});

test('restart: Auto mode with write access resumes a plan when only read-only work was interrupted', async () => {
  const t=chat({ approvalMode: 'auto', permission: 'edit' });
  const p=plan(t,[{status:'done',assignee:'ea'},{status:'running',assignee:'ea',kind:'read'}],'running');
  T.recoverStale({ autoResume: true, resumeDelayMs: 5 });
  assert.equal(T.resumeScheduled(),1);
  assert.equal(T.getPlan(p.id).steps[1].status,'queued');
  for (let i=0;i<300 && T.getPlan(p.id).status!=='done';i++) await new Promise(r=>setTimeout(r,20));
  await idle(t.id);
  const done=T.getPlan(p.id);
  assert.equal(done.status,'done');
  assert.equal(done.steps[0].attempts,0, 'the finished step was not run again');
  assert.ok(T.getThread(t.id).messages.some(m=>m.role==='system' && /resumes automatically/.test(m.content)));
});

test('restart: a plan with an earlier failed build step is not auto-resumed (Run plan would re-queue it)', () => {
  const t=chat({ approvalMode: 'auto', permission: 'edit' });
  const p=plan(t,[{status:'failed',assignee:'ea',kind:'build',error:'boom'},{status:'running',assignee:'eb',kind:'read'}],'running');
  T.recoverStale({ autoResume: true, resumeDelayMs: 60_000 });
  assert.equal(T.resumeScheduled(),0);
  const rec=T.getPlan(p.id);
  assert.equal(rec.status,'paused');
  assert.equal(rec.steps[0].status,'failed');
  assert.equal(rec.steps[1].status,'queued');
});

test('restart: the delayed resume re-checks settings and survives a deleted chat', async () => {
  // Switched to Manual during the delay: stays paused.
  const t1=chat({ approvalMode: 'auto', permission: 'edit' });
  const p1=plan(t1,[{status:'running',assignee:'ea',kind:'read'}],'running');
  // Deleted during the delay: no uncaught error.
  const t2=chat({ approvalMode: 'auto', permission: 'edit' });
  const p2=plan(t2,[{status:'running',assignee:'ea',kind:'read'}],'running');
  const errors=[];
  const onErr=e=>errors.push(e);
  process.on('uncaughtException',onErr);
  try {
    T.recoverStale({ autoResume: true, resumeDelayMs: 40 });
    assert.equal(T.resumeScheduled(),2);
    T.updateThread(t1.id,{ settings: { approvalMode: 'manual' } });
    T.deleteThread(t2.id);
    await new Promise(r=>setTimeout(r,200));
  } finally { process.off('uncaughtException',onErr); }
  assert.deepEqual(errors,[]);
  assert.equal(T.getThread(t1.id).running,false);
  assert.equal(T.getPlan(p1.id).status,'paused');
  assert.ok(T.getThread(t1.id).messages.some(m=>m.role==='system' && /stays paused/.test(m.content)));
  assert.ok(!T.getPlan(p2.id), 'the deleted chat\'s plan is gone and was not resumed');
});

test('restart: Manual mode and read-only chats never auto-resume', () => {
  for (const settings of [{ approvalMode: 'manual', permission: 'edit' }, { approvalMode: 'auto', permission: 'read' }]) {
    const t=chat(settings);
    const p=plan(t,[{status:'running',assignee:'ea',kind:'read'}],'running');
    T.recoverStale({ autoResume: true, resumeDelayMs: 60_000 });
    assert.equal(T.resumeScheduled(),0, JSON.stringify(settings));
    assert.equal(T.getPlan(p.id).status,'paused');
  }
});

test('council: an exhausted member sits out with one note and never triggers the all-agents banner', async () => {
  F.markExhausted('eb', 'usage limit, try again in 2 hours');
  try {
    const t=chat({ members: ['ea','eb'], chair: 'ea', rounds: 1, permission: 'read', fallback: { enabled: true, order: ['ea','eb'], waitForReset: true } });
    T.updateThread(t.id,{ target: 'council' });
    await T.sendMessage(t.id,'council-skip-check');
    const done=await idle(t.id);
    const sys=done.messages.filter(m=>m.role==='system').map(m=>m.content);
    assert.equal(sys.filter(s=>/Sitting out this council: eb/.test(s)).length,1, sys.join(' | '));
    assert.ok(!sys.some(s=>/All agents are out of credits/.test(s)), sys.join(' | '));
    assert.equal(done.messages.filter(m=>m.role==='agent' && m.tool==='eb').length,0, 'no failed turn for the exhausted member');
    assert.ok(done.messages.some(m=>m.role==='agent' && m.tool==='ea' && m.status==='done'));
    assert.equal(T.waitingInfo(t.id),null);
  } finally { F.clearExhausted('eb'); }
});

test('failover: a launch failure next to an exhausted agent does not schedule a credit-reset retry', async () => {
  D.saveAgent({ id: 'nobinary', name: 'nobinary', command: path.join(temp,'does-not-exist.exe'), args: [], input: 'stdin' });
  F.markExhausted('eb', 'usage limit, try again in 2 hours');
  try {
    const t=chat({ fallback: { enabled: true, order: ['nobinary'], waitForReset: true } });
    T.updateThread(t.id,{ target: 'eb' });
    await T.sendMessage(t.id,'mixed-failure-check');
    const done=await idle(t.id);
    const sys=done.messages.filter(m=>m.role==='system').map(m=>m.content).join(' | ');
    assert.equal(T.waitingInfo(t.id),null, sys);
    assert.doesNotMatch(sys,/All agents are out of credits/);
    assert.match(sys,/Nothing was retried automatically/);
  } finally { F.clearExhausted('eb'); D.deleteAgent('nobinary'); }
});

test('failover: when every candidate is genuinely out of credits the chat waits for the earliest reset', async () => {
  F.markExhausted('ea', 'usage limit, try again in 3 hours');
  F.markExhausted('eb', 'usage limit, try again in 2 hours');
  try {
    const t=chat({ fallback: { enabled: true, order: ['eb'], waitForReset: true } });
    await T.sendMessage(t.id,'all-out-check');
    const done=await idle(t.id);
    const w=T.waitingInfo(t.id);
    assert.ok(w, done.messages.map(m=>m.content).join(' | '));
    assert.ok(Math.abs(w.until-(F.outOfCredits('eb').until+60_000))<1000, 'waits for the earliest reset');
    assert.ok(done.messages.some(m=>m.role==='system' && /All agents are out of credits/.test(m.content)));
    T.cancelWaiting(t.id);
  } finally { F.clearExhausted('ea'); F.clearExhausted('eb'); }
});

test('selected agent combinations answer directly and solo selection stays solo', async () => {
  const t=chat({responders:['ea','eb']});
  await T.sendMessage(t.id,'selection fixture'); await idle(t.id);
  assert.deepEqual(T.getThread(t.id).messages.filter(m=>m.role==='agent').map(m=>m.tool),['ea','eb']);
  T.updateThread(t.id,{target:'eb',settings:{responders:['eb'],members:['eb'],chair:'eb'}});
  await T.sendMessage(t.id,'solo fixture');await idle(t.id);
  assert.deepEqual(T.getThread(t.id).messages.filter(m=>m.role==='agent').map(m=>m.tool),['ea','eb','eb']);
  assert.throws(()=>T.updateThread(t.id,{settings:{responders:['not-a-real-agent']}}),/Invalid selected agents/);
  assert.throws(()=>T.updateThread(t.id,{settings:{responders:[]}}),/Invalid selected agents/);
});

test('project discovery and quick plans include hub-only folders', async () => {
  const t=chat();const saved=plan(t,[{title:'Quick plan fixture'}]);
  const {listProjects,projectDetail}=await import('../src/projects.js');
  assert.ok(listProjects().some(p=>p.path===t.cwd && p.exists));
  const p=await projectDetail(t.cwd);assert.equal(p.plans[0].id,saved.id);assert.equal(p.plans[0].steps[0].title,'Quick plan fixture');
});

test('adding details keeps the same agent running, is idempotent and has independent read cursors',async()=>{
  const t=chat({autoRelay:false});await T.sendMessage(t.id,'slow-chat fixture');
  for(let i=0;i<100 && !T.getThread(t.id).messages.some(m=>m.role==='agent');i++)await new Promise(resolve=>setTimeout(resolve,5));
  const before=T.getThread(t.id).messages.find(m=>m.role==='agent');assert.ok(before);
  const options={mode:'details',requestId:'context-fixture-0001'};
  const added=await T.sendMessage(t.id,'Keep the original task; add an accessible label.',options);assert.equal(added.details,true);
  assert.equal(T.getThread(t.id).running,true);assert.equal(T.getThread(t.id).messages.filter(m=>m.role==='agent').length,1);assert.equal(T.getThread(t.id).queue.length,0);
  const duplicate=await T.sendMessage(t.id,'Keep the original task; add an accessible label.',options);assert.equal(duplicate.duplicate,true);
  const {readTaskUpdates}=await import('../src/context-updates.js');
  assert.equal(readTaskUpdates(t.id,'ea').updates.length,1);assert.equal(readTaskUpdates(t.id,'ea').updates.length,0);assert.equal(readTaskUpdates(t.id,'eb').updates.length,1);
  const finished=await idle(t.id);assert.equal(finished.messages.find(m=>m.id===before.id).status,'done');assert.equal(finished.messages.filter(m=>m.round==='context-update').length,1);
});


test('new turns receive owner prompts and selected credentials without putting secret values in the prompt',async()=>{
  const prior=process.env.TOKEN_ENCRYPTION_KEY;process.env.TOKEN_ENCRYPTION_KEY='cd'.repeat(32);
  const G=await import('../src/config/globals.js');
  const p=G.savePrompt({title:'Fixture global style',content:'Global fixture: use short paragraphs.',targets:['ea']});
  G.saveVariable({name:'FIXTURE_ACCESS',value:'synthetic-fixture-value',secret:true,targets:['ea']});
  try{
    const t=chat();await T.sendMessage(t.id,'capture-global-fixture');await idle(t.id);
    const result=JSON.parse(fs.readFileSync(path.join(t.cwd,'captured-global.json'),'utf8'));
    assert.match(result.prompt,/Global fixture: use short paragraphs/);assert.match(result.prompt,/FIXTURE_ACCESS/);assert.doesNotMatch(result.prompt,/synthetic-fixture-value/);assert.equal(result.credential,true);assert.equal(result.master,false);
  }finally{G.deletePrompt(p.id);G.deleteVariable('FIXTURE_ACCESS');if(prior===undefined)delete process.env.TOKEN_ENCRYPTION_KEY;else process.env.TOKEN_ENCRYPTION_KEY=prior;}
});

async function waitForFixture(predicate, label) {
  for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,20));}
  throw new Error('Timed out: '+label);
}
async function withProcessLimit(limit, fn) {
  const old=process.env.CONCLAVE_MAX_AGENT_PROCESSES;process.env.CONCLAVE_MAX_AGENT_PROCESSES=String(limit);
  try{return await fn();}finally{if(old===undefined)delete process.env.CONCLAVE_MAX_AGENT_PROCESSES;else process.env.CONCLAVE_MAX_AGENT_PROCESSES=old;}
}
function releaseFixture(thread){fs.writeFileSync(path.join(thread.cwd,'release-processes'),'release');}

test('direct read combinations overlap and the default cap queues a fourth process',async()=>{
 await withProcessLimit(3,async()=>{
  const t=chat({permission:'read',members:['ea','eb','ec','ed'],responders:['ea','eb','ec','ed']});
  try{
   await T.sendMessage(t.id,'bounded-slot-fixture');
   await waitForFixture(()=>['ea','eb','ec'].every(a=>fs.existsSync(path.join(t.cwd,a+'.started'))),'first three processes');
   assert.equal(fs.existsSync(path.join(t.cwd,'ed.started')),false);
   assert.deepEqual(T.getAgentProcessStats(),{limit:3,active:3,queued:1});
   assert.equal(T.getThread(t.id).messages.find(m=>m.tool==='ed').phase,'queued');
   releaseFixture(t);const done=await idle(t.id);assert.ok(done.messages.filter(m=>m.role==='agent').every(m=>m.status==='done'));
   let active=0,peak=0;for(const item of fs.readFileSync(path.join(t.cwd,'process-trace.jsonl'),'utf8').trim().split('\n').map(JSON.parse)){active+=item.event==='start'?1:-1;peak=Math.max(peak,active);}
   assert.equal(peak,3);assert.equal(active,0);assert.equal(T.getAgentProcessStats().active,0);
  }finally{releaseFixture(t);await idle(t.id);}
 });
});

test('capacity-delayed initial responders use the same pre-reply context snapshot',async()=>{
 await withProcessLimit(1,async()=>{
  const t=chat({permission:'read',members:['ea','eb'],responders:['ea','eb']});
  await T.sendMessage(t.id,'capture-initial-fixture original user request');await idle(t.id);
  for(const tool of ['ea','eb']){
   const prompt=fs.readFileSync(path.join(t.cwd,tool+'.prompt'),'utf8');assert.match(prompt,/original user request/);
   assert.doesNotMatch(prompt,/PEER_REPLY_MARKER_/);
  }
  assert.equal(T.getThread(t.id).messages.filter(m=>m.role==='agent' && m.status==='done').length,2);
 });
});

test('workspace lock waiters do not occupy capacity needed by unrelated work',async()=>{
 await withProcessLimit(2,async()=>{
  const writer=chat(),blocked=chat({},writer.cwd),reader=chat({permission:'read'});
  try{
   await T.sendMessage(writer.id,'bounded-slot-fixture writer');await waitForFixture(()=>fs.existsSync(path.join(writer.cwd,'ea.started')),'first writer');
   await T.sendMessage(blocked.id,'bounded-slot-fixture blocked writer');
   await waitForFixture(()=>T.getThread(blocked.id).messages.some(m=>m.role==='agent' && m.phase==='queued'),'queued writer');
   await T.sendMessage(reader.id,'bounded-slot-fixture independent reader');await waitForFixture(()=>fs.existsSync(path.join(reader.cwd,'ea.started')),'independent reader');
   assert.equal(T.getAgentProcessStats().active,2);assert.equal(T.getAgentProcessStats().queued,0);
   assert.equal(fs.readFileSync(path.join(writer.cwd,'process-trace.jsonl'),'utf8').trim().split('\n').length,1,'second writer has not launched');
  }finally{releaseFixture(writer);releaseFixture(reader);await Promise.all([idle(writer.id),idle(blocked.id),idle(reader.id)]);}
  const trace=fs.readFileSync(path.join(writer.cwd,'process-trace.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(trace.map(x=>x.event),['start','end','start','end']);
 });
});

test('stopping a capacity-queued turn prevents launch and leaves no capacity leak',async()=>{
 await withProcessLimit(1,async()=>{
  const holder=chat({permission:'read'}),queued=chat({permission:'read'});
  try{
   await T.sendMessage(holder.id,'bounded-slot-fixture holder');await waitForFixture(()=>fs.existsSync(path.join(holder.cwd,'ea.started')),'capacity holder');
   await T.sendMessage(queued.id,'bounded-slot-fixture queued');await waitForFixture(()=>T.getAgentProcessStats().queued===1,'queued capacity');
   T.stopThread(queued.id);const done=await idle(queued.id);
   assert.equal(done.messages.find(m=>m.role==='agent').status,'stopped');assert.equal(fs.existsSync(path.join(queued.cwd,'ea.started')),false);
   assert.deepEqual(T.getAgentProcessStats(),{limit:1,active:1,queued:0});
  }finally{releaseFixture(holder);await Promise.all([idle(holder.id),idle(queued.id)]);}
  const next=chat({permission:'read'});await T.sendMessage(next.id,'capacity available again');assert.equal((await idle(next.id)).messages.at(-1).status,'done');assert.equal(T.getAgentProcessStats().active,0);
 });
});

test('an agent failure releases its slot for another selected responder',async()=>{
 await withProcessLimit(1,async()=>{
  const t=chat({permission:'read',responders:['ea','eb']});await T.sendMessage(t.id,'one-fails-fixture');
  const done=await idle(t.id);assert.equal(done.messages.find(m=>m.tool==='ea').status,'error');assert.equal(done.messages.find(m=>m.tool==='eb').status,'done');assert.equal(T.getAgentProcessStats().active,0);
 });
});

test('duplicate initial handoffs are coalesced and run after both initial responses',async()=>{
 const t=chat({permission:'read',autoRelay:true,members:['ea','eb','ec'],responders:['ea','eb']});
 await T.sendMessage(t.id,'dedup-relay-fixture');const done=await idle(t.id);
 assert.deepEqual(done.messages.filter(m=>m.role==='agent').map(m=>m.tool),['ea','eb','ec']);
 const prompt=fs.readFileSync(path.join(t.cwd,'ec.prompt'),'utf8');assert.match(prompt,/EA_INITIAL_COMPLETED/);assert.match(prompt,/EB_INITIAL_COMPLETED/);
});

test('ordered relay chains keep the hop limit under concurrent direct dispatch',async()=>{
 const t=chat({permission:'read',autoRelay:true,members:['ea','eb','ec','ed','ee','ef']});
 await T.sendMessage(t.id,'hop-relay-fixture');const done=await idle(t.id);
 assert.deepEqual(done.messages.filter(m=>m.role==='agent').map(m=>m.tool),['ea','eb','ec','ed','ee']);
 assert.ok(done.messages.some(m=>m.role==='system' && /after 4 hops/.test(m.content)));
});

test('same native-session waiters leave free process capacity for another chat',async()=>{
 await withProcessLimit(2,async()=>{
  const t=chat(), p=plan(t,[{owner:'ea',kind:'read',title:'bounded-slot-fixture'},{owner:'ea',kind:'read',title:'bounded-slot-fixture'}]);
  const other=chat({permission:'read'});
  try{
   T.runPlan(t.id,p.id);await waitForFixture(()=>fs.existsSync(path.join(t.cwd,'ea.started')),'session holder');
   await T.sendMessage(other.id,'bounded-slot-fixture other session');await waitForFixture(()=>fs.existsSync(path.join(other.cwd,'ea.started')),'unrelated native session');
   assert.deepEqual(T.getAgentProcessStats(),{limit:2,active:2,queued:0});
  }finally{releaseFixture(t);releaseFixture(other);await Promise.all([idle(t.id),idle(other.id)]);}
  assert.equal(T.getPlan(p.id).status,'done');
  const order=fs.readFileSync(path.join(t.cwd,'process-trace.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(order.map(x=>x.event),['start','end','start','end']);
 });
});

test('multi-agent quota exhaustion retains a single automatic reset wait',async()=>{
 F.markExhausted('ea','usage limit, try again in 3 hours');F.markExhausted('eb','usage limit, try again in 2 hours');
 const t=chat({permission:'read',responders:['ea','eb'],fallback:{enabled:true,order:['ea','eb'],waitForReset:true}});
 try{
  await T.sendMessage(t.id,'parallel all-out fixture');await idle(t.id);
  assert.ok(T.waitingInfo(t.id));assert.equal(T.getThread(t.id).messages.filter(m=>m.role==='system' && /All agents are out of credits/.test(m.content)).length,1);
 }finally{T.cancelWaiting(t.id);F.clearExhausted('ea');F.clearExhausted('eb');}
});

test('a completed initial responder can ask the owner while its peer is still working',async()=>{
 const t=chat({permission:'read',responders:['ea','eb']});
 try{
  await T.sendMessage(t.id,'parallel-question-fixture');
  await waitForFixture(()=>T.getThread(t.id).questions.some(q=>q.status==='pending'),'initial question');
  assert.equal(T.getThread(t.id).running,true);
  assert.ok(T.getThread(t.id).messages.some(m=>m.tool==='eb' && m.status==='running'));
 }finally{releaseFixture(t);await idle(t.id);}
});
