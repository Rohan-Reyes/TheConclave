// Run on the Pi as the Jarvis identity. Credentials stay in process memory.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { openDb, id, transaction } from '../src/db.js';
let cookie='';
async function call(path,body){
  return new Promise((resolve,reject)=>{
    const encoded=body?JSON.stringify(body):null;
    const req=request({host:'127.0.0.1',port:3210,path,method:body?'POST':'GET',headers:{Host:'jarvis.aten-systems.site',Origin:'https://jarvis.aten-systems.site',Cookie:cookie,...(encoded?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(encoded)}:{})}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(text)}));});req.on('error',reject);req.end(encoded);
  });
}
const password=readFileSync('/var/lib/jarvis/initial-owner-password','utf8').trim();
const login=await call('/api/login',{username:'owner',password,device_name:'Deployment verification'});
if(login.status!==200)throw new Error(`Owner login failed: ${login.status}`);
cookie=login.headers['set-cookie'][0].split(';')[0];
if(!login.headers['set-cookie'][0].includes('Secure'))throw new Error('Public cookie is missing Secure');
if((await call('/api/me')).status!==200)throw new Error('Authenticated API check failed');
await call('/api/logout',{});console.log('Owner password login, secure cookie, authenticated API and logout verified without exposing credentials.');
const db=openDb(),schedule=id(),now=Date.now();
db.prepare("INSERT INTO schedules VALUES(?,?,?,?,?,?,'active','catch_up',?)").run(schedule,'Deployment verification','Deployment health check',JSON.stringify({type:'once',kind:'reminder'}),'Asia/Manila',now,now);
try{
  let job;
  for(let i=0;i<15;i++){await new Promise(resolve=>setTimeout(resolve,1000));job=db.prepare('SELECT * FROM jobs WHERE schedule_id=?').get(schedule);if(job?.state==='completed')break;}
  if(job?.state!=='completed')throw new Error('Live scheduler did not complete its verification reminder');
  if(db.prepare('SELECT count(*) AS n FROM notifications WHERE job_id=?').get(job.id).n!==1)throw new Error('Expected one notification');
  console.log('Live durable scheduler and worker completed exactly one reminder notification.');
}finally{
  transaction(db,()=>{db.prepare('DELETE FROM notifications WHERE job_id IN (SELECT id FROM jobs WHERE schedule_id=?)').run(schedule);db.prepare('DELETE FROM jobs WHERE schedule_id=?').run(schedule);db.prepare('DELETE FROM schedules WHERE id=?').run(schedule);});db.close();
}
