// Calls the Jarvis assistant API mounted at /assistant/api (same Conclave login).
export async function japi(path, data, method = data === undefined ? 'GET' : 'POST') {
  const res = await fetch(`/assistant/api${path}`, {
    method, credentials: 'same-origin',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await res.json().catch(() => ({}));
  if (res.status === 401) { location.replace('/login'); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
  return result;
}

let mePromise;
export const jarvisMe = () => (mePromise ||= japi('/me').catch(e => { mePromise = null; throw e; }));

export function fmtDate(n, timezone) {
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone || undefined }).format(new Date(n)); }
  catch { return new Date(n).toLocaleString(); }
}

// Browser speech recognition (where supported). Returns null when unavailable.
export function dictation(onText, onState) {
  const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
  if (!SR) return null;
  let rec = null;
  return {
    get active() { return !!rec; },
    toggle() {
      if (rec) { rec.stop(); return; }
      rec = new SR(); rec.interimResults = false; rec.continuous = false; rec.lang = navigator.language || 'en-US';
      rec.onresult = e => onText([...e.results].map(r => r[0].transcript).join(' '));
      rec.onend = rec.onerror = () => { rec = null; onState(false); };
      rec.start(); onState(true);
    },
    stop() { rec?.abort(); rec = null; },
  };
}
