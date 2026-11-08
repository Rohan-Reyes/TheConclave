import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { mountAuth, createCredentials } from '../src/auth.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'conclave-auth-'));
const file = path.join(temp, 'owner.json');
const password = 'long offline fixture password 123!';
const credentials = await createCredentials('owner', password);
fs.writeFileSync(file, JSON.stringify(credentials));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const origin = 'https://conclave.example';

async function fixture(t, options = {}) {
  const app = express();
  mountAuth(app, { root: process.cwd(), env: { CONCLAVE_AUTH_FILE: file, CONCLAVE_PUBLIC_ORIGIN: origin, CONCLAVE_INTERNAL_TOKEN: 'offline-internal-token-123' }, ...options });
  app.get('/api/private', (req, res) => res.json({ private: true }));
  app.get('/private.js', (req, res) => res.send('secret module'));
  app.post('/api/private', express.json(), (req, res) => res.json({ changed: true }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, request: (url, opts) => fetch(base + url, opts), login: (pass = password, extra = {}) => fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...extra }, body: JSON.stringify({ username: 'owner', password: pass }),
  }) };
}

test('owner auth protects pages, static files, APIs and exposes no credentials in status', async t => {
  const f = await fixture(t);
  const page = await f.request('/private.js', { redirect: 'manual' });
  assert.equal(page.status, 303); assert.equal(page.headers.get('location'), '/login');
  assert.equal((await f.request('/api/private')).status, 401);
  const status = await f.request('/api/auth/status');
  assert.deepEqual(await status.json(), { enabled: true, authenticated: false });
  const login = await f.request('/login');
  assert.equal(login.status, 200); assert.match(await login.text(), /Private access/);
});

test('correct owner login creates signed secure cookie; tampering and logout reject replay', async t => {
  const f = await fixture(t);
  assert.equal((await f.login('wrong password')).status, 401);
  const login = await f.login(); assert.equal(login.status, 200);
  const set = login.headers.get('set-cookie');
  assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Strict/); assert.match(set, /Secure/);
  const cookie = set.split(';')[0];
  assert.equal((await f.request('/api/private', { headers: { Cookie: cookie } })).status, 200);
  const status = await f.request('/api/auth/status', { headers: { Cookie: cookie } });
  assert.equal((await status.json()).authenticated, true);
  assert.equal((await f.request('/api/private', { headers: { Cookie: cookie + 'x' } })).status, 401);
  const logout = await f.request('/api/auth/logout', { method: 'POST', headers: { Origin: origin, Cookie: cookie } });
  assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await f.request('/api/private', { headers: { Cookie: cookie } })).status, 401);
});

test('sessions expire server-side and origin is required for every browser mutation', async t => {
  let current = 1000;
  const f = await fixture(t, { now: () => current, sessionMs: 60000 });
  assert.equal((await f.login(password, { Origin: 'https://attacker.example' })).status, 403);
  const login = await f.login(); const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request('/api/private', { method: 'POST', headers: { Cookie: cookie } })).status, 403);
  assert.equal((await f.request('/api/private', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await f.request('/api/private', { method: 'POST', headers: { Cookie: cookie, Origin: origin } })).status, 200);
  current += 60001;
  assert.equal((await f.request('/api/private', { headers: { Cookie: cookie } })).status, 401);
});

test('failed login throttling is enforced and releases after its time window', async t => {
  let current = 1000;
  const f = await fixture(t, { now: () => current, maxAttempts: 2, windowMs: 10000 });
  assert.equal((await f.login('wrong')).status, 401);
  assert.equal((await f.login('wrong')).status, 401);
  const blocked = await f.login(); assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '10');
  current += 10001;
  assert.equal((await f.login()).status, 200);
});

test('local MCP requires the exact internal token and a loopback Host', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/private', { headers: { 'X-Conclave-Internal': 'wrong' } })).status, 401);
  const headers = { 'X-Conclave-Internal': 'offline-internal-token-123' };
  assert.equal((await f.request('/api/private', { headers })).status, 200);
  assert.equal((await f.request('/api/private', { method: 'POST', headers })).status, 200);
  const status = await new Promise((resolve, reject) => {
    const req = http.get(f.base + '/api/private', { headers: { ...headers, Host: 'conclave.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(status, 401);
});

test('malformed or missing public authentication fails closed while local defaults remain compatible', () => {
  assert.deepEqual(mountAuth(express(), { env: {} }), { enabled: false });
  assert.throws(() => mountAuth(express(), { env: { CONCLAVE_PUBLIC_ORIGIN: origin } }), /required/);
  const bad = path.join(temp, 'invalid.json'); fs.writeFileSync(bad, '{}');
  assert.throws(() => mountAuth(express(), { env: { CONCLAVE_AUTH_FILE: bad } }), /Invalid/);
  assert.throws(() => mountAuth(express(), { env: { CONCLAVE_AUTH_FILE: file, CONCLAVE_PUBLIC_ORIGIN: 'http://insecure.example' } }), /HTTPS/);
  assert.equal(JSON.stringify(credentials).includes(password), false);
});
