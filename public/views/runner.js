import { api, esc, toast, modal, copy, $, $$ } from '../lib.js';

let activeEventSource = null;

export function closeActiveRunnerEvents() {
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
}

// Format status badge
function statusBadge(status, exitCode) {
  const cls = status === 'running' ? 'ok'
    : status === 'starting' ? 'hub'
    : status === 'stopping' ? 'warn'
    : status === 'done' ? (exitCode === 0 ? 'ok' : 'danger')
    : status === 'failed' ? 'danger'
    : 'muted';
  const label = status === 'done' && exitCode !== null ? (exitCode === 0 ? 'exited 0' : `exit ${exitCode}`)
    : status;
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

// Confirmation modal before first run of any unconfirmed command
export function confirmCommandModal(cmd, onConfirm) {
  const fullArgs = Array.isArray(cmd.args) ? cmd.args.join(' ') : '';
  const fullCmd = `${cmd.executable} ${fullArgs}`.trim();

  modal(`
    <div class="row" style="justify-content:space-between;align-items:center">
      <h2 style="margin:0">Confirm Command Execution</h2>
      <button class="icon-btn" id="cfm-x">✕</button>
    </div>
    <p class="muted small" style="margin:8px 0">This command will execute directly on your local system under your project working folder. Please verify the exact command below before continuing:</p>
    <div class="panel pad" style="margin:8px 0;background:var(--panel-2)">
      <div style="font-weight:600;margin-bottom:4px">${esc(cmd.label || cmd.id)}</div>
      <div class="mono small" style="word-break:break-all">${esc(fullCmd || cmd.script || cmd.executable)}</div>
      ${cmd.script ? `<div class="tiny muted" style="margin-top:4px">package.json script: <code>${esc(cmd.script)}</code></div>` : ''}
    </div>
    <div class="modal-actions">
      <button id="cfm-cancel">Cancel</button>
      <button class="primary" id="cfm-run">Confirm & Run</button>
    </div>`, (root, close) => {
    $('#cfm-x', root).onclick = close;
    $('#cfm-cancel', root).onclick = close;
    $('#cfm-run', root).onclick = () => {
      close();
      onConfirm(cmd.fingerprint);
    };
  });
}

// Main Runner View
export async function renderRunner(view, params) {
  closeActiveRunnerEvents();
  const cwd = params.get('cwd') || '';
  if (!cwd) {
    const projects = await api('/api/projects').catch(() => []);
    view.innerHTML = `
      <div class="head">
        <div><h1>Task Runner</h1><div class="muted">Run npm scripts and project commands in background with live streaming logs.</div></div>
      </div>
      <div class="panel pad">
        <h3>Select a project folder</h3>
        <div class="grid" style="margin-top:10px">
          ${projects.filter(p => p.exists).map(p => `
            <a class="panel pad" href="#/runner?cwd=${encodeURIComponent(p.path)}" style="color:inherit;text-decoration:none">
              <b>${esc(p.name)}</b>
              <div class="tiny mono muted">${esc(p.path)}</div>
            </a>`).join('') || '<div class="empty">No projects found.</div>'}
        </div>
      </div>`;
    return;
  }

  view.innerHTML = `
    <div class="head">
      <div>
        <div class="row" style="align-items:center;gap:8px">
          <h1>Task Runner</h1>
          <a class="small" href="#/project/${encodeURIComponent(cwd)}">Project details ↗</a>
          <a class="small" href="#/hub?cwd=${encodeURIComponent(cwd)}">Chat ↗</a>
        </div>
        <div class="muted small mono">${esc(cwd)}</div>
      </div>
      <div class="row" style="gap:6px">
        <button id="btn-refresh" class="small ghost">↻ Refresh</button>
        <button id="btn-add-cmd" class="small">＋ Custom Command</button>
      </div>
    </div>
    <div class="runner-container" id="runner-root">Loading…</div>`;

  $('#btn-refresh').onclick = () => renderRunner(view, params);
  $('#btn-add-cmd').onclick = () => addCommandModal(cwd, () => renderRunner(view, params));

  await mountRunnerContainer($('#runner-root'), cwd);
}

// Mount Runner inside any container (for standalone view or modal dialog)
export async function mountRunnerContainer(container, cwd, onSendToChat) {
  closeActiveRunnerEvents();

  let cmdData, jobData;
  try {
    [cmdData, jobData] = await Promise.all([
      api('/api/runner/commands?cwd=' + encodeURIComponent(cwd)),
      api('/api/runner/jobs?cwd=' + encodeURIComponent(cwd))
    ]);
  } catch (err) {
    container.innerHTML = `<div class="empty err">Runner unavailable: ${esc(err.message)}</div>`;
    return;
  }

  const commands = cmdData.commands || [];
  let jobs = jobData.jobs || [];

  // Pick default selected job: first running job, or first job in list
  let selectedJobId = jobs.find(j => ['starting', 'running', 'stopping'].includes(j.status))?.id || jobs[0]?.id || null;

  container.innerHTML = `
    <div class="runner-layout">
      <!-- Left: Commands & Tasks -->
      <div class="runner-sidebar">
        <div class="runner-pane-title">Commands (${commands.length})</div>
        <div class="runner-command-list" id="runner-commands">
          ${commands.map(c => `
            <div class="runner-command-item" data-cmd-id="${esc(c.id)}">
              <div style="min-width:0;flex:1">
                <div class="runner-cmd-name">${esc(c.label)}</div>
                ${c.script ? `<div class="tiny mono muted" style="overflow:hidden;text-overflow:ellipsis">${esc(c.script)}</div>` : ''}
              </div>
              <button class="small primary" data-act="run-cmd" data-id="${esc(c.id)}" ${c.unavailable ? 'disabled title="' + esc(c.error || '') + '"' : ''}>Run</button>
            </div>`).join('') || '<div class="empty small">No npm scripts or saved commands.</div>'}
        </div>

        <div class="runner-pane-title" style="margin-top:14px">Recent Tasks (${jobs.length})</div>
        <div class="runner-job-list" id="runner-jobs">
          ${jobs.map(j => `
            <div class="runner-job-item ${j.id === selectedJobId ? 'active' : ''}" data-job-id="${esc(j.id)}">
              <div style="min-width:0;flex:1">
                <div class="runner-job-name">${esc(j.label)}</div>
                <div class="tiny muted">${j.pid ? 'pid ' + j.pid + ' · ' : ''}${statusBadge(j.status, j.exitCode)}</div>
              </div>
              ${['starting', 'running'].includes(j.status) ? `<button class="small danger icon-btn" data-act="stop-job" data-id="${esc(j.id)}" title="Stop process">■</button>` : ''}
            </div>`).join('') || '<div class="empty small">No tasks run yet.</div>'}
        </div>
      </div>

      <!-- Right: Live Log & Execution Details -->
      <div class="runner-main" id="runner-job-pane">
        <div class="empty small">Select a running task or launch a command.</div>
      </div>
    </div>`;

  // Draw Job Details Pane
  function renderJobPane(job) {
    const pane = $('#runner-job-pane', container);
    if (!pane) return;
    if (!job) {
      pane.innerHTML = '<div class="empty small">Select a task on the left or run a command.</div>';
      return;
    }

    const isActive = ['starting', 'running', 'stopping'].includes(job.status);
    const hasUrls = job.urls && job.urls.length > 0;

    pane.innerHTML = `
      <div class="runner-job-header">
        <div style="min-width:0">
          <div class="row" style="align-items:center;gap:8px">
            <h3 style="margin:0">${esc(job.label)}</h3>
            <span id="job-status-badge">${statusBadge(job.status, job.exitCode)}</span>
            ${job.pid ? `<span class="chip tiny mono">pid ${job.pid}</span>` : ''}
          </div>
          <div class="tiny muted" style="margin-top:2px">Started ${new Date(job.started).toLocaleTimeString()} · ${job.lastSeq || 0} log lines ${job.droppedBytes ? `(${formatBytes(job.droppedBytes)} truncated)` : ''}</div>
        </div>
        <div class="row" style="gap:6px;align-items:center">
          ${hasUrls ? `<a class="btn primary small" id="btn-open-app" href="${esc(job.urls[0])}" target="_blank" rel="noopener">🚀 Open App</a>` : ''}
          ${isActive ? '<button class="small danger" id="btn-job-stop">■ Stop</button>' : ''}
          <button class="small" id="btn-job-restart">↻ Restart</button>
          <button class="small ghost" id="btn-job-copy-log" title="Copy logs to clipboard">Copy logs</button>
          <button class="small" id="btn-job-send-chat" title="Send log snippet to chat">Send to chat</button>
        </div>
      </div>

      ${hasUrls ? `
        <div class="runner-urls-banner">
          <span>🌐 Detected Local Server:</span>
          ${job.urls.map(u => `<a class="runner-url-link" href="${esc(u)}" target="_blank" rel="noopener">${esc(u)} ↗</a>`).join(' ')}
        </div>` : ''}

      <div class="runner-log-pane" id="log-pane">
        <div class="runner-log-stream" id="log-stream">
          ${(job.logs || []).map(l => `<div class="log-line ${esc(l.stream)}"><span class="log-seq">${l.seq}</span>${esc(l.text)}</div>`).join('') || '<div class="muted tiny">Waiting for output…</div>'}
        </div>
      </div>`;

    const logPane = $('#log-pane', pane);
    if (logPane) logPane.scrollTop = logPane.scrollHeight;

    $('#btn-job-stop', pane)?.addEventListener('click', async () => {
      try {
        await api(`/api/runner/jobs/${job.id}/stop`, { method: 'POST', body: { cwd } });
        toast('Stopping task…');
      } catch (e) { toast(e.message, true); }
    });

    $('#btn-job-restart', pane)?.addEventListener('click', async () => {
      const cmd = commands.find(c => c.id === job.commandId);
      const doRestart = async confirmation => {
        try {
          const newJob = await api(`/api/runner/jobs/${job.id}/restart`, {
            method: 'POST',
            body: { cwd, confirmation }
          });
          toast('Task restarted');
          selectJob(newJob.id);
        } catch (e) { toast(e.message, true); }
      };

      if (cmd && !cmd.confirmed) {
        confirmCommandModal(cmd, doRestart);
      } else {
        doRestart(cmd?.fingerprint);
      }
    });

    $('#btn-job-copy-log', pane)?.addEventListener('click', () => {
      const text = (job.logs || []).map(l => l.text).join('');
      copy(text || 'No logs recorded.');
    });

    $('#btn-job-send-chat', pane)?.addEventListener('click', () => {
      const recentLogs = (job.logs || []).slice(-40).map(l => l.text).join('').slice(-3000);
      const textToSend = `\`${job.label}\` task logs (${job.status}${job.exitCode !== null ? `, exit ${job.exitCode}` : ''}):\n\`\`\`\n${recentLogs || '(no logs)'}\n\`\`\``;

      if (onSendToChat) {
        onSendToChat(textToSend);
      } else {
        copy(textToSend);
        toast('Logs formatted & copied! Paste into Conclave chat.');
      }
    });

    // Subscribe to SSE events for this job
    closeActiveRunnerEvents();
    activeEventSource = new EventSource(`/api/runner/jobs/${job.id}/events?cwd=${encodeURIComponent(cwd)}&after=${job.lastSeq || 0}`);

    activeEventSource.onmessage = ev => {
      const event = JSON.parse(ev.data);
      if (event.type === 'snapshot' || event.type === 'status') {
        const j = event.job;
        Object.assign(job, j);
        const badgeEl = $('#job-status-badge', pane);
        if (badgeEl) badgeEl.innerHTML = statusBadge(job.status, job.exitCode);
        // Update sidebar item badge
        const sideItem = container.querySelector(`.runner-job-item[data-job-id="${job.id}"] .tiny`);
        if (sideItem) sideItem.innerHTML = `${job.pid ? 'pid ' + job.pid + ' · ' : ''}${statusBadge(job.status, job.exitCode)}`;
      } else if (event.type === 'log') {
        const l = event.log;
        if (!job.logs) job.logs = [];
        job.logs.push(l);
        job.lastSeq = l.seq;
        const streamEl = $('#log-stream', pane);
        if (streamEl) {
          const atBottom = logPane.scrollHeight - logPane.scrollTop - logPane.clientHeight < 50;
          const lineEl = document.createElement('div');
          lineEl.className = `log-line ${l.stream}`;
          lineEl.innerHTML = `<span class="log-seq">${l.seq}</span>${esc(l.text)}`;
          streamEl.appendChild(lineEl);
          if (atBottom) logPane.scrollTop = logPane.scrollHeight;
        }
        if (event.urls?.length && (!job.urls || job.urls.length !== event.urls.length)) {
          job.urls = event.urls;
          renderJobPane(job);
        }
      }
    };
  }

  async function selectJob(id) {
    selectedJobId = id;
    $$('.runner-job-item', container).forEach(el => el.classList.toggle('active', el.dataset.jobId === id));
    try {
      const cur = await api(`/api/runner/jobs/${id}?cwd=` + encodeURIComponent(cwd));
      renderJobPane(cur);
    } catch {
      renderJobPane(null);
    }
  }

  // Handle run command action
  async function runCommand(cmdId) {
    const cmd = commands.find(c => c.id === cmdId);
    if (!cmd) return;

    const execute = async fingerprint => {
      try {
        const job = await api('/api/runner/jobs', {
          method: 'POST',
          body: { cwd, commandId: cmd.id, confirmation: fingerprint }
        });
        toast(`Started ${cmd.label}`);
        // Refresh job list and select newly started job
        const updatedJobs = await api('/api/runner/jobs?cwd=' + encodeURIComponent(cwd));
        jobs = updatedJobs.jobs || [];
        const jobListEl = $('#runner-jobs', container);
        if (jobListEl) {
          jobListEl.innerHTML = jobs.map(j => `
            <div class="runner-job-item ${j.id === job.id ? 'active' : ''}" data-job-id="${esc(j.id)}">
              <div style="min-width:0;flex:1">
                <div class="runner-job-name">${esc(j.label)}</div>
                <div class="tiny muted">${j.pid ? 'pid ' + j.pid + ' · ' : ''}${statusBadge(j.status, j.exitCode)}</div>
              </div>
              ${['starting', 'running'].includes(j.status) ? `<button class="small danger icon-btn" data-act="stop-job" data-id="${esc(j.id)}" title="Stop process">■</button>` : ''}
            </div>`).join('');
        }
        selectJob(job.id);
      } catch (e) { toast(e.message, true); }
    };

    if (!cmd.confirmed) {
      confirmCommandModal(cmd, execute);
    } else {
      execute(cmd.fingerprint);
    }
  }

  // Event delegations for container
  container.addEventListener('click', async e => {
    const runBtn = e.target.closest('[data-act="run-cmd"]');
    if (runBtn) {
      runCommand(runBtn.dataset.id);
      return;
    }

    const stopBtn = e.target.closest('[data-act="stop-job"]');
    if (stopBtn) {
      const jid = stopBtn.dataset.id;
      api(`/api/runner/jobs/${jid}/stop`, { method: 'POST', body: { cwd } })
        .then(() => toast('Stopping…'), err => toast(err.message, true));
      return;
    }

    const jobItem = e.target.closest('.runner-job-item');
    if (jobItem && !e.target.closest('button')) {
      selectJob(jobItem.dataset.jobId);
    }
  });

  if (selectedJobId) selectJob(selectedJobId);
}

// Add Custom Command Modal
function addCommandModal(cwd, onAdded) {
  modal(`
    <h2 style="margin:0">Add Custom Command</h2>
    <div class="muted small" style="margin-bottom:8px">Saved commands run directly under <code>${esc(cwd)}</code>.</div>
    <label class="field">Label (optional)<input id="ac-label" placeholder="e.g. Build Bundle or Run Tests"></label>
    <label class="field">Executable<input id="ac-exe" class="mono" placeholder="e.g. node or C:\\path\\to\\python.exe"></label>
    <label class="field">Arguments (separated by spaces)<input id="ac-args" class="mono" placeholder="e.g. scripts/build.js --prod"></label>
    <div class="modal-actions">
      <button id="ac-cancel">Cancel</button>
      <button class="primary" id="ac-save">Save Command</button>
    </div>`, async (root, close) => {
    $('#ac-cancel', root).onclick = close;
    $('#ac-save', root).onclick = async () => {
      const executable = $('#ac-exe', root).value.trim();
      if (!executable) return toast('Executable is required', true);
      const label = $('#ac-label', root).value.trim() || executable;
      const rawArgs = $('#ac-args', root).value.trim();
      const args = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : [];
      try {
        await api('/api/runner/commands', {
          method: 'POST',
          body: { cwd, label, executable, args }
        });
        toast('Command saved');
        close();
        onAdded?.();
      } catch (e) { toast(e.message, true); }
    };
  });
}

// Open Runner in a Modal Dialog directly from chat header
export function openRunnerModal(cwd, onSendToChat) {
  if (!cwd) return toast('No working folder set for this chat', true);
  modal(`
    <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
      <div class="row" style="align-items:center;gap:8px">
        <h2 style="margin:0">Project Tasks & Runner</h2>
        <span class="mono tiny muted">${esc(cwd)}</span>
      </div>
      <button class="icon-btn" id="rm-close">✕</button>
    </div>
    <div id="rm-content" style="min-height:420px"></div>`, (root, close) => {
    $('#rm-close', root).onclick = () => { closeActiveRunnerEvents(); close(); };
    mountRunnerContainer($('#rm-content', root), cwd, text => {
      closeActiveRunnerEvents();
      close();
      onSendToChat?.(text);
    });
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
