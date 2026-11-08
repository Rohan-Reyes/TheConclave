import pty from '@lydell/node-pty';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export class TerminalService {
  constructor({ defaultCwd = process.env.CONCLAVE_FILES_ROOT || path.join(os.homedir(), 'Conclave') } = {}) {
    this.defaultCwd = defaultCwd;
    try { fs.mkdirSync(this.defaultCwd, { recursive: true }); } catch {}
    this.sessions = new Map();
  }

  resolveCwd(requestedCwd) {
    if (!requestedCwd || typeof requestedCwd !== 'string') {
      return this.defaultCwd;
    }
    const clean = requestedCwd.trim();
    if (!clean) return this.defaultCwd;

    let resolved = clean.startsWith('~') ? path.join(os.homedir(), clean.slice(1)) : clean;
    resolved = path.resolve(resolved);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw fail(`Directory not found: ${clean}`, 404);
    }
    return resolved;
  }

  getEnvironment() {
    const isWin = process.platform === 'win32';
    const env = {
      ...process.env,
      HOME: os.homedir(),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'en_US.UTF-8',
      PATH: process.env.PATH || '',
    };

    if (!isWin) {
      const extraPaths = [
        path.join(os.homedir(), '.local', 'bin'),
        path.join(os.homedir(), '.local', 'share', 'conclave', 'runtime', 'current', 'bin'),
        path.join(os.homedir(), '.nvm', 'versions', 'node', 'v24.18.0', 'bin'),
        '/usr/local/bin',
        '/usr/bin',
        '/bin'
      ];
      env.PATH = `${extraPaths.join(':')}:${env.PATH}`;
    }
    return env;
  }

  getInfo() {
    return {
      platform: process.platform,
      arch: process.arch,
      user: os.userInfo().username,
      hostname: os.hostname(),
      home: os.homedir(),
      defaultCwd: this.defaultCwd,
      filesRoot: process.env.CONCLAVE_FILES_ROOT || path.join(os.homedir(), 'Conclave'),
      appRoot: process.cwd(),
      quickActions: this.getDefaultActions()
    };
  }

  getDefaultActions() {
    const isWin = process.platform === 'win32';
    return [
      { id: 'git-status', label: 'Git Status', cmd: 'git status --short', icon: '🌿', desc: 'Working tree status' },
      { id: 'git-log', label: 'Git Log', cmd: 'git log --oneline -n 8', icon: '📜', desc: 'Recent 8 commits' },
      { id: 'list-files', label: 'List Files', cmd: isWin ? 'dir' : 'ls -lah', icon: '📁', desc: 'Detailed file listing' },
      { id: 'disk-usage', label: 'Disk Space', cmd: isWin ? 'Get-PSDrive -PSProvider FileSystem' : 'df -h', icon: '💾', desc: 'Disk filesystem usage' },
      { id: 'memory', label: 'Memory', cmd: isWin ? 'Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 ProcessName, @{N="MB";E={[math]::Round($_.WorkingSet64/1MB,1)}}' : 'free -h', icon: '⚡', desc: 'System memory status' },
      { id: 'agents', label: 'Agent Status', cmd: isWin ? 'claude --version; agy --version; codex --version; copilot --version' : 'claude --version 2>&1; agy --version 2>&1; codex --version 2>&1; copilot --version 2>&1', icon: '🤖', desc: 'Verify all 4 agent CLIs' },
      { id: 'services', label: 'Services', cmd: isWin ? 'powershell -File scripts/conclave-service.ps1 -Action status' : 'systemctl status conclave cloudflared-conclave --no-pager', icon: '🔄', desc: 'Conclave background services' },
      { id: 'runtimes', label: 'Runtimes', cmd: isWin ? 'node -v; python --version' : 'node -v; npm -v; python3 --version', icon: '🐍', desc: 'Node.js, npm, Python versions' },
      { id: 'sys-info', label: 'Sys Info', cmd: isWin ? 'systeminfo | Select-String "OS Name","Total Physical Memory"' : 'uname -a && uptime', icon: 'ℹ️', desc: 'System kernel & uptime' },
      { id: 'htop', label: 'Top Processes', cmd: isWin ? 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 ProcessName, CPU, WorkingSet64' : 'top -b -n 1 | head -n 15', icon: '🔝', desc: 'Top resource consuming processes' },
    ];
  }

  spawnPtySession({ cwd, cols = 80, rows = 24 } = {}) {
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
    const resolvedCwd = this.resolveCwd(cwd);
    const env = this.getEnvironment();

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: Math.max(cols, 20),
      rows: Math.max(rows, 5),
      cwd: resolvedCwd,
      env
    });

    const sessionId = crypto.randomUUID();
    const session = {
      id: sessionId,
      pty: ptyProcess,
      cwd: resolvedCwd,
      startedAt: Date.now()
    };
    this.sessions.set(sessionId, session);

    ptyProcess.onExit(() => {
      this.sessions.delete(sessionId);
    });

    return session;
  }

  handleWsConnection(ws, req) {
    let session = null;
    try {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const cwd = url.searchParams.get('cwd') || '';
      const cols = parseInt(url.searchParams.get('cols') || '80', 10);
      const rows = parseInt(url.searchParams.get('rows') || '24', 10);

      session = this.spawnPtySession({ cwd, cols, rows });

      // Send initial session details
      ws.send(JSON.stringify({
        type: 'session',
        sessionId: session.id,
        cwd: session.cwd,
        platform: process.platform,
        arch: process.arch,
        user: os.userInfo().username,
        hostname: os.hostname()
      }));

      // Pipe PTY output to WebSocket
      session.pty.onData(data => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'output', data }));
        }
      });

      session.pty.onExit(({ exitCode, signal }) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
          ws.close();
        }
      });

      // Handle client input
      ws.on('message', message => {
        try {
          const payload = JSON.parse(message.toString());
          if (payload.type === 'input' && typeof payload.data === 'string') {
            session.pty.write(payload.data);
          } else if (payload.type === 'resize') {
            const c = parseInt(payload.cols, 10);
            const r = parseInt(payload.rows, 10);
            if (c > 0 && r > 0) {
              session.pty.resize(c, r);
            }
          } else if (payload.type === 'signal' && payload.signal) {
            session.pty.kill(payload.signal);
          }
        } catch {
          // If message is raw string or binary, write directly to PTY
          session.pty.write(message.toString());
        }
      });

      ws.on('close', () => {
        if (session && session.pty) {
          try { session.pty.kill(); } catch {}
        }
      });

      ws.on('error', () => {
        if (session && session.pty) {
          try { session.pty.kill(); } catch {}
        }
      });

    } catch (err) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', error: err.message }));
        ws.close(1011, err.message);
      }
    }
  }

  async exec({ cmd, cwd, timeoutMs = 0, maxBuffer = 10 * 1024 * 1024 }) {
    if (!cmd || typeof cmd !== 'string' || !cmd.trim()) {
      throw fail('Command string is required');
    }
    const command = cmd.trim();
    const resolvedCwd = this.resolveCwd(cwd);
    const timeout = Number(timeoutMs) || 0; // 0 = NO LIMITS

    const isWin = process.platform === 'win32';
    const shell = isWin ? 'powershell.exe' : '/bin/bash';
    const shellArgs = isWin
      ? ['-NoProfile', '-NonInteractive', '-Command', `& { ${command} }; if ($LASTEXITCODE) { exit $LASTEXITCODE }`]
      : ['-c', command];

    const env = this.getEnvironment();
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let truncated = false;

    return new Promise((resolve) => {
      let proc;
      let timer = null;
      let killed = false;

      try {
        proc = spawn(shell, shellArgs, {
          cwd: resolvedCwd,
          env,
          windowsHide: true,
        });
      } catch (err) {
        return resolve({
          ok: false,
          cmd: command,
          cwd: resolvedCwd,
          stdout: '',
          stderr: err.message,
          output: err.message,
          exitCode: -1,
          durationMs: Date.now() - start,
          error: err.message
        });
      }

      if (timeout > 0) {
        timer = setTimeout(() => {
          killed = true;
          try {
            if (isWin) {
              spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
            } else {
              proc.kill('SIGTERM');
              setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 1000);
            }
          } catch {}
        }, timeout);
      }

      proc.stdout.on('data', chunk => {
        if (maxBuffer > 0 && stdout.length < maxBuffer) {
          stdout += chunk.toString('utf8');
        } else if (maxBuffer > 0) {
          truncated = true;
        } else {
          stdout += chunk.toString('utf8');
        }
      });

      proc.stderr.on('data', chunk => {
        if (maxBuffer > 0 && stderr.length < maxBuffer) {
          stderr += chunk.toString('utf8');
        } else if (maxBuffer > 0) {
          truncated = true;
        } else {
          stderr += chunk.toString('utf8');
        }
      });

      proc.on('error', err => {
        if (timer) clearTimeout(timer);
        resolve({
          ok: false,
          cmd: command,
          cwd: resolvedCwd,
          stdout,
          stderr: err.message,
          output: (stdout + '\n' + err.message).trim(),
          exitCode: -1,
          durationMs: Date.now() - start,
          error: err.message
        });
      });

      proc.on('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        const durationMs = Date.now() - start;
        let finalStderr = stderr;
        if (killed) {
          finalStderr += `\n[Process timed out after ${timeout / 1000}s]`;
        }
        if (truncated) {
          stdout += `\n[Output truncated at ${maxBuffer / 1024} KB]`;
        }
        const combined = stdout + (finalStderr ? (stdout ? '\n' : '') + finalStderr : '');
        resolve({
          ok: code === 0,
          cmd: command,
          cwd: resolvedCwd,
          stdout,
          stderr: finalStderr,
          output: combined,
          exitCode: code !== null ? code : (signal ? -1 : 0),
          signal: signal || null,
          durationMs,
          timestamp: new Date().toISOString()
        });
      });
    });
  }
}

export function mountTerminal(app, wrap, terminal = new TerminalService()) {
  app.get('/api/terminal/info', wrap(() => terminal.getInfo()));
  app.get('/api/terminal/actions', wrap(() => terminal.getDefaultActions()));
  app.post('/api/terminal/exec', wrap(req => terminal.exec(req.body || {})));
  return terminal;
}

export function attachTerminalWs(server, terminal = new TerminalService()) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
      if (url.pathname === '/api/terminal/ws') {
        wss.handleUpgrade(request, socket, head, ws => {
          wss.emit('connection', ws, request);
        });
      }
    } catch {
      socket.destroy();
    }
  });

  wss.on('connection', (ws, request) => {
    terminal.handleWsConnection(ws, request);
  });

  return wss;
}
