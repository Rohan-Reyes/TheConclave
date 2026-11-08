// Browser verification harness against an ISOLATED preview server with synthetic data.
// Usage: node scripts/check-ui.mjs --isolated
//    or: node scripts/check-ui.mjs http://127.0.0.1:4788 <thread-id> [screenshot-dir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isIsolated = process.argv.includes('--isolated');

let base = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'http://127.0.0.1:4788';
let threadId = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
let screenshotOut = path.join(root, 'docs', 'screenshots');
let artifactsOut = path.join(root, 'artifacts', 'mobile-verification');

let isoServer, isoTmp;
if (isIsolated) {
  isoTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-iso-'));
  const dbPath = path.join(isoTmp, 'test.db');
  const env = { ...process.env, AGENT_HUB_DATA_DIR: isoTmp, AGENT_HUB_DB: dbPath, CONCLAVE_PORT: '4788' };
  threadId = execFileSync('node', ['scripts/seed-demo.mjs'], { env, encoding: 'utf8', cwd: root }).trim();
  isoServer = spawn('node', ['server.js'], { env, cwd: root, stdio: 'ignore', windowsHide: true });
  base = 'http://127.0.0.1:4788';
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${base}/api/stats`, { headers: { Host: '127.0.0.1:4788' } });
      if (res.ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
}

if (!threadId) throw new Error('Supply a synthetic preview thread ID; do not capture private chats.');
fs.mkdirSync(screenshotOut, { recursive: true });
fs.mkdirSync(artifactsOut, { recursive: true });

const browser = [process.env.CONCLAVE_BROWSER,
  path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe')].find(p => p && fs.existsSync(p));
if (!browser) throw new Error('Set CONCLAVE_BROWSER to an installed Chromium/Edge executable.');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-ui-'));
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
], { windowsHide: true, stdio: 'ignore' });

let ws, closeBrowser;
const pending = new Map();
let seq = 0;
const browserErrors = [];
const desktopNetworkMutations = [];
let monitorDesktopMutations = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const reportCases = [];
const reportFailures = [];

try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await delay(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();

  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.id) {
      const call = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) call?.reject(new Error(data.error.message));
      else call?.resolve(data.result);
    }
    if (data.method === 'Runtime.exceptionThrown') browserErrors.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);
    if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') browserErrors.push(data.params.entry.text);
    if (data.method === 'Network.requestWillBeSent' && monitorDesktopMutations) {
      const method = (data.params?.request?.method || '').toUpperCase();
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        desktopNetworkMutations.push({ url: data.params?.request?.url, method });
      }
    }
  });
  ws.addEventListener('close', () => {
    for (const call of pending.values()) call.reject(new Error('Browser connection closed'));
    pending.clear();
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20_000);
    pending.set(id, { resolve: r => { clearTimeout(timeout); resolve(r); }, reject: e => { clearTimeout(timeout); reject(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };

  closeBrowser = () => send('Browser.close');

  const waitFor = async expression => {
    for (let i = 0; i < 120; i++) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    throw new Error(`UI condition timed out: ${expression}`);
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__checkHitTarget = function(el) {
        if (!el) return { present: false, reachable: false, reason: 'missing' };
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return { present: true, reachable: false, width: r.width, height: r.height, reason: 'zero-size' };
        const inViewport = r.top >= 0 && r.bottom <= window.innerHeight + 2 && r.left >= 0 && r.right <= window.innerWidth + 2;
        if (!inViewport) return { present: true, reachable: false, inViewport: false, top: r.top, bottom: r.bottom, left: r.left, right: r.right, windowHeight: window.innerHeight, windowWidth: window.innerWidth, reason: 'out-of-viewport' };
        const cx = Math.floor(r.left + r.width / 2);
        const cy = Math.floor(r.top + r.height / 2);
        const hit = document.elementFromPoint(cx, cy);
        const reachable = !!hit && (el === hit || el.contains(hit));
        return { present: true, inViewport: true, reachable, hitTag: hit ? hit.tagName + (hit.id ? '#' + hit.id : '') : null };
      };
    `
  });

  const screenshot = async (dir, name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from(shot.data, 'base64'));
  };

  const navigate = async route => {
    await send('Page.navigate', { url: `${base}/#/${route}` });
    await waitFor('document.readyState === "complete" && !!document.querySelector("#view")');
    await delay(350);
  };

  // 1. Initial Desktop Captures (Light & Dark)
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await navigate(`hub/${threadId}`);
  await waitFor('!!document.querySelector("#input")');
  await evaluate('document.documentElement.dataset.theme = "light"');
  await delay(200);
  await screenshot(screenshotOut, 'council-light');

  await evaluate('document.documentElement.dataset.theme = "dark"');
  await delay(200);
  await screenshot(screenshotOut, 'council-dark');

  // 2. Draft reload check
  const draftChecks = [];
  await evaluate('document.querySelector("#input").value = "persistent draft fixture"; document.querySelector("#input").dispatchEvent(new Event("input", { bubbles: true }))');
  await send('Page.reload');
  await waitFor('document.querySelector("#input")?.value === "persistent draft fixture"');
  draftChecks.push({ name: 'draft survives reload', passed: true });
  await evaluate('document.querySelector("#input").value = ""; document.querySelector("#input").dispatchEvent(new Event("input", { bubbles: true }))');
  reportCases.push({ name: 'draft-reload', checks: draftChecks });

  // Matrix of Viewports & Themes to verify
  const matrix = [
    { name: '360-light', width: 360, height: 800, theme: 'light' },
    { name: '360-dark', width: 360, height: 800, theme: 'dark' },
    { name: '390-light', width: 390, height: 844, theme: 'light' },
    { name: '390-dark', width: 390, height: 844, theme: 'dark' },
    { name: '420-light', width: 420, height: 900, theme: 'light' },
    { name: '420-dark', width: 420, height: 900, theme: 'dark' },
    { name: 'landscape-light', width: 844, height: 390, theme: 'light' },
    { name: 'landscape-dark', width: 844, height: 390, theme: 'dark' },
    { name: 'keyboard-space-light', width: 390, height: 500, theme: 'light' },
    { name: 'keyboard-space-dark', width: 390, height: 500, theme: 'dark' },
  ];

  for (const tc of matrix) {
    await send('Emulation.setDeviceMetricsOverride', { width: tc.width, height: tc.height, deviceScaleFactor: 1, mobile: tc.width <= 420 });
    await send('Page.navigate', { url: `${base}/#/hub/${threadId}` });
    await send('Page.reload');
    await waitFor('document.readyState === "complete" && !!document.querySelector("#input")');
    await evaluate(`document.documentElement.dataset.theme = "${tc.theme}"`);
    await delay(200);

    // Capture case screenshots
    await screenshot(artifactsOut, tc.name);
    if (tc.name === '420-dark') {
      await screenshot(screenshotOut, 'council-mobile');
    }

    // Set up mutation guard, synthetic runner data, and hit-target checker
    await evaluate(`
      window.__stubs = { mutations: [] };
      window.__origFetch = window.__origFetch || window.fetch;
      window.EventSource = function() {
        this.close = function() {};
        this.addEventListener = function() {};
        this.removeEventListener = function() {};
      };
      window.__checkHitTarget = function(el) {
        if (!el) return { present: false, reachable: false, reason: 'missing' };
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return { present: true, reachable: false, width: r.width, height: r.height, reason: 'zero-size' };
        const inViewport = r.top >= 0 && r.bottom <= window.innerHeight + 2 && r.left >= 0 && r.right <= window.innerWidth + 2;
        if (!inViewport) return { present: true, reachable: false, inViewport: false, top: r.top, bottom: r.bottom, left: r.left, right: r.right, windowHeight: window.innerHeight, windowWidth: window.innerWidth, reason: 'out-of-viewport' };
        const cx = Math.floor(r.left + r.width / 2);
        const cy = Math.floor(r.top + r.height / 2);
        const hit = document.elementFromPoint(cx, cy);
        const reachable = !!hit && (el === hit || el.contains(hit));
        return { present: true, inViewport: true, reachable, hitTag: hit ? hit.tagName + (hit.id ? '#' + hit.id : '') : null };
      };
      window.fetch = function(url, opts) {
        const u = String(url);
        if (opts && (opts.method === 'POST' || opts.method === 'PATCH' || opts.method === 'DELETE')) {
          let parsedBody = null;
          try { parsedBody = opts.body ? JSON.parse(opts.body) : null; } catch {}
          window.__stubs.mutations.push({ url: u, method: opts.method, body: parsedBody });
          if (u.includes('/attachments')) {
            const files = parsedBody?.files || [{ name: 'addressed-upload.png' }];
            return Promise.resolve(new Response(JSON.stringify({
              ok: true,
              files: files.map(f => ({ originalName: f.name, filename: f.name, isImage: true, path: 'data/attachments/' + f.name, url: '#' }))
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
          }
          return Promise.resolve(new Response(JSON.stringify({ ok: true, id: 'job-restarted' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        if (u.includes('/api/runner/commands')) {
          return Promise.resolve(new Response(JSON.stringify({
            commands: [{ id: 'cmd-test', label: 'npm test', executable: 'npm', args: ['test'], script: 'npm test', confirmed: true, fingerprint: 'fp1' }]
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        if (u.includes('/api/runner/jobs/')) {
          return Promise.resolve(new Response(JSON.stringify({
            id: 'job-test',
            commandId: 'cmd-test',
            label: 'npm test',
            status: 'running',
            pid: 1234,
            started: Date.now() - 5000,
            lastSeq: 3,
            urls: ['http://localhost:3000'],
            logs: [{ seq: 1, stream: 'stdout', text: 'Server running at http://localhost:3000' }]
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        if (u.includes('/api/runner/jobs')) {
          return Promise.resolve(new Response(JSON.stringify({
            jobs: [{
              id: 'job-test',
              commandId: 'cmd-test',
              label: 'npm test',
              status: 'running',
              pid: 1234,
              started: Date.now() - 5000,
              lastSeq: 3,
              urls: ['http://localhost:3000'],
              logs: [{ seq: 1, stream: 'stdout', text: 'Server running at http://localhost:3000' }]
            }]
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return window.__origFetch.apply(this, arguments);
      };
    `);

    const checks = [];
    const record = (name, passed, detail = null) => {
      const entry = { name, passed: !!passed };
      if (!passed) {
        if (detail) entry.detail = detail;
        reportFailures.push({ case: tc.name, check: name, detail: detail ?? 'failed' });
      }
      checks.push(entry);
    };

    // 1. Horizontal overflow & outer scroll
    const pageMetrics = await evaluate(`({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      scrollY: window.scrollY
    })`);
    record('no horizontal page overflow', pageMetrics.scrollWidth <= pageMetrics.innerWidth + 2);
    record('no outer page scroll', pageMetrics.scrollY === 0);

    // 2. Usable conversation space
    const layout = await evaluate(`(() => {
      const msgs = document.querySelector('.msgs')?.getBoundingClientRect();
      const head = document.querySelector('.hub-head')?.getBoundingClientRect();
      const comp = document.querySelector('.composer')?.getBoundingClientRect();
      return {
        msgsHeight: msgs ? msgs.height : 0,
        msgsTop: msgs ? msgs.top : 0,
        msgsBottom: msgs ? msgs.bottom : 0,
        headHeight: head ? head.height : 0,
        compHeight: comp ? comp.height : 0
      };
    })()`);
    const minMsgs = Math.min(120, tc.height * 0.2);
    record('conversation has usable space', layout.msgsHeight >= minMsgs, {
      width: tc.width, height: tc.height, msgsHeight: layout.msgsHeight, minRequired: minMsgs, layout
    });

    // 3. Chat list & onboarding initial states
    const initStates = await evaluate(`({
      drawerOpen: document.body.classList.contains('mobile-list-open'),
      onboardingOpen: !!document.querySelector('.onboarding-card') && document.querySelector('.onboarding-card').offsetHeight > 0
    })`);
    record('chat list initially collapsed', !initStates.drawerOpen);
    record('onboarding initially collapsed', tc.height <= 550 ? !initStates.onboardingOpen : true);

    // 4. Basic controls visibility
    const sendBtn = await evaluate('window.__checkHitTarget(document.querySelector("#send"))');
    record('Send visible', !!sendBtn?.reachable, sendBtn);
    record('Composer input visible', await evaluate('!!document.querySelector("#input") && document.querySelector("#input").offsetHeight > 0'));

    // 5. Chats toggle & drawer interaction
    const chatsBtn = await evaluate('window.__checkHitTarget(document.querySelector("#btn-mobile-chats"))');
    record('Chats toggle reachable', !!chatsBtn?.reachable, chatsBtn);
    if (chatsBtn?.reachable) {
      await evaluate('document.querySelector("#btn-mobile-chats").click()');
      await waitFor('document.body.classList.contains("mobile-list-open")');
      const drawerOpened = await evaluate('document.body.classList.contains("mobile-list-open")');
      record('chat drawer opens', drawerOpened);
      const closeBtn = await evaluate('window.__checkHitTarget(document.querySelector("#close-mobile-list"))');
      record('Chat drawer close reachable', !!closeBtn?.reachable, closeBtn);
      await evaluate('document.querySelector("#close-mobile-list")?.click()');
      await waitFor('!document.body.classList.contains("mobile-list-open")');
      const drawerClosed = await evaluate('!document.body.classList.contains("mobile-list-open")');
      record('chat drawer closes', drawerClosed);
    } else {
      record('chat drawer opens', false, { error: 'chats toggle unreachable' });
      record('Chat drawer close reachable', false, { error: 'chats toggle unreachable' });
      record('chat drawer closes', false, { error: 'chats toggle unreachable' });
    }

    // 6. Plan & Question Reachability & Captured Request Routing
    const planId = await evaluate('document.querySelector("[data-plan-id]")?.dataset.planId');
    const planRun = await evaluate(`(() => {
      const b = document.querySelector('[data-plan="run"]');
      if (!b) return null;
      b.scrollIntoView({ block: 'nearest' });
      return window.__checkHitTarget(b);
    })()`);
    record('Run plan reachable through conversation scroll', !!planRun?.reachable, planRun);

    // Click Run plan and verify captured mutation request targets the specific plan ID
    await evaluate('document.querySelector(\'[data-plan="run"]\')?.click()');
    await delay(100);
    const planCaptured = await evaluate(`(() => {
      const mut = window.__stubs.mutations.find(m => m.url.includes('/plans/') && m.url.includes('/run'));
      return mut ? mut.url : null;
    })()`);
    const planRouted = !!planCaptured && planCaptured.includes(`/plans/${planId}/run`);
    record('Run plan targets this plan', planRouted, { planId, planCaptured });

    // Question choice check & routing
    const questionId = await evaluate('document.querySelector("[data-question]")?.dataset.question');
    const qChoice = await evaluate(`(() => {
      const b = document.querySelector('[data-question] [data-answer]');
      if (!b) return null;
      b.scrollIntoView({ block: 'nearest' });
      return window.__checkHitTarget(b);
    })()`);
    record('Question choice reachable', !!qChoice?.reachable, qChoice);

    // Click question choice and verify captured request targets the specific question ID
    await evaluate('document.querySelector(\'[data-question] [data-answer]\')?.click()');
    await delay(100);
    const qChoiceCaptured = await evaluate(`(() => {
      const mut = window.__stubs.mutations.find(m => m.url.includes('/questions/') && m.url.includes('/answer'));
      return mut ? { url: mut.url, body: mut.body } : null;
    })()`);
    const qChoiceRouted = !!qChoiceCaptured && qChoiceCaptured.url.includes(`/questions/${questionId}/answer`);
    record('question answer targets correct question', qChoiceRouted, { questionId, qChoiceCaptured });

    // Free-text question answer check & routing
    const qFree = await evaluate(`(() => {
      const input = document.querySelector('[data-question] .q-input');
      const send = document.querySelector('[data-question] [data-answer-send]');
      if (!input || !send) return null;
      input.scrollIntoView({ block: 'nearest' });
      return window.__checkHitTarget(send);
    })()`);
    record('Free-text question answer reachable', !!qFree?.reachable, qFree);

    // Type answer into question input, click Answer, and verify captured request
    await evaluate(`(() => {
      const inp = document.querySelector('[data-question] .q-input');
      if (inp) {
        inp.value = 'Indigo theme option';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector('[data-question] [data-answer-send]')?.click();
    })()`);
    await delay(100);
    const qFreeCaptured = await evaluate(`(() => {
      const muts = window.__stubs.mutations.filter(m => m.url.includes('/questions/') && m.url.includes('/answer'));
      const last = muts[muts.length - 1];
      return last ? { url: last.url, body: last.body } : null;
    })()`);
    const qFreeRouted = !!qFreeCaptured && qFreeCaptured.url.includes(`/questions/${questionId}/answer`) && qFreeCaptured.body?.answer === 'Indigo theme option';
    record('free-text answer targets correct question', qFreeRouted, { questionId, qFreeCaptured });

    // Reset mutations from plan & question tests
    await evaluate('window.__stubs.mutations = []');

    // 7. Rendered More Actions Menu (⋯) Checks
    const moreMenu = await evaluate('window.__checkHitTarget(document.querySelector("#hub-more-actions summary"))');
    record('More actions menu reachable', !!moreMenu?.reachable, moreMenu);

    if (moreMenu?.reachable) {
      await evaluate('document.querySelector("#hub-more-actions summary").click()');
      const dropdownOpen = await evaluate('document.querySelector("#hub-more-actions").hasAttribute("open")');
      record('More actions menu opens', dropdownOpen);

      const items = await evaluate(`({
        pin: window.__checkHitTarget(document.querySelector('#m-btn-pin')),
        archive: window.__checkHitTarget(document.querySelector('#m-btn-archive')),
        export: window.__checkHitTarget(document.querySelector('#m-btn-export')),
        focus: window.__checkHitTarget(document.querySelector('#m-btn-focus')),
        del: window.__checkHitTarget(document.querySelector('#m-btn-del'))
      })`);
      const hasDownload = await evaluate('!!document.querySelector("#m-btn-export[download]")');
      record('More actions items reachable', items.pin.reachable && items.archive.reachable && items.export.reachable && items.focus.reachable && items.del.reachable && hasDownload);
      record('More actions Pin reachable', !!items?.pin?.reachable, items.pin);
      record('More actions Archive reachable', !!items?.archive?.reachable, items.archive);
      record('More actions Export reachable', !!items?.export?.reachable && hasDownload, items.export);
      record('More actions Focus reachable', !!items?.focus?.reachable, items.focus);
      record('More actions Delete reachable', !!items?.del?.reachable, items.del);

      // Verify Delete confirmation behavior
      await evaluate('document.querySelector("#m-btn-del").click()');
      const delArmed = await evaluate(`(() => {
        const d = document.querySelector('#m-btn-del');
        const armed = d && (d.dataset.armed === '1' || d.textContent.includes('Confirm'));
        if (d) { d.dataset.armed = ''; d.textContent = '✕ Delete chat'; }
        return armed;
      })()`);
      record('Delete confirmation armed', !!delArmed);

      // Outside click closes menu
      await evaluate('document.querySelector(".msgs").click()');
      const outsideClosed = await evaluate('!document.querySelector("#hub-more-actions").hasAttribute("open")');
      record('More actions closes on outside click', outsideClosed);

      // Close menu explicitly if still open
      const stillOpen = await evaluate('document.querySelector("#hub-more-actions").hasAttribute("open")');
      if (stillOpen) {
        await evaluate('document.querySelector("#hub-more-actions summary").click()');
      }
      const dropdownClosed = await evaluate('!document.querySelector("#hub-more-actions").hasAttribute("open")');
      record('More actions closes', dropdownClosed);
    } else {
      record('More actions menu opens', false);
      record('More actions items reachable', false);
      record('More actions Pin reachable', false);
      record('More actions Archive reachable', false);
      record('More actions Export reachable', false);
      record('More actions Focus reachable', false);
      record('More actions Delete reachable', false);
      record('Delete confirmation armed', false);
      record('More actions closes on outside click', false);
      record('More actions closes', false);
    }

    // 8. Long Draft Reachability
    await evaluate(`(() => {
      const inp = document.querySelector('#input');
      if (inp) {
        inp.value = Array(15).fill("A line of text in draft testing autogrow clamping").join("\\n");
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`);
    await delay(100);
    const draftState = await evaluate(`(() => {
      const msgs = document.querySelector('.msgs')?.getBoundingClientRect();
      const send = document.querySelector('#send');
      return {
        msgsHeight: msgs ? msgs.height : 0,
        send: window.__checkHitTarget(send)
      };
    })()`);
    const minDraftMsgs = Math.min(80, tc.height * 0.15);
    record('long draft preserves conversation space', draftState.msgsHeight >= minDraftMsgs, {
      height: tc.height, msgsHeight: draftState.msgsHeight, minRequired: minDraftMsgs
    });
    record('Send reachable with long draft', !!draftState?.send?.reachable, draftState.send);

    // Reset draft
    await evaluate('(() => { const inp = document.querySelector("#input"); if (inp) { inp.value = ""; inp.dispatchEvent(new Event("input", { bubbles: true })); } })()');

    // 9. Attachment Lifecycle & Addressed Upload Verification
    // Step A: Real file input attachment using DataTransfer
    await evaluate(`(() => {
      const dt = new DataTransfer();
      const f = new File(['upload verification bytes'], 'verified-file.png', { type: 'image/png' });
      dt.items.add(f);
      const input = document.querySelector('#file-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor('!!document.querySelector(".att-chip")');

    const attChipState = await evaluate(`(() => {
      const rm = document.querySelector('.att-remove');
      const send = document.querySelector('#send');
      return {
        rm: window.__checkHitTarget(rm),
        send: window.__checkHitTarget(send)
      };
    })()`);
    record('Attachment remove reachable', !!attChipState?.rm?.reachable, attChipState.rm);
    record('Send reachable with attachment', !!attChipState?.send?.reachable, attChipState.send);

    // Step B: Real removal by clicking the remove button
    await evaluate('document.querySelector(".att-remove")?.click()');
    await waitFor('!document.querySelector(".att-chip")');
    const chipRemoved = await evaluate('!document.querySelector(".att-chip") && document.querySelector("#composer-attachments").hidden');
    record('Remove attachment', chipRemoved);

    // Step C: Re-attach through file input and verify Send reachable
    await evaluate(`(() => {
      const dt = new DataTransfer();
      const f = new File(['addressed upload verification'], 'addressed-upload.png', { type: 'image/png' });
      dt.items.add(f);
      const input = document.querySelector('#file-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor('!!document.querySelector(".att-chip")');
    const sendAttState = await evaluate('window.__checkHitTarget(document.querySelector("#send"))');
    record('Send attachment reachable', !!sendAttState?.reachable, sendAttState);

    // Step D: Send message with attachment and verify captured upload request contains the file name
    await evaluate(`(() => {
      const inp = document.querySelector('#input');
      if (inp) {
        inp.value = 'Message with addressed attachment';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector('#send')?.click();
    })()`);
    const expectedAttachmentEndpoint = `/api/threads/${threadId}/attachments`;
    await waitFor(`window.__stubs.mutations.some(m => m.url.includes(${JSON.stringify(expectedAttachmentEndpoint)}))`);
    const uploadCaptured = await evaluate(`(() => {
      const ep = ${JSON.stringify(expectedAttachmentEndpoint)};
      const mut = window.__stubs.mutations.find(m => m.url.includes(ep));
      return mut ? { url: mut.url, body: mut.body } : null;
    })()`);
    const uploadValid = !!uploadCaptured &&
      uploadCaptured.url.includes(expectedAttachmentEndpoint) &&
      Array.isArray(uploadCaptured.body?.files) &&
      uploadCaptured.body.files.some(f => f.name === 'addressed-upload.png');
    record('attachment is included in the addressed upload', uploadValid, { uploadCaptured, expectedAttachmentEndpoint });

    // Clean up composer & clear expected mutations from attachment upload
    await evaluate(`(() => {
      window.__stubs.mutations = [];
      const inp = document.querySelector('#input');
      if (inp) { inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true })); }
      const atts = document.querySelector('#composer-attachments');
      if (atts) { atts.hidden = true; atts.innerHTML = ''; }
    })()`);

    // 10. Runner Modal Controls
    const runnerTrigger = await evaluate('window.__checkHitTarget(document.querySelector("#open-runner"))');
    record('Runner trigger reachable', !!runnerTrigger?.reachable, runnerTrigger);

    if (runnerTrigger?.reachable) {
      await evaluate('document.querySelector("#open-runner").click()');
      await waitFor('!!document.querySelector("#btn-job-restart")');
      const runnerControls = await evaluate(`(() => {
        const stop = document.querySelector('#btn-job-stop');
        const restart = document.querySelector('#btn-job-restart');
        const sendChat = document.querySelector('#btn-job-send-chat');
        const openApp = document.querySelector('#btn-open-app');
        [stop, restart, sendChat, openApp].forEach(b => b?.scrollIntoView?.({ block: 'nearest' }));
        return {
          stop: window.__checkHitTarget(stop),
          restart: window.__checkHitTarget(restart),
          sendChat: window.__checkHitTarget(sendChat),
          openApp: window.__checkHitTarget(openApp)
        };
      })()`);
      record('Runner Stop reachable', !!runnerControls?.stop?.reachable, runnerControls.stop);
      record('Runner Restart reachable', !!runnerControls?.restart?.reachable, runnerControls.restart);
      record('Runner Send to chat reachable', !!runnerControls?.sendChat?.reachable, runnerControls.sendChat);
      record('Runner Open app reachable', !!runnerControls?.openApp?.reachable, runnerControls.openApp);

      // Close runner modal cleanly
      await evaluate('document.querySelector("#rm-close")?.click()');
      await waitFor('!document.querySelector("#modal")?.open');
    } else {
      record('Runner Stop reachable', false);
      record('Runner Restart reachable', false);
      record('Runner Send to chat reachable', false);
      record('Runner Open app reachable', false);
    }

    // 11. Mutation Safety Verification
    const mutations = await evaluate('window.__stubs.mutations');
    record('no unexpected API mutation reached server', mutations.length === 0, { mutations });

    reportCases.push({
      name: tc.name,
      viewport: { width: tc.width, height: tc.height, name: tc.name.split('-')[0] },
      theme: tc.theme,
      checks
    });
  }

  // 3. Desktop Pages Smoke & Welcome View
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate('if (window.__stubs) window.__stubs.mutations = [];');
  desktopNetworkMutations.length = 0;
  monitorDesktopMutations = true;
  const welcomeChecks = [];

  for (const route of ['', 'chats', 'memory', 'projects', 'files', 'config', 'usage']) {
    await navigate(route);
    await waitFor('!document.querySelector("#view")?.innerText.includes("Loading")');
    const hasErr = await evaluate('!!document.querySelector("#view .error")');
    assert.equal(hasErr, false, `${route} has an error panel`);
  }

  // Welcome view reachability check on short desktop viewport
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 600, deviceScaleFactor: 1, mobile: false });
  await navigate('hub?new=1');
  await waitFor('!!document.querySelector("#q-send")');

  const welcomeState = await evaluate(`(() => {
    const btn = document.querySelector('#q-send');
    if (!btn) return { present: false, reachable: false, reason: 'missing-btn' };
    btn.scrollIntoView({ block: 'nearest' });
    const hit = window.__checkHitTarget ? window.__checkHitTarget(btn) : null;
    // Exercise click handler with empty draft to verify interactivity without network mutations
    btn.click();
    return {
      present: true,
      reachable: !!hit?.reachable,
      hit
    };
  })()`);

  const pageMutations = await evaluate('window.__stubs?.mutations || []');
  const allDesktopMutations = [...desktopNetworkMutations, ...pageMutations];
  monitorDesktopMutations = false;

  const recordWelcome = (name, passed, detail) => {
    const entry = { name, passed: !!passed };
    if (!passed) {
      if (detail) entry.detail = detail;
      reportFailures.push({ case: 'welcome-short', check: name, detail: detail ?? 'failed' });
    }
    welcomeChecks.push(entry);
  };

  recordWelcome('Welcome Start chat reachable by scrolling', !!welcomeState?.reachable, welcomeState);
  recordWelcome('browser has no exceptions or failed resources', browserErrors.length === 0, { browserErrors });
  recordWelcome('no browser mutation reached the network', allDesktopMutations.length === 0, { allDesktopMutations });
  reportCases.push({ name: 'welcome-short', checks: welcomeChecks });

  // 4. Output report.json
  const totalChecks = reportCases.reduce((acc, c) => acc + c.checks.length, 0);
  const totalPassed = reportCases.reduce((acc, c) => acc + c.checks.filter(x => x.passed).length, 0);
  const totalFailed = reportCases.reduce((acc, c) => acc + c.checks.filter(x => !x.passed).length, 0);

  const report = {
    cases: reportCases,
    failures: reportFailures,
    limitations: [
      'CSS viewport checks and reduced browser height simulate phone/keyboard space only; no physical iOS/Android keyboard, browser chrome, safe-area inset or touch-device behavior is verified.',
      'Plan, question and runner actions verify reachable controls and correctly addressed UI requests using browser fixtures; backend execution is covered separately by the offline suite.'
    ],
    paidAgentCalls: 0
  };

  fs.writeFileSync(path.join(artifactsOut, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log(`\nCompleted ${reportCases.length} cases, ${totalChecks} checks: ${totalPassed} passed, ${totalFailed} failed. No paid agents or commands ran.`);
  if (totalFailed > 0) {
    console.error(`FAILURES: ${JSON.stringify(reportFailures, null, 2)}`);
    process.exitCode = 1;
  }
} finally {
  if (closeBrowser) await Promise.race([closeBrowser().catch(() => {}), delay(1500)]);
  ws?.close();
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  } else {
    child.kill();
  }
  if (isoServer) {
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(isoServer.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    } else {
      isoServer.kill();
    }
  }
  await delay(250);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  if (isoTmp) {
    try { fs.rmSync(isoTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}
