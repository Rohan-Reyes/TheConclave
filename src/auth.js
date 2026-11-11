import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const derive = promisify(crypto.scrypt);
const COOKIE = 'conclave_session';
const MIN_PASSWORD = 12;
const MAX_PASSKEYS = 20;
const CHALLENGE_MS = 5 * 60_000;
const equal = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export async function createCredentials(username, password) {
  if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || password.length < 16) throw new Error('A username and password of at least 16 characters are required');
  const salt = crypto.randomBytes(32).toString('hex');
  const passwordHash = (await derive(password, salt, 64)).toString('hex');
  return { username: username.trim(), salt, passwordHash, sessionSecret: crypto.randomBytes(32).toString('hex'), passkeys: [] };
}

// Write the owner file atomically and readable by the owner only, so a crash
// mid-write can never leave a half-written credentials file.
function persist(file, config) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

const validPasskey = p => p && typeof p.id === 'string' && p.id.length <= 1024 && typeof p.publicKey === 'string'
  && Number.isInteger(p.counter) && p.counter >= 0;

export function mountAuth(app, { root, env = process.env, now = Date.now, sessionMs = 12 * 3600000, maxAttempts = 10, windowMs = 15 * 60000, onSessionRevoked = () => {} } = {}) {
  const file = env.CONCLAVE_AUTH_FILE;
  if (!file) {
    if (env.CONCLAVE_PUBLIC_ORIGIN) throw new Error('CONCLAVE_AUTH_FILE is required when exposing a public origin');
    app.get('/api/auth/status', (_req, res) => res.json({ enabled: false, authenticated: false }));
    app.get('/api/auth/account', (_req, res) => res.json({ enabled: false }));
    return { enabled: false };
  }
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Cannot read owner authentication configuration'); }
  if (!config || typeof config.username !== 'string' || !config.username.trim()
      || !/^[a-f0-9]{64}$/i.test(config.salt || '') || !/^[a-f0-9]{128}$/i.test(config.passwordHash || '')
      || !/^[a-f0-9]{64,}$/i.test(config.sessionSecret || '')) throw new Error('Invalid owner authentication configuration');
  if (config.passkeys !== undefined && (!Array.isArray(config.passkeys) || !config.passkeys.every(validPasskey))) throw new Error('Invalid passkey configuration');
  config.passkeys ||= [];
  // A stable, private WebAuthn user handle for the single owner.
  if (!/^[A-Za-z0-9_-]{16,}$/.test(config.userHandle || '')) { config.userHandle = crypto.randomBytes(32).toString('base64url'); persist(file, config); }

  let publicOrigin;
  if (env.CONCLAVE_PUBLIC_ORIGIN) {
    try {
      const u = new URL(env.CONCLAVE_PUBLIC_ORIGIN);
      if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error();
      publicOrigin = u.origin;
    } catch { throw new Error('CONCLAVE_PUBLIC_ORIGIN must be an HTTPS origin'); }
  }
  // sessions: id -> { expires, created, lastSeen, userAgent, method }
  const sessions = new Map(), attempts = new Map(), challenges = new Map();
  const secure = !!publicOrigin;
  const signature = value => crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
  const cookie = (token, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const publicId = id => crypto.createHash('sha256').update(id).digest('base64url').slice(0, 12);
  const internal = req => {
    if (!env.CONCLAVE_INTERNAL_TOKEN || !equal(req.get('X-Conclave-Internal') || '', env.CONCLAVE_INTERNAL_TOKEN)) return false;
    const ip = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return false;
    try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${req.get('host')}`).hostname); } catch { return false; }
  };
  const revoke = id => { sessions.delete(id); onSessionRevoked(id); };
  const session = req => {
    const raw = (req.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    if (!raw || raw.length > 256) return null;
    const [id, sig, extra] = raw.split('.');
    if (extra !== undefined || !id || !sig || !equal(sig, signature(id))) return null;
    const s = sessions.get(id);
    if (!s || s.expires <= now()) { revoke(id); return null; }
    s.lastSeen = now();
    return id;
  };
  const originOK = req => {
    if (internal(req)) return true;
    const allowed = publicOrigin || `${req.protocol}://${req.get('host')}`;
    return req.get('origin') === allowed;
  };
  const expectedOrigin = req => publicOrigin || `${req.protocol}://${req.get('host')}`;
  const rpID = req => new URL(expectedOrigin(req)).hostname;
  const startSession = (req, res, method) => {
    for (const [id, s] of sessions) if (s.expires <= now()) revoke(id);
    if (sessions.size >= 64) revoke(sessions.keys().next().value);
    const id = crypto.randomBytes(32).toString('base64url');
    sessions.set(id, { expires: now() + sessionMs, created: now(), lastSeen: now(), userAgent: String(req.get('user-agent') || '').slice(0, 200), method });
    res.set('Set-Cookie', cookie(`${id}.${signature(id)}`, Math.floor(sessionMs / 1000)));
  };
  // Shared sign-in throttle for password and passkey attempts.
  const throttle = (req, res) => {
    const key = req.socket.remoteAddress;
    let limit = attempts.get(key);
    if (!limit || limit.until <= now()) { limit = { count: 0, until: now() + windowMs }; attempts.set(key, limit); }
    if (limit.count >= maxAttempts) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((limit.until - now()) / 1000))));
      res.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
      return null;
    }
    limit.count++;
    return key;
  };
  const passwordMatches = async password => {
    if (typeof password !== 'string' || !password || password.length > 1024) return false;
    const hash = (await derive(password, config.salt, 64)).toString('hex');
    return equal(hash, config.passwordHash);
  };
  const putChallenge = value => {
    for (const [k, v] of challenges) if (v.expires <= now()) challenges.delete(k);
    if (challenges.size >= 200) challenges.delete(challenges.keys().next().value);
    const id = crypto.randomBytes(18).toString('base64url');
    challenges.set(id, { ...value, expires: now() + CHALLENGE_MS });
    return id;
  };
  const takeChallenge = (id, kind) => {
    const c = typeof id === 'string' ? challenges.get(id) : null;
    challenges.delete(id);
    return c && c.kind === kind && c.expires > now() ? c : null;
  };
  const json = express.json({ limit: '64kb' });
  const requireSession = (req, res, next) => {
    const id = internal(req) ? null : session(req);
    if (!id) return res.status(401).json({ error: 'Sign in required' });
    req.sessionId = id;
    next();
  };
  const toCredential = p => ({ id: p.id, publicKey: Buffer.from(p.publicKey, 'base64url'), counter: p.counter, transports: p.transports || undefined });

  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'DENY');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !originOK(req)) return res.status(403).json({ error: 'Forbidden origin' });
    next();
  });
  app.get('/login', (req, res) => res.sendFile(path.join(root, 'public', 'login.html')));
  app.get('/api/auth/status', (req, res) => res.json({ enabled: true, authenticated: !!session(req) }));

  app.post('/api/auth/login', json, async (req, res, next) => {
    try {
      const key = throttle(req, res); if (!key) return;
      const { username, password } = req.body || {};
      if (typeof username !== 'string' || username.length > 200) return res.status(401).json({ error: 'Invalid username or password' });
      const ok = await passwordMatches(password);
      if (!ok || !equal(username, config.username)) return res.status(401).json({ error: 'Invalid username or password' });
      attempts.delete(key);
      startSession(req, res, 'password');
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---- passkey sign-in (no session yet)
  app.post('/api/auth/passkey/options', json, async (req, res, next) => {
    try {
      if (!config.passkeys.length) return res.status(404).json({ error: 'No passkeys are set up yet. Sign in with your password, then add one in Settings.' });
      const options = await generateAuthenticationOptions({
        rpID: rpID(req), userVerification: 'required',
        allowCredentials: config.passkeys.map(p => ({ id: p.id, transports: p.transports || undefined })),
      });
      res.json({ challengeId: putChallenge({ kind: 'login', challenge: options.challenge }), options });
    } catch (e) { next(e); }
  });
  app.post('/api/auth/passkey/verify', json, async (req, res, next) => {
    try {
      const key = throttle(req, res); if (!key) return;
      const { challengeId, response } = req.body || {};
      const c = takeChallenge(challengeId, 'login');
      const pk = config.passkeys.find(p => p.id === response?.id);
      if (!c || !pk) return res.status(401).json({ error: 'Passkey sign-in failed. Try again.' });
      let result;
      try {
        result = await verifyAuthenticationResponse({
          response, expectedChallenge: c.challenge, expectedOrigin: expectedOrigin(req), expectedRPID: rpID(req),
          credential: toCredential(pk), requireUserVerification: true,
        });
      } catch { return res.status(401).json({ error: 'Passkey sign-in failed. Try again.' }); }
      if (!result.verified) return res.status(401).json({ error: 'Passkey sign-in failed. Try again.' });
      pk.counter = result.authenticationInfo.newCounter;
      pk.lastUsed = new Date(now()).toISOString();
      persist(file, config);
      attempts.delete(key);
      startSession(req, res, 'passkey');
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post('/api/auth/logout', (req, res) => {
    const id = session(req); if (id) revoke(id);
    res.set('Set-Cookie', cookie('', 0)); res.json({ ok: true });
  });

  // ---- account settings (signed-in owner only)
  app.get('/api/auth/account', requireSession, (req, res) => res.json({
    enabled: true,
    username: config.username,
    passwordUpdated: config.passwordUpdated || null,
    passkeys: config.passkeys.map(p => ({ id: p.id, name: p.name || 'Passkey', created: p.created || null, lastUsed: p.lastUsed || null, backedUp: !!p.backedUp })),
    sessions: [...sessions].filter(([, s]) => s.expires > now()).map(([id, s]) => ({
      id: publicId(id), current: id === req.sessionId, created: new Date(s.created).toISOString(),
      lastSeen: new Date(s.lastSeen).toISOString(), userAgent: s.userAgent, method: s.method,
    })).sort((a, b) => (b.current - a.current) || b.lastSeen.localeCompare(a.lastSeen)),
    minPasswordLength: MIN_PASSWORD,
    rpID: rpID(req),
  }));

  app.post('/api/auth/password', requireSession, json, async (req, res, next) => {
    try {
      const { current, next: nextPassword } = req.body || {};
      if (!await passwordMatches(current)) return res.status(403).json({ error: 'Your current password is incorrect' });
      if (typeof nextPassword !== 'string' || nextPassword.length < MIN_PASSWORD || nextPassword.length > 1024) return res.status(400).json({ error: `Use at least ${MIN_PASSWORD} characters` });
      if (nextPassword === current) return res.status(400).json({ error: 'Choose a password you have not used here' });
      config.salt = crypto.randomBytes(32).toString('hex');
      config.passwordHash = (await derive(nextPassword, config.salt, 64)).toString('hex');
      config.passwordUpdated = new Date(now()).toISOString();
      persist(file, config);
      // Everyone else is signed out; this browser stays signed in.
      for (const id of [...sessions.keys()]) if (id !== req.sessionId) revoke(id);
      res.json({ ok: true, signedOutOthers: true });
    } catch (e) { next(e); }
  });

  app.post('/api/auth/sessions/revoke-others', requireSession, (req, res) => {
    let count = 0;
    for (const id of [...sessions.keys()]) if (id !== req.sessionId) { revoke(id); count++; }
    res.json({ ok: true, count });
  });

  app.post('/api/auth/passkeys/register/options', requireSession, json, async (req, res, next) => {
    try {
      if (!await passwordMatches(req.body?.password)) return res.status(403).json({ error: 'Your password is incorrect' });
      if (config.passkeys.length >= MAX_PASSKEYS) return res.status(400).json({ error: `You can keep up to ${MAX_PASSKEYS} passkeys` });
      const options = await generateRegistrationOptions({
        rpName: 'Conclave', rpID: rpID(req), userName: config.username, userDisplayName: config.username,
        userID: Buffer.from(config.userHandle, 'base64url'), attestationType: 'none',
        excludeCredentials: config.passkeys.map(p => ({ id: p.id, transports: p.transports || undefined })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      });
      const name = String(req.body?.name || '').trim().slice(0, 60) || 'Passkey';
      res.json({ challengeId: putChallenge({ kind: 'register', challenge: options.challenge, sessionId: req.sessionId, name }), options });
    } catch (e) { next(e); }
  });
  app.post('/api/auth/passkeys/register/verify', requireSession, json, async (req, res, next) => {
    try {
      const { challengeId, response } = req.body || {};
      const c = takeChallenge(challengeId, 'register');
      if (!c || c.sessionId !== req.sessionId) return res.status(400).json({ error: 'This passkey request expired. Try again.' });
      let result;
      try {
        result = await verifyRegistrationResponse({
          response, expectedChallenge: c.challenge, expectedOrigin: expectedOrigin(req), expectedRPID: rpID(req), requireUserVerification: true,
        });
      } catch (e) { return res.status(400).json({ error: `The passkey could not be verified: ${e.message}` }); }
      if (!result.verified) return res.status(400).json({ error: 'The passkey could not be verified' });
      const { credential, credentialBackedUp } = result.registrationInfo;
      if (config.passkeys.some(p => p.id === credential.id)) return res.status(409).json({ error: 'This passkey is already registered' });
      config.passkeys.push({
        id: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64url'), counter: credential.counter,
        transports: credential.transports || [], name: c.name, created: new Date(now()).toISOString(), lastUsed: null, backedUp: !!credentialBackedUp,
      });
      persist(file, config);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  app.post('/api/auth/passkeys/:id/rename', requireSession, json, (req, res) => {
    const pk = config.passkeys.find(p => p.id === req.params.id);
    if (!pk) return res.status(404).json({ error: 'Passkey not found' });
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Enter a name' });
    pk.name = name; persist(file, config);
    res.json({ ok: true });
  });
  app.post('/api/auth/passkeys/:id/delete', requireSession, json, async (req, res, next) => {
    try {
      if (!await passwordMatches(req.body?.password)) return res.status(403).json({ error: 'Your password is incorrect' });
      const before = config.passkeys.length;
      config.passkeys = config.passkeys.filter(p => p.id !== req.params.id);
      if (config.passkeys.length === before) return res.status(404).json({ error: 'Passkey not found' });
      persist(file, config);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.use((req, res, next) => {
    const authenticated = session(req);
    if (authenticated) {
      req.conclaveIdentity = { id: authenticated, username: config.username, expires: sessions.get(authenticated).expires };
      return next();
    }
    if (internal(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in required' });
    if (req.path.startsWith('/vendor/simplewebauthn')) return next();   // the sign-in page needs it
    res.redirect(303, '/login');
  });
  return { enabled: true };
}
