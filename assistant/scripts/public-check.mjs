import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
// Optional edge-IP argument bypasses only stale local DNS while retaining TLS/Host validation.
const edge=process.argv[2];
if(edge&&!/^\d{1,3}(\.\d{1,3}){3}$/.test(edge))throw new Error('Expected IPv4 edge address');
const browser=await chromium.launch({args:edge?[`--host-resolver-rules=MAP jarvis.aten-systems.site ${edge}`]:[]});
try{
  mkdirSync('artifacts',{recursive:true});
  for(const [name,url,ignoreHTTPSErrors]of [['public','https://jarvis.aten-systems.site',false],['lan','https://192.168.100.156:3443',true]]){
    const context=await browser.newContext({ignoreHTTPSErrors,viewport:{width:1280,height:850}}),page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const response=await page.goto(url,{waitUntil:'networkidle'});assert.equal(response.status(),200);
    await page.locator('#login-form').waitFor({state:'visible'});
    assert.equal(await page.getByRole('button',{name:'Sign in securely'}).count(),1);
    const health=await page.evaluate(async()=>({status:(await fetch('/api/health')).status}));assert.equal(health.status,200);
    assert.deepEqual(errors,[]);await page.screenshot({path:`artifacts/deployed-${name}.png`,fullPage:true});
    console.log(`${name}: HTTPS login page, assets, health endpoint and browser JavaScript passed.`);await context.close();
  }
}finally{await browser.close();}
