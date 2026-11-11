// Small DOM helpers shared by the ported Jarvis pages (same shapes as the former /assistant app,
// so page code stays reviewable side by side). Each page renders into a `.jx` root inside #view.
import { toast as libToast } from '../../lib.js';
import { japi, jarvisMe, fmtDate } from './api.js';

let current = null; // { root, page, params }
export const ctx = { me: null };
export const api = japi;
export const toast = (text, isErr = false) => libToast(text, isErr);
export const date = n => fmtDate(n, ctx.me?.timezone || 'Asia/Manila');
export function root() { return current.root; }

export function el(tag, text, className) { const e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; if (className) e.className = className; return e; }
export function button(text, action, style = '') {
  const b = el('button', text, style); b.type = 'button';
  b.onclick = async () => { b.disabled = true; try { await action(); } catch (e) { toast(e.message, true); } finally { b.disabled = false; } };
  return b;
}
export function card(title, description, target = current.root) {
  const c = el('section', undefined, 'jx-card'); if (title) c.append(el('h2', title)); if (description) c.append(el('p', description, 'muted'));
  target.append(c); return c;
}
export function field(form, label, name, type = 'text', value = '', required = true) {
  const l = el('label', label, 'jx-field'), input = document.createElement(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input');
  if (!['textarea', 'select'].includes(type)) input.type = type;
  input.name = name; input.value = value ?? ''; input.required = required;
  if (type === 'password') input.autocomplete = 'off';
  l.append(input); form.append(l); return input;
}
export function select(form, label, name, options, value) {
  const s = field(form, label, name, 'select');
  for (const [v, t] of options) { const o = el('option', t); o.value = v; s.append(o); }
  if (value) s.value = value; return s;
}
export function form(target, submitText, action) {
  const f = document.createElement('form'), b = el('button', submitText, 'primary'); b.type = 'submit'; f.className = 'jx-form';
  f.onsubmit = async e => { e.preventDefault(); b.disabled = true; try { await action(Object.fromEntries(new FormData(f)), f); } catch (error) { toast(error.message, true); } finally { b.disabled = false; } };
  f.addButton = () => { const a = el('div', undefined, 'jx-actions'); a.append(b); f.append(a); };
  target.append(f); return f;
}
export function item(target, title, description) {
  const d = el('div', undefined, 'jx-item'); d.append(el('h3', title)); if (description) d.append(el('p', description, 'muted'));
  target.append(d); return d;
}
export function tag(text) { const t = String(text); return el('span', t.replaceAll('_', ' '), `jx-tag ${t.replace(/[^a-z_-]/gi, '')}`); }
export function actions(target, buttons) { const d = el('div', undefined, 'jx-actions'); d.append(...buttons); target.append(d); return d; }
export function empty(target, text) { target.append(el('p', text, 'jx-empty')); }
export function grid(target = current.root) { const g = el('div', undefined, 'jx-grid'); target.append(g); return g; }
export function checkbox(target, name, label, checked = false) {
  const l = el('label', undefined, 'jx-check'), input = document.createElement('input');
  input.type = 'checkbox'; input.name = name; input.checked = !!checked; l.append(input, document.createTextNode(label)); target.append(l); return input;
}

// Dictation button for a text field (browser speech recognition where available).
let activeDictation = null;
export function voiceControls(parent, input) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const row = el('div', undefined, 'jx-voice'), status = el('span', '', 'muted'); status.setAttribute('role', 'status');
  const mic = button('🎙 Dictate', () => {
    if (activeDictation) { activeDictation.stop(); return; }
    const r = new Recognition(); activeDictation = r;
    r.lang = localStorage.getItem('jarvis-speech-language') || navigator.language || 'en-PH'; r.interimResults = false; r.continuous = false;
    r.onstart = () => { mic.textContent = '■ Stop'; status.textContent = 'Listening…'; };
    r.onresult = e => { const text = [...e.results].filter(x => x.isFinal).map(x => x[0].transcript).join(' '); input.value = (input.value + (input.value ? ' ' : '') + text).slice(0, input.maxLength > 0 ? input.maxLength : 12000); status.textContent = 'Added. Review before saving.'; };
    r.onerror = e => { status.textContent = `Microphone: ${e.error}`; };
    r.onend = () => { if (activeDictation === r) activeDictation = null; mic.textContent = '🎙 Dictate'; if (status.textContent === 'Listening…') status.textContent = ''; };
    try { r.start(); } catch (err) { activeDictation = null; status.textContent = err.message; }
  }, 'small');
  mic.disabled = !Recognition || !window.isSecureContext;
  row.append(mic, status); parent.append(row);
}

// Page runner: renders `fn` into a fresh .jx root; render() re-runs the current page.
let version = 0;
export async function mountPage(view, title, fn, params) {
  activeDictation?.abort?.(); activeDictation = null;
  const my = ++version;
  ctx.me = ctx.me || await jarvisMe();
  const page = el('div', undefined, 'jx-page');
  if (title) { const head = el('div', undefined, 'jx-head'); head.append(el('h1', title)); page.append(head); }
  const body = el('div', undefined, 'jx'); page.append(body);
  current = { root: body, fn, params, view, title };
  view.replaceChildren(page);
  try { await fn(params); }
  catch (e) { if (my === version) { body.append(el('p', e.message, 'jx-error')); toast(e.message, true); } }
}
export async function render() {
  if (!current) return;
  const { view, title, fn, params } = current;
  const y = window.scrollY;
  await mountPage(view, title, fn, params);
  window.scrollTo(0, y);
}
export function leaveJarvisPage() { version++; activeDictation?.abort?.(); activeDictation = null; current = null; }
