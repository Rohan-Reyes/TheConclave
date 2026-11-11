import { createInterface } from 'node:readline/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createCredentials } from '../src/auth.js';

if (!process.stdin.isTTY) throw new Error('Run setup in a private interactive terminal');
if (existsSync('.env') || existsSync('private/owner.json')) throw new Error('Existing setup found; refusing to replace credentials');
const prompt = createInterface({input:process.stdin,output:process.stdout});
try {
  const username=(await prompt.question('Owner username: ')).trim();
  prompt.close();
  const hidden=createInterface({input:process.stdin,output:process.stdout});
  hidden._writeToOutput=()=>{};
  process.stdout.write('New password (16+ characters, hidden): ');
  const password=await hidden.question('');
  process.stdout.write('\nConfirm password (hidden): ');
  const confirm=await hidden.question(''); hidden.close();process.stdout.write('\n');
  if(password!==confirm)throw new Error('Passwords do not match');
  const credentials=await createCredentials(username,password);
  mkdirSync('private',{recursive:true,mode:0o700});
  writeFileSync('private/owner.json',JSON.stringify(credentials,null,2),{mode:0o600,flag:'wx'});
  writeFileSync('.env',`CONCLAVE_PORT=4888\nCONCLAVE_AUTH_FILE=${resolve('private/owner.json')}\nCONCLAVE_ASSISTANT_ENABLED=1\nAGENT_HUB_DATA_DIR=./private/coding\nDATA_DIR=./private/assistant\nAPP_TIMEZONE=Asia/Manila\nSESSION_SECRET=${randomBytes(32).toString('hex')}\nTOKEN_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\n`,{mode:0o600,flag:'wx'});
  console.log('Private development setup created. Run npm start and npm run worker.');
} finally {prompt.close();}
