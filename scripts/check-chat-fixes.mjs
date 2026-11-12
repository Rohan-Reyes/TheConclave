// Synthetic data only. No model or external connector is invoked.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const temp=mkdtempSync(join(tmpdir(),'conclave-chat-ui-'));
const project=join(temp,'fixture-project');mkdirSync(project);writeFileSync(join(project,'package.json'),JSON.stringify({scripts:{fixture:'node -e "console.log(123)"'}}));
const emptyFolder=join(temp,'empty-project');mkdirSync(emptyFolder);
const profile=join(temp,'profile');mkdirSync(profile);
process.env.TOKEN_ENCRYPTION_KEY='ac'.repeat(32);
process.env.AGENT_HUB_DB=join(temp,'hub.db');process.env.AGENT_HUB_DATA_DIR=join(temp,'data');
const {createThread}=await import('../src/agents/threads.js');
const {getDb,now}=await import('../src/db.js');
const thread=createThread({title:'Synthetic UI fixture',cwd:project,target:'codex',settings:{sync:false,permission:'read',approvalMode:'manual'}});
getDb().prepare('INSERT INTO plans(id,thread_id,status,summary,steps,created,updated) VALUES(?,?,?,?,?,?,?)').run('fixture-plan',thread.id,'proposed','Synthetic project plan',JSON.stringify([{id:'1',title:'Inspect fixture',owner:'codex',status:'queued',dependsOn:[],files:[]}]),now(),now());
const port=await new Promise(resolve=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['server.js'],{cwd:process.cwd(),env:{...process.env,HOME:profile,USERPROFILE:profile,CONCLAVE_PORT:String(port),CONCLAVE_AUTH_FILE:'',CONCLAVE_PUBLIC_ORIGIN:'',CONCLAVE_ASSISTANT_ENABLED:'0',CONCLAVE_INTERNAL_TOKEN:''},stdio:'ignore'});
const closed=new Promise(resolve=>child.once('close',resolve));
let browser, page, stage='startup';
try {
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/stats')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  browser=await chromium.launch({headless:true,...(process.env.CONCLAVE_BROWSER?{executablePath:process.env.CONCLAVE_BROWSER}:{}),args:['--no-sandbox']});
  page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.stack || e.message));
  await page.route('**/api/runner/jobs/*/events?*', async route => {await new Promise(r=>setTimeout(r,300));await route.continue();});
  await page.route('**/api/models',route=>route.fulfill({json:Object.fromEntries(['claude','antigravity','codex'].map(id=>[id,{models:[{id:'',label:'Default'}],efforts:['medium']}]))}));
  // Guard against accidentally starting an AI while exercising controls.
  await page.route('**/api/threads/*/messages',route=>route.request().method()==='POST'?route.abort():route.continue());
  stage='settings variables, prompts and skills';
  await page.goto(base+'/#/config?tab=variables');await page.locator('#variable-add').click();
  await page.locator('#variable-form [name="name"]').fill('FIXTURE_VAULT_TOKEN');await page.locator('#variable-form [name="value"]').fill('browser-secret-fixture-321');
  await page.locator('#variable-form .global-target[value="codex"]').check();await page.locator('#variable-form [type="submit"]').click();
  await page.locator('[data-variable-edit="FIXTURE_VAULT_TOKEN"]').waitFor();
  assert.ok(!(await page.content()).includes('browser-secret-fixture-321'));
  assert.ok(!JSON.stringify(await(await fetch(base+'/api/globals/variables')).json()).includes('browser-secret-fixture-321'));
  await page.locator('[data-variable-edit="FIXTURE_VAULT_TOKEN"]').click();assert.equal(await page.locator('#variable-form [name="value"]').inputValue(),'');await page.locator('#variable-cancel').click();
  await page.goto(base+'/#/config?tab=prompts');await page.locator('#prompt-add').click();await page.locator('#global-prompt-form [name="title"]').fill('Fixture writing style');await page.locator('#global-prompt-form [name="content"]').fill('Use concise paragraphs.');await page.locator('#global-prompt-form [type="submit"]').click();
  await page.locator('[data-prompt-toggle]').click();await page.getByText('Off',{exact:true}).waitFor();
  await page.goto(base+'/#/config?tab=skills');await page.locator('#skill-install').click();await page.locator('#install-name').fill('fixture-workflow');await page.locator('#install-content').fill('---\nname: fixture-workflow\ndescription: Synthetic skill for UI checks\n---\nFollow project instructions.');await page.locator('.install-target[value="codex"]').check();await page.locator('#install-review').click();await page.locator('#install-apply:not([disabled])').click();await page.getByText('fixture-workflow',{exact:true}).waitFor();
  assert.ok((await import('node:fs')).existsSync(join(profile,'.codex','skills','fixture-workflow','SKILL.md')));
  await page.goto(base+'/#/hub?new=1');await page.locator('#q-target').waitFor();
  await page.locator('#q-target [data-v="codex"]').click();
  assert.equal(await page.locator('#q-target [aria-pressed="true"]').count(),2);
  await page.locator('#q-target [data-v="claude"]').click();
  assert.equal(await page.locator('#q-target [data-v="codex"]').getAttribute('aria-pressed'),'true');
  await page.locator('#q-target [data-v="council"]').click();
  assert.equal(await page.locator('#q-target [aria-pressed="true"]').count(),1);
  assert.equal(await page.locator('#q-target [data-v="council"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#q-target [data-v="codex"]').getAttribute('aria-pressed'),'false');
  await page.locator('#nc2').click();await page.locator('#nc-target').waitFor();
  assert.equal(await page.locator('#nc-target [data-v="council"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#nc-target [data-v="codex"]').getAttribute('aria-pressed'),'false');
  await page.locator('#nc-cwd').fill(project);await page.locator('#nc-go').click();await page.locator('#input').waitFor();
  const createdId=page.url().split('/hub/')[1];const created=await(await fetch(base+'/api/threads/'+createdId)).json();assert.equal(created.target,'council');assert.deepEqual(created.settings.members,['codex']);
  await page.goto(base+'/#/hub/'+thread.id);await page.locator('#input').waitFor();
  await page.locator('#target [data-v="claude"]').click();
  await page.waitForFunction(()=>document.querySelector('#target [data-v="claude"]')?.disabled===false);
  let saved=await(await fetch(base+'/api/threads/'+thread.id)).json();assert.deepEqual(saved.settings.responders,['codex','claude']);
  await page.locator('#target [data-v="council"]').click();await page.waitForFunction(()=>document.querySelector('#target [data-v="council"]')?.disabled===false);
  saved=await(await fetch(base+'/api/threads/'+thread.id)).json();assert.equal(saved.target,'council');assert.deepEqual(saved.settings.members,['codex','claude']);
  await page.locator('#target [data-v="council"]').click();await page.waitForFunction(()=>document.querySelector('#target [data-v="council"]')?.disabled===false);
  await page.locator('#target [data-v="claude"]').click();await page.waitForFunction(()=>document.querySelector('#target [data-v="claude"]')?.disabled===false);
  saved=await(await fetch(base+'/api/threads/'+thread.id)).json();assert.equal(saved.target,'codex');assert.deepEqual(saved.settings.responders,['codex']);
  await page.locator('#open-plan').click();await page.getByRole('heading',{name:'Synthetic project plan'}).waitFor();await page.locator('#plan-quick-close').click();
  await page.locator('#open-runner').click();await page.locator('#rm-content [data-cmd-id="npm:fixture"]').waitFor();assert.equal(await page.locator('#rm-add').count(),1);
  await page.locator('#rm-content [data-cmd-id="npm:fixture"] button').click();
  await page.locator('#cfm-run').click();
  await page.waitForFunction(()=>document.querySelector('#rm-content #log-stream')?.textContent.includes('123'));
  assert.equal(await page.locator('#modal').evaluate(d=>d.open),true);
  stage='empty folder and custom command';
  await page.locator('#rm-folder').fill(emptyFolder);await page.locator('#rm-refresh').click();
  await page.getByText('This folder has no package.json scripts or saved commands.',{exact:false}).waitFor();
  await page.locator('#rm-add').click();await page.locator('#ac-label').fill('Echo spaced argument');await page.locator('#ac-exe').fill(process.execPath);
  await page.locator('#ac-args').fill(JSON.stringify(['-e','console.log("hello spaced argument")']));await page.locator('#ac-save').click();
  stage='run custom command';
  await page.locator('#rm-content [data-act="run-cmd"]').click();await page.locator('#cfm-run').click();
  await page.waitForFunction(()=>document.querySelector('#rm-content #log-stream')?.textContent.includes('hello spaced argument'));
  await page.locator('#rm-close').click();
  await page.goto(base+'/#/runner');await page.getByRole('link').filter({hasText:'fixture-project'}).first().waitFor();
  await page.goto(base+'/#/project/'+encodeURIComponent(project));await page.locator('#project-plan-quick').click();await page.getByRole('heading',{name:'Synthetic project plan'}).waitFor();await page.locator('#plan-quick-close').click();
  const synthetic={id:'stream-fixture',role:'agent',tool:'codex',status:'running',content:'Synthetic streaming output.\n'.repeat(500),created:now(),activity:[]};
  await page.route('**/api/threads/'+thread.id+'*',async route=>{const response=await route.fetch();const data=await response.json();data.running=true;data.messages=[...data.messages,synthetic];await route.fulfill({json:data});});
  await page.evaluate(() => {
    const Native=window.EventSource;
    window.EventSource=class extends Native {
      constructor(...args){super(...args);if(String(args[0]).includes('/api/threads/'))this.fixtureTimer=setInterval(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'delta',id:'stream-fixture',text:'More synthetic output.\n'.repeat(20)})})),60);}
      close(){clearInterval(this.fixtureTimer);super.close();}
    };
  });
  for(const size of [{width:1440,height:1000},{width:390,height:844},{width:844,height:390}]){
    await page.setViewportSize(size);await page.goto(base+'/#/hub/'+thread.id);await page.locator('#input').waitFor();await page.locator('#input').fill('Keep this draft while the agent works.');
    await page.waitForTimeout(500);
    const box=await page.locator('#input').boundingBox(),composer=await page.locator('#composer').boundingBox();
    assert.ok(box.height>=47,JSON.stringify({size,box}));assert.ok(box.y>=0 && box.y+box.height<=size.height,JSON.stringify({size,box,composer}));
    assert.equal(await page.locator('#input').inputValue(),'Keep this draft while the agent works.');
    const card=page.locator('.hm[data-id="stream-fixture"]');
    const metrics=await card.evaluate(el=>({height:el.getBoundingClientRect().height,scroll:el.scrollHeight}));
    assert.ok(metrics.height>=88 && metrics.scroll<=metrics.height+2,JSON.stringify({size,metrics}));
    const logos=await page.locator('#team .agent-logo, #working .agent-logo, .hm[data-id="stream-fixture"] .agent-logo').evaluateAll(images=>images.map(img=>({src:img.getAttribute('src'),loaded:img.complete && img.naturalWidth>0})));
    assert.ok(logos.length>=2,JSON.stringify(logos));assert.ok(logos.every(img=>img.loaded),JSON.stringify(logos));

  }
  stage='non-interrupting Alt+M';const detailRequests=[],stops=[];
  await page.route('**/api/threads/'+thread.id+'/messages',route=>{detailRequests.push(route.request().postDataJSON());return route.fulfill({json:{ok:true,details:true,delivery:'Available at the next context check'}});});
  page.on('request',request=>{if(request.url().endsWith('/stop'))stops.push(request.url());});
  await page.locator('#input').fill('Additional context without interruption.');await page.keyboard.press('Alt+m');
  await page.waitForFunction(()=>document.querySelector('#input')?.value==='');assert.equal(detailRequests.length,1);assert.equal(detailRequests[0].mode,'details');assert.deepEqual(stops,[]);
  stage='mobile settings layout';await page.setViewportSize({width:390,height:844});
  for(const tab of ['variables','prompts','skills']){
    await page.goto(base+'/#/config?tab='+tab);await page.locator('#'+({variables:'variable-add',prompts:'prompt-add',skills:'skill-install'}[tab])).waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile settings overflow: '+tab);
  }
  assert.deepEqual(errors,[]);console.log('PASS: secret masking, global prompts, skill installation, Alt+M without stop, solo/combo/council, saved selection, plan quick views, Runner command confirmation/execution/live logs and project discovery, non-collapsing reply cards/composer and loaded agent logos at desktop/mobile/landscape sizes.');
}catch(error){console.error('Browser stage:',stage);console.error((await page?.locator('#modal-body').innerText().catch(()=>''))?.slice(0,1600));throw error;}finally{await browser?.close();child.kill();await closed;getDb().close();rmSync(temp,{recursive:true,force:true});}
