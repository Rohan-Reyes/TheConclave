// What to do when an agent runs out of credits / hits a rate limit.
//  1. Recognise quota errors from each CLI.
//  2. Remember the agent is out until its reset time (from the error, or the plan limits).
//  3. Callers try the next agent in the chat's fallback order instead.
import { kvGet, kvSet, getDb } from '../db.js';
import { getLimits } from './catalog.js';

const QUOTA_RE = /usage limit|rate.?limit|quota|exhausted|out of (credits|usage|tokens)|insufficient|credit balance|limit (reached|exceeded)|exceeded your|too many requests|\b429\b|billing|resource_exhausted|upgrade (your )?plan|try again (at|in|later)/i;
const NOT_QUOTA_RE = /context (length|window)|maximum context|prompt is too long|max_tokens/i;
const LAUNCH_ERROR_RE = /spawn .*ENOENT|executable not found|could not start|not recognized as an internal or external command/i;

export function isLaunchError(text) {
  return LAUNCH_ERROR_RE.test(String(text || ''));
}

export function exhaustionSummary(allExhausted, outNotes = []) {
  const notesStr = outNotes.length ? ` ${outNotes.join('; ')}.` : '';
  if (allExhausted) return `All agents are out of credits right now.${notesStr}`;
  return `Some agents are unavailable or encountered errors.${notesStr}`;
}

export function isQuotaError(text) {
  const t = String(text || '');
  return QUOTA_RE.test(t) && !NOT_QUOTA_RE.test(t) && !LAUNCH_ERROR_RE.test(t);
}

// Best guess for when the agent can work again.
function resetFromError(text) {
  const t = String(text || '');
  const epoch = t.match(/\|(\d{10})\b/) || t.match(/reset[^0-9]{0,20}(\d{10})\b/i);
  if (epoch) return Number(epoch[1]) * 1000;
  const rel = t.match(/in (?:about )?(\d+)\s*(h|hour|hours|m|min|minutes)\b/i);
  if (rel) return Date.now() + Number(rel[1]) * (/^h/i.test(rel[2]) ? 3600_000 : 60_000);
  return null;
}

function resetFromLimits(tool) {
  try {
    const l = getLimits();
    if (tool === 'claude' && l.claude) {
      const w = Object.values(l.claude.unifiedWindows || {}).filter(x => x.utilization >= 0.99 && x.resetsAt);
      const t = w.length ? Math.max(...w.map(x => x.resetsAt)) : l.claude.resetsAt;
      return t ? t * 1000 : null;
    }
    if (tool === 'codex' && l.codex) {
      const w = [l.codex.primary, l.codex.secondary].filter(x => x && x.usedPct >= 99 && x.resetsAt);
      return w.length ? Math.max(...w.map(x => x.resetsAt)) : null;
    }
    if (tool === 'antigravity' && l.antigravity) {
      const seen = new Date(l.antigravity.seen).getTime();
      const toMs = s => { const h = s.match(/(\d+)h/), m = s.match(/(\d+)m/), d = s.match(/(\d+)d/); return ((d ? +d[1] * 24 : 0) + (h ? +h[1] : 0)) * 3600_000 + (m ? +m[1] * 60_000 : 0); };
      const w = l.antigravity.groups.flatMap(g => g.windows).filter(x => x.remainingPct <= 1 && x.refresh);
      return w.length ? Math.min(...w.map(x => seen + toMs(x.refresh))) : null;
    }
  } catch {}
  return null;
}

export function markExhausted(tool, errorText) {
  const until = resetFromError(errorText) || resetFromLimits(tool) || Date.now() + 60 * 60_000;
  kvSet(`exhausted:${tool}`, { until, reason: String(errorText || '').slice(0, 300) });
  return until;
}

export function clearExhausted(tool) { getDb().prepare('DELETE FROM kv WHERE k = ?').run(`exhausted:${tool}`); }

// Returns null if usable, or { until, reason } if the agent is out right now.
export function outOfCredits(tool) {
  const e = kvGet(`exhausted:${tool}`)?.value;
  if (e && e.until > Date.now()) return e;
  // Proactive: the live limits already say 100% used.
  try {
    const l = getLimits();
    if (tool === 'claude' && l.claude) {
      const full = Object.values(l.claude.unifiedWindows || {}).find(x => x.utilization >= 1 && x.resetsAt * 1000 > Date.now());
      if (full || (l.claude.status === 'rejected' && l.claude.resetsAt * 1000 > Date.now())) return { until: (full?.resetsAt || l.claude.resetsAt) * 1000, reason: 'Claude plan limit reached' };
    }
    if (tool === 'codex' && l.codex) {
      const full = [l.codex.primary, l.codex.secondary].find(x => x && x.usedPct >= 100 && x.resetsAt > Date.now());
      if (full) return { until: full.resetsAt, reason: 'Codex plan limit reached' };
    }
  } catch {}
  return null;
}

export function creditStatus(ids) {
  return Object.fromEntries(ids.map(id => [id, outOfCredits(id)]));
}

// Antigravity has separate quota buckets: Gemini models vs Claude/GPT models.
// When one bucket is empty, the other may still work.
export function otherAgyBucket(currentModel) {
  return /claude|gpt/i.test(currentModel || '') ? 'Gemini 3.8 Flash (Medium)' : 'Claude Sonnet 5.5 (Medium)';
}

export const fmtTime = ms => new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
