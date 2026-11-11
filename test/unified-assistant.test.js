import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentials, mountAuth } from '../src/auth.js';
import { createApp } from '../assistant/src/server.js';
import { sessionHash } from '../assistant/src/security.js';
import { openDb } from '../assistant/src/db.js';

test('one login gates assistant, persists notes, rejects forged identity and revokes both surfaces', async t => {
  const dir=mkdtempSync(join(tmpdir(),'conclave-unified-'));
  const file=join(dir,'owner.json');
  writeFileSync(file,JSON.stringify(await createCredentials('owner','test-password-only-1234')));
  const db=openDb(':memory:');
  const app=express();
  const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  mountAuth(app,{root:process.cwd(),env:{CONCLAVE_AUTH_FILE:file},onSessionRevoked:id=>db.prepare('DELETE FROM sessions WHERE id=?').run(sessionHash(id,'11'.repeat(32)))});
  const assistant=createApp({db,origin,secret:'11'.repeat(32),encryptionKey:'22'.repeat(32),sharedIdentity:req=>req.conclaveIdentity});
  app.use('/assistant',(req,res)=>assistant.emit('request',req,res));
  t.after(async()=>{await new Promise(r=>server.close(r));db.close();rmSync(dir,{recursive:true,force:true});});
  const anon=await fetch(origin+'/assistant/api/notes',{headers:{'X-Conclave-Identity':'owner'},redirect:'manual'});assert.equal(anon.status,303);
  const login=await fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'owner',password:'test-password-only-1234'})});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const call=(path,body,extra={})=>fetch(origin+path,{headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{}),...extra});
  const me=await call('/assistant/api/me');assert.equal((await me.json()).username,'owner');
  const saved=await call('/assistant/api/notes',{title:'Test task',content:'Build a thing'});assert.equal(saved.status,201);
  const notes=await call('/assistant/api/notes');assert.equal((await notes.json())[0].content,'Build a thing');
  const assets=await call('/assistant/');assert.equal(assets.headers.get('x-frame-options'),'SAMEORIGIN');assert.match(assets.headers.get('content-security-policy'),/frame-ancestors 'self'/);assert.match(await assets.text(),/\/assistant\/app.js/);
  const forbidden=await call('/assistant/api/notes',{title:'CSRF',content:'No'},{headers:{Cookie:cookie,Origin:'https://other.invalid','Content-Type':'application/json'}});assert.equal(forbidden.status,403);
  const bypass=await call('/assistant/api/login',{username:'owner',password:'test-password-only-1234'});assert.equal(bypass.status,409);
  await call('/api/auth/logout',{});
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM devices').get().n,0);
  const revoked=await fetch(origin+'/assistant/api/notes',{headers:{Cookie:cookie},redirect:'manual'});assert.equal(revoked.status,303);
});

test('merged memory graph: tags origin, links coding context, hides Local Only, supports incremental refresh', async () => {
  const { mergedMemoryGraph } = await import('../assistant/src/memory-graph.js');
  const { codingSnapshot, isSeamlessThread } = await import('../src/unified-assistant.js');
  const { DatabaseSync: Database } = await import('node:sqlite');
  const db = openDb(':memory:');
  const old = Date.now() - 60_000;
  db.prepare('INSERT INTO memories(id,content,updated_at) VALUES(?,?,?)').run('m1', 'Prefers dark mode in every editor', old);
  db.prepare('INSERT INTO notes(id,title,content,updated_at) VALUES(?,?,?,?)').run('n1', 'Groceries', 'Milk and eggs', old);
  const coding = new Database(':memory:');
  coding.exec(`CREATE TABLE memories(id TEXT PRIMARY KEY,title TEXT,body TEXT,type TEXT,scope TEXT,tags TEXT,source_tool TEXT,import_key TEXT,created TEXT,updated TEXT);
    CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,target TEXT,settings TEXT,created TEXT,updated TEXT);`);
  const iso = new Date(old).toISOString();
  const thread = coding.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)');
  thread.run('t1', 'Ship unified UI', '/work/u/Conclave/app', 'claude', '{}', iso, iso);
  thread.run('t2', 'Private client work', '/work/u/client-secret', 'codex', '{}', iso, iso);
  thread.run('t3', 'Opted-in project', '/work/u/opted', 'codex', JSON.stringify({ sync: true }), iso, iso);
  const mem = coding.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?)');
  mem.run('c1', 'Use node --test', 'Tests run with node --test', 'project', '/work/u/Conclave/app', '', 'hub', null, iso, iso);
  mem.run('c2', 'Client API secret layout', 'Never share', 'project', '/work/u/client-secret', '', 'hub', null, iso, iso);
  mem.run('c3', 'Global habit', 'Already mirrored', 'user', 'global', '', 'hub', null, iso, iso);

  assert.equal(isSeamlessThread({ cwd: '/x/conclave', settings: '{}' }), true);
  assert.equal(isSeamlessThread({ cwd: '/x/conclave', settings: '{"sync":false}' }), false);
  const snap = codingSnapshot(coding);
  const before = JSON.stringify(coding.prepare('SELECT * FROM memories').all());

  const g = mergedMemoryGraph(db, { coding: snap });
  const ids = new Set(g.nodes.map(n => n.id));
  for (const n of g.nodes) assert.ok(['jarvis', 'conclave'].includes(n.origin), `origin on ${n.id}`);
  assert.ok(ids.has('m1') && ids.has('note:n1'));
  assert.ok(ids.has('project:/work/u/Conclave/app') && ids.has('chat:t1') && ids.has('coding:c1'));
  assert.ok(ids.has('project:/work/u/opted') && ids.has('chat:t3'));
  assert.ok(!ids.has('project:/work/u/client-secret') && !ids.has('chat:t2') && !ids.has('coding:c2'), 'Local Only hidden by default');
  assert.ok(!ids.has('coding:c3'), 'global coding memories are not duplicated');
  assert.equal(g.excluded_local, 1);
  assert.ok(g.links.some(l => l.source === 'project:/work/u/Conclave/app' && l.target === 'coding:c1'));
  for (const l of g.links) assert.ok(ids.has(l.source) && ids.has(l.target), `dangling link ${l.source} -> ${l.target}`);
  assert.equal(g.nodes.find(n => n.id === 'coding:c1').read_only, true);

  const all = mergedMemoryGraph(db, { coding: snap, includeLocal: true });
  const allIds = new Set(all.nodes.map(n => n.id));
  assert.ok(allIds.has('coding:c2') && allIds.has('chat:t2'));
  assert.equal(all.nodes.find(n => n.id === 'project:/work/u/client-secret').local_only, true);

  const since = Date.now() - 1000;
  db.prepare('INSERT INTO memories(id,content,updated_at) VALUES(?,?,?)').run('m2', 'Walks the dog every morning', Date.now());
  const inc = mergedMemoryGraph(db, { coding: snap, updatedSince: since });
  assert.equal(inc.incremental, true);
  assert.deepEqual(inc.nodes.filter(n => n.type === 'memory').map(n => n.id), ['m2']);
  assert.ok(inc.ids.includes('m1') && inc.ids.includes('m2'));
  assert.ok(inc.links.every(l => l.source === 'm2' || l.target === 'm2'));

  assert.equal(JSON.stringify(coding.prepare('SELECT * FROM memories').all()), before, 'coding database untouched');
  assert.equal(db.prepare("SELECT count(*) AS n FROM memories WHERE id LIKE 'coding:%' OR id LIKE 'c%'").get().n, 0, 'nothing copied into Jarvis');
  coding.close(); db.close();
});

test('graph endpoint keeps legacy shape by default and serves merged graph with merged=1', async t => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO memories(id,content,updated_at) VALUES(?,?,?)').run('m1', 'Likes coffee', Date.now());
  const { createServer } = await import('node:http');
  const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const assistant = createApp({ db, origin, secret: '11'.repeat(32), encryptionKey: '22'.repeat(32), sharedIdentity: () => ({ id: 'graph-test', expires: Date.now() + 3600e3 }),
    codingSnapshot: () => ({ memories: [], threads: [{ id: 't1', title: 'Chat', cwd: '/c/conclave', updated: new Date().toISOString(), seamless: true }] }) });
  server.on('request', (req, res) => assistant.emit('request', req, res));
  t.after(() => new Promise(r => { server.close(r); db.close(); }));
  const base = `${origin}/api/memories/graph`;
  const legacy = await (await fetch(base)).json();
  assert.ok(legacy.nodes.every(n => ['jarvis', 'category', 'topic', 'memory'].includes(n.type)));
  const merged = await (await fetch(base + '?merged=1')).json();
  assert.ok(merged.nodes.some(n => n.id === 'chat:t1' && n.origin === 'conclave'));
  const noCoding = await (await fetch(base + '?merged=1&coding=0')).json();
  assert.ok(!noCoding.nodes.some(n => n.origin === 'conclave'));
});

// Scripted stand-in for `userbot.py --login`: no network, records what it was sent.
function fakeLoginBridge(script) {
  const sent = [], out = [];
  return { sent, factory: () => ({
    send: msg => { sent.push(msg); out.push(script(msg, sent.length)); },
    next: async () => out.shift() ?? Promise.reject(new Error('closed')),
    close: () => {},
  }) };
}
const SESSION = '1' + 'B'.repeat(200);

test('telegram browser login: phone -> code -> 2FA saves only the encrypted session', async () => {
  const { TelegramLogin, telegramStatus } = await import('../assistant/src/telegram.js');
  const db = openDb(':memory:'), key = '33'.repeat(32);
  const fake = fakeLoginBridge(msg => msg.phone ? { step: 'code' }
    : msg.code === '11111' ? { step: 'code', error: 'PhoneCodeInvalidError' }
    : msg.code ? { step: 'password' }
    : msg.password === 'correct horse' ? { step: 'done', session: SESSION, account_id: 777 } : { step: 'password', error: 'PasswordHashInvalidError' });
  const login = new TelegramLogin(db, key, { spawnBridge: fake.factory, app: () => null });

  await assert.rejects(login.start({ phone: '12', api_id: 1, api_hash: 'ab'.repeat(16) }), /international format/);
  await assert.rejects(login.start({ phone: '+639171234567' }), /API ID/);
  const started = await login.start({ phone: '+63 917 123 4567', api_id: '12345', api_hash: 'ab'.repeat(16), owner_id: '424242' });
  assert.equal(started.step, 'code');
  assert.deepEqual(fake.sent[0], { api_id: 12345, api_hash: 'ab'.repeat(16), phone: '+639171234567' });
  await assert.rejects(login.code({ login_id: 'wrong', code: '12345' }), /expired/);
  await assert.rejects(login.password({ login_id: started.login_id, password: 'x' }), /waiting for the code/);
  const retry = await login.code({ login_id: started.login_id, code: '11111' });
  assert.equal(retry.step, 'code'); assert.match(retry.error, /not correct/);
  assert.equal((await login.code({ login_id: started.login_id, code: '22222' })).step, 'password');
  assert.match((await login.password({ login_id: started.login_id, password: 'nope' })).error, /password is not correct/);
  const done = await login.password({ login_id: started.login_id, password: 'correct horse' });
  assert.deepEqual(done, { step: 'done', account_id: 777, same_as_owner: false });
  assert.equal(login.status(), null);

  const status = telegramStatus(db, key);
  assert.equal(status.configured, true); assert.equal(status.enabled, false); assert.equal(status.owner_id, 424242); assert.equal(status.account_id, 777);
  assert.deepEqual(Object.fromEntries(status.checklist.map(c => [c.id, c.done])), { app: true, owner: true, session: true, separate: true, enabled: false });
  assert.doesNotMatch(JSON.stringify(status), /BBBBBBBB|abababab/);
  // Nothing typed during login is persisted anywhere, and the session is only stored encrypted.
  const dump = JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => db.prepare(`SELECT * FROM "${t.name}"`).all()));
  for (const secret of ['11111', '22222', 'correct horse', 'nope', '9171234567', SESSION]) assert.ok(!dump.includes(secret), `persisted: ${secret}`);
  assert.ok(db.prepare("SELECT count(*) AS n FROM audit WHERE event='telegram.login_completed'").get().n === 1);
  db.close();
});

test('telegram browser login: rate limits, step limit, owner == userbot warning, routes need the owner session', async t => {
  const { TelegramLogin } = await import('../assistant/src/telegram.js');
  const db = openDb(':memory:'), key = '33'.repeat(32);
  let now = 1_000_000;
  const fake = fakeLoginBridge(msg => msg.phone ? { step: 'code' } : msg.code === '99999' ? { step: 'done', session: SESSION, account_id: 5 } : { step: 'code', error: 'PhoneCodeInvalidError' });
  const login = new TelegramLogin(db, key, { spawnBridge: fake.factory, now: () => now, app: () => ({ api_id: 1, api_hash: 'cd'.repeat(16) }) });
  for (let i = 0; i < 5; i++) await login.start({ phone: '+15550000000' });
  await assert.rejects(login.start({ phone: '+15550000000' }), e => e.status === 429);
  now += 61 * 60e3;
  const s = await login.start({ phone: '+15550000000', owner_id: 5 });
  for (let i = 0; i < 8; i++) await login.code({ login_id: s.login_id, code: '12345' });
  await assert.rejects(login.code({ login_id: s.login_id, code: '12345' }), e => e.status === 429);
  const s2 = await login.start({ phone: '+15550000000', owner_id: 5 });
  now += 11 * 60e3;
  await assert.rejects(login.code({ login_id: s2.login_id, code: '99999' }), /expired/);
  const s3 = await login.start({ phone: '+15550000000', owner_id: 5 });
  assert.equal((await login.code({ login_id: s3.login_id, code: '99999' })).same_as_owner, true);
  db.close();

  const { createServer } = await import('node:http');
  const db2 = openDb(':memory:');
  const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let signedIn = false;
  const app = createApp({ db: db2, origin, secret: '11'.repeat(32), encryptionKey: '22'.repeat(32), sharedIdentity: () => signedIn ? { id: 'tg-test', expires: Date.now() + 3600e3 } : null,
    telegramLoginOptions: { spawnBridge: fakeLoginBridge(() => ({ step: 'code' })).factory, app: () => ({ api_id: 1, api_hash: 'cd'.repeat(16) }) } });
  server.on('request', (req, res) => app.emit('request', req, res));
  t.after(() => new Promise(r => { server.close(r); db2.close(); }));
  const post = (path, body) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  assert.equal((await post('/api/telegram/login/start', { phone: '+15550000000' })).status, 401);
  signedIn = true;
  const r = await post('/api/telegram/login/start', { phone: '+15550000000' });
  assert.equal(r.status, 200); assert.equal((await r.json()).step, 'code');
  const st = await (await fetch(origin + '/api/telegram')).json();
  assert.equal(st.login.step, 'code'); assert.equal(st.checklist.find(c => c.id === 'session').done, false);
  assert.equal((await fetch(origin + '/api/telegram/login', { method: 'DELETE', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' })).status, 200);
  assert.equal((await (await fetch(origin + '/api/telegram')).json()).login, null);
});
