// Offline smoke test for council plans and questions (no real agents, no credits).
// Uses two fake CLI agents and a throwaway database.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-plans-'));
process.env.AGENT_HUB_DB = path.join(tmp, 'hub.db');
const fake = path.join(tmp, 'fake-agent.mjs');
// The fake agent reads the prompt on stdin and answers by its role.
fs.writeFileSync(fake, `
let s = ''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => {
  const me = process.argv[2];
  if (s.includes('You chair this council')) {
    console.log('Verdict: do it in 3 steps.');
    console.log('\`\`\`conclave-plan');
    console.log(JSON.stringify({ summary: 'demo', steps: [
      { id: 'a', title: 'write file one', owner: 'fa', files: ['one.txt'], kind: 'build', effort: 2 },
      { id: 'b', title: 'write file two', owner: 'any', files: ['two.txt'], kind: 'build', effort: 2 },
      { id: 'c', title: 'review both', owner: 'fb', kind: 'read', dependsOn: ['a', 'b'], effort: 1 },
    ] }, null, 1).replace('"effort": 1\\n', '"effort": 1,\\n'));   // trailing comma: lenient parser must cope
    console.log('\`\`\`');
  } else if (s.includes('PLAN STEP c') && !s.includes('The user answered')) {
    console.log('I need a decision.');
    console.log('\`\`\`conclave-question\\n{"question": "Tabs or spaces?", "options": ["tabs", "spaces"]}\\n\`\`\`');
  } else if (s.includes('PLAN STEP')) {
    console.log(me + ' did: ' + (s.match(/PLAN STEP (\\w+)/) || [])[1] + (s.includes('The user answered') ? ' (with answer)' : ''));
  } else {
    console.log(me + ' says hi');
  }
}); `);

const { getDb } = await import('../src/db.js');
const drivers = await import('../src/agents/drivers.js');
const T = await import('../src/agents/threads.js');
getDb();
for (const id of ['fa', 'fb']) drivers.saveAgent({ id, name: id.toUpperCase(), command: process.execPath, args: [fake, id], input: 'stdin' });

const idle = async id => { for (let i = 0; i < 200; i++) { if (!T.getThread(id).running) return T.getThread(id); await new Promise(r => setTimeout(r, 100)); } throw new Error('timeout'); };
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };

const t = T.createThread({ cwd: tmp, target: 'council', settings: { members: ['fa', 'fb'], chair: 'fa', rounds: 0, permission: 'edit', approvalMode: 'auto', fallback: { enabled: false } } });
T.sendMessage(t.id, 'build the demo');
let th = await idle(t.id);
let plan = th.plans[0];
ok(plan && plan.steps.length === 3, `plan parsed despite trailing comma (${plan?.status})`);
ok(plan.steps.find(s => s.id === 'a').status === 'done' && plan.steps.find(s => s.id === 'b').status === 'done', 'auto mode ran build steps a and b');
ok(plan.steps.find(s => s.id === 'b').assignee === 'fb', `"any" step balanced to the less-loaded agent (got ${plan.steps.find(s => s.id === 'b').assignee})`);
ok(plan.steps.find(s => s.id === 'c').status === 'waiting' && plan.status === 'paused', 'question block paused step c');
ok(th.questions.length === 1 && th.questions[0].options.length === 2, 'question card data stored with options');
const order = th.messages.filter(m => m.round?.startsWith('step-')).map(m => m.round);
ok(order.indexOf('step-a') < order.indexOf('step-b'), 'one writer at a time: a finished before b started');

T.answerQuestion(th.questions[0].id, 'spaces');
let stale = false; try { T.answerQuestion(th.questions[0].id, 'tabs'); } catch (e) { stale = e.status === 409; }
ok(stale, 'second answer to the same question is rejected');
th = await idle(t.id);
plan = th.plans[0];
ok(plan.status === 'done', `answer resumed the step and the plan finished (${plan.status})`);
ok(th.messages.some(m => m.content.includes('did: c (with answer)')), 'resumed step received the answer');

let dup = false; try { T.runPlan(t.id, plan.id); } catch (e) { dup = e.status === 409; }
ok(dup, 'Run plan on a finished plan is refused');

// Manual mode: plan waits for Run plan.
const t2 = T.createThread({ cwd: tmp, target: 'council', settings: { members: ['fa', 'fb'], chair: 'fa', rounds: 0, permission: 'edit', approvalMode: 'manual', fallback: { enabled: false } } });
T.sendMessage(t2.id, 'build again');
let th2 = await idle(t2.id);
ok(th2.plans[0].status === 'proposed', 'manual mode leaves the plan proposed');
T.runPlan(t2.id, th2.plans[0].id);
let dup2 = false; try { T.runPlan(t2.id, th2.plans[0].id); } catch (e) { dup2 = e.status === 409; }
ok(dup2, 'double click on Run plan is refused while running');
th2 = await idle(t2.id);
ok(['paused', 'done'].includes(th2.plans[0].status), `Run plan executed it (${th2.plans[0].status})`);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
