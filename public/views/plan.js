// Council plan board, questions from agents, and the team (roles + usage) panel.
import { api, esc, toast, modal, $, $$ } from '../lib.js';

const STEP_ICON = { queued: '○', running: '', done: '✓', failed: '✕', waiting: '?', skipped: '⤼' };
const PLAN_LABEL = { proposed: 'Ready', running: 'Running', paused: 'Paused', done: 'Done', failed: 'Failed', cancelled: 'Cancelled', invalid: 'Unreadable', empty: 'No work needed' };
export const ROLE_LABEL = { lead: 'Team lead', builder: 'Builder', reviewer: 'Reviewer', tester: 'Tester', researcher: 'Researcher', designer: 'Designer', member: 'Member', bench: 'Benched' };

// ---------- plan board (shown under the verdict it came from)
export function planHtml(p, tools) {
  const name = id => tools[id] || id;
  const done = p.steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
  const pct = p.steps.length ? Math.round(done / p.steps.length * 100) : 0;
  const ctl = [];
  if (p.status === 'proposed' || p.status === 'paused') ctl.push(`<button class="small primary" data-plan="run">▶ ${p.status === 'paused' ? 'Resume' : 'Run plan'}</button>`);
  if (p.status === 'running') ctl.push('<button class="small" data-plan="pause">⏸ Pause</button>');
  if (['proposed', 'running', 'paused'].includes(p.status)) ctl.push('<button class="small danger" data-plan="cancel">Cancel</button>');
  if (p.status === 'invalid') ctl.push('<button class="small primary" data-plan="lead">Give it all to the lead</button>');
  return `<div class="plan ${p.status}" data-plan-id="${p.id}">
    <div class="plan-head">
      <div style="min-width:0"><b>Plan</b> <span class="chip">${esc(PLAN_LABEL[p.status] || p.status)}</span>
        ${p.summary ? `<span class="muted small"> ${esc(p.summary)}</span>` : ''}</div>
      <div class="row" style="gap:6px">${ctl.join('')}</div>
    </div>
    ${p.steps.length ? `<div class="plan-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>` : ''}
    ${p.error ? `<div class="small" style="color:var(--danger)">${esc(p.error)}</div>` : ''}
    <ol class="steps">${p.steps.map(s => `
      <li class="step ${s.status}" data-step="${esc(s.id)}">
        <span class="sicon">${s.status === 'running' ? '<span class="spin"></span>' : STEP_ICON[s.status] || '○'}</span>
        <div class="sbody">
          <div class="stitle">${esc(s.id)}. ${esc(s.title)} ${s.kind === 'read' ? '<span class="chip">read-only</span>' : ''}</div>
          <div class="smeta">
            <span class="who-chip ${esc(s.assignee || s.owner)}">${esc(name(s.assignee || s.owner))}</span>
            ${s.review ? `<span class="muted tiny">review: ${esc(name(s.review))}</span>` : ''}
            ${s.files?.length ? `<span class="muted tiny mono">${esc(s.files.slice(0, 3).join(', '))}${s.files.length > 3 ? ' …' : ''}</span>` : ''}
            ${s.error ? `<span class="tiny" style="color:var(--danger)">${esc(s.error)}</span>` : ''}
          </div>
        </div>
        <div class="sact">${['failed', 'waiting', 'queued'].includes(s.status) && p.status !== 'done' && p.status !== 'cancelled' ? `
          ${s.status === 'failed' ? '<button class="small" data-step-act="retry">Retry</button>' : ''}
          <button class="small" data-step-act="skip">Skip</button>
          <select class="small" data-step-act="reassign" title="Give this step to…"><option value="">Reassign…</option>${Object.entries(tools).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>` : ''}
        </div>
      </li>`).join('')}
    </ol>
  </div>`;
}

// ---------- questions agents ask the user
export function questionHtml(q, tools) {
  return `<div class="question" data-question="${q.id}">
    <div class="who"><span class="q-badge">?</span><b>${esc(tools[q.agent] || q.agent)}</b> asks you</div>
    <div class="q-text">${esc(q.question)}</div>
    ${q.options?.length ? `<div class="q-opts">${q.options.map(o => `<button class="pill" data-answer="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
    <div class="row" style="gap:6px"><input class="q-input grow" placeholder="${q.options?.length ? 'Or type your own answer…' : 'Type your answer…'}"><button class="small primary" data-answer-send>Answer</button></div>
    <div class="tiny muted">${q.via === 'tool' ? 'The agent is waiting for your answer.' : 'Your answer goes back to this agent and it continues.'}</div>
  </div>`;
}

export function bindPlanAndQuestions(root, threadId, after) {
  root.addEventListener('click', async e => {
    const pb = e.target.closest('[data-plan]');
    if (pb) {
      const planId = pb.closest('[data-plan-id]').dataset.planId;
      const act = pb.dataset.plan;
      try {
        if (act === 'lead') await api(`/api/threads/${threadId}/messages`, { method: 'POST', body: { executePlan: true } });
        else await api(`/api/threads/${threadId}/plans/${planId}/${act}`, { method: 'POST', body: {} });
        after?.();
      } catch (err) { toast(err.message, true); }
      return;
    }
    const sb = e.target.closest('button[data-step-act]');
    if (sb) {
      const planId = sb.closest('[data-plan-id]').dataset.planId, stepId = sb.closest('[data-step]').dataset.step;
      api(`/api/threads/${threadId}/plans/${planId}/steps/${encodeURIComponent(stepId)}/${sb.dataset.stepAct}`, { method: 'POST', body: {} }).then(after, err => toast(err.message, true));
      return;
    }
    const ab = e.target.closest('[data-answer], [data-answer-send]');
    if (ab) {
      const card = ab.closest('[data-question]');
      const answer = ab.hasAttribute('data-answer') ? ab.dataset.answer : $('.q-input', card).value.trim();
      if (!answer) return toast('Type an answer first', true);
      card.classList.add('done');
      api(`/api/questions/${card.dataset.question}/answer`, { method: 'POST', body: { answer } }).then(() => { toast('Answer sent'); after?.(); }, err => { card.classList.remove('done'); toast(err.message, true); });
    }
  });
  root.addEventListener('change', e => {
    const sel = e.target.closest('select[data-step-act="reassign"]');
    if (!sel || !sel.value) return;
    const planId = sel.closest('[data-plan-id]').dataset.planId, stepId = sel.closest('[data-step]').dataset.step;
    api(`/api/threads/${threadId}/plans/${planId}/steps/${encodeURIComponent(stepId)}/reassign`, { method: 'POST', body: { agent: sel.value } }).then(after, err => toast(err.message, true));
  });
  root.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.classList.contains('q-input')) { e.preventDefault(); e.target.closest('[data-question]').querySelector('[data-answer-send]').click(); }
  });
}

// ---------- team: roles + live usage
export function usageOf(id, limits, credits) {
  if (credits?.[id]) return { pct: 100, out: true, text: `out until ${new Date(credits[id].until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` };
  let pct = null;
  if (id === 'claude' && limits?.claude) pct = Math.max(0, ...Object.values(limits.claude.unifiedWindows || {}).filter(w => w.resetsAt * 1000 > Date.now()).map(w => w.utilization * 100));
  if (id === 'codex' && limits?.codex) pct = Math.max(0, ...[limits.codex.primary, limits.codex.secondary].filter(Boolean).map(w => w.usedPct));
  if (id === 'antigravity' && limits?.antigravity) pct = Math.max(0, ...limits.antigravity.groups.flatMap(g => g.windows.map(w => 100 - w.remainingPct)));
  return pct == null || !isFinite(pct) ? { pct: null, text: 'limits unknown' } : { pct: Math.round(pct), text: `${Math.round(pct)}% used` };
}

export function teamStripHtml(team, tools, limits, credits, busyIds = new Set()) {
  return team.map(m => {
    const u = usageOf(m.id, limits, credits);
    return `<span class="mate ${m.id} ${u.out ? 'out' : ''} ${busyIds.has(m.id) ? 'busy' : ''}" title="${esc(tools[m.id] || m.id)} · ${esc(ROLE_LABEL[m.role] || m.role)} · ${esc(u.text)}">
      <span class="av">${esc((tools[m.id] || m.id)[0])}</span>
      <span class="mate-txt"><b>${esc(tools[m.id] || m.id)}</b><span>${esc(ROLE_LABEL[m.role] || m.role)}</span></span>
      ${u.pct != null ? `<span class="mini-meter ${u.pct >= 90 ? 'hot' : u.pct >= 70 ? 'warm' : ''}"><i style="width:${Math.min(100, u.pct)}%"></i></span>` : ''}
    </span>`;
  }).join('');
}

export async function teamDialog(t, tools, save) {
  const [limits, credits] = await Promise.all([api('/api/limits').catch(() => ({})), api('/api/credits').catch(() => ({}))]);
  const roles = t.settings.roles || {};
  const roleOf = id => roles[id] || (!t.settings.members.includes(id) ? 'bench' : id === t.settings.chair ? 'lead' : 'member');
  modal(`
    <h2 style="margin:0">Team</h2>
    <div class="muted small">Give each agent a role. Agents see the roles and everyone's current usage, so the lead can hand heavy work to whoever has headroom. Benched agents sit out councils and plans.</div>
    <div class="team-rows">${Object.entries(tools).map(([id, label]) => {
      const u = usageOf(id, limits, credits);
      return `<div class="team-row">
        <span class="mate ${id}"><span class="av">${esc(label[0])}</span><b>${esc(label)}</b></span>
        <select data-role="${id}">${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}" ${roleOf(id) === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <span class="team-usage">${u.pct != null ? `<span class="mini-meter wide ${u.pct >= 90 ? 'hot' : u.pct >= 70 ? 'warm' : ''}"><i style="width:${Math.min(100, u.pct)}%"></i></span>` : ''}<span class="tiny muted">${esc(u.text)}</span></span>
      </div>`;
    }).join('')}</div>
    <div class="tiny muted">Tip: one Team lead writes the verdict and splits the work. Builders get build steps; reviewers and testers check them.</div>
    <div class="modal-actions"><button id="tm-cancel">Cancel</button><button class="primary" id="tm-save">Save team</button></div>`, (root, close) => {
    $('#tm-cancel', root).onclick = close;
    $('#tm-save', root).onclick = async () => {
      const r = Object.fromEntries($$('[data-role]', root).map(s => [s.dataset.role, s.value]));
      const leads = Object.keys(r).filter(k => r[k] === 'lead');
      if (leads.length > 1) return toast('Pick only one team lead', true);
      const members = Object.keys(r).filter(k => r[k] !== 'bench');
      if (!members.length) return toast('At least one agent must be on the team', true);
      await save({ roles: r, members, chair: leads[0] || members[0] });
      close(); toast('Team saved');
    };
  });
}
