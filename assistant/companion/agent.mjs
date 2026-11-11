// Optional outbound-only companion. Keep its config/credential private and outside the repository.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
const run=promisify(execFile), config=JSON.parse(readFileSync(process.argv[2]||'companion.private.json','utf8'));
const origin=new URL(config.origin);
if(origin.origin!==config.origin||(origin.protocol!=='https:'&&!['127.0.0.1','localhost'].includes(origin.hostname)))throw new Error('Use exact HTTPS origin or local development origin');
if(!config.token||!Array.isArray(config.capabilities))throw new Error('Configure unique credential and explicit capabilities');
let stopped=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>stopped=true);
async function api(path,data){const res=await fetch(`${origin.origin}/api/companion/${path}`,{method:'POST',headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'},body:JSON.stringify(data),redirect:'error',signal:AbortSignal.timeout(15000)});if(!res.ok)throw new Error(`Server returned ${res.status}`);return res.json();}
async function approved(text){if(!process.stdin.isTTY)throw new Error('Sensitive companion actions require interactive local confirmation');const rl=createInterface({input:process.stdin,output:process.stdout});try{return(await rl.question(`${text}\nApprove locally? Type yes: `)).trim()==='yes';}finally{rl.close();}}
async function execute(work){
  if(!config.capabilities.includes(work.kind))throw new Error('Capability is not allowed locally');
  if(work.expires_at<=Date.now())throw new Error('Action expired');
  if(work.kind==='notify'){
    if(process.platform==='linux')await run('notify-send',['--',work.payload.title,work.payload.body],{timeout:10000});
    else console.log(`Jarvis notification: ${work.payload.title}\n${work.payload.body}`);
    return 'Notification presented on the companion';
  }
  if(work.kind==='read_file'){
    const path=realpathSync(resolve(work.payload.path));
    const allowed=(config.allowed_roots||[]).some(root=>{const rel=relative(realpathSync(root),path);return rel!==''&&!rel.startsWith('..')&&!isAbsolute(rel);});
    if(!allowed||!statSync(path).isFile()||statSync(path).size>12000)throw new Error('File must be below an allowed root and smaller than 12 KB');
    if(!await approved(`Read selected file and send its text to your Jarvis server: ${path}`))throw new Error('Declined locally');
    if(Math.min(work.expires_at,work.lease_until)<=Date.now())throw new Error('Action expired during confirmation');
    await api('validate',{id:work.id});
    return readFileSync(path,'utf8').slice(0,12000);
  }
  if(work.kind==='command'){
    const command=config.commands?.[work.payload.command_id];
    if(!Array.isArray(command)||!command.length||!command.every(x=>typeof x==='string'))throw new Error('Command ID is not in the local allowlist');
    if(!await approved(`Run locally allowlisted command ${work.payload.command_id}: ${JSON.stringify(command)}`))throw new Error('Declined locally');
    if(Math.min(work.expires_at,work.lease_until)<=Date.now())throw new Error('Action expired during confirmation');
    await api('validate',{id:work.id});
    const result=await run(command[0],command.slice(1),{shell:false,windowsHide:true,timeout:20000,maxBuffer:12000});return result.stdout.slice(0,12000);
  }
  throw new Error('Unsupported local capability');
}
console.log('Jarvis companion running. Outbound polling; no inbound listener.');
while(!stopped){
  try{const {work}=await api('poll',{});if(work){let state='completed',result;try{result=await execute(work);}catch{state='failed';result='Local action failed, expired or was declined; inspect locally.';}await api('result',{id:work.id,state,result});}}
  catch{console.error('Companion disconnected or credential revoked. No action is replayed locally.');}
  await new Promise(resolve=>setTimeout(resolve,5000));
}
