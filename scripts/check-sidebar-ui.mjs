// Isolated browser test for selector behavior and rebuilt sidebar layout.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createCredentials } from '../src/auth.js';
import { openDb } from '../assistant/src/db.js';

const dir = mkdtempSync(join(tmpdir(), 'conclave-sidebar-ui-'));
const profile = join(dir, 'profile');
mkdirSync(profile);
const longUser = 'super-long-administrator-name-for-testing-overflow-truncation@local';
const owner = join(dir, 'owner.json');
writeFileSync(owner, JSON.stringify(await createCredentials(longUser, 'fixture-pass-123')));

// Assistant db fixture
const db = openDb(join(dir, 'assistant', 'jarvis.sqlite'));
db.close();

const port = await new Promise(resolve => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const base = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ['server.js'], {
  env: {
    ...process.env,
    HOME: profile,
    USERPROFILE: profile,
    CONCLAVE_PORT: String(port),
    CONCLAVE_AUTH_FILE: owner,
    CONCLAVE_PUBLIC_ORIGIN: '',
    CONCLAVE_INTERNAL_TOKEN: '',
    CONCLAVE_ASSISTANT_ENABLED: '1',
    SESSION_SECRET: 'ab'.repeat(32),
    TOKEN_ENCRYPTION_KEY: 'cd'.repeat(32),
    AGENT_HUB_DATA_DIR: join(dir, 'coding'),
    AGENT_HUB_DB: join(dir, 'coding', 'hub.db'),
    DATA_DIR: join(dir, 'assistant')
  },
  stdio: 'ignore'
});

const closed = new Promise(r => child.once('close', r));
let browser;

try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + '/api/auth/status')).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }

  const launchOpts = {
    headless: true,
    args: ['--no-sandbox']
  };
  if (process.env.CONCLAVE_BROWSER) launchOpts.executablePath = process.env.CONCLAVE_BROWSER;
  browser = await chromium.launch(launchOpts);

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  // 1. Sign in
  const login = await page.request.post(base + '/api/auth/login', {
    headers: { Origin: base },
    data: { username: longUser, password: 'fixture-pass-123' }
  });
  assert.equal(login.status(), 200);

  // 2. Create multiple threads (some with very long titles) to test Recent chats capping and overflow
  for (let i = 1; i <= 9; i++) {
    const title = i === 1
      ? 'An exceptionally lengthy chat title designed to test text ellipsis and verify zero horizontal overflow in sidebar'
      : `Project Chat ${i} Investigation and Implementation`;
    const res = await page.request.post(base + '/api/threads', {
      headers: { Origin: base },
      data: { title, target: i % 2 === 0 ? 'council' : 'codex' }
    });
    assert.equal(res.status(), 200);
  }

  // 3. Load Hub
  await page.goto(base + '/#/hub');
  await page.locator('#sidebar').waitFor();

  // Test layout zones: top, mid, foot
  const top = page.locator('.sidebar-top');
  const mid = page.locator('.sidebar-mid');
  const foot = page.locator('.sidebar-foot');
  assert.equal(await top.count(), 1, 'sidebar-top must exist');
  assert.equal(await mid.count(), 1, 'sidebar-mid must exist');
  assert.equal(await foot.count(), 1, 'sidebar-foot must exist');

  // Verify both memory destinations are preserved
  const mindNav = page.locator('a[data-nav="mind"]');
  const memoryNav = page.locator('a[data-nav="memory"]');
  assert.equal(await mindNav.count(), 1, '3D Memory destination in Jarvis must be present');
  assert.equal(await memoryNav.count(), 1, 'Memory destination in Coding must be present');

  // Verify recent chats list is capped to 6 visible items and "See all chats" link is present
  await page.locator('#recent-chats a').first().waitFor();
  const visibleRecents = await page.locator('#recent-chats a:visible').count();
  assert.ok(visibleRecents <= 6, `Visible recents should be capped at <= 6, got ${visibleRecents}`);
  const seeAllLink = page.locator('.recent-all-link');
  assert.equal(await seeAllLink.count(), 1, 'See all chats link must be present');

  // Verify middle scrolling region has min-height: 0 and overflow-y: auto
  const midStyles = await mid.evaluate(el => {
    const s = getComputedStyle(el);
    return { overflowY: s.overflowY, minHeight: s.minHeight, flexGrow: s.flexGrow };
  });
  assert.equal(midStyles.overflowY, 'auto');
  assert.equal(midStyles.minHeight, '0px');
  assert.equal(midStyles.flexGrow, '1');

  // Check geometry: middle scroll box bottom must not exceed footer top (no overlap)
  const midBox = await mid.boundingBox();
  const footBox = await foot.boundingBox();
  assert.ok(midBox && footBox);
  assert.ok(midBox.y + midBox.height <= footBox.y + 1, 'Middle scroll container must not overlap footer');

  // Test Account Menu: opening it must stay unclipped above the footer
  await page.locator('#account-btn').click();
  const menu = page.locator('#account-menu');
  assert.equal(await menu.isVisible(), true, 'Account menu should open');
  const menuBox = await menu.boundingBox();
  assert.ok(menuBox);
  assert.ok(menuBox.y >= 0, 'Account menu should not be clipped above viewport');

  // Close account menu
  await page.locator('#account-btn').click();

  // Test Short Desktop (1440x500): middle must scroll, footer must remain pinned and unoverlapped
  await page.setViewportSize({ width: 1440, height: 500 });
  await page.waitForTimeout(100);
  const shortMidBox = await mid.boundingBox();
  const shortFootBox = await foot.boundingBox();
  assert.ok(shortMidBox && shortFootBox);
  assert.ok(shortMidBox.y + shortMidBox.height <= shortFootBox.y + 1, 'Short desktop: middle must not overlap footer');
  const isScrollable = await mid.evaluate(el => el.scrollHeight > el.clientHeight);
  assert.equal(isScrollable, true, 'Short desktop: middle should become scrollable');

  // Test Phone Landscape (844x390): drawer layout
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(100);
  const landscapeFootBox = await foot.boundingBox();
  assert.ok(landscapeFootBox.height > 30, 'Footer remains rendered in landscape');

  // Test Collapsed Mode on Desktop
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.body.classList.add('sidebar-collapsed'));
  await page.waitForTimeout(100);
  const sbWidth = await page.locator('#sidebar').evaluate(el => el.getBoundingClientRect().width);
  assert.ok(Math.abs(sbWidth - 68) <= 2, `Collapsed sidebar width should be ~68px, got ${sbWidth}`);
  assert.equal(await page.locator('.brand-name').isVisible(), false, 'Brand text hidden when collapsed');
  assert.equal(await page.locator('#recent-chats').isVisible(), false, 'Recent list hidden when collapsed');

  // Un-collapse
  await page.evaluate(() => document.body.classList.remove('sidebar-collapsed'));

  // Test Council Selector behavior in chat
  await page.goto(base + '/#/hub');
  await page.locator('#target').waitFor();

  const councilBtn = page.locator('#target button[data-v="council"]');
  const codexBtn = page.locator('#target button[data-v="codex"]');
  const claudeBtn = page.locator('#target button[data-v="claude"]');

  // Click Council button
  await councilBtn.click();
  await page.waitForTimeout(200);

  // In Council mode: ONLY Council button should be lit
  assert.equal(await councilBtn.getAttribute('aria-pressed'), 'true');
  assert.ok((await councilBtn.getAttribute('class')).includes('on'));
  assert.equal(await codexBtn.getAttribute('aria-pressed'), 'false');
  assert.ok(!(await codexBtn.getAttribute('class')).includes('on'));
  assert.equal(await claudeBtn.getAttribute('aria-pressed'), 'false');
  assert.ok(!(await claudeBtn.getAttribute('class')).includes('on'));

  // Click Codex: exits Council mode, only Codex is lit
  await codexBtn.click();
  await page.waitForTimeout(200);
  assert.equal(await councilBtn.getAttribute('aria-pressed'), 'false');
  assert.ok(!(await councilBtn.getAttribute('class')).includes('on'));
  assert.equal(await codexBtn.getAttribute('aria-pressed'), 'true');
  assert.ok((await codexBtn.getAttribute('class')).includes('on'));

  // Reload page to verify persistence
  await page.reload();
  await page.locator('#target').waitFor();
  assert.equal(await page.locator('#target button[data-v="codex"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#target button[data-v="council"]').getAttribute('aria-pressed'), 'false');

  assert.equal(errors.length, 0, `Page errors encountered: ${errors.join(', ')}`);
  console.log('check-sidebar-ui: All tests passed successfully.');
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
  await closed;
  rmSync(dir, { recursive: true, force: true });
}
