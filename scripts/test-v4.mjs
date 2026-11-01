// v4 checks against the running Conclave: Codex memory tools (sandboxed),
// queue while busy, Send now, team status + roles in prompts.
const H = 'http://127.0.0.1:4777';
const call = async (p, body, method = body ? 'POST' : 'GET') => {
  const r = await fetch(H + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const idle = async id => { for (let i = 0; i < 160; i++) { const t = await call(`/api/threads/${id}`); if (!t.running && !(t.queue || []).length) return t; await new Promise(r => setTimeout(r, 1500)); } };
const show = (t, from = 0) => t.messages.slice(from).forEach(m => console.log(`  [${m.role}${m.tool ? ':' + m.tool : ''}${m.round ? ' ' + m.round : ''}] ${m.status} ${m.error ? '(' + m.error.slice(0, 80) + ') ' : ''}${m.content.replace(/\s+/g, ' ').slice(0, 150)}`));

const t = await call('/api/threads', { target: 'codex', settings: { permission: 'read', shell: 'sandboxed', roles: { claude: 'lead', codex: 'builder', antigravity: 'reviewer' } } });
console.log('team:', JSON.stringify(t.team));

console.log('1) Codex uses the shared memory tool (used to stall on an approval prompt)');
await call(`/api/threads/${t.id}/messages`, { text: 'Use the agent-hub-memory memory_search tool for "zumi" and tell me the first title. Also: what is your role in this team, and which teammate has the most usage headroom? One line each.' });
let s = await idle(t.id); show(s);

console.log('2) Queue while busy, then Send now');
await call(`/api/threads/${t.id}/messages`, { text: 'Count slowly from 1 to 5, one number per line, explaining each number in a sentence.' });
await new Promise(r => setTimeout(r, 2500));
const q1 = await call(`/api/threads/${t.id}/messages`, { text: '@claude reply with just: queued message delivered' });
console.log('  queued?', JSON.stringify(q1));
s = await idle(t.id); show(s, 2);
await call(`/api/threads/${t.id}/messages`, { text: 'Write a 300-word story about a lighthouse.' });
await new Promise(r => setTimeout(r, 4000));
const n = await call(`/api/threads/${t.id}/messages`, { text: '@claude reply with just: send-now worked', mode: 'now' });
console.log('  send now:', JSON.stringify(n));
s = await idle(t.id); show(s, 6);
await call(`/api/threads/${t.id}`, undefined, 'DELETE');
console.log('cleaned up');
