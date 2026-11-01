// Browser smoke checks against an ISOLATED preview server with synthetic data.
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
let out = path.resolve(process.argv[4] || (isIsolated ? 'docs/screenshots' : 'artifacts/ui'));

let isoServer, isoTmp;
if (isIsolated) {
  isoTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-iso-'));
  const dbPath = path.join(isoTmp, 'test.db');
  const env = { ...process.env, AGENT_HUB_DATA_DIR: isoTmp, AGENT_HUB_DB: dbPath, CONCLAVE_PORT: '4788' };
  threadId = execFileSync('node', ['scripts/seed-demo.mjs'], { env, encoding: 'utf8', cwd: root }).trim();
  isoServer = spawn('node', ['server.js'], { env, cwd: root, stdio: 'ignore', windowsHide: true });
  base = 'http://127.0.0.1:4788';
  out = path.join(root, 'docs', 'screenshots');
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${base}/api/stats`, { headers: { Host: '127.0.0.1:4788' } });
      if (res.ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
}

if (!threadId) throw new Error('Supply a synthetic preview thread ID; do not capture private chats.');
fs.mkdirSync(out, { recursive: true });
const browser = [process.env.CONCLAVE_BROWSER,
  path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe')].find(p => p && fs.existsSync(p));
if (!browser) throw new Error('Set CONCLAVE_BROWSER to an installed Chromium/Edge executable.');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-ui-'));
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let ws, closeBrowser;
const pending = new Map(); let seq = 0;
const errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await delay(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.id) { const call = pending.get(data.id); pending.delete(data.id); if (data.error) call?.reject(new Error(data.error.message)); else call?.resolve(data.result); }
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);
    if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') errors.push(data.params.entry.text);
  });
  ws.addEventListener('close', () => { for (const call of pending.values()) call.reject(new Error('Browser connection closed')); pending.clear(); });
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
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
    for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error(`UI condition timed out: ${expression}`);
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  const navigate = async route => {
    await send('Page.navigate', { url: base + '/#/' + route });
    await waitFor('document.readyState === "complete" && !!document.querySelector("#view")');
    await delay(700);
  };
  const screenshot = async name => {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
  };
  await navigate('hub/' + threadId);
  await waitFor('!!document.querySelector("#input")');
  await evaluate('document.documentElement.dataset.theme="light"');
  await screenshot('council-light');
  const text = await evaluate('document.body.innerText');
  assert.match(text, /Run plan/); assert.match(text, /Which color/);
  await evaluate('document.querySelector("#input").value="persistent draft fixture"; document.querySelector("#input").dispatchEvent(new Event("input",{bubbles:true}))');
  await send('Page.reload'); await waitFor('document.querySelector("#input")?.value === "persistent draft fixture"');
  await evaluate('document.querySelector("#btn-templates").click()');
  await waitFor('document.body.innerText.includes("Investigate") || !!document.querySelector(".slash-item")');
  await evaluate('document.querySelector("#input").value=""; document.querySelector("#input").dispatchEvent(new Event("input",{bubbles:true})); document.activeElement?.blur()');
  await evaluate('document.documentElement.dataset.theme="dark"');
  await screenshot('council-dark');
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
  await delay(300);
  await screenshot('council-mobile');
  const overflow = await evaluate('document.documentElement.scrollWidth > window.innerWidth + 2');
  assert.equal(overflow, false, 'Mobile page overflows horizontally');
  // Do not run a plan: this fixture must never call a paid agent.
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  for (const route of ['', 'chats', 'memory', 'projects', 'config', 'usage']) {
    await navigate(route);
    await waitFor('!document.querySelector("#view")?.innerText.includes("Loading")');
    assert.equal(await evaluate('!!document.querySelector("#view .error")'), false, `${route} has an error panel`);
  }
  assert.deepEqual(errors, [], 'Browser exceptions or failed resources');
  console.log(`UI passed: draft reload, templates, plan/question cards, mobile width, all pages. Screenshots: ${out}`);
} finally {
  if (closeBrowser) await Promise.race([closeBrowser().catch(() => {}), delay(1500)]);
  ws?.close();
  if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
  else child.kill();
  if (isoServer) {
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(isoServer.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
    else isoServer.kill();
  }
  await delay(250);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  if (isoTmp) {
    try { fs.rmSync(isoTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}
