import { TelegramWorker } from './telegram.js';
import { promptText } from '../../src/config/globals.js';
import { openDb } from './db.js';
import { tick } from './scheduling.js';
import { deliverPush } from './push.js';
const db = openDb();
const telegram=new TelegramWorker(db,process.env.TOKEN_ENCRYPTION_KEY,{instructions:()=>promptText('assistant')});
let telegramBusy=false;
let stopped = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopped = true; });
console.log('Jarvis worker running; durable SQLite polling every second.');
while (!stopped) {
  try { await tick(db); await deliverPush(db, process.env.TOKEN_ENCRYPTION_KEY); } catch { console.error('Worker tick failed; retrying. No private payload logged.'); }
  if(!telegramBusy){telegramBusy=true;telegram.tick().catch(()=>{}).finally(()=>{telegramBusy=false;});}
  await new Promise(resolve => setTimeout(resolve, 1000));
}
telegram.close();
while(telegramBusy || telegram.active.size)await new Promise(resolve=>setTimeout(resolve,100));
db.close();
