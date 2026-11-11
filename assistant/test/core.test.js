import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, id } from '../src/db.js';
import { interpretSchedule, materialize, claim, tick, recover } from '../src/scheduling.js';
import { passwordHash, passwordMatches, encrypt, decrypt } from '../src/security.js';
import { getSecret, setSecret, beginOAuth, accessToken } from '../src/integrations.js';
import { createApp } from '../src/server.js';
import { request as httpRequest } from 'node:http';
import { companionSchema, companionOwner, companionDevice } from '../src/companion.js';

const secret = '11'.repeat(32), encryptionKey = '22'.repeat(32);
test('password hashing and authenticated encryption reject incorrect credentials and tampering', () => {
  const hash = passwordHash('a-private-test-password'); assert(passwordMatches('a-private-test-password', hash)); assert(!passwordMatches('wrong', hash));
  const cipher = encrypt('private refresh token', encryptionKey); assert(!cipher.includes('private')); assert.equal(decrypt(cipher, encryptionKey), 'private refresh token'); assert.throws(() => decrypt(cipher, secret));
});
test('Manila natural-language preview yields UTC and weekdays survive weekend', () => {
  const now = Date.parse('2026-11-06T02:00:00Z');
  const tomorrow = interpretSchedule('Remind me tomorrow at 9 AM', 'Asia/Manila', now);
  assert.equal(tomorrow.utc, '2026-11-07T01:00:00.000Z');
  const weekday = interpretSchedule('Every weekday at 7 AM', 'Asia/Manila', now);
  assert.equal(weekday.utc, '2026-11-08T23:00:00.000Z');
  assert.throws(() => interpretSchedule('tomorrow at 25 AM', 'Asia/Manila', now));
  assert.throws(() => interpretSchedule('2027-03-14T02:30', 'America/New_York', now));
});
test('durability, concurrent connections, atomic claims, unique occurrence and reminder completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-')), path = join(dir, 'test.sqlite');
  const db = openDb(path), second = openDb(path), now = Date.now(), schedule = id();
  try {
    db.prepare("INSERT INTO schedules VALUES(?,?,?,?,?,?,'active','catch_up',?)").run(schedule, 'Take a break', 'once', '{"type":"once"}', 'Asia/Manila', now - 1000, now);
    materialize(db, now); materialize(second, now);
    assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 1);
    const first = claim(db, now); assert(first); assert.equal(claim(second, now), undefined);
    recover(second, now + 31_000); await tick(second, now + 33_000);
    assert.equal(db.prepare('SELECT state FROM jobs').get().state, 'completed');
    assert.equal(db.prepare('SELECT count(*) AS n FROM notifications').get().n, 1);
    db.close(); const reopened = openDb(path); assert.equal(reopened.prepare('SELECT count(*) AS n FROM notifications').get().n, 1); reopened.close();
  } finally { try { db.close(); } catch {} second.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('external send leases become uncertain and are never reclaimed', () => {
  const db = openDb(':memory:'), now = Date.now();
  db.prepare("INSERT INTO jobs(id,occurrence_at,kind,payload,state,available_at,lease_until) VALUES(?,?,?,'{}','running',?,?)").run(id(), now, 'email_send', now, now - 1);
  recover(db, now); assert.equal(db.prepare('SELECT state FROM jobs').get().state, 'uncertain'); assert.equal(claim(db, now), undefined); db.close();
});
test('expired external actions never contact the provider', async () => {
  const db=openDb(':memory:'),now=Date.now(),target=id();
  db.prepare("INSERT INTO jobs(id,occurrence_at,kind,payload,state,available_at) VALUES(?,?,?,?,'queued',?)").run(target,now,'email_send',JSON.stringify({expires_at:now-1,provider:'google',draft_id:'missing'}),now);
  await tick(db,now,encryptionKey);
  assert.equal(db.prepare('SELECT state FROM jobs WHERE id=?').get(target).state,'failed');assert.equal(db.prepare('SELECT attempts FROM jobs WHERE id=?').get(target).attempts,1);db.close();
});
test('companion grants, atomic claims, expiry and revocation fail closed', () => {
  const db=openDb(':memory:');companionSchema(db);
  const enrolled=companionOwner(db,'/api/companions',{name:'Test Linux',capabilities:['notify']},secret,'POST'),auth=`Bearer ${enrolled.token}`;
  assert.throws(()=>companionOwner(db,'/api/companions/work',{device_id:enrolled.id,kind:'command',command_id:'x'},secret,'POST'));
  const work=companionOwner(db,'/api/companions/work',{device_id:enrolled.id,kind:'notify',title:'Hello',body:'Local only'},secret,'POST');
  const first=companionDevice(db,'/api/companion/poll',{},auth,secret);assert.equal(first.work.id,work.id);
  assert.equal(companionDevice(db,'/api/companion/poll',{},auth,secret).work,null);
  companionDevice(db,'/api/companion/result',{id:work.id,state:'completed',result:'Shown'},auth,secret);
  assert.throws(()=>companionDevice(db,'/api/companion/result',{id:work.id,state:'completed',result:'Shown'},auth,secret));
  const expiring=companionOwner(db,'/api/companions/work',{device_id:enrolled.id,kind:'notify',title:'Expired'},secret,'POST');
  db.prepare('UPDATE companion_work SET expires_at=? WHERE id=?').run(Date.now()-1,expiring.id);
  assert.equal(companionDevice(db,'/api/companion/poll',{},auth,secret).work,null);
  assert.equal(db.prepare('SELECT state FROM companion_work WHERE id=?').get(expiring.id).state,'expired');
  companionOwner(db,`/api/companions/${enrolled.id}`,{},secret,'DELETE');assert.throws(()=>companionDevice(db,'/api/companion/poll',{},auth,secret));db.close();
});
test('OAuth state is session bound, PKCE uses S256 and secrets are encrypted', () => {
  const db = openDb(':memory:'); setSecret(db, 'config:google', { client_id: 'test-id', client_secret: 'private-client-secret' }, encryptionKey);
  assert.equal(getSecret(db, 'config:google', encryptionKey).client_id, 'test-id');
  assert(!db.prepare('SELECT cipher FROM secrets').get().cipher.includes('private-client-secret'));
  const url = new URL(beginOAuth(db, 'google', 'read', 'session-hash', 'http://127.0.0.1:3210', encryptionKey));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert(!url.searchParams.get('scope').includes('gmail.send'));
  const state = db.prepare('SELECT * FROM oauth_states').get(); assert.equal(state.session_id, 'session-hash'); assert.notEqual(state.verifier, url.searchParams.get('code_challenge')); db.close();
});
test('revoked refresh tokens require reconnect and are never exposed',async()=>{
  const db=openDb(':memory:'),savedFetch=globalThis.fetch;
  setSecret(db,'config:google',{client_id:'test-id',client_secret:'test-secret'},encryptionKey);
  db.prepare("INSERT INTO connections VALUES('google','read','connected',?,?)").run(encrypt(JSON.stringify({access_token:'old-test-access',refresh_token:'revoked-test-refresh',expires_at:0}),encryptionKey),Date.now());
  let calls=0;globalThis.fetch=async()=>{calls++;return new Response('{"error":"invalid_grant"}',{status:400});};
  try{await assert.rejects(accessToken(db,'google',encryptionKey),/refresh connection/);assert.equal(calls,1);assert.equal(db.prepare('SELECT status FROM connections').get().status,'reconnect_required');assert.equal(db.prepare('SELECT count(*) AS n FROM refresh_locks').get().n,0);}
  finally{globalThis.fetch=savedFetch;db.close();}
});
test('ambiguous provider send is attempted once and held for reconciliation',async()=>{
  const db=openDb(':memory:'),savedFetch=globalThis.fetch,now=Date.now(),draft=id(),job=id();
  db.prepare("INSERT INTO connections VALUES('google','prepare','connected',?,?)").run(encrypt(JSON.stringify({access_token:'synthetic-access',expires_at:now+3600000}),encryptionKey),now);
  db.prepare('INSERT INTO drafts VALUES(?,?,?,?,?,?)').run(draft,'test@example.invalid','Private test','Never delivered','[]',now);
  db.prepare("INSERT INTO jobs(id,occurrence_at,kind,payload,state,available_at) VALUES(?,?,?,?,'queued',?)").run(job,now,'email_send',JSON.stringify({provider:'google',draft_id:draft,expires_at:now+900000}),now);
  let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Synthetic ambiguous transport failure');};
  try{await tick(db,now,encryptionKey);await tick(db,now+10000,encryptionKey);assert.equal(calls,1);assert.equal(db.prepare('SELECT state FROM jobs WHERE id=?').get(job).state,'uncertain');}
  finally{globalThis.fetch=savedFetch;db.close();}
});
test('HTTP authentication, origin/host checks, real disconnected state, approvals and device revocation', async t => {
  const db = openDb(':memory:'); db.prepare('INSERT INTO owner VALUES(1,?,?)').run('owner', passwordHash('test-owner-password'));
  const origin = 'http://127.0.0.1:3210', app = createApp({ db, origin, secret, encryptionKey });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(() => { db.close(); resolve(); })));
  const base = `http://127.0.0.1:${app.address().port}`;
  let cookie = '';
  async function call(path, data, method = data ? 'POST' : 'GET', extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(base + path, { method, headers: { Host: '127.0.0.1:3210', Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, ...(data ? { 'Content-Length': Buffer.byteLength(JSON.stringify(data)) } : {}), ...extraHeaders } }, res => {
        let raw=''; res.on('data', chunk => raw+=chunk); res.on('end', () => resolve({ status: res.statusCode, headers: { get: name => { const v=res.headers[name]; return Array.isArray(v) ? v[0] : v; } }, json: async () => JSON.parse(raw) }));
      }); req.on('error', reject); if (data) req.write(JSON.stringify(data)); req.end();
    });
  }
  assert.equal((await call('/api/me')).status, 401);
  assert.equal((await call('/api/login', { username: 'owner', password: 'test-owner-password' }, 'POST', { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await call('/api/me', undefined, 'GET', { Host: 'evil.invalid' })).status, 403);
  let response = await call('/api/login', { username: 'owner', password: 'test-owner-password' }); assert.equal(response.status, 200); cookie = response.headers.get('set-cookie').split(';')[0]; assert(response.headers.get('set-cookie').includes('HttpOnly'));
  response = await call('/api/connections'); const connections = await response.json(); assert(connections.every(x => x.status === 'not_connected'));
  response = await call('/api/schedules/preview', { title: 'Test', text: 'Tomorrow at 9 AM', timezone: 'Asia/Manila', missed_policy: 'catch_up' }); const preview = await response.json(); assert.equal(response.status, 200);
  assert.equal((await call('/api/schedules', { preview_token: preview.preview_token + 'tamper' })).status, 400);
  assert.equal((await call('/api/schedules', { preview_token: preview.preview_token })).status, 201);
  response = await call('/api/drafts', { provider: 'google', recipients: 'test@example.invalid', subject: 'Test', body: 'Do not send' }); assert.equal(response.status, 409);
  db.prepare("INSERT INTO connections VALUES('google','prepare','connected',NULL,?)").run(Date.now());
  response = await call('/api/drafts', { provider: 'google', recipients: 'test@example.invalid', subject: 'Test', body: 'Do not send' }); assert.equal(response.status, 201); const approval = await response.json();
  assert.equal(db.prepare('SELECT state FROM jobs').get().state, 'waiting_for_approval');
  assert.equal((await call(`/api/approvals/${approval.id}`, { decision: 'approved' })).status, 200);
  assert.equal((await call(`/api/approvals/${approval.id}`, { decision: 'approved' })).status, 409);
  const device = (await (await call('/api/devices')).json())[0]; assert(device.current);
  assert.equal((await call(`/api/devices/${device.id}`, {}, 'DELETE')).status, 200); assert.equal((await call('/api/me')).status, 401);
});
test('memory map categorises, links related memories and records activity for lighting up', async () => {
  const { memoryGraph, relevantMemories, recordActivity, classify } = await import('../src/memory-graph.js');
  const db = openDb(':memory:'), add = (content, category = null) => { const memoryId = id(); db.prepare('INSERT INTO memories(id,content,updated_at,category) VALUES(?,?,?,?)').run(memoryId, content, Date.now(), category); return memoryId; };
  const coffee = add('I prefer black coffee in the morning and dislike sugar'), pi = add('Jarvis server runs on my Raspberry Pi over SSH'), tunnel = add('The Raspberry Pi uses a Cloudflare tunnel for the Jarvis server'), mom = add('My mom birthday is March 3', 'people');
  assert.equal(classify('I prefer black coffee'), 'preference'); assert.equal(classify('Gym workout every evening with my doctor plan'), 'health');
  const g = memoryGraph(db), ids = new Set(g.nodes.map(n => n.id));
  assert(ids.has('jarvis') && ids.has('category:people')); assert.equal(g.nodes.find(n => n.id === mom).category, 'people');
  assert(g.links.some(l => l.kind === 'related' && [l.source, l.target].includes(pi) && [l.source, l.target].includes(tunnel)));
  assert(g.links.every(l => ids.has(l.source) && ids.has(l.target)));
  const hits = relevantMemories(db, 'Is my Raspberry Pi tunnel healthy?').map(h => h.id);
  assert(hits.includes(pi) && hits.includes(tunnel) && !hits.includes(coffee) && !hits.includes(mom));
  assert.deepEqual(relevantMemories(db, 'the and of'), []);
  recordActivity(db, [{ id: tunnel, score: 2 }], 'chat');
  assert.equal(db.prepare('SELECT access_count FROM memories WHERE id=?').get(tunnel).access_count, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM memory_activity WHERE memory_id=? AND source=?').get(tunnel, 'chat').n, 1);
});
test('structured profiles split into one memory per phrase with section topics', async () => {
  const { parsePhrases, memoryGraph } = await import('../src/memory-graph.js');
  const text = '====\nMASTER FILE\n====\n1. SCHOOL & RESEARCH\n----\n- Grade: Grade 11 student\n- Robotics Team:\n  * Won gold at a regional robotics challenge\n  * Coach is Ms. Example\n\n## Hardware\n- Laptop: 32 GB RAM workstation\n';
  const phrases = parsePhrases(text);
  assert.deepEqual(phrases.map(p => p.topic), ['School & Research', 'School & Research', 'School & Research', 'Hardware']);
  assert.equal(phrases[1].content, 'Robotics Team › Won gold at a regional robotics challenge');
  const db = openDb(':memory:'); for (const p of phrases) db.prepare('INSERT INTO memories(id,content,updated_at,topic) VALUES(?,?,?,?)').run(id(), p.content, Date.now(), p.topic);
  const g = memoryGraph(db); assert.equal(g.nodes.filter(n => n.type === 'topic').length, 2); assert(g.links.some(l => l.source === 'jarvis' && l.target === 'topic:hardware'));
});
test('dossier importer preserves epistemic kinds, source provenance, and idempotent re-imports', async () => {
  const { previewMemoryImport, importMemoryDocument } = await import('../src/memory-import.js');
  const { memoryGraph } = await import('../src/memory-graph.js');
  const db = openDb(':memory:');
  const dossier = [
    '# Strategic Context',
    '- Workstation has 64 GB RAM and RTX GPU.',
    '- Planned target is launching the v2 portal next month.',
    '- Estimated 85% probability of qualifying for finals.',
    '- If qualified for ISEF, travel scenario activates.',
    '[TEMPLATE: OUTREACH MESSAGE]',
    '- Hello, I am reaching out regarding our sponsorship proposal.'
  ].join('\n');
  const preview = previewMemoryImport(db, 'dossier.txt', dossier);
  assert.equal(db.prepare('SELECT count(*) AS n FROM memories').get().n, 0);
  assert.equal(preview.total_phrases, 5);
  assert.equal(preview.new_memories, 5);
  assert.equal(preview.kinds.statement, 1);
  assert.equal(preview.kinds.plan, 1);
  assert.equal(preview.kinds.estimate, 1);
  assert.equal(preview.kinds.conditional, 1);
  assert.equal(preview.kinds.template, 1);

  const first = importMemoryDocument(db, 'dossier.txt', dossier);
  assert.equal(first.imported, 5);
  assert.equal(first.skipped_duplicates, 0);

  const second = importMemoryDocument(db, 'dossier.txt', dossier);
  assert.equal(second.imported, 0);
  assert.equal(second.skipped_duplicates, 5);

  const graph = memoryGraph(db);
  const memNodes = graph.nodes.filter(n => n.type === 'memory');
  assert.equal(memNodes.length, 5);
  for (const node of memNodes) {
    assert.equal(node.source, 'dossier.txt');
    assert(Number.isInteger(node.metadata.source_line) && node.metadata.source_line >= 2);
    assert(Array.isArray(node.metadata.sources) && node.metadata.sources.length === 1);
  }
  const tplNode = memNodes.find(n => n.metadata.kind === 'template');
  assert.equal(tplNode.metadata.qualification, 'hypothetical');
  db.close();
});
