// Isolated browser fixtures. No live model, speech service or Telegram call.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {createCredentials} from '../src/auth.js';
import {openDb} from '../assistant/src/db.js';
const dir=mkdtempSync(join(tmpdir(),'conclave-management-ui-'));
const profile=join(dir,'profile');mkdirSync(profile);
const owner=join(dir,'owner.json');writeFileSync(owner,JSON.stringify(await createCredentials('owner','fixture-password-123')));
const db=openDb(join(dir,'assistant','jarvis.sqlite'));
for(let i=0;i<8;i++)db.prepare('INSERT INTO memories(id,content,updated_at) VALUES(?,?,?)').run('fixture-'+i,`Project memory ${i}: review the calendar and project schedule`,Date.now());db.close();
const port=await new Promise(resolve=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['server.js'],{env:{...process.env,HOME:profile,USERPROFILE:profile,CONCLAVE_PORT:String(port),CONCLAVE_AUTH_FILE:owner,CONCLAVE_PUBLIC_ORIGIN:'',CONCLAVE_INTERNAL_TOKEN:'',CONCLAVE_ASSISTANT_ENABLED:'1',SESSION_SECRET:'ab'.repeat(32),TOKEN_ENCRYPTION_KEY:'cd'.repeat(32),AGENT_HUB_DATA_DIR:join(dir,'coding'),AGENT_HUB_DB:join(dir,'coding','hub.db'),DATA_DIR:join(dir,'assistant')},stdio:'ignore'});
const closed=new Promise(r=>child.once('close',r));let browser;
try{
 for(let i=0;i<100;i++){try{if((await fetch(base+'/api/auth/status')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
 browser=await chromium.launch({headless:true,executablePath:process.env.CONCLAVE_BROWSER || '/usr/bin/chromium-browser',args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const login=await page.request.post(base+'/api/auth/login',{headers:{Origin:base},data:{username:'owner',password:'fixture-password-123'}});assert.equal(login.status(),200);
 await page.goto(base+'/#/management');
 let frame=page.frameLocator('.assistant-frame');await frame.getByRole('heading',{name:'Jarvis',exact:true}).waitFor();
 assert.equal(await page.locator('#sidebar').count(),1);
 assert.equal(await frame.locator('#shell > aside').isVisible(),false);
 // The outer sidebar stays the same DOM node while navigating Jarvis sections.
 await page.locator('#sidebar').evaluate(e=>e.dataset.preserved='yes');
 for(const theme of ['dark','light']){
  await page.evaluate(t=>{localStorage.setItem('hub-theme',t);document.documentElement.dataset.theme=t;},theme);
  await frame.locator('html').evaluate((_,t)=>new Promise(resolve=>{const check=()=>document.documentElement.dataset.theme===t?resolve():setTimeout(check,20);check();}),theme);
  const colors=await page.locator('html').evaluate(e=>[getComputedStyle(e).getPropertyValue('--bg').trim(),getComputedStyle(e).getPropertyValue('--text').trim()]);
  assert.deepEqual(await frame.locator('html').evaluate(e=>[getComputedStyle(e).getPropertyValue('--bg').trim(),getComputedStyle(e).getPropertyValue('--text').trim()]),colors);
 }
 assert.equal(await page.locator('.version-badge').textContent(),'v2.0.0');
 await page.locator('[data-nav="mind"]').click();frame=page.frameLocator('.assistant-frame');await frame.locator('canvas').waitFor();
 await frame.getByRole('button',{name:'List view',exact:true}).click();await frame.locator('.memory-list button').first().click();
 await frame.getByRole('textbox',{name:'Edit selected memory'}).fill('Updated project memory from the inspector');
 await frame.getByRole('button',{name:'Save',exact:true}).click();
 await frame.getByRole('button',{name:'List view',exact:true}).click();await frame.getByRole('searchbox',{name:'Find a memory'}).fill('Updated project memory');
 assert.equal(await frame.locator('.memory-list button').count(),1);
 await frame.getByRole('button',{name:'3D view',exact:true}).click();await frame.locator('canvas').waitFor({state:'visible'});
 await page.screenshot({path:'/tmp/conclave-memory-desktop.png',fullPage:true});
 assert.equal(await page.locator('#sidebar').getAttribute('data-preserved'),'yes');
 await page.locator('[data-nav="telegram"]').click();frame=page.frameLocator('.assistant-frame');
 await frame.locator('[name="api_id"]').fill('12345');await frame.locator('[name="api_hash"]').fill('ab'.repeat(16));await frame.locator('[name="owner_id"]').fill('123456');await frame.locator('[name="session"]').fill('1'+'A'.repeat(352));
 await frame.getByRole('button',{name:'Save encrypted credentials'}).click();
 await frame.getByRole('button',{name:'Save Telegram settings'}).waitFor();
 assert.equal(await frame.locator('[name="api_hash"]').inputValue(),'');assert.equal(await frame.locator('[name="session"]').inputValue(),'');
 await page.setViewportSize({width:390,height:844});
 assert.ok(await frame.locator('body').evaluate(e=>e.scrollWidth<=innerWidth+1));
 await page.goto(base+'/assistant/#dashboard');await page.waitForURL('**/#/mind');await page.frameLocator('.assistant-frame').locator('canvas').waitFor();
 assert.deepEqual(errors,[]);console.log('Management browser checks passed: persistent shell, light/dark tokens, memory edits/list/search, masked credentials, phone layout and legacy links.');
}finally{await browser?.close();child.kill();await closed;rmSync(dir,{recursive:true,force:true});}
