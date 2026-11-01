import { api, esc, badge, ago, shortPath, TOOL_LABEL } from '../lib.js';

export async function renderHome(view) {
  const [stats, recent, activity, projects] = await Promise.all([
    api('/api/stats'), api('/api/chats?limit=8'), api('/api/activity'), api('/api/projects'),
  ]);
  const byTool = Object.fromEntries(stats.chats.map(c => [c.tool, c]));
  const tools = ['claude', 'antigravity', 'codex'];
  view.innerHTML = `
    <div class="head"><div><h1>Overview</h1><div class="muted">Claude Code, Antigravity and Codex in one place</div></div><a class="btn primary" href="#/hub?new=1" style="color:#fff">＋ New council chat</a></div>
    <div class="grid">
      ${tools.map(t => `
        <a class="panel stat" href="#/chats?tool=${t}" style="color:inherit;text-decoration:none">
          ${badge(t)}<b>${byTool[t]?.n || 0}</b>
          <span class="muted small">chats${byTool[t]?.last ? ' · last ' + ago(byTool[t].last) : t === 'codex' ? ' · none yet' : ''}</span>
        </a>`).join('')}
      <a class="panel stat" href="#/memory" style="color:inherit;text-decoration:none">
        ${badge('hub', 'shared')}<b>${stats.memories}</b><span class="muted small">memories</span>
      </a>
    </div>
    ${stats.memories === 0 ? `<div class="panel pad" style="margin-top:12px">
      <b>Get started:</b> import your existing Claude Code memory files, then connect the memory server to all three tools.
      <div class="row" style="margin-top:8px"><a class="btn" href="#/memory">Go to Memory →</a><a class="btn" href="#/config">Connect tools →</a></div>
    </div>` : ''}
    <div class="split" style="margin-top:8px">
      <div>
        <h2>Recent chats</h2>
        <div class="panel list">${recent.map(c => `
          <a class="item" href="#/chat/${encodeURIComponent(c.id)}">
            ${badge(c.tool)}
            <div style="min-width:0"><div class="title">${esc(c.title)}</div><div class="sub">${esc(shortPath(c.project || c.cwd, 3))}</div></div>
            <span class="muted tiny">${ago(c.updated)}</span>
          </a>`).join('') || '<div class="empty">No chats indexed yet.</div>'}
        </div>
        <h2>Active projects</h2>
        <div class="panel list">${projects.filter(p => !p.isHome).slice(0, 6).map(p => `
          <a class="item" href="#/project/${encodeURIComponent(p.path)}">
            <span class="chip">${p.total}</span>
            <div style="min-width:0"><div class="title">${esc(p.name)}</div><div class="sub">${esc(p.path)}</div></div>
            <span class="muted tiny">${ago(p.last)}</span>
          </a>`).join('') || '<div class="empty">No projects yet.</div>'}
        </div>
      </div>
      <div>
        <h2>Memory activity</h2>
        <div class="panel list">${groupActivity(activity).slice(0, 12).map(a => `
          <div class="item" style="grid-template-columns:auto 1fr">
            ${badge(a.actor)}
            <div style="min-width:0"><div class="sub" style="color:var(--text)">${a.count > 1 ? `${esc(a.action.replace('memory.', ''))} ×${a.count}` : `${esc(a.action.replace('memory.', ''))}: ${esc(a.detail)}`}</div><div class="tiny muted">${ago(a.at)}</div></div>
          </div>`).join('') || '<div class="empty small">Nothing yet. Memory writes from any tool show up here.</div>'}
        </div>
        <p class="tiny muted">Index: ${stats.index.lastRun ? 'scanned ' + ago(stats.index.lastRun) + ` (${stats.index.lastDurationMs} ms)` : 'running…'}. Rescans every 30s.</p>
      </div>
    </div>`;
}

// Collapse runs of the same action by the same tool (e.g. 15 imports) into one row.
function groupActivity(rows) {
  const out = [];
  for (const a of rows) {
    const last = out[out.length - 1];
    if (last && last.actor === a.actor && last.action === a.action && Math.abs(new Date(last.at) - new Date(a.at)) < 120000) last.count++;
    else out.push({ ...a, count: 1 });
  }
  return out;
}
