// Local browser/API acceptance check. Real dossiers are optional and stay in memory/ignored artifacts.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { passwordHash } from '../src/security.js';
import { relevantMemories, recordActivity } from '../src/memory-graph.js';

const fixtures = [
  'I prefer black coffee in the morning', 'I dislike long meetings before 10 AM',
  'My sister Ana birthday is in March', 'Jarvis server runs on my Raspberry Pi',
  'Raspberry Pi uses a Cloudflare tunnel for Jarvis', 'Conclave project is my coding workspace',
  'Gym workout every Tuesday evening', 'I live in Quezon City, Manila',
  'Monthly internet bill is due on the 15th', 'Every weekday at 7 AM send me a briefing',
  'My laptop runs Windows 11', 'Project Aten Systems client deadline is Friday'
];
const sources = [{ name: 'synthetic-memory-profile.txt', content: `# Synthetic memories\n${fixtures.map(text => `- ${text}`).join('\n')}` },
  ...(process.env.MEMORY_FILES || '').split(';').filter(Boolean).map(path => ({ name: basename(path), content: readFileSync(path, 'utf8') }))];
const db = openDb(':memory:');
db.prepare('INSERT INTO owner VALUES(1,?,?)').run('dash-owner', passwordHash('test-only-local-password'));
const origin = 'http://localhost:4218';
const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const phraseKey = phrase => JSON.stringify([normalize(phrase.content), normalize(phrase.topic), phrase.metadata?.kind || phrase.kind || 'fact']);
const app = createApp({ db, origin, secret: '11'.repeat(32), encryptionKey: '22'.repeat(32) });
await new Promise(resolve => app.listen(4218, '127.0.0.1', resolve));
let browser;
async function api(page, path, body) {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }, { path, body });
}
async function signIn(page) {
  await page.goto(origin);
  await page.getByLabel('Username', { exact: true }).fill('dash-owner');
  await page.getByLabel('Password', { exact: true }).fill('test-only-local-password');
  await page.getByRole('button', { name: 'Sign in securely' }).click();
  await page.locator('#shell').waitFor({ state: 'visible' });
}
async function openDashboard(page) {
  await page.goto(`${origin}/#dashboard`);
  await page.locator('.dash-stage canvas').waitFor();
  await page.waitForFunction(() => Number(document.querySelector('.dash-stage canvas')?.dataset.frames) > 1);
}
async function state(page) {
  return page.locator('.dash-stage canvas').evaluate(canvas => Object.fromEntries(Object.entries(canvas.dataset).map(([key, value]) => [key, Number.isFinite(Number(value)) ? Number(value) : value])));
}
try {
  browser = await chromium.launch({ headless: true });
  mkdirSync('artifacts', { recursive: true });
  const setup = await browser.newPage();
  await signIn(setup);
  const expected = new Map();
  for (const source of sources) {
    const countBefore = db.prepare('SELECT count(*) n FROM memories').get().n;
    const preview = await api(setup, '/memories/import/preview', source);
    assert.equal(preview.status, 200, 'Memory import preview must accept the source file');
    assert.equal(db.prepare('SELECT count(*) n FROM memories').get().n, countBefore, 'Preview must not save memories');
    assert(preview.data.total_phrases > 0);
    for (const phrase of preview.data.phrases) if (!expected.has(phraseKey(phrase))) expected.set(phraseKey(phrase), phrase);
    const response = await api(setup, '/memories/import', source);
    assert.equal(response.status, 201, 'Memory import API must accept the source file');
    assert.equal(db.prepare('SELECT count(*) n FROM memories').get().n, expected.size, 'Every unique parsed phrase must be imported');
    const duplicate = await api(setup, '/memories/import', source);
    assert.equal(duplicate.status, 201);
    assert.equal(duplicate.data.imported, 0, 'Reimporting a source must not duplicate its memories');
  }
  const response = await api(setup, '/memories/graph');
  assert.equal(response.status, 200);
  const graph = response.data, memoryNodes = graph.nodes.filter(node => node.type === 'memory'), byId = new Map(graph.nodes.map(node => [node.id, node]));
  assert.equal(memoryNodes.length, expected.size);
  const imported = new Map(memoryNodes.map(node => [phraseKey(node), node]));
  for (const [key, phrase] of expected) {
    const node = imported.get(key); assert(node, 'A parsed source phrase is missing from the graph');
    assert(node.category && graph.categories[node.category], 'Every memory must have a valid category');
    if (phrase.topic) {
      assert.equal(node.topic, phrase.topic, 'Source topic must survive import');
      assert(graph.links.some(link => link.target === node.id && byId.get(link.source)?.type === 'topic'), 'Topic must connect to each imported phrase');
    }
    assert(graph.links.some(link => link.target === node.id && byId.get(link.source)?.type === 'category'), 'Category must connect to each memory');
  }
  assert.equal(graph.nodes.filter(node => node.type === 'jarvis').length, 1);
  for (const link of graph.links) assert(byId.has(link.source) && byId.has(link.target), 'Graph links must have existing endpoints');
  console.log(`Import check passed: ${sources.length} sources, ${memoryNodes.length} unique phrase nodes, hierarchy links, idempotent reimport. Private contents were not logged.`);
  await setup.close();

  for (const [name, viewport] of [['desktop', { width: 1440, height: 950 }], ['phone', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport, hasTouch: name === 'phone', isMobile: name === 'phone' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await signIn(page); await openDashboard(page);
    const canvas = page.locator('.dash-stage canvas');
    assert.match(await canvas.getAttribute('aria-label'), /3D/);
    assert.match(await page.locator('.dash-hud').textContent(), new RegExp(`${expected.size} memories`));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: page must not overflow horizontally`);
    await page.getByRole('checkbox', { name: 'Slowly rotate' }).uncheck();
    await page.getByRole('slider', { name: 'Link length', exact: true }).fill('160');
    await page.getByRole('slider', { name: 'Repel force', exact: true }).fill('1500');
    assert.deepEqual(await page.evaluate(() => { const opts = JSON.parse(localStorage.getItem('jarvis-graph')); return [opts.linkLength, opts.repel, opts.spin]; }), [160, 1500, false]);
    await page.reload(); await page.waitForFunction(() => Number(document.querySelector('.dash-stage canvas')?.dataset.frames) > 1);
    assert.equal(await page.getByRole('slider', { name: 'Link length', exact: true }).inputValue(), '160');
    const category = page.locator('.legend .chip').first(), beforeHidden = await state(page);
    await category.click(); await page.waitForTimeout(120);
    assert((await state(page)).visible < beforeHidden.visible, 'Category filtering must hide nodes');
    await category.click();
    await page.getByRole('searchbox', { name: 'Find a memory' }).fill('Raspberry');
    await page.waitForTimeout(100);
    await page.getByRole('searchbox', { name: 'Find a memory' }).fill('');
    const hits = relevantMemories(db, 'Is the Raspberry Pi tunnel for Jarvis up?');
    assert(hits.length >= 2, 'Fixture must exercise memory activation');
    const at = recordActivity(db, hits, 'chat');
    await page.waitForResponse(async response => response.url().includes('/memories/activity?') && (await response.json()).events.some(event => event.created_at >= at && event.source === 'chat'));
    await page.waitForFunction(() => /\d+ lit/.test(document.querySelector('.dash-hud')?.textContent || ''), null, { timeout: 6000 });
    assert(await page.locator('.feed-row').count() >= 2);
    const selectedId = hits.at(-1).id;
    const activityBefore = db.prepare('SELECT access_count FROM memories WHERE id=?').get(selectedId).access_count;
    await page.locator('.feed-row').first().click();
    await page.getByLabel('Category', { exact: true }).waitFor();
    await page.waitForTimeout(150);
    assert(db.prepare('SELECT access_count FROM memories WHERE id=?').get(selectedId).access_count > activityBefore, 'Opening a memory records access');
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox(), x = box.x + 25, y = box.y + 40;
    const cameraBefore = await state(page);
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 70, y + 25, { steps: 10 }); await page.mouse.up();
    await page.waitForTimeout(120);
    const orbited = await state(page);
    assert(Math.abs(orbited.yaw - cameraBefore.yaw) > .05 || Math.abs(orbited.pitch - cameraBefore.pitch) > .05, 'Dragging empty space must orbit the 3D camera');
    await page.mouse.move(x, y); await page.mouse.wheel(0, -150); await page.waitForTimeout(120);
    assert((await state(page)).zoom > orbited.zoom, 'Wheel must zoom the camera');
    if (name === 'phone') {
      const cdp = await page.context().newCDPSession(page), cy = Math.min(box.y + box.height / 2, viewport.height - 90), cx = viewport.width / 2;
      const beforePinch = await state(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 35, y: cy, id: 1 }, { x: cx + 35, y: cy, id: 2 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 60, y: cy + 5, id: 1 }, { x: cx + 60, y: cy + 5, id: 2 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await page.waitForTimeout(120);
      assert((await state(page)).zoom > beforePinch.zoom, 'Two-finger pinch must zoom');
    }
    const frames = (await state(page)).frames; await page.waitForTimeout(250);
    assert((await state(page)).frames > frames, 'Animation must continue after interactions');
    await page.screenshot({ path: `artifacts/dashboard-${name}.png`, fullPage: name === 'phone' });
    await canvas.evaluate(element => { window.__oldDashboardCanvas = element; });
    await page.locator('nav a[data-page="chat"]').click(); await page.waitForTimeout(150);
    const stopped = await page.evaluate(() => window.__oldDashboardCanvas.dataset.frames);
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => window.__oldDashboardCanvas.dataset.frames), stopped, 'Leaving Dashboard must stop its animation');
    await openDashboard(page);
    assert.equal(await page.locator('.dash-stage canvas').count(), 1, 'Returning must mount only one graph');
    assert.deepEqual(errors, [], `${name}: browser exceptions`); await page.close();
    console.log(`${name}: 3D graph, controls/persistence, category filter, memory activation/selection, orbit/zoom and lifecycle passed.`);
  }
  console.log('Dashboard acceptance checks passed; no production data or services were touched.');
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => app.close(resolve)); db.close();
}
