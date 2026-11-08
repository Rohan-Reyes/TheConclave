import { api, esc, toast, copy, $, $$ } from '../lib.js';

let activeWs = null;
let activeTerm = null;
let activeFitAddon = null;
let currentCwd = '';

export async function renderTerminal(view, params) {
  // Clean up any previous session
  if (activeWs) {
    try { activeWs.close(); } catch {}
    activeWs = null;
  }
  if (activeTerm) {
    try { activeTerm.dispose(); } catch {}
    activeTerm = null;
  }

  const initialCwd = params.get('cwd') || '';

  // Fetch terminal system info
  let info = { platform: 'linux', quickActions: [] };
  try {
    info = await api('/api/terminal/info');
  } catch (e) {
    console.error('Failed to fetch terminal info:', e);
  }

  currentCwd = initialCwd || info.defaultCwd || info.filesRoot || '';

  // Load custom actions from localStorage
  let customActions = [];
  try {
    customActions = JSON.parse(localStorage.getItem('conclave_custom_terminal_actions') || '[]');
  } catch {}

  const allActions = [...(info.quickActions || []), ...customActions];

  view.innerHTML = `
    <div class="head terminal-head">
      <div>
        <div class="row" style="align-items:center;gap:8px">
          <h1>Terminal</h1>
          <span class="badge ${info.platform === 'win32' ? 'warn' : 'ok'}" id="term-host-badge" title="Host System">
            ${esc(info.platform === 'win32' ? 'Windows' : 'Linux')} · ${esc(info.arch || '')}
          </span>
          <span class="badge" id="term-conn-status" style="background:#21262d;color:#8b949e">Connecting…</span>
          <span class="tiny muted" id="term-host-user">${esc(info.user || '')}@${esc(info.hostname || 'conclave')}</span>
        </div>
        <div class="muted small">Interactive pseudo-terminal (PTY) session with zero limits & one-click quick actions.</div>
      </div>
      <div class="row" style="gap:6px">
        <button id="btn-term-reconnect" class="small ghost" title="Restart terminal session">🔄 Reconnect</button>
        <button id="btn-term-clear" class="small ghost" title="Clear terminal screen (Ctrl+L)">🧹 Clear</button>
        <button id="btn-term-copy" class="small ghost" title="Copy terminal selection">📋 Copy</button>
      </div>
    </div>

    <!-- CWD Selector Bar -->
    <div class="panel pad term-cwd-bar" style="margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span class="small" style="font-weight:600">Working Directory:</span>
      <input type="text" id="term-cwd-input" class="mono small" style="flex:1;min-width:240px;padding:4px 8px;border-radius:4px;border:1px solid var(--border)" value="${esc(currentCwd)}" />
      <div class="row" style="gap:4px">
        ${info.filesRoot ? `<button id="btn-cwd-files" class="small ghost tiny" title="Set to Conclave Projects folder">📁 Projects</button>` : ''}
        ${info.appRoot ? `<button id="btn-cwd-app" class="small ghost tiny" title="Set to Conclave App root">💻 App</button>` : ''}
        ${info.home ? `<button id="btn-cwd-home" class="small ghost tiny" title="Set to Home folder">🏠 Home</button>` : ''}
        <button id="btn-cwd-apply" class="small tiny" title="Spawn new session in this folder">Apply</button>
      </div>
    </div>

    <!-- Quick Action Buttons Section -->
    <div class="panel pad term-actions-panel" style="margin-bottom:10px">
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
        <span class="small" style="font-weight:600;letter-spacing:0.5px;text-transform:uppercase;color:var(--muted)">⚡ Quick Actions (Click to Run in Terminal)</span>
        <button id="btn-add-action" class="small ghost tiny" title="Add a custom quick action button">＋ Add Action</button>
      </div>
      <div class="term-actions-grid" id="term-actions-container">
        ${allActions.map(action => `
          <button class="term-action-btn" data-cmd="${esc(action.cmd)}" data-id="${esc(action.id)}" title="${esc(action.desc || action.cmd)}">
            <span class="term-action-icon">${esc(action.icon || '▶')}</span>
            <span class="term-action-label">${esc(action.label)}</span>
          </button>
        `).join('')}
      </div>
    </div>

    <!-- Real-Time Interactive Terminal Window -->
    <div class="term-window">
      <div class="term-window-header">
        <div class="term-dots">
          <span class="dot red"></span>
          <span class="dot yellow"></span>
          <span class="dot green"></span>
        </div>
        <div class="term-window-title mono tiny" id="term-window-title">
          ${esc(info.platform === 'win32' ? 'powershell.exe' : '/bin/bash')} · ${esc(currentCwd)}
        </div>
        <div class="term-window-status tiny muted" id="term-session-badge">PTY Ready</div>
      </div>
      <div class="term-container-wrapper" style="position:relative;background:#0d1117;padding:8px;min-height:480px;height:calc(100vh - 360px);max-height:750px;overflow:hidden">
        <div id="xterm-container" style="width:100%;height:100%"></div>
      </div>
    </div>
  `;

  const container = $('#xterm-container', view);
  const cwdInput = $('#term-cwd-input', view);
  const connStatus = $('#term-conn-status', view);
  const winTitle = $('#term-window-title', view);
  const sessionBadge = $('#term-session-badge', view);

  // Setup xterm.js
  const TerminalClass = window.Terminal;
  const FitAddonClass = window.FitAddon?.FitAddon;

  if (!TerminalClass) {
    container.innerHTML = `<div class="empty" style="padding:40px;color:#f85149">xterm.js could not be loaded. Please reload the page.</div>`;
    return;
  }

  const term = new TerminalClass({
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 50000, // No limits
    fontFamily: 'ui-monospace, SFMono-Regular, "Cascadia Code", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    lineHeight: 1.25,
    theme: {
      background: '#0d1117',
      foreground: '#c9d1d9',
      cursor: '#58a6ff',
      selectionBackground: 'rgba(56, 139, 253, 0.4)',
      black: '#484f58',
      red: '#ff7b72',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#58a6ff',
      magenta: '#bc8cff',
      cyan: '#39c5cf',
      white: '#b1bac4',
      brightBlack: '#6e7681',
      brightRed: '#ffa198',
      brightGreen: '#56d364',
      brightYellow: '#e3b341',
      brightBlue: '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#56d4dd',
      brightWhite: '#f0f6fc',
    }
  });

  activeTerm = term;

  let fitAddon = null;
  if (FitAddonClass) {
    fitAddon = new FitAddonClass();
    term.loadAddon(fitAddon);
    activeFitAddon = fitAddon;
  }

  term.open(container);
  if (fitAddon) {
    try { fitAddon.fit(); } catch {}
  }

  // Connect WebSocket to real interactive PTY
  function connectPty() {
    if (activeWs) {
      try { activeWs.close(); } catch {}
    }

    connStatus.textContent = 'Connecting PTY…';
    connStatus.className = 'badge warn';
    sessionBadge.textContent = 'Connecting…';

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const cols = term.cols || 80;
    const rows = term.rows || 24;
    const wsUrl = `${protocol}//${location.host}/api/terminal/ws?cwd=${encodeURIComponent(currentCwd)}&cols=${cols}&rows=${rows}`;

    const ws = new WebSocket(wsUrl);
    activeWs = ws;

    ws.onopen = () => {
      connStatus.textContent = '🟢 SSH PTY Active';
      connStatus.className = 'badge ok';
      sessionBadge.textContent = 'Connected';
      sessionBadge.style.color = '#3fb950';
      term.focus();
      if (fitAddon) {
        fitAddon.fit();
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output' && msg.data) {
          term.write(msg.data);
        } else if (msg.type === 'session') {
          sessionBadge.textContent = `PID: ${msg.sessionId.slice(0, 8)}`;
          winTitle.textContent = `${msg.platform === 'win32' ? 'powershell' : 'bash'} · ${msg.cwd}`;
        } else if (msg.type === 'exit') {
          term.writeln(`\r\n\x1b[33m[Session closed with exit code ${msg.exitCode !== undefined ? msg.exitCode : 0}]\x1b[0m\r\n`);
          connStatus.textContent = '⚪ Session Closed';
          connStatus.className = 'badge';
        } else if (msg.type === 'error') {
          term.writeln(`\r\n\x1b[31m[Error: ${msg.error}]\x1b[0m\r\n`);
        }
      } catch {
        term.write(event.data);
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      connStatus.textContent = '🔴 Connection Error';
      connStatus.className = 'badge danger';
    };

    ws.onclose = () => {
      connStatus.textContent = '⚪ Disconnected';
      connStatus.className = 'badge';
      sessionBadge.textContent = 'Disconnected';
      sessionBadge.style.color = '#8b949e';
    };

    // User typing into terminal forwards directly to PTY
    term.onData(data => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });
  }

  connectPty();

  // Resize handler
  const resizeHandler = () => {
    if (fitAddon) {
      try {
        fitAddon.fit();
        if (activeWs && activeWs.readyState === WebSocket.OPEN) {
          activeWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch {}
    }
  };
  window.addEventListener('resize', resizeHandler);

  // Quick Action click handlers
  $$('.term-action-btn', view).forEach(btn => {
    btn.onclick = () => {
      const cmd = btn.getAttribute('data-cmd');
      if (cmd && activeWs && activeWs.readyState === WebSocket.OPEN) {
        // Send command string followed by Enter (\r) to run interactively in the PTY!
        activeWs.send(JSON.stringify({ type: 'input', data: cmd + '\r' }));
        term.focus();
      } else if (cmd) {
        toast('Terminal not connected. Click Reconnect.');
      }
    };
  });

  // Reconnect button
  $('#btn-term-reconnect', view).onclick = () => {
    term.clear();
    connectPty();
  };

  // Clear button
  $('#btn-term-clear', view).onclick = () => {
    term.clear();
    term.focus();
  };

  // Copy selection button
  $('#btn-term-copy', view).onclick = () => {
    const sel = term.getSelection();
    if (sel) {
      copy(sel);
      toast('Copied terminal selection');
    } else {
      toast('Select text in terminal to copy');
    }
  };

  // CWD navigation buttons
  $('#btn-cwd-files', view)?.addEventListener('click', () => {
    cwdInput.value = info.filesRoot || '';
    currentCwd = cwdInput.value;
    connectPty();
  });

  $('#btn-cwd-app', view)?.addEventListener('click', () => {
    cwdInput.value = info.appRoot || '';
    currentCwd = cwdInput.value;
    connectPty();
  });

  $('#btn-cwd-home', view)?.addEventListener('click', () => {
    cwdInput.value = info.home || '';
    currentCwd = cwdInput.value;
    connectPty();
  });

  $('#btn-cwd-apply', view)?.addEventListener('click', () => {
    currentCwd = cwdInput.value.trim();
    connectPty();
  });

  cwdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      currentCwd = cwdInput.value.trim();
      connectPty();
    }
  });

  // Add custom action button
  $('#btn-add-action', view).onclick = () => {
    const label = prompt('Action Button Label (e.g. Test Suite, Rebuild):');
    if (!label || !label.trim()) return;
    const cmd = prompt(`Shell command to execute for "${label}":`);
    if (!cmd || !cmd.trim()) return;
    const icon = prompt('Icon / Emoji for button (optional, e.g. 🧪, 🔨):', '⚡') || '⚡';

    const newAction = {
      id: 'custom-' + Date.now(),
      label: label.trim(),
      cmd: cmd.trim(),
      icon: icon.trim(),
      desc: cmd.trim()
    };

    customActions.push(newAction);
    try {
      localStorage.setItem('conclave_custom_terminal_actions', JSON.stringify(customActions));
    } catch {}

    toast(`Added quick action "${label}"`);
    renderTerminal(view, params);
  };

  setTimeout(() => {
    if (fitAddon) {
      try { fitAddon.fit(); } catch {}
    }
    term.focus();
  }, 100);
}
