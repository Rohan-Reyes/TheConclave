import { getDb } from './db.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExecutionClaims } from './execution-claims.js';
import * as threads from './agents/threads.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function translatePath(p, fromPlatform, toPlatform) {
  if (!p || typeof p !== 'string') return p;
  if (fromPlatform === 'win32' && toPlatform !== 'win32') {
    let res = p;
    res = res.replace(/[cC]:[\\\/][uU]sers[\\\/][uU]ser[\\\/][cC]onclave/gi, '/home/rasp-pi/Conclave');
    res = res.replace(/[cC]:[\\\/][uU]sers[\\\/][uU]ser[\\\/]agent-hub/gi, '/home/rasp-pi/.local/share/conclave/app');
    res = res.replace(/[cC]:[\\\/][uU]sers[\\\/][uU]ser/gi, '/home/rasp-pi');
    // Convert backslashes within translated linux path components
    res = res.replace(/\/home\/rasp-pi[^\s"'<>`]*/g, match => match.replace(/\\+/g, '/'));
    if (/^[a-zA-Z]:[\\\/]/.test(p) || p.startsWith('\\\\')) {
      res = res.replace(/\\+/g, '/');
    }
    return res;
  } else if (fromPlatform !== 'win32' && toPlatform === 'win32') {
    let res = p;
    res = res.replace(/\/home\/rasp-pi\/Conclave/g, 'C:\\Users\\User\\Conclave');
    res = res.replace(/\/home\/rasp-pi\/(\.local\/share\/conclave\/app|agent-hub)/g, 'C:\\Users\\User\\agent-hub');
    res = res.replace(/\/home\/rasp-pi/g, 'C:\\Users\\User');
    // Convert forward slashes within translated windows path components
    res = res.replace(/[cC]:\\Users\\User[^\s"'<>`]*/gi, match => match.replace(/\/+/g, '\\'));
    if (p.startsWith('/home/rasp-pi')) {
      res = res.replace(/\//g, '\\');
    }
    return res;
  }
  return p;
}

export class SyncService {
  constructor({
    remoteOrigin = process.env.CONCLAVE_REMOTE_ORIGIN ?? (process.platform === 'win32' ? 'https://conclave.aten-systems.site' : ''),
    ownerUser = process.env.CONCLAVE_OWNER_USER || 'rohan',
    ownerPass = process.env.CONCLAVE_OWNER_PASS || '',
    device = process.env.CONCLAVE_DEVICE || (process.platform === 'win32' ? 'laptop' : 'rasp-pi'),
    claims = new ExecutionClaims()
  } = {}) {
    this.remoteOrigin = remoteOrigin;
    this.ownerUser = ownerUser;
    this.ownerPass = ownerPass;
    this.cachedSessionCookie = null;
    this.cachedCookieTime = 0;
    this.device = device;
    this.claims = claims;
    this.locks = new Map(); // status cache only; never authorizes execution
  }

  isLocalRunning(threadId) { return threads.isThreadRunning(threadId); }
  getLock(threadId) {
    const result = this.claims.get(threadId, this.device);
    return { ...result, otherDeviceWorking: !!result.busy && result.device !== this.device };
  }
  setLock(threadId, device) { this.locks.set(threadId, { busy: true, device }); }
  clearLock(threadId) { this.locks.delete(threadId); }
  isRemoteWorkingCached(threadId) { return this.locks.get(threadId)?.device !== this.device && !!this.locks.get(threadId)?.busy; }
  async remote(pathname, { method = 'GET', body } = {}) {
    if (!this.remoteOrigin) throw fail('Pi coordination is unavailable. Seamless work is paused; Local Only chats remain independent.', 503);
    try {
      const cookie = await this.getRemoteCookie();
      const res = await fetch(this.remoteOrigin + pathname, {
        method, headers: { Cookie: cookie, Origin: this.remoteOrigin, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000)
      });
      if (res.status === 401) this.cachedSessionCookie = null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) { throw fail(`Cannot confirm exclusive execution with the Pi (${error.message}). Seamless work was not started.`, 503); }
  }
  async checkRemoteBusy(threadId) {
    const t = threads.getThread(threadId);
    if (!this.isSeamless(t)) return { busy: false, otherDeviceWorking: false };
    const result = this.device === 'rasp-pi' ? this.getLock(threadId) : await this.remote(`/api/sync/lock/${encodeURIComponent(threadId)}`);
    if (result.busy) this.setLock(threadId, result.device); else this.clearLock(threadId);
    return { ...result, otherDeviceWorking: !!result.busy && result.device !== this.device };
  }
  async acquireLock(threadId, requestId = randomUUID()) {
    const t = threads.getThread(threadId);
    if (!this.isSeamless(t)) return { acquired: true, localOnly: true };
    const args = { threadId, requestId, device: this.device };
    let result = this.device === 'rasp-pi' ? this.claims.acquire(args)
      : await this.remote(`/api/sync/lock/${encodeURIComponent(threadId)}`, { method: 'POST', body: args });

    // If claim was rejected because of a busy claim recorded under THIS device,
    // but this device is NOT running any job for this thread locally:
    // It is an orphaned/stale claim from a prior run, crash or restart on this device.
    // Reclaim it automatically by marking this device's stale claim as interrupted and retrying.
    if (!result.acquired && result.busy && result.device === this.device && !this.isLocalRunning(threadId)) {
      try {
        await this.markDeviceInterrupted(this.device, threadId);
        result = this.device === 'rasp-pi' ? this.claims.acquire(args)
          : await this.remote(`/api/sync/lock/${encodeURIComponent(threadId)}`, { method: 'POST', body: args });
      } catch (err) {
        console.warn('Auto-reclaim of stale lock failed:', err.message);
      }
    }

    if (result.busy) this.setLock(threadId, result.device); else this.clearLock(threadId);
    return result;
  }
  async releaseLock(threadId, claim, state = 'done') {
    if (!claim?.token) return;
    const args = { threadId, token: claim.token, state };
    const result = this.device === 'rasp-pi' ? this.claims.finish(args)
      : await this.remote(`/api/sync/lock/${encodeURIComponent(threadId)}`, { method: 'DELETE', body: args });
    this.clearLock(threadId);
    return result;
  }
  async markDeviceInterrupted(device = this.device, threadId = null) {
    if (this.device === 'rasp-pi') {
      const res = this.claims.markDeviceInterrupted(device, threadId);
      if (threadId) this.clearLock(threadId);
      return res;
    }
    try {
      const res = await this.remote('/api/sync/device/interrupted', {
        method: 'POST',
        body: { device, threadId }
      });
      if (threadId) this.clearLock(threadId);
      return res;
    } catch (e) {
      console.warn('Could not notify coordinator of device interrupted:', e.message);
      return { interrupted: 0 };
    }
  }
  handleRemoteLockRequest(threadId, body) {
    if (this.device !== 'rasp-pi') throw fail('This device is not the execution coordinator', 409);
    if (!body?.requestId) return { acquired: false, busy: true, device: 'rasp-pi', note: 'Coordination was updated. Reload local Conclave before sending Seamless messages.' };
    const result = this.claims.acquire({ threadId, requestId: body?.requestId, device: body?.device });
    if (result.busy) this.setLock(threadId, result.device);
    return result;
  }
  handleRemoteUnlock(threadId, body) {
    if (this.device !== 'rasp-pi') throw fail('This device is not the execution coordinator', 409);
    if (body?.token) {
      const result = this.claims.finish({ threadId, token: body.token, state: body?.state || 'done' });
      if (result.released) this.clearLock(threadId);
      return result;
    }
    if (body?.device) {
      const result = this.claims.interruptDeviceClaim({ threadId, device: body.device });
      if (result.ok) this.clearLock(threadId);
      return result;
    }
    return { ok: false, released: false };
  }

  isSeamless(thread) {
    if (!thread) return false;
    if (thread.settings && typeof thread.settings.sync === 'boolean') {
      return thread.settings.sync;
    }
    // Default seamless for projects in Conclave folder; local only otherwise
    return Boolean((thread.cwd || '').toLowerCase().includes('conclave'));
  }

  toggleSync(threadId, shouldSync) {
    const t = threads.getThread(threadId);
    if (!t) throw fail('Thread not found', 404);
    const syncVal = Boolean(shouldSync);
    const updated = threads.updateThread(threadId, {
      settings: { ...t.settings, sync: syncVal }
    });
    return {
      id: threadId,
      title: updated.title,
      sync: syncVal,
      syncMode: syncVal ? 'seamless' : 'local'
    };
  }

  getStatus() {
    const all = threads.listThreads();
    let seamlessCount = 0;
    let localCount = 0;

    const list = all.map(t => {
      const seamless = this.isSeamless(t);
      if (seamless) seamlessCount++;
      else localCount++;
      return {
        id: t.id,
        title: t.title,
        cwd: t.cwd,
        sync: seamless,
        syncMode: seamless ? 'seamless' : 'local',
        updated: t.updated
      };
    });

    return {
      remoteOrigin: this.remoteOrigin,
      isHostPi: process.platform !== 'win32',
      totalThreads: all.length,
      seamlessCount,
      localCount,
      threads: list
    };
  }

  // Receive synced thread payload from another Conclave instance
  receive({ fromPlatform, thread, messages = [], plans = [], questions = [] }) {
    if (!thread || !thread.id) throw fail('Thread data required');

    const db = getDb();
    const toPlatform = process.platform;
    const translatedCwd = translatePath(thread.cwd, fromPlatform, toPlatform);

    // Upsert thread
    const existing = db.prepare('SELECT id, settings FROM threads WHERE id = ?').get(thread.id);
    const existingSettings = existing ? (typeof existing.settings === 'string' ? JSON.parse(existing.settings || '{}') : existing.settings) : {};
    const incomingSettings = typeof thread.settings === 'string' ? JSON.parse(thread.settings || '{}') : (thread.settings || {});
    const settings = {
      ...existingSettings,
      ...incomingSettings,
      sync: true // Explicitly seamless
    };

    if (!existing) {
      db.prepare(`
        INSERT INTO threads (id, title, cwd, target, settings, created, updated)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        thread.id,
        thread.title || 'Synced chat',
        translatedCwd,
        thread.target || 'claude',
        JSON.stringify(settings),
        thread.created || new Date().toISOString(),
        thread.updated || new Date().toISOString()
      );
    } else {
      db.prepare(`
        UPDATE threads SET title = ?, cwd = ?, target = ?, settings = ?, updated = ?
        WHERE id = ?
      `).run(
        thread.title || 'Synced chat',
        translatedCwd,
        thread.target || 'claude',
        JSON.stringify(settings),
        thread.updated || new Date().toISOString(),
        thread.id
      );
    }

    // Upsert messages
    let insertedMessages = 0;
    const existingMsgIds = new Set(
      db.prepare('SELECT id FROM thread_messages WHERE thread_id = ?').all(thread.id).map(r => r.id)
    );

    for (const m of messages) {
      if (!existingMsgIds.has(m.id)) {
        const content = translatePath(m.content, fromPlatform, toPlatform);
        db.prepare(`
          INSERT INTO thread_messages (id, thread_id, role, tool, round, content, activity, status, error, created, finished, files, usage, snap)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          m.id,
          thread.id,
          m.role,
          m.tool || null,
          m.round || null,
          content || '',
          typeof m.activity === 'string' ? m.activity : JSON.stringify(m.activity || []),
          m.status || 'done',
          m.error || null,
          m.created || new Date().toISOString(),
          m.finished || null,
          typeof m.files === 'string' ? m.files : JSON.stringify(m.files || []),
          typeof m.usage === 'string' ? m.usage : JSON.stringify(m.usage || {}),
          m.snap ? (typeof m.snap === 'string' ? m.snap : JSON.stringify(m.snap)) : null
        );
        insertedMessages++;
      }
    }

    // Upsert plans
    for (const p of plans) {
      const exPlan = db.prepare('SELECT id FROM plans WHERE id = ?').get(p.id);
      if (!exPlan) {
        db.prepare(`
          INSERT INTO plans (id, thread_id, message_id, revision, status, summary, steps, error, created, updated)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          p.id, thread.id, p.message_id || null, p.revision || 1, p.status || 'done',
          p.summary || '', typeof p.steps === 'string' ? p.steps : JSON.stringify(p.steps || []),
          p.error || null, p.created || new Date().toISOString(), p.updated || new Date().toISOString()
        );
      }
    }

    // Upsert questions
    for (const q of questions) {
      const exQ = db.prepare('SELECT id FROM questions WHERE id = ?').get(q.id);
      if (!exQ) {
        db.prepare(`
          INSERT INTO questions (id, thread_id, message_id, plan_id, step_id, agent, question, options, multi, via, status, answer, created, answered)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          q.id, thread.id, q.message_id || null, q.plan_id || null, q.step_id || null,
          q.agent || 'council', q.question || '',
          typeof q.options === 'string' ? q.options : JSON.stringify(q.options || []),
          q.multi ? 1 : 0, q.via || 'tool', q.status || 'pending', q.answer || null,
          q.created || new Date().toISOString(), q.answered || null
        );
      }
    }

    return {
      ok: true,
      threadId: thread.id,
      insertedMessages,
      totalMessages: messages.length
    };
  }

  // Get authenticated session cookie for remote Pi instance
  async getRemoteCookie() {
    if (!this.ownerPass) {
      try {
        const file = process.env.CONCLAVE_SYNC_CREDENTIALS_FILE || path.join(os.homedir(), '.config', 'conclave', 'sync-owner.json');
        const credentials = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.ownerUser = credentials.username;
        this.ownerPass = credentials.password;
      } catch { throw fail('Private sync credentials are not configured', 503); }
    }

    if (this.cachedSessionCookie && (Date.now() - this.cachedCookieTime < 10 * 60 * 1000)) {
      return this.cachedSessionCookie;
    }

    const res = await fetch(`${this.remoteOrigin}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': this.remoteOrigin,
        'Referer': `${this.remoteOrigin}/login`
      },
      body: JSON.stringify({ username: this.ownerUser, password: this.ownerPass }),
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
      throw fail(`Remote login failed with status ${res.status}`);
    }

    const rawCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
    const cookie = (rawCookies || []).filter(Boolean).map(c => c.split(';')[0]).join('; ');
    this.cachedSessionCookie = cookie;
    this.cachedCookieTime = Date.now();
    return cookie;
  }

  // Push local seamless thread to remote Raspberry Pi instance
  async syncThread(threadId) {
    const t = threads.getThread(threadId);
    if (!t) throw fail('Thread not found', 404);
    if (!this.isSeamless(t)) {
      throw fail('This thread is configured as Local Only. Toggle Seamless sync first.', 400);
    }
    if (!this.remoteOrigin) {
      throw fail('Remote Conclave origin is not configured');
    }

    const db = getDb();
    const rawMessages = db.prepare('SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY seq ASC').all(threadId);
    const plans = db.prepare('SELECT * FROM plans WHERE thread_id = ?').all(threadId);
    const questions = db.prepare('SELECT * FROM questions WHERE thread_id = ?').all(threadId);

    const cookie = await this.getRemoteCookie();

    // 1. Push local messages to remote
    const pushRes = await fetch(`${this.remoteOrigin}/api/sync/receive`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie,
        'Origin': this.remoteOrigin
      },
      body: JSON.stringify({
        fromPlatform: process.platform,
        thread: {
          id: t.id,
          title: t.title,
          cwd: t.cwd,
          target: t.target,
          settings: t.settings,
          created: t.created,
          updated: t.updated
        },
        messages: rawMessages,
        plans,
        questions
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!pushRes.ok) {
      const errText = await pushRes.text();
      throw fail(`Remote sync failed: ${pushRes.status} ${errText}`);
    }

    const pushResult = await pushRes.json();

    // 2. Pull any remote messages that we might not have locally
    try {
      const remoteThreadRes = await fetch(`${this.remoteOrigin}/api/threads/${threadId}`, {
        signal: AbortSignal.timeout(10000),
        headers: {
          'Cookie': cookie,
          'Origin': this.remoteOrigin
        }
      });
      if (remoteThreadRes.ok) {
        const remoteData = await remoteThreadRes.json();
        const remoteMsgs = remoteData.messages || [];
        this.receive({
          fromPlatform: 'linux',
          thread: remoteData,
          messages: remoteMsgs
        });
      }
    } catch (e) {
      console.warn('Pull phase warning:', e.message);
    }

    return {
      ok: true,
      threadId,
      pushedMessages: rawMessages.length,
      remoteInserted: pushResult.insertedMessages,
      syncedAt: new Date().toISOString()
    };
  }

  async syncAllSeamless() {
    const status = this.getStatus();
    const seamlessThreads = status.threads.filter(t => t.sync);
    const results = [];

    for (const t of seamlessThreads) {
      try {
        const res = await this.syncThread(t.id);
        results.push({ id: t.id, title: t.title, ok: true, res });
      } catch (err) {
        results.push({ id: t.id, title: t.title, ok: false, error: err.message });
      }
    }

    return {
      total: seamlessThreads.length,
      successful: results.filter(r => r.ok).length,
      results
    };
  }
}

export function mountSync(app, wrap, syncService = new SyncService()) {
  app.get('/api/sync/status', wrap(() => syncService.getStatus()));
  app.post('/api/sync/receive', wrap(req => syncService.receive(req.body || {})));
  app.post('/api/sync/thread/:id', wrap(req => syncService.syncThread(req.params.id)));
  app.post('/api/sync/all', wrap(() => syncService.syncAllSeamless()));
  app.patch('/api/threads/:id/sync', wrap(req => syncService.toggleSync(req.params.id, req.body.sync)));
  app.get('/api/sync/lock/:id', wrap(req => syncService.checkRemoteBusy(req.params.id)));
  app.post('/api/sync/lock/:id', wrap(req => syncService.handleRemoteLockRequest(req.params.id, req.body)));
  app.delete('/api/sync/lock/:id', wrap(req => syncService.handleRemoteUnlock(req.params.id, req.body)));
  app.post('/api/sync/device/interrupted', wrap(req => {
    if (syncService.device !== 'rasp-pi') throw fail('This device is not the execution coordinator', 409);
    const { device, threadId } = req.body || {};
    return syncService.claims.markDeviceInterrupted(device, threadId);
  }));
  if (threads.setLockProvider) threads.setLockProvider(syncService);
  return syncService;
}
