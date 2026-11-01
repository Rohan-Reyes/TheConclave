// End-to-end test of hub chats: direct turn, tool switch, council.
// Usage: AGENT_HUB_DB=<temp db> node scripts/test-council.mjs <cwd>
import * as T from '../src/agents/threads.js';

const cwd = process.argv[2] || process.cwd();
const wait = id => new Promise(res => {
  const iv = setInterval(() => { if (!T.getThread(id).running) { clearInterval(iv); res(); } }, 500);
});
const show = (id, from = 0) => T.getThread(id).messages.slice(from).forEach(m =>
  console.log(`  [${m.role}${m.tool ? ':' + m.tool : ''}${m.round ? ' ' + m.round : ''}] ${m.status} ${m.error ? '(' + m.error + ') ' : ''}${m.content.replace(/\s+/g, ' ').slice(0, 160)}`));

const t = T.createThread({ cwd, target: 'claude', settings: { permission: 'read', rounds: 1 } });
console.log('1) direct to Claude');
T.sendMessage(t.id, 'Remember the code word PELICAN. Reply with one short sentence.');
await wait(t.id); show(t.id);

console.log('2) switch to Codex (must see the earlier context)');
T.sendMessage(t.id, '@codex What code word did I give earlier? One line.');
await wait(t.id); show(t.id, 2);

console.log('3) council');
T.sendMessage(t.id, '@all In one or two sentences each: is a tab or 2 spaces better for YAML indentation?');
await wait(t.id); show(t.id, 4);
console.log('sessions:', JSON.stringify(T.getThread(t.id).sessions));
process.exit(0);
