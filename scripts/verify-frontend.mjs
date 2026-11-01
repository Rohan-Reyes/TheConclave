import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { md } from '../public/lib.js';
import { SLASH_TEMPLATES } from '../public/views/hub.js';
import { planHtml, questionHtml } from '../public/views/plan.js';
import { renderRunner, openRunnerModal, confirmCommandModal } from '../public/views/runner.js';
import { mountExtra } from '../src/routes-extra.js';

console.log('1. Testing Markdown and Code Block Copy Rendering...');
const sampleInput = 'Here is some code:\n```javascript\nconsole.log(42);\n```';
const renderedMd = md(sampleInput);
assert(renderedMd.includes('code-block'), 'Must contain code-block container');
assert(renderedMd.includes('btn-copy-code'), 'Must contain btn-copy-code');
assert(renderedMd.includes('javascript'), 'Must preserve language header');
assert(renderedMd.includes('console.log(42);'), 'Must contain code text');
console.log('  -> Code block copy rendering: PASS');

console.log('2. Testing Slash Templates...');
assert.strictEqual(SLASH_TEMPLATES.length, 5, 'Must have 5 core templates');
const cmds = SLASH_TEMPLATES.map(s => s.cmd);
assert(cmds.includes('/plan'), 'Must include /plan');
assert(cmds.includes('/review'), 'Must include /review');
assert(cmds.includes('/debug'), 'Must include /debug');
assert(cmds.includes('/explain'), 'Must include /explain');
assert(cmds.includes('/tests'), 'Must include /tests');
for (const tpl of SLASH_TEMPLATES) {
  assert(tpl.template && tpl.template.startsWith(tpl.cmd), `Template for ${tpl.cmd} starts with command`);
}
console.log('  -> Slash templates (/plan, /review, /debug, /explain, /tests): PASS');

console.log('3. Testing existing Plan UI functions integrity...');
const mockPlan = {
  id: 'p1',
  status: 'proposed',
  summary: 'Refactor test',
  steps: [
    { id: '1', title: 'Step one', kind: 'write', owner: 'codex', status: 'queued' },
    { id: '2', title: 'Step two', kind: 'read', owner: 'claude', status: 'done' }
  ]
};
const planOut = planHtml(mockPlan, { codex: 'Codex', claude: 'Claude' });
assert(planOut.includes('Step one') && planOut.includes('Run plan'), 'planHtml renders correctly');

const mockQ = { id: 'q1', agent: 'antigravity', question: 'Which branch?', options: ['main', 'dev'], via: 'tool' };
const qOut = questionHtml(mockQ, { antigravity: 'Antigravity' });
assert(qOut.includes('Which branch?') && qOut.includes('main'), 'questionHtml renders correctly');
console.log('  -> Plan UI & Questions components: PASS');

console.log('4. Testing Attachment backend routes in src/routes-extra.js...');
const registeredRoutes = [];
const mockApp = {
  get(route, handler) { registeredRoutes.push({ method: 'GET', route, handler }); },
  post(route, handler) { registeredRoutes.push({ method: 'POST', route, handler }); },
  delete(route, handler) { registeredRoutes.push({ method: 'DELETE', route, handler }); },
  patch(route, handler) { registeredRoutes.push({ method: 'PATCH', route, handler }); },
};
const wrap = fn => fn;

mountExtra(mockApp, wrap);

const postThreadAtt = registeredRoutes.find(r => r.method === 'POST' && r.route === '/api/threads/:id/attachments');
const postAtt = registeredRoutes.find(r => r.method === 'POST' && r.route === '/api/attachments');
const getThreadAtt = registeredRoutes.find(r => r.method === 'GET' && r.route === '/api/threads/:id/attachments');

assert(postThreadAtt, 'Must mount POST /api/threads/:id/attachments');
assert(postAtt, 'Must mount POST /api/attachments');
assert(getThreadAtt, 'Must mount GET /api/threads/:id/attachments');
console.log('  -> Attachment routes mounted: PASS');

// Test attachment handling
const testDir = path.resolve('data', 'test-attachments');
fs.mkdirSync(testDir, { recursive: true });

// Valid attachment
const sampleText = Buffer.from('console.log("hello offline attachment");').toString('base64');
const res = postAtt.handler({
  body: {
    cwd: testDir,
    filename: '../../traversal_test.js',
    data: sampleText,
    encoding: 'base64'
  }
});

assert(res.ok, 'Upload should succeed');
assert(res.file.filename.includes('traversal_test.js'), 'Filename should be sanitized');
assert(!res.file.filename.includes('..'), 'Directory traversal stripped');
assert(fs.existsSync(res.file.path), 'File must be written on disk');
assert(res.file.path.startsWith(path.resolve(testDir, '.conclave', 'attachments')), 'Must be contained in canonical attachments folder');
console.log('  -> Attachment canonical containment and sanitization: PASS');

// Size limit rejection (>4MB)
let sizeRejected = false;
try {
  const hugeBuf = Buffer.alloc(5 * 1024 * 1024, 'a').toString('base64');
  postAtt.handler({
    body: {
      cwd: testDir,
      filename: 'too_large.bin',
      data: hugeBuf,
      encoding: 'base64'
    }
  });
} catch (e) {
  if (e.status === 413 || e.message.includes('exceeds maximum limit')) {
    sizeRejected = true;
  }
}
assert(sizeRejected, 'Payload over 4MB must be rejected with 413 limit error');
console.log('  -> Attachment 4MB size limit rejection: PASS');

// Clean up test dir
try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}

console.log('5. Testing Runner frontend integration and exports...');
assert(typeof renderRunner === 'function', 'renderRunner must be a function');
assert(typeof openRunnerModal === 'function', 'openRunnerModal must be a function');
assert(typeof confirmCommandModal === 'function', 'confirmCommandModal must be a function');

const hubCode = fs.readFileSync('public/views/hub.js', 'utf8');
assert(hubCode.includes('open-runner'), 'hub.js must include Runner button in header');
assert(hubCode.includes('/messages/${m.id}/edit'), 'hub.js must reference edit endpoint');

const projCode = fs.readFileSync('public/views/projects.js', 'utf8');
assert(projCode.includes('#/runner?cwd='), 'projects.js must link to runner view');

const appCode = fs.readFileSync('public/app.js', 'utf8');
assert(appCode.includes('renderRunner'), 'app.js must register runner route');

const css = fs.readFileSync('public/conclave-polish.css', 'utf8');
assert(css.includes('.runner-layout'), 'conclave-polish.css must include runner layout styles');
assert(css.includes('.runner-log-pane'), 'conclave-polish.css must include log pane styling');
console.log('  -> Runner frontend components and routing: PASS');

console.log('\nAll tests passed successfully!');
