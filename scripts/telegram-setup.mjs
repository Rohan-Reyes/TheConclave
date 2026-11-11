import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openDb} from '../assistant/src/db.js';
import {setSecret} from '../assistant/src/integrations.js';
if(!process.stdin.isTTY)throw new Error('Use a private interactive terminal for Telegram authorization');
if(!/^[a-f0-9]{64}$/i.test(process.env.TOKEN_ENCRYPTION_KEY || ''))throw new Error('Load the private Conclave environment first');
const python=process.env.TELEGRAM_PYTHON || 'python3';
const child=spawn(python,[fileURLToPath(new URL('../assistant/telegram/userbot.py',import.meta.url)),'--enroll'],{stdio:['inherit','pipe','inherit']});
let output='';for await(const chunk of child.stdout){output+=chunk;if(output.length>32000){child.kill();throw new Error('Invalid enrollment response');}}
const code=await new Promise(resolve=>{if(child.exitCode!==null)resolve(child.exitCode);else child.once('exit',resolve);});
let config;try{config=JSON.parse(output);}catch{throw new Error('Telegram enrollment did not complete');}
if(code!==0 || !config.session || !Number.isSafeInteger(config.owner_id) || config.owner_id<=0)throw new Error('Telegram enrollment failed; no credential saved');
const db=openDb();setSecret(db,'config:telegram',config,process.env.TOKEN_ENCRYPTION_KEY);db.close();
console.log('Telegram session stored encrypted. Open Telegram in Conclave to enable it. No message or call was sent.');
