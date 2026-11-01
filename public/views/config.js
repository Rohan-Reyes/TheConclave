import { api, esc, badge, toast, modal, renderDiff, $, $$ } from '../lib.js';
import { editInstructionFile } from './projects.js';

const HUB = 'agent-hub-memory';
const TOOL_OF = { claude: 'claude', antigravity: 'antigravity', codex: 'codex' };

export async function renderConfig(view, params) {
  const tab = params.get('tab') || 'mcp';
  view.innerHTML = `
    <div class="head"><div><h1>Config</h1><div class="muted">MCP servers, skills and global instruction files across all tools. Every change shows a diff first and keeps a backup.</div></div></div>
    <div class="tabs">
      <button data-tab="agents" class="${tab === 'agents' ? 'on' : ''}">Agents</button>
      <button data-tab="mcp" class="${tab === 'mcp' ? 'on' : ''}">MCP servers</button>
      <button data-tab="skills" class="${tab === 'skills' ? 'on' : ''}">Skills</button>
      <button data-tab="instructions" class="${tab === 'instructions' ? 'on' : ''}">Global instructions</button>
    </div>
    <div id="tab"></div>`;
  $$('[data-tab]').forEach(b => b.onclick = () => { location.hash = '#/config?tab=' + b.dataset.tab; });
  if (tab === 'agents') return renderAgents($('#tab'));
  if (tab === 'skills') return renderSkills($('#tab'));
  if (tab === 'instructions') return renderInstructions($('#tab'));
  return renderMcp($('#tab'));
}

function describe(s) {
  if (!s) return '';
  return s.type === 'http' ? s.url : [s.command, ...(s.args || [])].join(' ');
}

async function renderMcp(box) {
  const [{ targets, servers, errors }, hub] = await Promise.all([api('/api/mcp'), api('/api/mcp/hub-server')]);
  const tkeys = Object.keys(targets);
  const names = Object.keys(servers).sort((a, b) => (a === HUB ? -1 : b === HUB ? 1 : a.localeCompare(b)));
  const hubIn = servers[HUB] || {};
  const missing = tkeys.filter(t => !hubIn[t]);
  box.innerHTML = `
    <div class="panel pad" style="margin-bottom:16px">
      <h3>Shared memory server</h3>
      <div class="small">${missing.length
        ? `Connected to <b>${tkeys.length - missing.length}/${tkeys.length}</b> tools. Connect it so every tool can read and write the same memory.`
        : '<span style="color:var(--ok)">✓ Connected to every tool.</span>'}</div>
      <div class="mono tiny muted" style="margin:6px 0">${esc(describe(hub.server))}</div>
      ${missing.length ? `<button class="primary" id="connect">Connect to ${missing.map(t => targets[t].label).join(', ')}</button>` : ''}
      <div class="tiny muted" style="margin-top:6px">Restart open sessions in each tool afterwards to pick it up.</div>
    </div>
    ${Object.entries(errors).map(([t, e]) => `<div class="panel pad small" style="color:var(--danger);margin-bottom:8px">${esc(targets[t].label)}: could not read config (${esc(e)})</div>`).join('')}
    <div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">Servers × tools</h2><button id="add">＋ Add server</button></div>
    <div class="panel scroll-x" style="margin-top:10px">
      <table class="matrix">
        <tr><th>Server</th>${tkeys.map(t => `<th class="c" title="${esc(targets[t].file)}">${esc(targets[t].label)}</th>`).join('')}<th></th></tr>
        ${names.map(n => {
          const any = Object.values(servers[n])[0];
          return `<tr>
            <td style="min-width:0"><b>${esc(n)}</b><div class="mono tiny muted" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(describe(any))}">${esc(describe(any))}</div></td>
            ${tkeys.map(t => `<td class="c">${servers[n][t] ? '<span class="yes">✓</span>' : '<span class="no">—</span>'}</td>`).join('')}
            <td style="text-align:right"><button class="small" data-edit="${esc(n)}">Edit / copy</button></td></tr>`;
        }).join('')}
      </table>
    </div>
    <p class="tiny muted">Claude Code is changed through <span class="mono">claude mcp</span> (user scope). The other tools are changed by editing their config files, with a backup kept in <span class="mono">agent-hub\\backups</span>.</p>`;

  const reload = () => renderMcp(box);
  $('#connect')?.addEventListener('click', () => mcpDialog(HUB, withClientEnv(hub.server), missing, targets, reload, { lockName: true }));
  $('#add').onclick = () => mcpDialog('', { type: 'stdio', command: '', args: [], env: {} }, [], targets, reload);
  $$('[data-edit]').forEach(b => b.onclick = () => {
    const n = b.dataset.edit;
    const have = Object.keys(servers[n]);
    mcpDialog(n, servers[n][have[0]], have, targets, reload, { lockName: true, existing: have });
  });
}

// The memory server tags writes with the tool name via AGENT_HUB_CLIENT.
function withClientEnv(server) { return { ...server, env: { ...(server.env || {}) } }; }

function mcpDialog(name, server, preselect, targets, onDone, { lockName = false, existing = [] } = {}) {
  const tkeys = Object.keys(targets);
  modal(`
    <h2 style="margin:0">${existing.length ? 'Edit' : 'Add'} MCP server</h2>
    <div class="row">
      <label class="field grow">Name<input id="s-name" value="${esc(name)}" ${lockName ? 'readonly' : ''}></label>
      <label class="field">Type<select id="s-type"><option value="stdio">stdio (command)</option><option value="http">http (URL)</option></select></label>
    </div>
    <div id="s-stdio">
      <label class="field">Command<input id="s-cmd" value="${esc(server.command || '')}"></label>
      <label class="field" style="margin-top:8px">Arguments (one per line)<textarea id="s-args" rows="3">${esc((server.args || []).join('\n'))}</textarea></label>
      <label class="field" style="margin-top:8px">Environment (KEY=value per line)<textarea id="s-env" rows="3">${esc(Object.entries(server.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'))}</textarea></label>
    </div>
    <div id="s-http"><label class="field">URL<input id="s-url" value="${esc(server.url || '')}"></label>
      <label class="field" style="margin-top:8px">Headers (Key: value per line)<textarea id="s-headers" rows="2">${esc(Object.entries(server.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'))}</textarea></label></div>
    <div><div class="muted small" style="margin-bottom:4px">Apply to</div>
      <div class="row">${tkeys.map(t => `<label class="small"><input type="checkbox" value="${t}" ${preselect.includes(t) ? 'checked' : ''} class="s-t"> ${esc(targets[t].label)}${existing.includes(t) ? ' ✓' : ''}</label>`).join('')}</div>
    </div>
    <div id="s-preview"></div>
    <div class="modal-actions">
      ${existing.length ? '<button class="danger" id="s-remove" style="margin-right:auto">Remove from checked</button>' : ''}
      <button id="s-cancel">Cancel</button><button id="s-review">Review changes</button><button class="primary" id="s-apply" disabled>Apply</button>
    </div>`, (root, close) => {
    const typeSel = $('#s-type', root);
    typeSel.value = server.type || 'stdio';
    const sync = () => { $('#s-stdio', root).hidden = typeSel.value !== 'stdio'; $('#s-http', root).hidden = typeSel.value !== 'http'; };
    typeSel.onchange = sync; sync();
    let pending = null;   // { server|null } that was reviewed
    const read = () => {
      const lines = id => $(id, root).value.split('\n').map(s => s.trim()).filter(Boolean);
      const s = typeSel.value === 'http'
        ? { type: 'http', url: $('#s-url', root).value.trim(), headers: Object.fromEntries(lines('#s-headers').map(l => [l.split(':')[0].trim(), l.split(':').slice(1).join(':').trim()])) }
        : { type: 'stdio', command: $('#s-cmd', root).value.trim(), args: lines('#s-args'), env: Object.fromEntries(lines('#s-env').map(l => [l.split('=')[0].trim(), l.split('=').slice(1).join('=')])) };
      return { name: $('#s-name', root).value.trim(), server: s, targets: $$('.s-t', root).filter(c => c.checked).map(c => c.value) };
    };
    root.addEventListener('input', () => { pending = null; $('#s-apply', root).disabled = true; });
    async function review(remove) {
      const r = read();
      if (!r.name) return toast('Name is required', true);
      if (!r.targets.length) return toast('Pick at least one tool', true);
      const server = remove ? null : r.server;
      // Tag memory-server writes with the tool that made them (one env per tool is set on apply).
      const prev = await api('/api/mcp/preview', { method: 'POST', body: { name: r.name, server, targets: r.targets } });
      $('#s-preview', root).innerHTML = prev.map(p => `<div class="small" style="margin-top:8px"><b>${esc(targets[p.target].label)}</b> <span class="mono tiny muted">${esc(p.file)}${p.via ? ' (via ' + esc(p.via) + ')' : ''}</span></div>${renderDiff(p.diff)}`).join('');
      pending = { ...r, server };
      $('#s-apply', root).disabled = false;
      $('#s-apply', root).textContent = remove ? 'Remove' : 'Apply';
    }
    $('#s-cancel', root).onclick = close;
    $('#s-review', root).onclick = () => review(false);
    $('#s-remove', root)?.addEventListener('click', () => review(true));
    $('#s-apply', root).onclick = async () => {
      if (!pending) return;
      $('#s-apply', root).disabled = true;
      const results = [];
      for (const t of pending.targets) {
        let srv = pending.server;
        if (srv && pending.name === HUB) srv = { ...srv, env: { ...(srv.env || {}), AGENT_HUB_CLIENT: TOOL_OF[t] } };
        results.push(...await api('/api/mcp/apply', { method: 'POST', body: { name: pending.name, server: srv, targets: [t] } }));
      }
      const bad = results.filter(r => !r.ok);
      if (bad.length) toast(bad.map(b => `${targets[b.target].label}: ${b.error}`).join(' | '), true);
      else toast(`Done for ${results.length} tool(s). Backups saved.`);
      close(); onDone();
    };
  });
}

async function renderSkills(box) {
  const { targets, skills } = await api('/api/skills');
  const tkeys = Object.keys(targets);
  box.innerHTML = `
    <div class="panel scroll-x">
      <table class="matrix">
        <tr><th>Skill</th>${tkeys.map(t => `<th class="c" title="${esc(targets[t].dir)}">${esc(targets[t].label)}</th>`).join('')}</tr>
        ${skills.map(s => `<tr>
          <td><b>${esc(s.name)}</b><div class="tiny muted" style="max-width:480px">${esc(s.description.slice(0, 180))}</div></td>
          ${tkeys.map(t => `<td class="c">${s.in[t] ? '<span class="yes">✓</span>' : `<button class="small" data-copy="${esc(s.folder)}" data-to="${t}" data-from="${Object.keys(s.in)[0]}" title="Copy from ${esc(targets[Object.keys(s.in)[0]].label)}">Copy here</button>`}</td>`).join('')}
        </tr>`).join('') || `<tr><td colspan="${tkeys.length + 1}" class="empty">No skills found.</td></tr>`}
      </table>
    </div>
    <p class="tiny muted">A skill is a folder with a SKILL.md file. Copying never overwrites an existing skill.</p>`;
  $$('[data-copy]', box).forEach(b => b.onclick = async () => {
    try {
      await api('/api/skills/copy', { method: 'POST', body: { folder: b.dataset.copy, from: b.dataset.from, to: b.dataset.to } });
      toast('Skill copied'); renderSkills(box);
    } catch (e) { toast(e.message, true); }
  });
}

async function renderInstructions(box) {
  const files = await api('/api/instructions/global');
  box.innerHTML = `
    <div class="grid">${files.map(f => `
      <div class="panel pad">
        <div class="row" style="justify-content:space-between;align-items:center">${badge(f.tool)}<button class="small" data-file="${esc(f.path)}">${f.exists ? 'Edit' : 'Create'}</button></div>
        <div class="mono tiny muted" style="margin:6px 0;overflow-wrap:anywhere">${esc(f.path)}</div>
        <div class="small muted">${f.exists ? `${f.content.split('\n').length} lines` : 'Not created yet'}</div>
      </div>`).join('')}
    </div>
    <p class="tiny muted">These load into every session of that tool. Keep shared facts in Memory instead, so all tools see the same version.</p>`;
  $$('[data-file]', box).forEach(b => b.onclick = () => editInstructionFile(b.dataset.file, () => renderInstructions(box)));
}

// ---- Agents: connect more CLI tools as Conclave members
async function renderAgents(box) {
  const { agents, presets } = await api('/api/agents');
  box.innerHTML = `
    <div class="panel pad" style="margin-bottom:14px">
      <h3>Built-in members</h3>
      <div class="row" style="gap:8px">${badge('claude')}${badge('antigravity')}${badge('codex')}</div>
      <div class="small muted" style="margin-top:6px">These keep their own sessions, permissions and the shared memory. Each terminal session also gets <code>council_ask</code> and <code>agent_ask</code> tools through the memory server, so you can call the others from inside any tool.</div>
    </div>
    <div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">Your extra agents</h2><button id="add-agent">＋ Custom agent</button></div>
    <div class="panel list" style="margin-top:10px">${agents.map(a => `
      <div class="item" style="grid-template-columns:auto 1fr auto">
        <span class="chip">@${esc(a.id)}</span>
        <div style="min-width:0"><div class="title">${esc(a.name)}${a.enabled ? '' : ' <span class="muted tiny">(off)</span>'}</div>
          <div class="sub mono">${esc(a.command)} ${esc(a.args.join(' '))} ${a.input === 'stdin' ? '‹ prompt on stdin' : ''}</div></div>
        <div class="row" style="gap:4px"><button class="small" data-test="${esc(a.id)}">Test</button><button class="small" data-edit-agent="${esc(a.id)}">Edit</button><button class="small danger" data-del="${esc(a.id)}">Remove</button></div>
      </div>`).join('') || '<div class="empty small">None yet. Add a preset below or your own CLI.</div>'}
    </div>
    <h2>Presets</h2>
    <div class="grid">${presets.map(p => `
      <div class="panel pad" style="display:flex;flex-direction:column;gap:6px">
        <div class="row" style="justify-content:space-between;align-items:center"><b>${esc(p.name)}</b>
          ${p.path ? '<span class="badge" style="--c:var(--ok)">installed</span>' : '<span class="badge">not found</span>'}</div>
        <div class="mono tiny muted">${esc(p.command)} ${esc(p.args.join(' '))}</div>
        ${p.note ? `<div class="tiny muted">${esc(p.note)}</div>` : ''}
        <div style="margin-top:auto">${p.added ? '<span class="small muted">Added ✓</span>' : `<button class="small ${p.path ? 'primary' : ''}" data-preset="${esc(p.id)}">${p.path ? 'Add to Conclave' : 'Add anyway'}</button>`}</div>
      </div>`).join('')}
    </div>
    <p class="tiny muted">Extra agents run as plain text CLIs: they get the chat so far on each turn and their output becomes the reply. Mention them with @id, or tick them as council members in a chat's settings.</p>`;

  const reload = () => renderAgents(box);
  $('#add-agent').onclick = () => agentDialog({}, reload);
  $$('[data-edit-agent]', box).forEach(b => b.onclick = () => agentDialog(agents.find(a => a.id === b.dataset.editAgent), reload));
  $$('[data-preset]', box).forEach(b => b.onclick = async () => {
    const p = presets.find(x => x.id === b.dataset.preset);
    try { await api('/api/agents', { method: 'POST', body: p }); toast(`${p.name} added`); reload(); } catch (e) { toast(e.message, true); }
  });
  $$('[data-del]', box).forEach(b => b.onclick = async () => {
    if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = 'Sure?'; return; }
    await api('/api/agents/' + b.dataset.del, { method: 'DELETE' }); reload();
  });
  $$('[data-test]', box).forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Testing…';
    try {
      const r = await api(`/api/agents/${b.dataset.test}/test`, { method: 'POST', body: {} });
      toast(r.ok ? `Works: "${r.text.trim().slice(0, 60)}"` : `Failed: ${(r.error || r.text || 'no reply').slice(0, 200)}`, !r.ok);
    } catch (e) { toast(e.message, true); }
    b.disabled = false; b.textContent = 'Test';
  });
}

function agentDialog(a, onDone) {
  modal(`
    <h2 style="margin:0">${a.id ? 'Edit' : 'Add'} agent</h2>
    <div class="row">
      <label class="field grow">Name<input id="a-name" value="${esc(a.name || '')}" placeholder="My Local Model"></label>
      <label class="field">Handle (@mention)<input id="a-id" value="${esc(a.id || '')}" placeholder="auto" ${a.id ? 'readonly' : ''}></label>
    </div>
    <label class="field">Command (exe or name on PATH)<input id="a-cmd" class="mono" value="${esc(a.command || '')}" placeholder="ollama"></label>
    <label class="field">Arguments (one per line, <code>{prompt}</code> = the message)<textarea id="a-args" rows="4">${esc((a.args || []).join('\n'))}</textarea></label>
    <label class="field">Send the prompt<select id="a-input"><option value="stdin" ${a.input !== 'arg' ? 'selected' : ''}>on stdin (best for long chats)</option><option value="arg" ${a.input === 'arg' ? 'selected' : ''}>as the {prompt} argument</option></select></label>
    <label class="small check"><input type="checkbox" id="a-on" ${a.enabled !== false ? 'checked' : ''}> Enabled</label>
    <div class="modal-actions"><button id="a-cancel">Cancel</button><button class="primary" id="a-save">Save</button></div>`, (root, close) => {
    $('#a-cancel', root).onclick = close;
    $('#a-save', root).onclick = async () => {
      try {
        await api('/api/agents', { method: 'POST', body: {
          id: $('#a-id', root).value.trim() || undefined, name: $('#a-name', root).value.trim(), command: $('#a-cmd', root).value.trim(),
          args: $('#a-args', root).value.split('\n').map(x => x.trim()).filter(Boolean), input: $('#a-input', root).value, enabled: $('#a-on', root).checked,
        } });
        close(); toast('Agent saved'); onDone();
      } catch (e) { toast(e.message, true); }
    };
  });
}
