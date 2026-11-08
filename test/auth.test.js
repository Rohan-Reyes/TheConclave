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

// ---- account settings: password change, sessions, passkey guards
async function accountFixture(t) {
  const own = path.join(temp, `owner-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(own, JSON.stringify(await createCredentials('owner', password)));
  const app = express();
  app.use(express.json());
  mountAuth(app, { root: process.cwd(), env: { CONCLAVE_AUTH_FILE: own, CONCLAVE_PUBLIC_ORIGIN: origin } });
  app.get('/api/private', (req, res) => res.json({ private: true }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, cookie) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body || {}) });
  const login = async pass => { const r = await post('/api/auth/login', { username: 'owner', password: pass }); return r.status === 200 ? r.headers.get('set-cookie').split(';')[0] : r.status; };
  return { own, base, post, login, get: (url, cookie) => fetch(base + url, { headers: cookie ? { Cookie: cookie } : {} }) };
}

test('account details need a session and never expose hashes or secrets', async t => {
  const f = await accountFixture(t);
  assert.equal((await f.get('/api/auth/account')).status, 401);
  const cookie = await f.login(password);
  const body = await (await f.get('/api/auth/account', cookie)).json();
  assert.equal(body.username, 'owner');
  assert.equal(body.sessions.length, 1); assert.equal(body.sessions[0].current, true);
  const raw = JSON.stringify(body);
  for (const secret of ['passwordHash', 'salt', 'sessionSecret', 'userHandle', 'publicKey']) assert.equal(raw.includes(secret), false, secret);
});

test('password change verifies the current password, enforces length, and signs out other sessions', async t => {
  const f = await accountFixture(t);
  const me = await f.login(password), other = await f.login(password);
  assert.equal((await f.post('/api/auth/password', { current: 'wrong', next: 'a brand new password 456' }, me)).status, 403);
  assert.equal((await f.post('/api/auth/password', { current: password, next: 'short' }, me)).status, 400);
  assert.equal((await f.post('/api/auth/password', { current: password, next: password }, me)).status, 400);
  const changed = await f.post('/api/auth/password', { current: password, next: 'a brand new password 456' }, me);
  assert.equal(changed.status, 200);
  assert.equal((await f.get('/api/private', me)).status, 200, 'this browser stays signed in');
  assert.equal((await f.get('/api/private', other)).status, 401, 'other sessions are signed out');
  assert.equal(await f.login(password), 401, 'the old password no longer works');
  assert.equal(typeof await f.login('a brand new password 456'), 'string');
  const stored = JSON.parse(fs.readFileSync(f.own, 'utf8'));
  assert.equal(JSON.stringify(stored).includes('a brand new password 456'), false);
  assert.ok(stored.passwordUpdated);
});

test('sign out other sessions keeps only the current one', async t => {
  const f = await accountFixture(t);
  const me = await f.login(password), a = await f.login(password), b = await f.login(password);
  const r = await (await f.post('/api/auth/sessions/revoke-others', {}, me)).json();
  assert.equal(r.count, 2);
  assert.equal((await f.get('/api/private', me)).status, 200);
  assert.equal((await f.get('/api/private', a)).status, 401);
  assert.equal((await f.get('/api/private', b)).status, 401);
});

test('passkeys: adding or removing needs the password; sign-in rejects unknown or replayed challenges', async t => {
  const f = await accountFixture(t);
  assert.equal((await f.post('/api/auth/passkey/options', {})).status, 404, 'no passkeys yet');
  const me = await f.login(password);
  assert.equal((await f.post('/api/auth/passkeys/register/options', { password: 'wrong' }, me)).status, 403);
  assert.equal((await f.post('/api/auth/passkeys/register/options', { password })).status, 401, 'needs a session');
  const opts = await f.post('/api/auth/passkeys/register/options', { password, name: 'Laptop' }, me);
  assert.equal(opts.status, 200);
  const { challengeId, options } = await opts.json();
  assert.equal(options.rp.id, 'conclave.example');
  assert.equal(options.authenticatorSelection.userVerification, 'required');
  // A bogus attestation is rejected, and the challenge cannot be reused.
  const bogus = { id: 'abc', rawId: 'abc', type: 'public-key', response: { clientDataJSON: 'e30', attestationObject: 'oA' }, clientExtensionResults: {} };
  assert.equal((await f.post('/api/auth/passkeys/register/verify', { challengeId, response: bogus }, me)).status, 400);
  assert.equal((await f.post('/api/auth/passkeys/register/verify', { challengeId, response: bogus }, me)).status, 400);
  assert.equal((await f.post('/api/auth/passkeys/x/delete', { password: 'wrong' }, me)).status, 403);
  assert.equal((await f.post('/api/auth/passkeys/x/delete', { password }, me)).status, 404);
  assert.equal(JSON.parse(fs.readFileSync(f.own, 'utf8')).passkeys.length, 0);
});
