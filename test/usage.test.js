import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(),'conclave-usage-'));
const profile = path.join(temp,'profile');fs.mkdirSync(profile);
process.env.USERPROFILE = profile;process.env.HOME = profile;
process.env.AGENT_HUB_DB = path.join(temp,'test.db');
process.env.AGENT_HUB_DATA_DIR = path.join(temp,'data');
const { readCopilotLimits, normalizeLimits, getLimits } = await import('../src/agents/catalog.js');
const { usageOf, copilotUsageText } = await import('../public/views/plan.js');
const { renderLimitCards, meter } = await import('../public/views/usage.js');
const { getDb, kvSet } = await import('../src/db.js');
const { outOfCredits } = await import('../src/agents/failover.js');
after(()=>{getDb().close();fs.rmSync(temp,{recursive:true,force:true});});

function session(dir,id,snapshots,mtime) {
  const p=path.join(dir,id,'events.jsonl');fs.mkdirSync(path.dirname(p),{recursive:true});
  fs.writeFileSync(p,snapshots.map(value=>typeof value==='string'?value:JSON.stringify(value)).join('\n'));
  if(mtime)fs.utimesSync(p,mtime,mtime);
  return p;
}
const snapshot = (data,timestamp='2026-11-01T00:00:00.000Z')=>({timestamp,data:{accountingSnapshot:data}});

test('missing or unreadable Copilot accounting stays unknown, never ready or zero',()=>{
  assert.equal(readCopilotLimits({sessionDir:path.join(temp,'absent')}),null);
  const dir=path.join(temp,'bad');session(dir,'bad',['not JSON']);
  assert.equal(readCopilotLimits({sessionDir:dir}),null);
  assert.deepEqual(usageOf('copilot',{},{}),{pct:null,text:'usage unknown'});
  assert.doesNotMatch(renderLimitCards({}),/GitHub Copilot/);
  const card=renderLimitCards({}, {}, Date.now(), [{id:'copilot'}]);
  assert.match(card,/GitHub Copilot/);assert.match(card,/usage unknown/);
  assert.doesNotMatch(card,/ready \(0|0 credits used|1 request/);
});

test('Copilot snapshot preserves zero and uses accounting-event freshness, not later file edits',t=>{
  t.mock.method(Date,'now',()=>Date.parse('2026-11-01T00:02:00.000Z'));
  const dir=path.join(temp,'zero');
  session(dir,'example-session',[
    snapshot({totalNanoAiu:200000000,totalUserRequests:2}),
    snapshot({totalNanoAiu:0,totalUserRequests:0,totalPremiumRequestCost:99}),
    '{incomplete tail',
  ],new Date('2026-11-02T00:00:00Z'));
  const result=readCopilotLimits({sessionDir:dir});
  assert.equal(result.scope,'session');assert.equal(result.sessionId,'example-session');
  assert.equal(result.creditsUsed,0);assert.equal(result.requests,0);
  assert.equal(result.seen,'2026-11-01T00:00:00.000Z');assert.equal(result.seenSource,'event');
  assert.match(copilotUsageText(result),/session 0 credits used · 0 requests · recorded 2m ago/);
  assert.doesNotMatch(copilotUsageText(result),/T00:00:00|\.000Z/);
});

test('Copilot usage is a single session snapshot, not an aggregate or inferred request allowance',()=>{
  const dir=path.join(temp,'scoped');
  session(dir,'older',[snapshot({totalNanoAiu:700000000,totalUserRequests:8})],new Date('2026-10-30'));
  session(dir,'latest',[snapshot({totalNanoAiu:200000000,totalUserRequests:1})],new Date('2026-10-31'));
  const result=readCopilotLimits({sessionDir:dir});
  assert.equal(result.creditsUsed,.2);assert.equal(result.requests,1);
  const card=renderLimitCards({copilot:result});
  assert.match(card,/session 0.2 credits used/);assert.match(card,/recorded /);
  assert.match(card,/account allowance and billing-period totals are unknown/);
});

test('partial and malformed counters are not fabricated; fallback timestamp is labeled as file freshness',()=>{
  const dir=path.join(temp,'partial');
  const file=session(dir,'partial',[{data:{accountingSnapshot:{totalNanoAiu:false,totalPremiumRequestCost:5}}}]);
  const result=readCopilotLimits({sessionDir:dir});
  assert.equal(result.creditsUsed,null);assert.equal(result.requests,null);
  assert.equal(result.seenSource,'file');assert.equal(result.seen,new Date(fs.statSync(file).mtimeMs).toISOString());
  assert.match(copilotUsageText(result),/session usage unknown · file updated/);
  assert.doesNotMatch(copilotUsageText(result),/0 credits|1 request/);
  assert.match(copilotUsageText({creditsUsed:.000000001,requests:0,seen:'bad'}),/1e-9 credits used · 0 requests · observation time unknown/);
});

test('expired Claude and Codex windows disappear while active percentages clamp without mutating snapshots',()=>{
  const now=Date.now();
  const original={claude:{status:'rejected',resetsAt:(now-1)/1000,unifiedWindows:{five_hour:{utilization:1.16,resetsAt:(now-1)/1000},seven_day:{utilization:.25,resetsAt:(now+60000)/1000}}},
    codex:{primary:{usedPct:116,resetsAt:now+60000},secondary:{usedPct:100,resetsAt:now-1}}};
  const before=structuredClone(original), l=normalizeLimits(original,now);
  assert.deepEqual(original,before);
  assert.equal(l.claude.unifiedWindows.five_hour,undefined);assert.equal(l.claude.status,'unknown');
  assert.equal(l.codex.primary.usedPct,100);assert.equal(l.codex.secondary,null);
  assert.equal(usageOf('claude',original,{},now).pct,25);
  assert.equal(usageOf('codex',original,{},now).text,'100% used');
  assert.equal(usageOf('codex',{codex:{primary:{usedPct:116,resetsAt:now-1}}},{},now).pct,null);
  assert.equal(usageOf('claude',{claude:{unifiedWindows:{five_hour:{utilization:1.16,resetsAt:(now+60000)/1000}}}},{},now).pct,100);
});

test('Antigravity relative refresh windows expire using observation time, including compact durations',()=>{
  const now=Date.now(), l=normalizeLimits({antigravity:{seen:new Date(now-45*60000).toISOString(),groups:[{name:'sample',windows:[
    {window:'5h',remainingPct:0,refresh:'30m'}, {window:'weekly',remainingPct:-16,refresh:'1h30m'},
  ]}]}},now);
  assert.equal(l.antigravity.groups[0].windows.length,1);
  assert.equal(l.antigravity.groups[0].windows[0].resetsAt,now+45*60000);
  assert.equal(l.antigravity.groups[0].windows[0].remainingPct,0);
  assert.equal(usageOf('antigravity',l,{},now).pct,100);
});

test('Usage cards and ARIA meters never show over-100%, stale exhaustion, or NaN',()=>{
  const now=Date.now();
  for(const pct of [116,1000]){
    const html=meter('Sample',pct,'');assert.match(html,/aria-valuenow="100"/);assert.match(html,/>100%</);assert.doesNotMatch(html,new RegExp('>'+pct+'%'));
  }
  for(const pct of [null,undefined,false,NaN,''])assert.match(meter('Sample',pct,''),/usage unknown/);
  const html=renderLimitCards({codex:{primary:{usedPct:116,windowMin:300,resetsAt:now-1}}},{codex:{until:now-1}},now);
  assert.match(html,/No current limit window/);assert.doesNotMatch(html,/116%|Out of credits|NaN/);
  assert.equal(usageOf('codex',{}, {codex:{until:now-1}},now).out,undefined);
});

test('normalized active exhaustion still blocks dispatch; expired cached windows do not',t=>{
  const now=Date.now();
  const sessions=path.join(profile,'.codex','sessions');fs.mkdirSync(sessions,{recursive:true});
  fs.writeFileSync(path.join(sessions,'fixture.jsonl'),JSON.stringify({payload:{rate_limits:{primary:{used_percent:116,window_minutes:300,resets_at:(now+10000)/1000}}}}));
  kvSet('ratelimit:claude',{unifiedWindows:{five_hour:{utilization:1.16,resetsAt:(now+60000)/1000}}});
  assert.equal(getLimits().claude.unifiedWindows.five_hour.utilization,1);
  assert.ok(outOfCredits('claude'));
  kvSet('ratelimit:claude',{status:'rejected',resetsAt:(now-1)/1000,unifiedWindows:{five_hour:{utilization:1.16,resetsAt:(now-1)/1000}}});
  assert.equal(outOfCredits('claude'),null);
  assert.deepEqual(getLimits().claude.unifiedWindows,{});
  assert.equal(getLimits().codex.primary.usedPct,100);
  assert.ok(outOfCredits('codex'));
  // The snapshot cache is still within its 30s TTL. Expiry must nevertheless
  // be checked against the current time on every access.
  t.mock.method(Date,'now',()=>now+15000);
  assert.equal(getLimits().codex.primary,null);
  assert.equal(outOfCredits('codex'),null);
});
