// Run once, locally as the Jarvis OS identity, with its private runtime environment.
// The generated login password is written only to a mode-0600 private file.
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { passwordHash } from '../src/security.js';
const db=openDb();
if(!db.prepare('SELECT id FROM owner').get()){
  const password=randomBytes(24).toString('base64url');
  writeFileSync('/var/lib/jarvis/initial-owner-password',password+'\n',{mode:0o600,flag:'wx'});
  db.prepare('INSERT INTO owner VALUES(1,?,?)').run('owner',passwordHash(password));
  console.log('Owner provisioned. Retrieve the initial credential privately over SSH, then change it in Settings.');
}else console.log('Existing owner preserved.');
db.close();
