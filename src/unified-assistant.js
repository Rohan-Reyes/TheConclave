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
  const assistant = createApp({ db, origin, globalInstructions:()=>promptText('assistant'), sharedIdentity: req => req.conclaveIdentity });
  app.use('/assistant', (req, res) => {
    if (!req.conclaveIdentity) return res.status(401).json({ error: 'Owner browser session required' });
    if (req.url === '/' && !req.originalUrl.includes('/assistant/')) return res.redirect(308, '/assistant/');
    assistant.emit('request', req, res);
  });
  return id => db.prepare('DELETE FROM sessions WHERE id=?').run(sessionHash(id, env.SESSION_SECRET));
}
