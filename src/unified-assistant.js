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
  const assistant = createApp({ db, origin, syncSharedMemory, globalInstructions:()=>promptText('assistant'), sharedIdentity: req => req.conclaveIdentity });
  app.use('/assistant', (req, res) => {
    if (!req.conclaveIdentity) return res.status(401).json({ error: 'Owner browser session required' });
    if (req.url === '/' && !req.originalUrl.includes('/assistant/')) return res.redirect(308, '/assistant/');
    assistant.emit('request', req, res);
  });
  return id => db.prepare('DELETE FROM sessions WHERE id=?').run(sessionHash(id, env.SESSION_SECRET));
}

export function syncGlobalMemories(coding,assistant) {
  const rows=coding.prepare("SELECT * FROM memories WHERE scope='global'").all(),ids=new Set();
  for(const row of rows){const memoryId='conclave-'+row.id;ids.add(memoryId);assistant.prepare(`INSERT INTO memories(id,content,updated_at,topic,source,metadata) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at,topic=excluded.topic,metadata=excluded.metadata WHERE memories.content!=excluded.content OR memories.updated_at!=excluded.updated_at`).run(memoryId,row.title+'\n'+row.body,Date.parse(row.updated) || Date.now(),'Conclave · '+row.type,'conclave-shared',JSON.stringify({kind:row.type==='reference'?'source_claim':'owner_context',scope:'global',source_id:row.id}));}
  for(const old of assistant.prepare("SELECT id FROM memories WHERE source='conclave-shared'").all())if(!ids.has(old.id))assistant.prepare('DELETE FROM memories WHERE id=?').run(old.id);
}
