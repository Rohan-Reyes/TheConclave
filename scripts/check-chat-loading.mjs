// Automated browser test for accelerated chat data, pagination, lazy activity, AbortController guards and reconnect reconciliation.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const temp = mkdtempSync(join(tmpdir(), 'conclave-chat-loading-'));
const project = join(temp, 'fixture-project');
mkdirSync(project);
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'fixture' }));
const profile = join(temp, 'profile');
mkdirSync(profile);

process.env.TOKEN_ENCRYPTION_KEY = 'ac'.repeat(32);
process.env.AGENT_HUB_DB = join(temp, 'hub.db');
process.env.AGENT_HUB_DATA_DIR = join(temp, 'data');

const { createThread } = await import('../src/agents/threads.js');
const { getDb, now } = await import('../src/db.js');

// Thread 1: 75 messages with activity to test pagination (60 limit) and lazy activity
const thread1 = createThread({
  title: 'Long History Thread',
  cwd: project,
  target: 'codex',
  settings: { sync: false, permission: 'read' }
});

const ins = getDb().prepare(
  'INSERT INTO thread_messages(id,thread_id,role,tool,content,activity,status,created) VALUES(?,?,?,?,?,?,?,?)'
);
for (let i = 1; i <= 75; i++) {
  const acts = i % 2 === 0 ? JSON.stringify([`action-1-${i}`, `action-2-${i}`]) : '[]';
  ins.run(
    `msg-t1-${i}`,
    thread1.id,
    i % 2 === 1 ? 'user' : 'agent',
    i % 2 === 1 ? null : 'codex',
    `Message ${i} content in thread 1`,
    acts,
    'done',
    now()
  );
}

// Thread 2: short thread for switching tests
const thread2 = createThread({
  title: 'Second Fast Thread',
  cwd: project,
  target: 'claude',
  settings: { sync: false, permission: 'read' }
});
ins.run('msg-t2-1', thread2.id, 'user', null, 'Hello from thread 2', '[]', 'done', now());
ins.run('msg-t2-2', thread2.id, 'agent', 'claude', 'Claude response in thread 2', '[]', 'done', now());

// Thread 3: cold thread for testing loading state and end-to-end latency measurement
const thread3 = createThread({
  title: 'Cold Thread 3',
  cwd: project,
  target: 'antigravity',
  settings: { sync: false, permission: 'read' }
});
ins.run('msg-t3-1', thread3.id, 'user', null, 'Hello from thread 3', '[]', 'done', now());
ins.run('msg-t3-2', thread3.id, 'agent', 'antigravity', 'Antigravity response in thread 3', '[]', 'done', now());

const port = await new Promise(resolve => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const base = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: profile,
    USERPROFILE: profile,
    CONCLAVE_PORT: String(port),
    CONCLAVE_AUTH_FILE: '',
    CONCLAVE_PUBLIC_ORIGIN: '',
    CONCLAVE_ASSISTANT_ENABLED: '0',
    CONCLAVE_INTERNAL_TOKEN: ''
  },
  stdio: 'ignore'
});

const closed = new Promise(resolve => child.once('close', resolve));
let browser, page, stage = 'startup';

try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + '/api/stats')).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }

  browser = await chromium.launch({
    headless: true,
    ...(process.env.CONCLAVE_BROWSER ? { executablePath: process.env.CONCLAVE_BROWSER } : {}),
    args: ['--no-sandbox']
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);

  const errors = [];
  page.on('pageerror', e => errors.push(e.stack || e.message));

  // 1. Concurrent resource fetching and initial paginated rendering (60 messages)
  stage = 'initial thread load with pagination';
  await page.goto(base + '/#/hub/' + thread1.id);
  await page.locator('#msgs').waitFor();
  await page.locator('.hm[data-id="msg-t1-75"]').waitFor();

  // Initial count of rendered messages should be 60 (out of 75)
  const initialCards = await page.locator('#msgs .hm').count();
  assert.equal(initialCards, 60, `Expected 60 messages on initial load, found ${initialCards}`);

  // Load earlier messages button should be present
  const loadEarlierBtn = page.locator('#btn-load-earlier');
  assert.equal(await loadEarlierBtn.count(), 1, 'Expected #btn-load-earlier button to be present');

  // 2. Lazy tool activity expansion
  stage = 'lazy tool activity expansion';
  // msg-t1-74 is an agent message with 2 actions
  const actDetails = page.locator('.hm[data-id="msg-t1-74"] details.tool.act');
  assert.equal(await actDetails.count(), 1, 'Expected details.tool.act for msg-t1-74');
  const summaryText = await actDetails.locator('summary').innerText();
  assert.ok(summaryText.includes('2 actions'), `Summary should state 2 actions, got: ${summaryText}`);

  // Expand activity
  await actDetails.locator('summary').click();
  await page.waitForFunction(() => {
    const pre = document.querySelector('.hm[data-id="msg-t1-74"] details.tool.act pre');
    return pre && pre.textContent.includes('action-1-74');
  });
  const actPreText = await actDetails.locator('pre').innerText();
  assert.ok(actPreText.includes('action-1-74') && actPreText.includes('action-2-74'), 'Activity pre should contain loaded logs');

  // 3. Load earlier messages with scroll position preservation
  stage = 'load earlier messages & scroll position';
  const { scrollTopBefore, scrollHeightBefore } = await page.evaluate(() => {
    const msgs = document.querySelector('#msgs');
    msgs.scrollTop = 150;
    const btn = document.querySelector('#btn-load-earlier');
    const st = msgs.scrollTop;
    const sh = msgs.scrollHeight;
    btn.click();
    return { scrollTopBefore: st, scrollHeightBefore: sh };
  });

  // Wait until earlier message (e.g. msg-t1-1) is present
  await page.locator('.hm[data-id="msg-t1-1"]').waitFor();
  const allCards = await page.locator('#msgs .hm').count();
  assert.equal(allCards, 75, `Expected 75 messages after loading earlier, found ${allCards}`);

  // Earlier button should now be gone because hasMore is false
  assert.equal(await page.locator('#btn-load-earlier').count(), 0);

  // Scroll position should be adjusted by the delta in scrollHeight
  const scrollHeightAfter = await page.evaluate(() => document.querySelector('#msgs').scrollHeight);
  const scrollTopAfter = await page.evaluate(() => document.querySelector('#msgs').scrollTop);
  const expectedScrollTop = scrollTopBefore + (scrollHeightAfter - scrollHeightBefore);
  assert.ok(Math.abs(scrollTopAfter - expectedScrollTop) <= 2, `Scroll position mismatch: got ${scrollTopAfter}, expected ${expectedScrollTop}`);

  // 4. Draft preservation across chat switches
  stage = 'draft preservation across chat switches';
  await page.locator('#input').fill('Draft typed in thread 1');
  await page.waitForTimeout(200);

  // Switch to Thread 2
  await page.goto(base + '/#/hub/' + thread2.id);
  await page.locator('.hm[data-id="msg-t2-2"]').waitFor();
  assert.equal(await page.locator('#input').inputValue(), '', 'Thread 2 input should be empty');

  // Switch back to Thread 1
  await page.goto(base + '/#/hub/' + thread1.id);
  await page.locator('.hm[data-id="msg-t1-75"]').waitFor();
  assert.equal(await page.locator('#input').inputValue(), 'Draft typed in thread 1', 'Draft in thread 1 should be preserved');

  // 5. AbortController & route-generation guard against stale responses
  stage = 'stale response guard on rapid switch';
  let thread1Delayed = false;
  await page.route(`**/api/threads/${thread1.id}*`, async route => {
    if (thread1Delayed) {
      await new Promise(r => setTimeout(r, 600));
    }
    await route.continue();
  });

  thread1Delayed = true;
  // Trigger switch to Thread 1, then immediately to Thread 2
  await page.evaluate(t1Id => { location.hash = '#/hub/' + t1Id; }, thread1.id);
  await page.waitForTimeout(50);
  await page.evaluate(t2Id => { location.hash = '#/hub/' + t2Id; }, thread2.id);
  await page.locator('.hm[data-id="msg-t2-2"]').waitFor();

  // Wait long enough for the delayed thread 1 request to finish
  await page.waitForTimeout(800);
  // Verify that Thread 2 is still active and was NOT overwritten by Thread 1
  const currentTitle = await page.locator('#title').inputValue();
  assert.equal(currentTitle, 'Second Fast Thread', 'Thread 2 should not be replaced by delayed Thread 1 response');

  // 6. SSE Reconnect reconciliation across multi-page gap without duplicate messages
  stage = 'reconnect reconciliation across multi-page gap';
  // Insert 65 messages directly in db to exceed the 60-msg limit per page
  for (let i = 1; i <= 65; i++) {
    ins.run(`msg-t2-reconcile-${i}`, thread2.id, 'user', null, `Reconciled bulk ${i}`, '[]', 'done', now());
  }
  const maxSeq = getDb().prepare('SELECT MAX(seq) AS s FROM thread_messages WHERE thread_id = ?').get(thread2.id)?.s;

  // Trigger hello reconciliation event via EventSource
  await page.evaluate(seq => {
    if (window.__cvEs?.onmessage) {
      window.__cvEs.onmessage(new MessageEvent('message', {
        data: JSON.stringify({ type: 'hello', lastSeq: seq, at: Date.now() })
      }));
    }
  }, maxSeq);

  // Both first page and second page should have arrived
  await page.locator('.hm[data-id="msg-t2-reconcile-1"]').waitFor();
  await page.locator('.hm[data-id="msg-t2-reconcile-65"]').waitFor();
  assert.equal(await page.locator('.hm[data-id="msg-t2-reconcile-65"]').count(), 1, 'Final multi-page message must appear');

  // Dispatch again to ensure deduplication prevents duplicate messages
  await page.evaluate(seq => {
    if (window.__cvEs?.onmessage) {
      window.__cvEs.onmessage(new MessageEvent('message', {
        data: JSON.stringify({ type: 'hello', lastSeq: seq, at: Date.now() })
      }));
    }
  }, maxSeq);
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.hm[data-id="msg-t2-reconcile-65"]').count(), 1, 'Message must not be duplicated');

  // 7. Verify background refresh does not clobber newer SSE updates
  stage = 'preserve newer SSE updates during background refresh';
  // Simulate active stream on a message
  await page.evaluate(() => {
    if (window.__cvEs?.onmessage) {
      window.__cvEs.onmessage(new MessageEvent('message', {
        data: JSON.stringify({
          type: 'message',
          message: { id: 'stream-msg', role: 'agent', tool: 'claude', status: 'running', content: 'Streaming token 1', activity: ['act-live-1'], seq: 9999 }
        })
      }));
      window.__cvEs.onmessage(new MessageEvent('message', {
        data: JSON.stringify({
          type: 'delta',
          id: 'stream-msg',
          text: ' and token 2'
        })
      }));
    }
  });

  await page.waitForFunction(() => {
    const el = document.querySelector('.hm[data-id="stream-msg"]');
    return el && el.textContent.includes('Streaming token 1 and token 2');
  });

  // Now trigger an EventSource 'thread' event which calls refresh()
  await page.evaluate(() => {
    if (window.__cvEs?.onmessage) {
      window.__cvEs.onmessage(new MessageEvent('message', {
        data: JSON.stringify({ type: 'thread' })
      }));
    }
  });
  await page.waitForTimeout(400);

  // The streaming message content must still be intact and not wiped
  const streamContent = await page.locator('.hm[data-id="stream-msg"]').innerText();
  assert.ok(streamContent.includes('Streaming token 1 and token 2'), `Streaming content should not be wiped by refresh, got: ${streamContent}`);

  // 8. Shell preservation across chat switches
  stage = 'chat shell preservation during navigation';
  await page.evaluate(() => {
    const layout = document.querySelector('.cv-layout');
    if (layout) layout.dataset.testMarker = 'persistent-shell';
  });

  // Switch to Thread 1
  await page.evaluate(t1Id => { location.hash = '#/hub/' + t1Id; }, thread1.id);
  await page.locator('.hm[data-id="msg-t1-75"]').waitFor();

  // Verify that .cv-layout DOM element was preserved (not re-created)
  const shellMarker = await page.evaluate(() => {
    return document.querySelector('.cv-layout')?.dataset.testMarker;
  });
  assert.equal(shellMarker, 'persistent-shell', 'The .cv-layout shell must be preserved during navigation');

  // Verify active thread indicator in sidebar
  const activeLinkHref = await page.evaluate(() => {
    return document.querySelector('#threads a.hub-thread.on')?.getAttribute('href');
  });
  assert.equal(activeLinkHref, '#/hub/' + thread1.id, 'Active link class must update to thread 1');

  // 9. Warm and cold switch measurement and loading state
  stage = 'warm and cold switch measurement and loading state';
  const warmSwitch = await page.evaluate(() => window.__cvLastSwitch);
  assert.ok(warmSwitch, 'window.__cvLastSwitch should be recorded');
  assert.equal(warmSwitch.type, 'warm', 'Switching back to cached thread should be a warm switch');
  assert.equal(warmSwitch.threadId, thread1.id);
  assert.ok(typeof warmSwitch.durationMs === 'number' && warmSwitch.durationMs >= 0, 'durationMs must be a non-negative number');
  assert.ok(warmSwitch.durationMs < 150, `Warm switch should be fast, took ${warmSwitch.durationMs}ms`);

  // Perform a cold switch to thread3 with an artificial network delay to test loading state and latency measurement
  let thread3Delayed = true;
  await page.route(`**/api/threads/${thread3.id}*`, async route => {
    if (thread3Delayed) {
      await new Promise(r => setTimeout(r, 220));
    }
    await route.continue();
  });

  // Switch to cold thread3
  await page.evaluate(t3Id => { location.hash = '#/hub/' + t3Id; }, thread3.id);

  // During the delay, .hub-main-loading must be displayed and old main content removed
  await page.locator('.hub-main-loading').waitFor();
  assert.equal(await page.locator('.hm[data-id="msg-t1-75"]').count(), 0, 'Previous chat messages must be cleared while cold loading');

  // Wait for thread3 to finish loading
  await page.locator('.hm[data-id="msg-t3-2"]').waitFor();

  // Verify cold switch metric captures the full end-to-end fetch latency
  const coldSwitch = await page.evaluate(() => window.__cvLastSwitch);
  assert.equal(coldSwitch.type, 'cold', 'Fresh thread switch must be recorded as cold');
  assert.equal(coldSwitch.threadId, thread3.id);
  assert.ok(coldSwitch.durationMs >= 180, `Cold switch durationMs (${coldSwitch.durationMs}ms) should include network fetch latency`);

  // 10. Queued and starting agent presentation
  stage = 'queued and starting agent presentation';
  await page.evaluate(() => {
    if (window.__cvEs?.onmessage) {
      window.__cvEs.onmessage(new MessageEvent('message', {
        data: JSON.stringify({
          type: 'message',
          message: { id: 'msg-queued-1', role: 'agent', tool: 'codex', status: 'running', phase: 'queued', content: '', seq: 10001 }
        })
      }));
      window.__cvEs.onmessage(new MessageEvent('message', {
        data: JSON.stringify({
          type: 'message',
          message: { id: 'msg-starting-1', role: 'agent', tool: 'claude', status: 'running', phase: 'starting', content: '', seq: 10002 }
        })
      }));
    }
  });

  await page.locator('#working .work-chip.ph-queued').waitFor();
  await page.locator('#working .work-chip.ph-starting').waitFor();
  const chipQueuedText = await page.locator('#working .work-chip.ph-queued').innerText();
  const chipStartingText = await page.locator('#working .work-chip.ph-starting').innerText();
  assert.ok(chipQueuedText.includes('is queued'), `Queued chip should contain "is queued", got: ${chipQueuedText}`);
  assert.ok(chipStartingText.includes('is starting'), `Starting chip should contain "is starting", got: ${chipStartingText}`);

  const phaseQueuedCard = await page.locator('.hm[data-id="msg-queued-1"] .phase-label.phase-queued').count();
  const phaseStartingCard = await page.locator('.hm[data-id="msg-starting-1"] .phase-label.phase-starting').count();
  assert.equal(phaseQueuedCard, 1, 'Message card should have .phase-label.phase-queued');
  assert.equal(phaseStartingCard, 1, 'Message card should have .phase-label.phase-starting');

  // 11. Stream connection status and genuine failure handling
  stage = 'genuine stream failure indicator';
  // Simulate stream closed with readyState = 2 (EventSource.CLOSED)
  await page.evaluate(() => {
    if (window.__cvEs) {
      Object.defineProperty(window.__cvEs, 'readyState', { value: 2, configurable: true });
      if (window.__cvEs.onerror) window.__cvEs.onerror(new Event('error'));
    }
  });

  await page.locator('#reconnect-pill.disconnected').waitFor();
  const pillText = await page.locator('#reconnect-pill .status-txt').innerText();
  assert.equal(pillText, 'Disconnected', `Stream failure should display Disconnected, got: ${pillText}`);
  const pillTitle = await page.locator('#reconnect-pill').getAttribute('title');
  assert.equal(pillTitle, 'Live stream disconnected', `Pill title should reflect disconnected status, got: ${pillTitle}`);

  assert.deepEqual(errors, []);
  console.log('PASS: chat loading acceleration, shell preservation, warm/cold switch measurement, queued agent presentation, and failure indicator.');
} catch (error) {
  console.error('Check chat loading stage failed:', stage);
  throw error;
} finally {
  await browser?.close();
  child.kill();
  await closed;
  getDb().close();
  rmSync(temp, { recursive: true, force: true });
}
