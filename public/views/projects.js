import { api, esc, badge, ago, md, toast, modal, renderDiff, $, $$ } from '../lib.js';
import { memoryForm } from './memory.js';
import { openPlanQuickView } from './plan.js';
import { confirmCommandModal } from './runner.js';

export async function renderProjects(view) {
  const projects = await api('/api/projects');
  view.innerHTML = `
    <div class="head"><div><h1>Projects</h1><div class="muted">Working folders across all tools. For sessions started in your home folder, the project is worked out from the folders the chat touched.</div></div></div>
    <div class="toolbar"><input type="search" id="pq" placeholder="Filter projects…"></div>
    <div class="grid" id="cards"></div>`;
  const draw = f => {
    $('#cards').innerHTML = projects.filter(p => !f || p.path.toLowerCase().includes(f)).map(p => `
      <a class="panel pad" href="#/project/${encodeURIComponent(p.path)}" style="color:inherit;text-decoration:none;display:flex;flex-direction:column;gap:6px">
        <h3 style="overflow-wrap:anywhere">${esc(p.isHome ? '~ Home folder' : p.name)}</h3>
        <div class="muted tiny mono" style="overflow-wrap:anywhere">${esc(p.path)}${p.exists ? '' : ' (missing)'}</div>
        <div class="row" style="gap:6px">${Object.entries(p.tools).map(([t, n]) => badge(t, n)).join('')}${p.memories ? `<span class="badge hub">${p.memories} memories</span>` : ''}</div>
        <div class="muted tiny">${p.last ? 'last active ' + ago(p.last) : ''}</div>
      </a>`).join('') || '<div class="empty">No projects.</div>';
  };
  $('#pq').addEventListener('input', e => draw(e.target.value.toLowerCase()));
  draw('');
}

export async function renderProject(view, params, path) {
  const p = await api('/api/projects/detail?path=' + encodeURIComponent(path));
  view.innerHTML = `
    <div class="head">
      <div style="min-width:0"><h1 style="overflow-wrap:anywhere">${esc(p.name || p.path)}</h1><div class="muted small mono" style="overflow-wrap:anywhere">${esc(p.path)}${p.exists ? '' : ' (folder not found)'}</div></div>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <a class="btn primary" style="color:#fff" href="#/hub?new=1&cwd=${encodeURIComponent(p.path)}">＋ Council chat here</a>
        <button id="project-plan-quick">▤ Plan quick view (${(p.plans || []).length})</button>
        <a class="btn" href="#/runner?cwd=${encodeURIComponent(p.path)}">▶ Tasks & Runner</a>
        ${['claude', 'antigravity', 'codex'].map(t => `<button data-launch="${t}" ${p.exists ? '' : 'disabled'}>▶ ${t === 'claude' ? 'Claude' : t === 'codex' ? 'Codex' : 'Antigravity'} in terminal</button>`).join('')}
      </div>
    </div>
    <div class="split">
      <div>
        <h2 style="margin-top:0">Chats (${p.chats.length})</h2>
        <div class="panel list">${p.chats.map(c => `
          <a class="item" href="#/chat/${encodeURIComponent(c.id)}">${badge(c.tool)}
            <div style="min-width:0"><div class="title">${esc(c.title)}</div><div class="sub">${c.msg_count} messages</div></div>
            <span class="muted tiny">${ago(c.updated)}</span></a>`).join('') || '<div class="empty">No chats.</div>'}
        </div>
        <h2>Project memories (${p.memories.length}) <button class="small" id="addmem" style="margin-left:8px">＋ Add</button></h2>
        <div class="panel list">${p.memories.map(m => `
          <div class="item" style="grid-template-columns:auto 1fr"><span class="chip">${esc(m.type)}</span>
            <div style="min-width:0"><div class="title">${esc(m.title)}</div><div class="md small">${md(m.body.slice(0, 600))}</div></div></div>`).join('') || '<div class="empty small">No memories scoped to this folder yet.</div>'}
        </div>
      </div>
      <div class="sticky" style="display:flex;flex-direction:column;gap:12px">
        <div class="panel pad">
          <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:6px">
            <h3 style="margin:0">Tasks & Runner</h3>
            <a class="tiny" href="#/runner?cwd=${encodeURIComponent(p.path)}">Open Runner ↗</a>
          </div>
          <div id="pj-runner-cmds" class="tiny">Loading commands…</div>
        </div>
        <div class="panel pad">
          <h3>Git</h3>
          ${p.git ? `
            <div class="small">Branch <b>${esc(p.git.branch)}</b> · ${p.git.dirty ? `<span style="color:var(--danger)">${p.git.dirty} changed files</span>` : '<span style="color:var(--ok)">clean</span>'}</div>
            ${p.git.root !== p.path ? `<div class="tiny muted mono">repo: ${esc(p.git.root)}</div>` : ''}
            <div class="tiny" style="margin-top:6px">${p.git.commits.map(c => `<div><span class="mono muted">${esc(c.hash)}</span> ${esc(c.msg)} <span class="muted">· ${esc(c.when)}</span></div>`).join('')}</div>`
            : '<div class="muted small">Not a git repository.</div>'}
        </div>
        <div class="panel pad">
          <h3>Instruction files</h3>
          <div class="muted tiny" style="margin-bottom:6px">What each tool reads automatically in this folder</div>
          ${p.files.map(f => `
            <div class="row" style="justify-content:space-between;align-items:center;padding:4px 0">
              <span>${badge(f.tool)} <span class="mono small">${esc(f.name)}</span></span>
              <button class="small" data-file="${esc(f.path)}">${f.exists ? 'Edit' : 'Create'}</button>
            </div>`).join('') || '<div class="muted small">Folder not found.</div>'}
        </div>
      </div>
    </div>`;

  $$('[data-launch]').forEach(b => b.onclick = async () => {
    try { await api('/api/launch', { method: 'POST', body: { tool: b.dataset.launch, cwd: p.path } }); toast('Terminal opened'); }
    catch (e) { toast(e.message, true); }
  });
  $$('[data-file]').forEach(b => b.onclick = () => editInstructionFile(b.dataset.file, () => renderProject(view, params, path)));
  $('#project-plan-quick').onclick = () => openPlanQuickView(p.plans || []);
  $('#addmem').onclick = () => memoryForm({ scope: p.path, type: 'project' }, () => renderProject(view, params, path));

  // Load runner commands preview
  api('/api/runner/commands?cwd=' + encodeURIComponent(p.path)).then(data => {
    const cmds = data.commands || [];
    const el = $('#pj-runner-cmds');
    if (!el) return;
    if (!cmds.length) {
      el.innerHTML = '<span class="muted">No npm scripts or saved commands in folder.</span>';
      return;
    }
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:6px">
        ${cmds.slice(0, 6).map(c => `
          <div class="row" style="justify-content:space-between;align-items:center;gap:6px">
            <span class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.label)}</span>
            <button class="small" data-run-cmd="${esc(c.id)}">Run</button>
          </div>`).join('')}
      </div>`;

    $$('[data-run-cmd]', el).forEach(btn => {
      btn.onclick = () => {
        const cmd = cmds.find(x => x.id === btn.dataset.runCmd);
        if (!cmd) return;
        const start = async confirmation => {
          try {
            await api('/api/runner/jobs', {
              method: 'POST',
              body: { cwd: p.path, commandId: cmd.id, confirmation }
            });
            toast(`Started task ${cmd.label}`);
            location.hash = `#/runner?cwd=${encodeURIComponent(p.path)}`;
          } catch (err) { toast(err.message, true); }
        };
        if (!cmd.confirmed) confirmCommandModal(cmd, start);
        else start(cmd.fingerprint);
      };
    });
  }).catch(() => {
    const el = $('#pj-runner-cmds');
    if (el) el.innerHTML = '<span class="muted">Runner offline.</span>';
  });
}

// Edit CLAUDE.md / AGENTS.md / GEMINI.md with a diff review before saving.
export async function editInstructionFile(file, onSaved) {
  const cur = await api('/api/instructions?path=' + encodeURIComponent(file));
  modal(`
    <h2 style="margin:0">${cur.exists ? 'Edit' : 'Create'} <span class="mono">${esc(file.split('\\').pop())}</span></h2>
    <div class="muted tiny mono">${esc(file)}</div>
    <textarea id="if-text" rows="20">${esc(cur.content)}</textarea>
    <div id="if-diff"></div>
    <div class="modal-actions"><button id="if-cancel">Cancel</button><button id="if-review">Review changes</button><button class="primary" id="if-save" disabled>Save (with backup)</button></div>`,
  (root, close) => {
    $('#if-cancel', root).onclick = close;
    $('#if-text', root).oninput = () => { $('#if-save', root).disabled = true; $('#if-diff', root).innerHTML = ''; };
    $('#if-review', root).onclick = async () => {
      const { diff } = await api('/api/instructions/preview', { method: 'POST', body: { path: file, content: $('#if-text', root).value } });
      $('#if-diff', root).innerHTML = renderDiff(diff);
      $('#if-save', root).disabled = false;
    };
    $('#if-save', root).onclick = async () => {
      try {
        const r = await api('/api/instructions', { method: 'PUT', body: { path: file, content: $('#if-text', root).value } });
        close(); toast(r.backup ? 'Saved. Backup kept.' : 'Saved'); onSaved?.();
      } catch (e) { toast(e.message, true); }
    };
  });
}
