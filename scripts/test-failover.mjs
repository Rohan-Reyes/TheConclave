// Failover test against the running Conclave (http://127.0.0.1:4777):
//  1) a fake agent that always reports "usage limit" -> Codex must take over
//  2) every agent marked out -> chat must wait and show a resume time
const H = 'http://127.0.0.1:4777';
const call = async (p, body, method = body ? 'POST' : 'GET') => {
  const r = await fetch(H + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const idle = async id => { for (let i = 0; i < 120; i++) { const t = await call(`/api/threads/${id}`); if (!t.running) return t; await new Promise(r => setTimeout(r, 1500)); } };
const show = t => t.messages.forEach(m => console.log(`  [${m.role}${m.tool ? ':' + m.tool : ''}] ${m.status} ${m.error ? '(' + m.error.slice(0, 70) + ') ' : ''}${m.content.replace(/\s+/g, ' ').slice(0, 130)}`));

await call('/api/agents', { id: 'brokebot', name: 'Broke Bot', command: process.execPath, args: ['-e', "console.error(\"You've hit your usage limit. Try again in 2 hours.\"); process.exit(1)"], input: 'stdin' });
let t = await call('/api/threads', { target: 'brokebot', settings: { permission: 'read', fallback: { enabled: true, order: ['codex'], otherModel: true, waitForReset: true } } });
console.log('1) Broke Bot is out of credits -> Codex should take over');
await call(`/api/threads/${t.id}/messages`, { text: 'Reply with one short line: ok, I took over' });
show(await idle(t.id));
const cr = await call('/api/credits');
console.log('  credits:', JSON.stringify(cr.brokebot && { until: new Date(cr.brokebot.until).toLocaleTimeString() }));

console.log('2) Only Broke Bot in the fallback order -> everyone out -> wait');
const t2 = await call('/api/threads', { target: 'brokebot', settings: { permission: 'read', fallback: { enabled: true, order: [], otherModel: true, waitForReset: true } } });
await call(`/api/threads/${t2.id}/messages`, { text: 'hello' });
const done2 = await idle(t2.id);
show(done2);
console.log('  waiting:', JSON.stringify(done2.waiting));

// clean up
await call(`/api/threads/${t2.id}/cancel-waiting`, {});
await call(`/api/credits/brokebot/clear`, {});
await call(`/api/threads/${t.id}`, undefined, 'DELETE');
await call(`/api/threads/${t2.id}`, undefined, 'DELETE');
await call('/api/agents/brokebot', undefined, 'DELETE');
console.log('cleaned up');
