import { createInterface } from 'node:readline/promises';
import { existsSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openDb } from './db.js';
import { passwordHash } from './security.js';

if (!process.stdin.isTTY) throw new Error('Run setup in an interactive terminal');
if (!existsSync('.env')) {
  writeFileSync('.env', `APP_ORIGIN=http://localhost:3210\nAPP_TIMEZONE=Asia/Manila\nPORT=3210\nDATA_DIR=./private\nSESSION_SECRET=${randomBytes(32).toString('hex')}\nTOKEN_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\nWEATHER_PROVIDER=open-meteo\n`, { mode: 0o600, flag: 'wx' });
}
process.loadEnvFile('.env');
const db = openDb();
if (db.prepare('SELECT id FROM owner').get()) { console.log('Owner already exists. Setup did not change credentials.'); db.close(); process.exit(0); }
const rl = createInterface({ input: process.stdin, output: process.stdout });
const username = (await rl.question('Owner username: ')).trim();
if (!username || username.length > 100) throw new Error('Username required (max 100 characters)');
rl.close();
// Raw input prevents password echo or inclusion in command history.
async function hidden(prompt) {
  process.stdout.write(prompt); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = data => {
      for (const char of data) {
        if (char === '\u0003') { cleanup(); reject(new Error('Setup cancelled')); return; }
        if (char === '\r' || char === '\n') { cleanup(); resolve(value); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    const cleanup = () => { process.stdin.removeListener('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
    process.stdin.on('data', onData);
  });
}
const password = await hidden('Owner password (12+ characters, hidden): ');
const confirm = await hidden('Confirm password: ');
if (password !== confirm) throw new Error('Passwords do not match');
db.prepare('INSERT INTO owner VALUES(1,?,?)').run(username, passwordHash(password));
db.close();
try { chmodSync('.env', 0o600); } catch { /* Windows uses ACLs. */ }
console.log('Owner created. Keep .env and private/ protected with OS permissions. Start API and worker in separate terminals.');
