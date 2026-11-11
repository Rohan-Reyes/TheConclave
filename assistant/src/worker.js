import { openDb } from './db.js';
import { tick } from './scheduling.js';
import { deliverPush } from './push.js';
const db = openDb();
let stopped = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopped = true; });
console.log('Jarvis worker running; durable SQLite polling every second.');
while (!stopped) {
  try { await tick(db); await deliverPush(db, process.env.TOKEN_ENCRYPTION_KEY); } catch { console.error('Worker tick failed; retrying. No private payload logged.'); }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
db.close();
