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
for (const id of ['ea', 'eb', 'quota', 'reviewfail']) D.saveAgent({ id, name: id, command: process.execPath, args: [fake, id], input: 'stdin' });
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
