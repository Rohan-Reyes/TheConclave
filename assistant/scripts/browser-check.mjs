import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { passwordHash } from '../src/security.js';
const db = openDb(':memory:');
db.prepare('INSERT INTO owner VALUES(1,?,?)').run('browser-test-owner', passwordHash('test-only-local-password'));
const app = createApp({ db, origin: 'http://localhost:4217', secret: '11'.repeat(32), encryptionKey: '22'.repeat(32) });
await new Promise(resolve => app.listen(4217, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const cdp=await page.context().newCDPSession(page);await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  const errors = []; page.on('pageerror', e=>errors.push(e.message));
  await page.goto('http://localhost:4217');
  await page.getByLabel('Username', { exact: true }).fill('browser-test-owner');
  await page.getByLabel('Password', { exact: true }).fill('test-only-local-password');
  await page.getByRole('button', { name: 'Sign in securely' }).click();
  await page.locator('#shell').waitFor({state:'visible'});
  await page.getByRole('link', { name: 'Tasks & Automations' }).click();
  await page.getByLabel('Reminder', { exact: true }).fill('Browser test reminder');
  await page.getByLabel('When', { exact: true }).fill('Tomorrow at 9 AM');
  await page.getByRole('button', { name: 'Preview schedule' }).click();
  await page.getByRole('button', { name: 'Confirm & save' }).click();
  await page.getByRole('heading', { name: 'Browser test reminder', exact: true }).waitFor();
  for (const title of ['Today','Inbox','Connections','Devices','Settings','Chat']) {
    await page.getByRole('link', { name: title, exact: true }).click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#page-title').textContent(), title);
    assert.equal(await page.locator('#content > .error-text').count(), 0, `${title} page error`);
  }
  await page.getByRole('link', { name:'Settings',exact:true }).click();
  await page.getByLabel('A preference or fact').fill('Prefer morning meetings.');
  await page.getByRole('button', { name:'Remember this',exact:true }).click();
  await page.getByLabel('Edit remembered fact').waitFor();
  await page.reload(); await page.getByLabel('Edit remembered fact').waitFor();
  await page.getByLabel('Passkey name',{exact:true}).fill('Browser virtual passkey');
  await page.getByLabel('Confirm password to enroll').fill('test-only-local-password');
  await page.getByRole('button',{name:'Add a passkey',exact:true}).click();
  await page.getByRole('heading',{name:'Browser virtual passkey',exact:true}).waitFor();
  await page.locator('#logout').click();await page.locator('#login').waitFor({state:'visible'});
  await page.getByRole('button',{name:'Sign in with a passkey',exact:true}).click();await page.locator('#shell').waitFor({state:'visible'});
  await page.getByRole('link', { name:'Connections',exact:true }).click();
  await page.getByRole('heading', { name:'Google Workspace',exact:true }).waitFor();
  mkdirSync('artifacts', { recursive:true }); await page.screenshot({path:'artifacts/connections-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  for (const title of ['Chat','Today','Tasks & Automations','Inbox','Connections','Devices','Settings']) {
    await page.locator(`nav a[data-page="${{'Tasks & Automations':'tasks',Chat:'chat',Today:'today',Inbox:'inbox',Connections:'connections',Devices:'devices',Settings:'settings'}[title]}"]`).click();
    await page.waitForTimeout(150);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1), `${title} overflows at mobile width`);
  }
  await page.screenshot({path:'artifacts/settings-mobile.png',fullPage:true});
  assert.deepEqual(errors, []); console.log('Browser checks passed: password/passkey login, passkey registration, schedule preview/confirmation, all seven sections, persistent memory, desktop/mobile layout, no browser errors.');
} finally { await browser.close(); await new Promise(resolve=>app.close(resolve)); db.close(); }
