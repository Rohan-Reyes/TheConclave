// Owner-managed prompts and encrypted runtime variables. Secrets never enter prompts.
import { getDb, newId, now } from '../db.js';
import { encrypt, decrypt } from '../../assistant/src/security.js';

const initialized = new WeakSet();
function db() {
  const store = getDb();
  if (!initialized.has(store)) {
    store.exec(`CREATE TABLE IF NOT EXISTS global_variables(name TEXT PRIMARY KEY,cipher TEXT NOT NULL,secret INTEGER NOT NULL,targets TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS global_prompts(id TEXT PRIMARY KEY,title TEXT NOT NULL,content TEXT NOT NULL,enabled INTEGER NOT NULL,targets TEXT NOT NULL,updated TEXT NOT NULL);`);
    initialized.add(store);
  }
  return store;
}
function key() {
  const value = process.env.TOKEN_ENCRYPTION_KEY;
  if (!/^[a-f0-9]{64}$/i.test(value || ''))
    throw new Error(
      'Configure TOKEN_ENCRYPTION_KEY before storing or using global variables',
    );
  return value;
}
const fail = (message) => {
  throw new Error(message);
};
function targets(value) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 30 ||
    value.some(
      (t) => typeof t !== 'string' || !/^[a-z][a-z0-9-]{0,59}$/.test(t),
    )
  )
    fail('Choose at least one valid runtime');
  return [...new Set(value)];
}
function variableName(value) {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(value))
    fail('Use an uppercase environment name, such as CLOUDFLARE_API_TOKEN');
  if (
    /^(?:PATH|HOME|USER|USERPROFILE|USERNAME|SHELL|COMSPEC|SYSTEMROOT|TEMP|TMP|TMPDIR|PWD|OLDPWD|ENV|BASH_ENV|IFS|CDPATH|ZDOTDIR|PYTHONPATH|RUBYOPT|PERL5OPT|SESSION_SECRET|TOKEN_ENCRYPTION_KEY|APP_ORIGIN|DATA_DIR|PORT)$/i.test(
      value,
    ) ||
    /^(?:CONCLAVE_|AGENT_HUB_|NODE_|LD_|DYLD_|NPM_|BASH_|GIT_|SSH_|XDG_|CODEX_|CLAUDE_|GEMINI_CLI_)/.test(
      value,
    )
  )
    fail(
      'This variable name is reserved for application or runtime configuration',
    );
  return value;
}
export function listVariables() {
  return db()
    .prepare('SELECT * FROM global_variables ORDER BY name')
    .all()
    .map((row) => ({
      name: row.name,
      secret: !!row.secret,
      targets: JSON.parse(row.targets),
      updated: row.updated,
      ...(!row.secret
        ? { value: decrypt(row.cipher, key()) }
        : { configured: true }),
    }));
}
export function saveVariable(input) {
  const name = variableName(input.name),
    selected = targets(input.targets),
    previous = db()
      .prepare('SELECT * FROM global_variables WHERE name=?')
      .get(name);
  if (input.secret !== undefined && typeof input.secret !== 'boolean')
    fail('Secret must be a boolean');
  const secret = input.secret ?? (previous ? !!previous.secret : true);
  if (previous?.secret && !secret && input.value === undefined)
    fail('Enter a replacement value to change a secret to a visible variable');
  let cipher = previous?.cipher;
  if (input.value !== undefined) {
    if (
      typeof input.value !== 'string' ||
      !input.value ||
      input.value.length > 16000 ||
      input.value.includes('\0')
    )
      fail('Enter a value of 1–16000 characters');
    cipher = encrypt(input.value, key());
  }
  if (!cipher) fail('A value is required for a new variable');
  db()
    .prepare(
      'INSERT INTO global_variables VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET cipher=excluded.cipher,secret=excluded.secret,targets=excluded.targets,updated=excluded.updated',
    )
    .run(name, cipher, Number(secret), JSON.stringify(selected), now());
  return { ok: true, name };
}
export function deleteVariable(name) {
  variableName(name);
  db().prepare('DELETE FROM global_variables WHERE name=?').run(name);
  return { ok: true };
}
export function environmentFor(runtime) {
  const rows = db()
    .prepare('SELECT * FROM global_variables')
    .all()
    .filter((row) => JSON.parse(row.targets).includes(runtime));
  if (!rows.length) return {};
  const encryptionKey = key();
  return Object.fromEntries(
    rows.map((row) => [
      variableName(row.name),
      decrypt(row.cipher, encryptionKey),
    ]),
  );
}
export function listPrompts() {
  return db()
    .prepare('SELECT * FROM global_prompts ORDER BY title,id')
    .all()
    .map((row) => ({
      ...row,
      enabled: !!row.enabled,
      targets: JSON.parse(row.targets),
    }));
}
export function savePrompt(input) {
  if (
    typeof input.title !== 'string' ||
    !input.title.trim() ||
    input.title.length > 160
  )
    fail('Prompt title must contain 1–160 characters');
  if (
    typeof input.content !== 'string' ||
    !input.content.trim() ||
    input.content.length > 12000
  )
    fail('Prompt content must contain 1–12000 characters');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean')
    fail('Enabled must be a boolean');
  const selected = targets(input.targets),
    store = db(),
    id = input.id || newId();
  if (typeof id !== 'string' || id.length > 100) fail('Invalid prompt ID');
  if (
    input.id &&
    !store.prepare('SELECT id FROM global_prompts WHERE id=?').get(id)
  )
    fail('Prompt not found');
  const others = store
    .prepare('SELECT id,content FROM global_prompts')
    .all()
    .filter((row) => row.id !== id);
  if (
    others.length >= 50 ||
    others.reduce((size, row) => size + row.content.length, 0) +
      input.content.length >
      32000
  )
    fail('Global prompts are limited to 50 entries and 32000 characters total');
  store
    .prepare(
      'INSERT INTO global_prompts VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,enabled=excluded.enabled,targets=excluded.targets,updated=excluded.updated',
    )
    .run(
      id,
      input.title.trim(),
      input.content.trim(),
      Number(input.enabled !== false),
      JSON.stringify(selected),
      now(),
    );
  return { ok: true, id };
}
export function deletePrompt(id) {
  db().prepare('DELETE FROM global_prompts WHERE id=?').run(String(id));
  return { ok: true };
}
export function promptText(runtime) {
  return listPrompts()
    .filter((p) => p.enabled && p.targets.includes(runtime))
    .map((p) => `### ${p.title}\n${p.content}`)
    .join('\n\n');
}
export function mountGlobals(app, wrap) {
  app.get(
    '/api/globals/variables',
    wrap(() => ({ variables: listVariables() })),
  );
  app.post(
    '/api/globals/variables',
    wrap((req) => saveVariable(req.body)),
  );
  app.delete(
    '/api/globals/variables/:name',
    wrap((req) => deleteVariable(req.params.name)),
  );
  app.get(
    '/api/globals/prompts',
    wrap(() => ({ prompts: listPrompts() })),
  );
  app.post(
    '/api/globals/prompts',
    wrap((req) => savePrompt(req.body)),
  );
  app.delete(
    '/api/globals/prompts/:id',
    wrap((req) => deletePrompt(req.params.id)),
  );
}

export function variableNamesFor(runtime) {
  return db()
    .prepare('SELECT name,targets FROM global_variables ORDER BY name')
    .all()
    .filter((row) => JSON.parse(row.targets).includes(runtime))
    .map((row) => row.name);
}
