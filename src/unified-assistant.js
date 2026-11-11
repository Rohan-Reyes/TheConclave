import { createHash } from 'node:crypto';
import { getDb } from './db.js';
import { promptText } from './config/globals.js';
import { openDb } from '../assistant/src/db.js';
import { sessionHash } from '../assistant/src/security.js';
import { createApp } from '../assistant/src/server.js';

// Mounted only after Conclave authentication. No HTTP header can assert identity.
export function mountAssistant(app, { authenticated, env = process.env } = {}) {
  if (env.CONCLAVE_ASSISTANT_ENABLED !== '1') return () => {};
  if (!authenticated) throw new Error('The unified assistant requires Conclave owner authentication');
  const origin = env.CONCLAVE_PUBLIC_ORIGIN || `http://127.0.0.1:${env.CONCLAVE_PORT || env.PORT || 4777}`;
  const db = openDb();
  db.prepare("DELETE FROM sessions WHERE label='Conclave browser'").run();
  const syncSharedMemory=()=>syncGlobalMemories(getDb(),db);
  syncSharedMemory();
  const assistant = createApp({ db, origin, syncSharedMemory, codingSnapshot: () => codingSnapshot(getDb()), globalInstructions:()=>promptText('assistant'), sharedIdentity: req => req.conclaveIdentity });
  app.use('/assistant', (req, res) => {
    if (!req.conclaveIdentity) return res.status(401).json({ error: 'Owner browser session required' });
    if (req.url === '/' && !req.originalUrl.includes('/assistant/')) return res.redirect(308, '/assistant/');
    if (req.method === 'GET' && /^\/(?:index\.html)?(?:\?.*)?$/.test(req.url)) return sendAssistantRedirect(res);
    assistant.emit('request', req, res);
  });
  return id => db.prepare('DELETE FROM sessions WHERE id=?').run(sessionHash(id, env.SESSION_SECRET));
}

// The assistant UI now lives inside the Conclave app. /assistant/ (old bookmarks, the installed PWA
// start URL, OAuth returns and push notification clicks) maps its old #page to the new route.
// Assets, the API, the manifest and the push service worker stay under /assistant/.
export const ASSISTANT_ROUTES = { dashboard: 'mind', chat: 'management', management: 'management', notes: 'assistant-notes', today: 'today', tasks: 'automations', inbox: 'assistant-inbox', connections: 'connectors', telegram: 'telegram', devices: 'jarvis/devices', settings: 'assistant-settings' };
const redirectScript = `(function(){var m=${JSON.stringify(ASSISTANT_ROUTES)};var k=location.hash.slice(1);location.replace('/#/'+(Object.prototype.hasOwnProperty.call(m,k)?m[k]:'management'));})();`;
const redirectHash = createHash('sha256').update(redirectScript).digest('base64');
const redirectPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conclave</title><link rel="manifest" href="/assistant/manifest.webmanifest"><script>${redirectScript}</script><noscript><meta http-equiv="refresh" content="0;url=/#/management"></noscript></head><body><a href="/#/management">Open Jarvis in Conclave</a></body></html>`;
export function sendAssistantRedirect(res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'sha256-${redirectHash}'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(redirectPage);
}

// Read-only view of Conclave coding context for the memory map. Nothing is written or copied.
// Seamless rule matches SyncManager.isSeamless: explicit settings.sync, else paths inside a Conclave folder.
export function isSeamlessThread(t) {
  let settings = t.settings;
  if (typeof settings === 'string') { try { settings = JSON.parse(settings); } catch { settings = {}; } }
  if (settings && typeof settings.sync === 'boolean') return settings.sync;
  return String(t.cwd || '').toLowerCase().includes('conclave');
}
export function codingSnapshot(coding) {
  const memories = coding.prepare('SELECT id, title, body, type, scope, updated FROM memories ORDER BY updated DESC LIMIT 2000').all();
  const threads = coding.prepare('SELECT id, title, cwd, settings, updated FROM threads ORDER BY updated DESC LIMIT 500').all()
    .map(t => ({ id: t.id, title: t.title, cwd: t.cwd, updated: t.updated, seamless: isSeamlessThread(t) }));
  return { memories, threads };
}

export function syncGlobalMemories(coding,assistant) {
  const rows=coding.prepare("SELECT * FROM memories WHERE scope='global'").all(),ids=new Set();
  for(const row of rows){const memoryId='conclave-'+row.id;ids.add(memoryId);assistant.prepare(`INSERT INTO memories(id,content,updated_at,topic,source,metadata) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at,topic=excluded.topic,metadata=excluded.metadata WHERE memories.content!=excluded.content OR memories.updated_at!=excluded.updated_at`).run(memoryId,row.title+'\n'+row.body,Date.parse(row.updated) || Date.now(),'Conclave · '+row.type,'conclave-shared',JSON.stringify({kind:row.type==='reference'?'source_claim':'owner_context',scope:'global',source_id:row.id}));}
  for(const old of assistant.prepare("SELECT id FROM memories WHERE source='conclave-shared'").all())if(!ids.has(old.id))assistant.prepare('DELETE FROM memories WHERE id=?').run(old.id);
}
