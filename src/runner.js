// User-started project tasks. Commands are saved explicitly or discovered from
// package.json; reconnecting to a log never starts a process.
import fs from 'node:fs';
import { environmentFor } from './config/globals.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { DATA_DIR } from './paths.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const active = job => ['starting', 'running', 'stopping'].includes(job.status);
const publicJob = job => ({ id: job.id, cwd: job.cwd, commandId: job.commandId, label: job.label,
  status: job.status, pid: job.pid, started: job.started, finished: job.finished,
  exitCode: job.exitCode, error: job.error, urls: [...job.urls], lastSeq: job.seq,
  droppedBytes: job.droppedBytes, logs: job.logs.map(log => ({ ...log })) });

export function projectFolder(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) throw fail('Choose an absolute project folder');
  let real;
  try { real = fs.realpathSync.native(cwd); if (!fs.statSync(real).isDirectory()) throw new Error(); }
  catch { throw fail('Project folder does not exist', 404); }
  return real;
}
const folderKey = cwd => process.platform === 'win32' ? cwd.toLowerCase() : cwd;

// Windows retains ParentProcessId after a parent exits. Sweep that ancestry at
// completion as well as using taskkill /T while the root is alive; otherwise a
// command that backgrounds a child could leave it behind after a successful exit.
async function cleanupDescendants(job) {
  if (!job.pid) return;
  if (process.platform !== 'win32') {
    try { process.kill(-job.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    return;
  }
  const rootPid = Number(job.pid);
  const since = Date.parse(job.started);
  const script = `$ErrorActionPreference = 'Stop'
$rootPid = ${rootPid}
$since = [DateTimeOffset]::FromUnixTimeMilliseconds(${since}).LocalDateTime.AddSeconds(-2)
$all = @(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -ge $since })
$ids = [System.Collections.Generic.HashSet[int]]::new()
[void]$ids.Add($rootPid)
do {
  $added = $false
  foreach ($item in $all) {
    if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $added = $true }
  }
} while ($added)
foreach ($item in $all) {
  if ($item.ProcessId -ne $rootPid -and $ids.Contains([int]$item.ProcessId)) {
    try { Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop }
    catch { if (Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue) { throw } }
  }
}`;
  await new Promise((resolve, reject) => execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 10_000 }, error => error ? reject(fail(`Could not clean up child processes: ${error.message}`)) : resolve()));
}

// npm.cmd cannot be spawned safely with shell:false. Invoke npm's JS entry
// through Node instead. npm itself interprets the explicitly confirmed scripts.
function npmCommand() {
  const candidates = [process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'node_modules/npm/bin/npm-cli.js'), path.join(dir, '../lib/node_modules/npm/bin/npm-cli.js'));
  }
  const cli = candidates.find(file => file && /npm-cli\.js$/i.test(file) && fs.existsSync(file));
  if (!cli) throw fail('npm CLI entry was not found. Install Node.js with npm or save a command using an executable path.');
  return { executable: process.execPath, args: [fs.realpathSync(cli)] };
}

function executableCommand(executable, args) {
  if (/^(npm|npm\.cmd)$/i.test(executable)) {
    const npm = npmCommand(); return { executable: npm.executable, args: [...npm.args, ...args] };
  }
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) throw fail('Batch files require a shell. Save the underlying executable and argument list instead.');
  return { executable, args };
}

export function loopbackUrls(text) {
  const urls = new Set();
  const clean = String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const match of clean.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    try {
      const raw = match[0].replace(/[),.;]+$/, '');
      const url = new URL(raw);
      if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) && !url.username && !url.password) urls.add(url.href);
    } catch {}
  }
  return [...urls];
}

function customCommand(input) {
  const executable = typeof input.executable === 'string' ? input.executable.trim() : '';
  if (!executable || executable.length > 2048 || executable.includes('\0')) throw fail('An executable is required');
  if (!Array.isArray(input.args) || input.args.length > 100 || input.args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))) throw fail('Arguments must be an array of strings (at most 100)');
  // A saved command is an executable and argv, never a string evaluated by a shell.
  executableCommand(executable, input.args);
  return { id: `custom:${crypto.randomUUID()}`, label: String(input.label || executable).slice(0, 100), executable, args: [...input.args] };
}

export class ProjectRunner {
  constructor({ storagePath = path.join(DATA_DIR, 'runner.json'), maxLogBytes = 256 * 1024, maxJobs = 50, environment = () => ({}) } = {}) {
    this.storagePath = storagePath;
    this.environment = environment;
    this.maxLogBytes = Math.max(1024, Math.min(1024 * 1024, maxLogBytes));
    this.maxJobs = Math.max(1, maxJobs);
    this.jobs = new Map();
    this.state = { projects: {} };
    if (storagePath && fs.existsSync(storagePath)) {
      try { this.state = JSON.parse(fs.readFileSync(storagePath, 'utf8')); }
      catch { throw fail('Runner settings could not be read; restore data/runner.json before starting commands'); }
      if (!this.state.projects || typeof this.state.projects !== 'object' || Array.isArray(this.state.projects)) throw fail('Runner settings are invalid');
    }
    this.closed = false;
  }

  settings(cwd) {
    const key = folderKey(cwd);
    return this.state.projects[key] ||= { commands: [], approved: [] };
  }

  persist() {
    if (!this.storagePath) return;
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const tmp = `${this.storagePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.storagePath);
  }

  commands(folder) {
    const cwd = projectFolder(folder);
    const settings = this.settings(cwd);
    const list = [];
    const manifest = path.join(cwd, 'package.json');
    if (fs.existsSync(manifest)) {
      let pkg;
      try {
        if (fs.statSync(manifest).size > 1024 * 1024) throw new Error('too large');
        pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      } catch { throw fail('package.json could not be read as JSON'); }
      if (pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)) {
        let npm; let npmError;
        try { npm = npmCommand(); } catch (error) { npmError = error.message; }
        for (const [name, script] of Object.entries(pkg.scripts)) {
          if (typeof script !== 'string' || !name || name.startsWith('-')) continue;
          const launch = npm || { executable: 'npm', args: [] };
          list.push({ id: `npm:${name}`, label: `npm run ${name}`, executable: launch.executable,
            args: [...launch.args, 'run', '--', name], script,
            ...(npmError ? { unavailable: true, error: npmError } : {}),
            // Pre/post scripts also run. Any manifest change invalidates consent.
            fingerprint: hash([folderKey(cwd), 'npm', name, pkg, launch]) });
        }
      }
    }
    for (const saved of settings.commands) {
      const launch = executableCommand(saved.executable, saved.args);
      list.push({ ...saved, ...launch, fingerprint: hash([folderKey(cwd), saved, launch]) });
    }
    return { cwd, commands: list.map(command => ({ ...command, confirmed: settings.approved.includes(command.fingerprint) })) };
  }

  saveCommand(folder, input) {
    const cwd = projectFolder(folder);
    const saved = customCommand(input);
    const settings = this.settings(cwd);
    if (settings.commands.length >= 50) throw fail('At most 50 saved commands are allowed per project');
    settings.commands.push(saved);
    this.persist();
    return this.commands(cwd).commands.find(command => command.id === saved.id);
  }

  deleteCommand(folder, id) {
    const cwd = projectFolder(folder);
    const settings = this.settings(cwd);
    if (!settings.commands.some(command => command.id === id)) throw fail('Saved command not found', 404);
    settings.commands = settings.commands.filter(command => command.id !== id);
    this.persist();
    return { ok: true };
  }

  list(folder) {
    const cwd = projectFolder(folder);
    return { cwd, jobs: [...this.jobs.values()].filter(job => folderKey(job.cwd) === folderKey(cwd)).map(publicJob).reverse() };
  }

  job(folder, id) {
    const cwd = projectFolder(folder);
    const job = this.jobs.get(id);
    if (!job || folderKey(job.cwd) !== folderKey(cwd)) throw fail('Task not found for this project', 404);
    return job;
  }

  get(folder, id) { return publicJob(this.job(folder, id)); }

  start(folder, commandId, confirmation) {
    if (this.closed) throw fail('Runner is shutting down', 409);
    const { cwd, commands } = this.commands(folder);
    const command = commands.find(item => item.id === commandId);
    if (!command) throw fail('Choose a project script or saved command', 404);
    if (command.unavailable) throw fail(command.error);
    if ([...this.jobs.values()].some(job => folderKey(job.cwd) === folderKey(cwd) && job.commandId === command.id && active(job))) throw fail('This command is already running', 409);
    if (!command.confirmed && confirmation !== command.fingerprint) throw fail('Confirm this exact command before its first run', 428);
    while (this.jobs.size >= this.maxJobs) {
      const old = [...this.jobs.values()].find(job => !active(job) && !job.listeners.size);
      if (!old) throw fail('Too many active tasks; stop a task first', 409);
      this.jobs.delete(old.id);
    }
    if (!command.confirmed) {
      const approved = this.settings(cwd).approved;
      approved.push(command.fingerprint);
      if (approved.length > 500) approved.splice(0, approved.length - 500);
      this.persist();
    }
    const job = { id: crypto.randomUUID(), cwd, commandId: command.id, label: command.label,
      status: 'starting', pid: null, started: new Date().toISOString(), finished: null,
      exitCode: null, error: null, urls: [], seq: 0, logs: [], logBytes: 0, droppedBytes: 0,
      listeners: new Set(), process: null, stopPromise: null, stopping: false, resolveDone: null, urlTail: '' };
    job.done = new Promise(resolve => { job.resolveDone = resolve; });
    this.jobs.set(job.id, job);
    let finishing = false;
    const finish = async (code, error = null) => {
      if (job.finished || finishing) return;
      finishing = true;
      try { await cleanupDescendants(job); }
      catch (cleanupError) { error = error ? `${error}; ${cleanupError.message}` : cleanupError.message; }
      job.exitCode = code;
      job.error = error;
      job.status = job.stopping ? 'stopped' : error || code !== 0 ? 'failed' : 'done';
      job.finished = new Date().toISOString();
      this.emit(job, { type: 'status', job: publicJob(job) });
      job.resolveDone(publicJob(job));
    };
    try {
      job.process = spawn(command.executable, command.args, { cwd, shell: false,
        detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key])=>!['TOKEN_ENCRYPTION_KEY','SESSION_SECRET','CONCLAVE_AUTH_FILE'].includes(key))), ...this.environment(), FORCE_COLOR: '0', NO_COLOR: '1' } });
      job.pid = job.process.pid || null;
      job.process.once('spawn', () => { if (!job.stopping) job.status = 'running'; this.emit(job, { type: 'status', job: publicJob(job) }); });
      for (const stream of ['stdout', 'stderr']) {
        const decoder = new StringDecoder('utf8');
        job.process[stream].on('data', data => this.log(job, stream, decoder.write(data)));
        job.process[stream].on('end', () => { const rest = decoder.end(); if (rest) this.log(job, stream, rest); });
      }
      job.process.once('error', error => finish(null, error.message));
      job.process.once('close', code => finish(code));
    } catch (error) { finish(null, error.message); }
    return publicJob(job);
  }

  emit(job, event) {
    for (const listener of job.listeners) { try { listener(event); } catch { job.listeners.delete(listener); } }
  }

  log(job, stream, text) {
    if (!text) return;
    const bytes = Buffer.from(text);
    let kept = bytes;
    if (bytes.length > this.maxLogBytes) {
      let offset = bytes.length - this.maxLogBytes;
      while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
      job.droppedBytes += offset; kept = bytes.subarray(offset);
    }
    const log = { seq: ++job.seq, stream, text: kept.toString('utf8') };
    job.logs.push(log);
    job.logBytes += Buffer.byteLength(log.text);
    while ((job.logBytes > this.maxLogBytes || job.logs.length > 2048) && job.logs.length > 1) {
      const removed = job.logs.shift(); const size = Buffer.byteLength(removed.text);
      job.logBytes -= size; job.droppedBytes += size;
    }
    const urlText = job.urlTail + text;
    job.urlTail = urlText.slice(-2048);
    for (const url of loopbackUrls(urlText)) if (!job.urls.includes(url) && job.urls.length < 10) job.urls.push(url);
    this.emit(job, { type: 'log', log, urls: [...job.urls], droppedBytes: job.droppedBytes });
  }

  subscribe(folder, id, listener, after = 0) {
    const job = this.job(folder, id);
    job.listeners.add(listener);
    listener({ type: 'snapshot', job: { ...publicJob(job), logs: job.logs.filter(log => log.seq > after) } });
    return () => job.listeners.delete(listener);
  }

  async stop(folder, id) {
    const job = this.job(folder, id);
    if (!active(job)) return publicJob(job);
    if (job.stopPromise) return job.stopPromise;
    job.stopping = true;
    job.status = 'stopping';
    this.emit(job, { type: 'status', job: publicJob(job) });
    job.stopPromise = (async () => {
      if (job.pid) {
        if (process.platform === 'win32') {
          const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
          await new Promise((resolve, reject) => execFile(taskkill, ['/PID', String(job.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, error => {
            // A process may finish between the status check and taskkill.
            if (error && !job.finished && job.process.exitCode === null && job.process.signalCode === null) reject(fail(`Could not stop the process tree: ${error.message}`)); else resolve();
          }));
        } else {
          try { process.kill(-job.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      }
      let timer;
      try { return await Promise.race([job.done, new Promise((_, reject) => { timer = setTimeout(() => reject(fail('Process tree did not stop within 5 seconds')), 5000); })]); }
      finally { clearTimeout(timer); }
    })();
    try { return await job.stopPromise; }
    catch (error) { job.stopPromise = null; job.error = error.message; this.emit(job, { type: 'status', job: publicJob(job) }); throw error; }
  }

  async restart(folder, id, confirmation) {
    const job = this.job(folder, id);
    await this.stop(folder, id);
    return this.start(folder, job.commandId, confirmation);
  }

  async shutdown() {
    this.closed = true;
    const results = await Promise.allSettled([...this.jobs.values()].filter(active).map(job => this.stop(job.cwd, job.id)));
    const errors = results.filter(result => result.status === 'rejected');
    if (errors.length) throw new AggregateError(errors.map(result => result.reason), 'Some project tasks could not be stopped');
  }

  // Last-resort synchronous cleanup for process.exit(). Normal shutdown uses stop().
  cleanupOnExit() {
    for (const job of this.jobs.values()) {
      if (!active(job) || !job.pid) continue;
      try {
        if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(job.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
        else process.kill(-job.pid, 'SIGKILL');
      } catch {}
    }
  }
}

let defaultRunner;
export const getRunner = () => defaultRunner ||= new ProjectRunner({environment:()=>environmentFor('runner')});
export const shutdownRunner = () => defaultRunner?.shutdown() || Promise.resolve();

export function mountRunner(app, wrap, runner = getRunner(), { shutdownHooks = true } = {}) {
  app.get('/api/runner/commands', wrap(req => runner.commands(req.query.cwd)));
  app.post('/api/runner/commands', wrap(req => runner.saveCommand(req.body.cwd, req.body)));
  app.delete('/api/runner/commands/:id', wrap(req => runner.deleteCommand(req.body.cwd, req.params.id)));
  app.get('/api/runner/jobs', wrap(req => runner.list(req.query.cwd)));
  app.post('/api/runner/jobs', wrap(req => runner.start(req.body.cwd, req.body.commandId, req.body.confirmation)));
  app.get('/api/runner/jobs/:id', wrap(req => runner.get(req.query.cwd, req.params.id)));
  app.post('/api/runner/jobs/:id/stop', wrap(req => runner.stop(req.body.cwd, req.params.id)));
  app.post('/api/runner/jobs/:id/restart', wrap(req => runner.restart(req.body.cwd, req.params.id, req.body.confirmation)));
  app.get('/api/runner/jobs/:id/events', (req, res) => {
    let off; let ping;
    try {
      runner.get(req.query.cwd, req.params.id); // Fail before sending SSE headers.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const after = Math.max(0, Number(req.headers['last-event-id'] || req.query.after) || 0);
      off = runner.subscribe(req.query.cwd, req.params.id, event => {
        if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
        res.write(`${event.log ? `id: ${event.log.seq}\n` : ''}data: ${JSON.stringify(event)}\n\n`);
      }, after);
      ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => { clearInterval(ping); off?.(); });
    } catch (error) {
      clearInterval(ping); off?.();
      if (!res.headersSent) res.status(error.status || 400).json({ error: error.message }); else res.end();
    }
  });
  if (shutdownHooks) {
    const onExit = () => runner.cleanupOnExit();
    process.once('exit', onExit);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      runner.shutdown().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
    });
  }
  return runner;
}
