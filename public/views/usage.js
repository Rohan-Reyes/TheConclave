import { api, esc, badge, ago, toast, $, $$ } from '../lib.js';
import { copilotUsageText } from './plan.js';

const SERIES = [
  { id: 'claude', label: 'Claude Code', v: '--s-claude' },
  { id: 'antigravity', label: 'Antigravity', v: '--s-antigravity' },
  { id: 'codex', label: 'Codex', v: '--s-codex' },
];
const fmt = n => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n || 0));
const money = n => n ? '$' + (n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString()) : '—';
const secs = ms => !ms ? '—' : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round(ms % 60000 / 1000)}s`;

export async function renderUsage(view, params) {
  const days = Number(params.get('days')) || 30;
  const u = await api('/api/usage?days=' + days);
  const tot = Object.fromEntries(u.totals.map(t => [t.tool, t]));
  const allTokens = u.totals.reduce((a, t) => a + (t.tin || 0) + (t.tout || 0), 0);
  const claudeCost = tot.claude?.cost || 0;
  const conclaveReplies = Object.values(u.conclave).reduce((a, c) => a + c.replies, 0);

  view.innerHTML = `
    <div class="head">
      <div><h1>Usage</h1><div class="muted">Tokens and cost from each tool's own history, plus replies run through Conclave</div></div>
      <div class="seg" id="range">${[7, 30, 90].map(d => `<button data-d="${d}" class="${d === days ? 'on' : ''}">${d} days</button>`).join('')}</div>
    </div>
    <div class="grid tiles">
      <div class="panel stat"><span class="muted small">Tokens, all tools</span><b>${fmt(allTokens)}</b><span class="muted tiny">${u.totals.reduce((a, t) => a + t.sessions, 0)} sessions</span></div>
      <div class="panel stat"><span class="muted small">Claude Code cost</span><b>${money(claudeCost)}</b><span class="muted tiny">as reported by Claude Code</span></div>
      <div class="panel stat"><span class="muted small">Conclave replies</span><b>${conclaveReplies}</b><span class="muted tiny">${secs(Object.values(u.conclave).reduce((a, c) => a + c.ms, 0))} of agent time</span></div>
    </div>

    <div class="row" style="justify-content:space-between;align-items:center;margin-top:18px">
      <h2 style="margin:0">Plan limits</h2>
      <button class="small" id="agy-refresh" title="Opens Antigravity in the background and reads its /usage screen">↻ Refresh Antigravity /usage</button>
    </div>
    <div class="grid" id="limits" style="margin-top:10px"><div class="panel pad muted small">Loading…</div></div>

    <div class="panel pad" style="margin-top:14px">
      <div class="row" style="justify-content:space-between;align-items:center">
        <h3 style="margin:0">Tokens per day</h3>
        <div class="row" style="align-items:center;gap:14px">
          <div class="legend">${SERIES.map(s => `<span><i style="background:var(${s.v})"></i>${s.label}</span>`).join('')}</div>
          <button class="small" id="as-table">Table view</button>
        </div>
      </div>
      <div class="chart" id="chart"></div>
      <div id="chart-table" hidden></div>
      <div class="muted tiny">Each session is counted on the day it started. Antigravity doesn't record token counts in its history, so only its Conclave replies are counted below.</div>
    </div>

    <div class="split" style="margin-top:4px">
      <div>
        <h2>By tool (history)</h2>
        <div class="panel scroll-x"><table class="matrix">
          <tr><th>Tool</th><th class="r">Sessions</th><th class="r">Input</th><th class="r">Output</th><th class="r">Cost</th></tr>
          ${SERIES.map(s => { const t = tot[s.id] || {}; return `<tr><td>${badge(s.id)}</td><td class="r">${t.sessions || 0}</td><td class="r">${fmt(t.tin)}</td><td class="r">${fmt(t.tout)}</td><td class="r">${s.id === 'claude' ? money(t.cost) : '—'}</td></tr>`; }).join('')}
        </table></div>
        <h2>Biggest sessions</h2>
        <div class="panel list">${u.top.filter(c => c.tin + c.tout > 0).map(c => `
          <a class="item" href="#/chat/${encodeURIComponent(c.id)}">${badge(c.tool)}
            <div style="min-width:0"><div class="title">${esc(c.title)}</div><div class="sub">${ago(c.updated)}</div></div>
            <span class="small r"><b>${fmt(c.tin + c.tout)}</b>${c.cost ? `<br><span class="muted tiny">${money(c.cost)}</span>` : ''}</span></a>`).join('') || '<div class="empty small">No token data yet.</div>'}
        </div>
      </div>
      <div>
        <h2>Conclave runs</h2>
        <div class="panel scroll-x"><table class="matrix">
          <tr><th>Agent</th><th class="r">Replies</th><th class="r">Tokens</th><th class="r">Avg time</th></tr>
          ${Object.entries(u.conclave).map(([k, c]) => `<tr><td>${badge(k)}</td><td class="r">${c.replies}</td><td class="r">${fmt(c.tin + c.tout + c.cached)}</td><td class="r">${secs(c.ms / c.replies)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted small">No Conclave replies in this range.</td></tr>'}
        </table></div>
        <h2>Costliest Conclave chats</h2>
        <div class="panel list">${u.threads.map(t => `
          <a class="item" href="#/hub/${t.id}"><span class="chip">${t.replies}</span>
            <div style="min-width:0"><div class="title">${esc(t.title)}</div><div class="sub">${secs(t.ms)} agent time</div></div>
            <span class="small r"><b>${fmt(t.tokens)}</b>${t.cost ? `<br><span class="muted tiny">${money(t.cost)}</span>` : ''}</span></a>`).join('') || '<div class="empty small">None yet.</div>'}
        </div>
      </div>
    </div>`;

  $$('#range button').forEach(b => b.onclick = () => { location.hash = '#/usage?days=' + b.dataset.d; });
  const refreshAgy = async () => {
    const b = $('#agy-refresh'); if (!b) return;
    b.disabled = true; b.textContent = 'Reading Antigravity /usage…';
    try { await api('/api/limits/antigravity', { method: 'POST', body: {} }); } catch (e) { toast(e.message, true); }
    if (!$('#agy-refresh')) return;
    b.disabled = false; b.textContent = '↻ Refresh Antigravity /usage';
    drawLimits(...await loadLimits());
  };
  $('#agy-refresh').onclick = refreshAgy;
  loadLimits().then(([l, cr, members]) => {
    drawLimits(l, cr, members);
  });
  drawChart(u.history, days);
  $('#as-table').onclick = () => {
    const t = $('#chart-table'), c = $('#chart');
    const show = t.hidden;
    t.hidden = !show; c.hidden = show;
    $('#as-table').textContent = show ? 'Chart view' : 'Table view';
  };
}

function drawChart(rows, days) {
  // One bucket per day, stacked by tool in a fixed order.
  const byDay = new Map();
  for (let i = days - 1; i >= 0; i--) byDay.set(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10), {});
  for (const r of rows) if (byDay.has(r.day)) byDay.get(r.day)[r.tool] = (r.tin || 0) + (r.tout || 0);
  const data = [...byDay.entries()].map(([day, v]) => ({ day, v, total: SERIES.reduce((a, s) => a + (v[s.id] || 0), 0) }));
  const max = Math.max(1, ...data.map(d => d.total));
  const box = $('#chart');
  const W = Math.max(320, box.clientWidth || 900), H = 220, L = 46, B = 22, T = 8;
  const step = (W - L - 4) / data.length;
  const bw = Math.max(3, Math.min(28, step - 4));
  const y = v => T + (H - T - B) * (1 - v / max);
  const ticks = [0, max / 2, max];
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Tokens per day by tool">`;
  for (const t of ticks) svg += `<line x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}" class="grid-line"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end" class="axis">${fmt(t)}</text>`;
  data.forEach((d, i) => {
    const x = L + i * step + (step - bw) / 2;
    let acc = 0;
    const segs = SERIES.filter(s => d.v[s.id]);
    segs.forEach((s, k) => {
      const v = d.v[s.id];
      const y0 = y(acc), y1 = y(acc + v);
      const h = Math.max(1, y0 - y1 - (k < segs.length - 1 ? 2 : 0));   // 2px gap between stacked fills
      const top = k === segs.length - 1;
      svg += top
        ? `<path d="M${x},${y0 - h + 4} q0,-4 4,-4 h${bw - 8} q4,0 4,4 v${h - 4} h${-bw}z" fill="var(${s.v})"/>`
        : `<rect x="${x}" y="${y0 - h}" width="${bw}" height="${h}" fill="var(${s.v})"/>`;
      acc += v;
    });
    svg += `<rect class="hit" x="${L + i * step}" y="${T}" width="${step}" height="${H - T - B}" data-i="${i}" tabindex="0"/>`;
    if (i % Math.ceil(data.length / 8) === 0) svg += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" class="axis">${d.day.slice(5)}</text>`;
  });
  svg += '</svg><div class="tip" hidden></div>';
  box.innerHTML = svg;
  const tip = $('.tip', box);
  const show = (el) => {
    const d = data[el.dataset.i];
    tip.innerHTML = '';
    const h = document.createElement('div'); h.className = 'tiny muted'; h.textContent = new Date(d.day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); tip.append(h);
    for (const s of SERIES) {
      const row = document.createElement('div'); row.className = 'tip-row';
      row.innerHTML = `<i style="background:var(${s.v})"></i>`;
      const b = document.createElement('b'); b.textContent = fmt(d.v[s.id] || 0);
      const l = document.createElement('span'); l.textContent = s.label;
      row.append(b, l); tip.append(row);
    }
    tip.hidden = false;
    const r = el.getBoundingClientRect(), br = box.getBoundingClientRect();
    tip.style.left = Math.min(br.width - 170, Math.max(0, r.left - br.left + r.width / 2 - 80)) + 'px';
    el.classList.add('on');
  };
  const hide = el => { tip.hidden = true; el.classList.remove('on'); };
  box.querySelectorAll('.hit').forEach(el => {
    el.addEventListener('pointerenter', () => show(el)); el.addEventListener('pointerleave', () => hide(el));
    el.addEventListener('focus', () => show(el)); el.addEventListener('blur', () => hide(el));
  });
  $('#chart-table').innerHTML = `<div class="scroll-x" style="max-height:320px;overflow-y:auto"><table class="matrix"><tr><th>Day</th>${SERIES.map(s => `<th class="r">${s.label}</th>`).join('')}<th class="r">Total</th></tr>
    ${data.filter(d => d.total).reverse().map(d => `<tr><td>${d.day}</td>${SERIES.map(s => `<td class="r">${fmt(d.v[s.id] || 0)}</td>`).join('')}<td class="r"><b>${fmt(d.total)}</b></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No data</td></tr>'}</table></div>`;
}

// One meter per limit window. "used" is shown for every tool so they compare directly.
export const meter = (label, usedPct, note) => {
  if (!(typeof usedPct === 'number' || typeof usedPct === 'string' && usedPct.trim() !== '') || !Number.isFinite(Number(usedPct))) return `<div class="tiny muted">${esc(label)} usage unknown</div>`;
  usedPct = Math.min(100, Math.max(0, Number(usedPct)));
  return `
  <div class="meter-row"><span class="tiny">${esc(label)}</span>
    <div class="meter ${usedPct >= 90 ? 'hot' : usedPct >= 70 ? 'warm' : ''}" role="meter" aria-label="${esc(label)} used" aria-valuenow="${Math.round(usedPct)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.min(100, Math.max(0, usedPct))}%"></i></div>
    <b class="small">${Math.round(usedPct)}%</b></div>
  ${note ? `<div class="tiny muted" style="margin:-2px 0 4px 60px">${esc(note)}</div>` : ''}`;
};
const until = ms => { if (!ms) return ''; const m = Math.max(0, Math.round((ms - Date.now()) / 60000)); return m >= 1440 ? `resets in ${Math.floor(m / 1440)}d ${Math.floor(m % 1440 / 60)}h` : `resets in ${Math.floor(m / 60)}h ${m % 60}m`; };

const loadLimits = () => Promise.all([api('/api/limits'), api('/api/credits').catch(() => ({})), api('/api/members').catch(() => [])]);
const outNote = (cr, tool, now) => Number(cr?.[tool]?.until) > now ? `<div class="out-note">⏸ Out of credits until ${new Date(cr[tool].until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}. Turns go to the next agent. <button class="small" data-clear="${tool}">Mark available</button></div>` : '';

function drawLimits(l, cr = {}, members = []) {
  const box = $('#limits'); if (!box) return;
  if (!box.dataset.bound) {
    box.dataset.bound = 1;
    box.addEventListener('click', async e => {
      const b = e.target.closest('[data-clear]'); if (!b) return;
      await api(`/api/credits/${b.dataset.clear}/clear`, { method: 'POST', body: {} });
      toast('Marked as available'); drawLimits(...await loadLimits());
    });
  }
  box.innerHTML = renderLimitCards(l, cr, Date.now(), members);
}

export function renderLimitCards(l, cr = {}, now = Date.now(), members = []) {
  const active = (w, scale = 1) => w && (w.resetsAt === null || w.resetsAt === undefined || Number(w.resetsAt) * scale > now);
  const cards = [];
  const c = l.claude, w = c?.unifiedWindows || {};
  cards.push(`<div class="panel pad limit-card"><h3>${badge('claude')}<span class="tiny muted">${c ? 'seen ' + ago(c.seen) : ''}</span></h3>${outNote(cr, 'claude', now)}
    ${c ? [['five_hour', '5-hour'], ['seven_day', 'Weekly']].filter(([k]) => active(w[k], 1000)).map(([k, lab]) => meter(lab, w[k].utilization * 100, until(w[k].resetsAt * 1000))).join('') || '<div class="tiny muted">No current limit window. Refresh usage after the next run.</div>'
      : '<div class="small muted">Appears after Claude runs once in Conclave.</div>'}</div>`);
  const a = l.antigravity;
  cards.push(`<div class="panel pad limit-card"><h3>${badge('antigravity')}<span class="tiny muted">${l.antigravityRefreshing ? 'refreshing…' : a ? 'seen ' + ago(a.seen) : ''}</span></h3>${outNote(cr, 'antigravity', now)}
    ${a ? a.groups.map(g => `<div class="tiny" style="font-weight:600;margin-top:4px">${esc(g.name)} <span class="muted" style="font-weight:400">${esc(g.models)}</span></div>
      ${g.windows.filter(x => active(x)).map(x => meter(x.window === 'weekly' ? 'Weekly' : '5-hour', 100 - x.remainingPct, x.resetsAt ? until(x.resetsAt) : x.refresh ? `refreshes in ${x.refresh}` : '')).join('')}`).join('')
      : '<div class="small muted">Not read yet. Click Refresh to read agy /usage.</div>'}</div>`);
  const x = l.codex;
  const lab = w2 => w2.windowMin >= 10000 ? 'Weekly' : w2.windowMin >= 280 ? '5-hour' : `${w2.windowMin}m`;
  cards.push(`<div class="panel pad limit-card"><h3>${badge('codex')}<span class="tiny muted">${x ? 'seen ' + ago(x.seen) : ''}</span></h3>${outNote(cr, 'codex', now)}
    ${x ? [x.primary, x.secondary].filter(w2 => active(w2)).map(w2 => meter(lab(w2), w2.usedPct, until(w2.resetsAt))).join('') || '<div class="tiny muted">No current limit window. Refresh usage after the next run.</div>'
      : '<div class="small muted">Appears after Codex runs once.</div>'}</div>`);
  if (l.copilot || members.some(m => (typeof m === 'string' ? m : m.id) === 'copilot')) cards.push(`<div class="panel pad limit-card"><h3>${badge('copilot')}</h3>${outNote(cr, 'copilot', now)}
    <div class="small">${esc(copilotUsageText(l.copilot))}</div>
    ${l.copilot?.tokens ? `<div class="tiny muted">${['input', 'output'].filter(key => Number.isFinite(l.copilot.tokens[key]?.tokenCount)).map(key => `${fmt(l.copilot.tokens[key].tokenCount)} ${key} tokens`).join(' · ')}</div>` : ''}
    <div class="tiny muted" style="margin-top:4px">Latest recorded session only; account allowance and billing-period totals are unknown.</div>
  </div>`);
  return cards.join('');
}
