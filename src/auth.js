import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';

const derive = promisify(crypto.scrypt);
const COOKIE = 'conclave_session';
const equal = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export async function createCredentials(username, password) {
  if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || password.length < 16) throw new Error('A username and password of at least 16 characters are required');
  const salt = crypto.randomBytes(32).toString('hex');
  const passwordHash = (await derive(password, salt, 64)).toString('hex');
  return { username: username.trim(), salt, passwordHash, sessionSecret: crypto.randomBytes(32).toString('hex') };
}

export function mountAuth(app, { root, env = process.env, now = Date.now, sessionMs = 12 * 3600000, maxAttempts = 10, windowMs = 15 * 60000 } = {}) {
  const file = env.CONCLAVE_AUTH_FILE;
  if (!file) {
    if (env.CONCLAVE_PUBLIC_ORIGIN) throw new Error('CONCLAVE_AUTH_FILE is required when exposing a public origin');
    app.get('/api/auth/status', (_req, res) => res.json({ enabled: false, authenticated: false }));
    return { enabled: false };
  }
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Cannot read owner authentication configuration'); }
  if (!config || typeof config.username !== 'string' || !config.username.trim()
      || !/^[a-f0-9]{64}$/i.test(config.salt || '') || !/^[a-f0-9]{128}$/i.test(config.passwordHash || '')
      || !/^[a-f0-9]{64,}$/i.test(config.sessionSecret || '')) throw new Error('Invalid owner authentication configuration');
  let publicOrigin;
  if (env.CONCLAVE_PUBLIC_ORIGIN) {
    try {
      const u = new URL(env.CONCLAVE_PUBLIC_ORIGIN);
      if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error();
      publicOrigin = u.origin;
    } catch { throw new Error('CONCLAVE_PUBLIC_ORIGIN must be an HTTPS origin'); }
  }
  const sessions = new Map(), attempts = new Map();
  const secure = !!publicOrigin;
  const signature = value => crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
  const cookie = (token, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const internal = req => {
    if (!env.CONCLAVE_INTERNAL_TOKEN || !equal(req.get('X-Conclave-Internal') || '', env.CONCLAVE_INTERNAL_TOKEN)) return false;
    const ip = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return false;
    try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${req.get('host')}`).hostname); } catch { return false; }
  };
  const session = req => {
    const raw = (req.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    if (!raw || raw.length > 256) return null;
    const [id, sig, extra] = raw.split('.');
    if (extra !== undefined || !id || !sig || !equal(sig, signature(id))) return null;
    const expiry = sessions.get(id);
    if (!expiry || expiry <= now()) { sessions.delete(id); return null; }
    return id;
  };
  const originOK = req => {
    if (internal(req)) return true;
    const allowed = publicOrigin || `${req.protocol}://${req.get('host')}`;
    return req.get('origin') === allowed;
  };
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
  app.post('/api/auth/login', express.json({ limit: '8kb' }), async (req, res, next) => {
    try {
      const key = req.socket.remoteAddress;
      let limit = attempts.get(key);
      if (!limit || limit.until <= now()) { limit = { count: 0, until: now() + windowMs }; attempts.set(key, limit); }
      if (limit.count >= maxAttempts) {
        res.set('Retry-After', String(Math.max(1, Math.ceil((limit.until - now()) / 1000))));
        return res.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
      }
      limit.count++;
      const { username, password } = req.body || {};
      if (typeof password !== 'string' || password.length > 1024 || typeof username !== 'string' || username.length > 200) return res.status(401).json({ error: 'Invalid username or password' });
      const hash = (await derive(password, config.salt, 64)).toString('hex');
      if (!equal(hash, config.passwordHash) || !equal(username, config.username)) return res.status(401).json({ error: 'Invalid username or password' });
      attempts.delete(key);
      for (const [id, expiry] of sessions) if (expiry <= now()) sessions.delete(id);
      if (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
      const id = crypto.randomBytes(32).toString('base64url');
      sessions.set(id, now() + sessionMs);
      res.set('Set-Cookie', cookie(`${id}.${signature(id)}`, Math.floor(sessionMs / 1000)));
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  app.post('/api/auth/logout', (req, res) => {
    const id = session(req); if (id) sessions.delete(id);
    res.set('Set-Cookie', cookie('', 0)); res.json({ ok: true });
  });
  app.use((req, res, next) => {
    if (internal(req) || session(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in required' });
    res.redirect(303, '/login');
  });
  return { enabled: true };
}
