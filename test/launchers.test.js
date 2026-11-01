import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-launchers-'));
process.env.AGENT_HUB_DB = path.join(temp, 'test.db');
process.env.AGENT_HUB_DATA_DIR = path.join(temp, 'data');
const { runTurn, saveAgent } = await import('../src/agents/drivers.js');
const { isQuotaError, isLaunchError, exhaustionSummary } = await import('../src/agents/failover.js');
const { getDb } = await import('../src/db.js');
after(() => { getDb().close(); fs.rmSync(temp, { recursive:true,force:true }); });

test('configured agent with a missing executable reaches process spawning and returns a launch failure', async () => {
  const command = path.join(temp, 'missing executable.exe');
  saveAgent({ id:'missing-fixture',name:'Missing fixture',command,args:[],input:'stdin' });
  const result = await runTurn('missing-fixture',{cwd:temp,prompt:'not an unknown-agent test'}).promise;
  assert.match(result.error,/ENOENT/);
  assert.doesNotMatch(result.error,/Unknown agent/i);
  assert.equal(isLaunchError(result.error),true);
  assert.equal(isQuotaError(result.error),false);
  assert.equal(result.text,'');
});

const fake = path.join(temp, 'fake agent transport.mjs');
fs.writeFileSync(fake, `let prompt='';for await(const chunk of process.stdin)prompt+=chunk;console.log(JSON.stringify({prompt,args:process.argv.slice(2)}));`);
const prompt = 'Exact "double quotes", \'single quotes\', Unicode \u4f60\u597d \ud83d\ude80\r\nline two\n& | < > ^ %PATH% !name! $VAR $(literal) `literal`\n';
test('configured Node agent receives multiline prompts and Windows metacharacters intact over stdin', async () => {
  saveAgent({id:'stdin-fixture',name:'Stdin fixture',command:process.execPath,args:[fake,'argument with spaces'],input:'stdin'});
  const result = await runTurn('stdin-fixture',{cwd:temp,prompt,permission:'read'}).promise;
  assert.equal(result.error,null);
  assert.deepEqual(JSON.parse(result.text),{prompt,args:['argument with spaces']});
});

test('configured argument-mode agent preserves a prompt as one argument without shell expansion', async () => {
  saveAgent({id:'argv-fixture',name:'Argv fixture',command:process.execPath,args:[fake,'{prompt}'],input:'arg'});
  const result = await runTurn('argv-fixture',{cwd:temp,prompt,permission:'read'}).promise;
  assert.equal(result.error,null);
  assert.deepEqual(JSON.parse(result.text),{prompt:'',args:[prompt]});
});

test('launch failures, quota errors, stalls and stopped runs remain distinct', () => {
  for(const error of ['Could not start copilot: spawn copilot ENOENT','spawn nonexistent-cmd ENOENT','Executable not found: fixture']) {
    assert.equal(isLaunchError(error),true);assert.equal(isQuotaError(error),false);
  }
  for(const error of ['Stalled: no output for 4 minutes','Stopped']) {
    assert.equal(isLaunchError(error),false);assert.equal(isQuotaError(error),false);
  }
  assert.equal(isQuotaError('HTTP 429 too many requests'),true);
  assert.equal(isLaunchError('out of credits'),false);
  assert.match(exhaustionSummary(true,['one is out']),/All agents are out of credits/);
  assert.doesNotMatch(exhaustionSummary(false,['one failed to launch']),/All agents are out of credits/);
});
