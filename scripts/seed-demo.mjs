// Synthetic UI fixture only. Refuses to touch the normal application database.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.env.AGENT_HUB_DB && path.resolve(process.env.AGENT_HUB_DB);
if (!target || !process.env.AGENT_HUB_DATA_DIR || target.toLowerCase() === path.join(root, 'data', 'hub.db').toLowerCase()) throw new Error('Set an isolated AGENT_HUB_DB and AGENT_HUB_DATA_DIR before seeding a demo.');
const { getDb, now, newId } = await import('../src/db.js');
const { createThread, createQuestion } = await import('../src/agents/threads.js');
const db = getDb();
const t = createThread({ title: 'Polish the project dashboard', cwd: process.platform === 'win32' ? 'C:\\demo\\Conclave' : '/demo/Conclave', target: 'council', settings: { approvalMode: 'manual', permission: 'edit', roles: { codex: 'lead', antigravity: 'designer', claude: 'reviewer' }, chair: 'codex' } });
const user = newId(), verdict = newId(), plan = newId();
const add = db.prepare('INSERT INTO thread_messages (id,thread_id,role,tool,round,content,status,created) VALUES (?,?,?,?,?,?,?,?)');
add.run(user, t.id, 'user', null, null, 'Add a project runner, make everyday tasks easier, and polish the dashboard.', 'done', now());
add.run(verdict, t.id, 'agent', 'codex', 'synthesis', 'The team has a plan ready. We will implement the runner, polish the composer, then review and test the integrated app.\n\n```js\nconsole.log("Ready to build together");\n```', 'done', now());
const steps = [
  { id: '1', title: 'Build project runner', owner: 'codex', assignee: 'codex', files: ['src/runner.js'], dependsOn: [], kind: 'build', effort: 3, status: 'done' },
  { id: '2', title: 'Polish composer and task panel', owner: 'antigravity', assignee: null, files: ['public/views/hub.js'], dependsOn: ['1'], kind: 'build', effort: 3, status: 'queued' },
  { id: '3', title: 'Review and verify the release', owner: 'any', assignee: null, files: [], dependsOn: ['2'], kind: 'read', effort: 2, status: 'queued' },
];
db.prepare('INSERT INTO plans (id,thread_id,message_id,revision,status,summary,steps,created,updated) VALUES (?,?,?,?,?,?,?,?,?)').run(plan,t.id,verdict,1,'proposed','A polished council workspace',JSON.stringify(steps),now(),now());
createQuestion({ threadId: t.id, agent: 'antigravity', question: 'Which color should the dashboard use?', options: ['Indigo', 'Teal', 'Keep the current theme'], via: 'block' });
console.log(t.id);
db.close();
