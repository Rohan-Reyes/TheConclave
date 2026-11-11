import { sessionHash, credential } from './security.js';
import { id, transaction, audit } from './db.js';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
export function companionSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS companions(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, capabilities TEXT NOT NULL, last_seen INTEGER, revoked_at INTEGER);
    CREATE TABLE IF NOT EXISTS companion_work(id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES companions(id), kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL, lease_until INTEGER, result TEXT, created_at INTEGER NOT NULL);`);
}
export function companionOwner(db,path,b,secret,method) {
  if(path==='/api/companions'&&method==='GET')return db.prepare('SELECT id,name,capabilities,last_seen,revoked_at FROM companions').all();
  if(path==='/api/companions'&&method==='POST'){
    if(typeof b.name!=='string'||!b.name.trim()||b.name.length>80)fail(400,'Device name required');
    if(!Array.isArray(b.capabilities)||!b.capabilities.length||!b.capabilities.every(c=>['notify','read_file','command'].includes(c)))fail(400,'Choose explicit supported capabilities');
    const token=credential(),target=id();
    db.prepare('INSERT INTO companions VALUES(?,?,?,?,NULL,NULL)').run(target,b.name.trim(),sessionHash(token,secret),JSON.stringify([...new Set(b.capabilities)])); audit(db,'companion.enrolled',target);
    return {id:target,token,note:'Shown once. Save privately on the companion device. Never paste into chat.'};
  }
  if(/^\/api\/companions\/[^/]+$/.test(path)&&method==='DELETE'){
    const target=path.split('/').at(-1);
    transaction(db,()=>{db.prepare('UPDATE companions SET revoked_at=? WHERE id=?').run(Date.now(),target);db.prepare("UPDATE companion_work SET state='cancelled' WHERE device_id=? AND state='queued'").run(target);audit(db,'companion.revoked',target);});return {ok:true};
  }
  if(path==='/api/companions/work'&&method==='GET')return db.prepare('SELECT id,device_id,kind,state,expires_at,result,created_at FROM companion_work ORDER BY created_at DESC LIMIT 100').all();
  if(path==='/api/companions/work'&&method==='POST'){
    const device=db.prepare('SELECT * FROM companions WHERE id=? AND revoked_at IS NULL').get(String(b.device_id));
    if(!device||!JSON.parse(device.capabilities).includes(b.kind))fail(403,'Device lacks the requested capability');
    let payload;
    if(b.kind==='notify')payload={title:String(b.title||'Jarvis').slice(0,200),body:String(b.body||'').slice(0,1000)};
    else if(b.kind==='read_file')payload={path:String(b.path||'').slice(0,500)};
    else if(b.kind==='command')payload={command_id:String(b.command_id||'').slice(0,100)};
    else fail(400,'Unsupported capability');
    const target=id(),now=Date.now();db.prepare("INSERT INTO companion_work VALUES(?,?,?,?,'queued',?,NULL,NULL,?)").run(target,device.id,b.kind,JSON.stringify(payload),now+5*60_000,now);audit(db,'companion.work_queued',target);return {id:target,expires_at:now+5*60_000};
  }
  fail(404,'Companion operation not found');
}
export function companionDevice(db,path,b,authorization,secret) {
  const token=authorization?.startsWith('Bearer ')?authorization.slice(7):'';
  const device=token&&db.prepare('SELECT * FROM companions WHERE token_hash=? AND revoked_at IS NULL').get(sessionHash(token,secret));
  if(!device)fail(401,'Companion credential invalid or revoked');
  const now=Date.now();db.prepare('UPDATE companions SET last_seen=? WHERE id=?').run(now,device.id);
  db.prepare("UPDATE companion_work SET state='expired' WHERE state='queued' AND expires_at<=?").run(now);
  db.prepare("UPDATE companion_work SET state='uncertain',result='Device disconnected during execution; reconcile locally before retrying' WHERE state='running' AND lease_until<=?").run(now);
  if(path==='/api/companion/poll'){
    const job=transaction(db,()=>db.prepare("UPDATE companion_work SET state='running',lease_until=? WHERE id=(SELECT id FROM companion_work WHERE device_id=? AND state='queued' AND expires_at>? ORDER BY created_at LIMIT 1) RETURNING id,kind,payload,expires_at,lease_until").get(now+60_000,device.id,now));
    return {work:job?{...job,payload:JSON.parse(job.payload)}:null};
  }
  if(path==='/api/companion/validate'){
    if(!db.prepare("SELECT id FROM companion_work WHERE id=? AND device_id=? AND state='running' AND lease_until>? AND expires_at>?").get(String(b.id),device.id,now,now))fail(409,'Work expired or no longer authorized');return {ok:true};
  }
  if(path==='/api/companion/result'){
    if(!['completed','failed'].includes(b.state)||typeof b.result!=='string'||b.result.length>16000)fail(400,'Invalid bounded result');
    const changed=db.prepare("UPDATE companion_work SET state=?,result=?,lease_until=NULL WHERE id=? AND device_id=? AND state='running' AND lease_until>? AND expires_at>?").run(b.state,b.result,String(b.id),device.id,now,now);
    if(!changed.changes)fail(409,'Work expired or was already acknowledged'); audit(db,'companion.work_result',String(b.id));return {ok:true};
  }
  fail(404,'Companion endpoint not found');
}
