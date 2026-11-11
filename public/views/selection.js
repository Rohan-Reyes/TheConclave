import { esc, toast } from '../lib.js';

export function selectedAgents(thread = {}, tools = {}) {
  const selected = thread.target === 'council' ? thread.settings?.members : thread.settings?.responders?.includes(thread.target) ? thread.settings.responders : [thread.target];
  const valid = [...new Set((selected || []).filter(id => Object.hasOwn(tools, id)))];
  return valid.length ? valid : [Object.keys(tools)[0]].filter(Boolean);
}

export function selectionHtml(thread, tools) {
  const selected = selectedAgents(thread, tools);
  return Object.entries(tools).map(([id,label]) => `<button type="button" data-v="${esc(id)}" class="${esc(id)} ${selected.includes(id) ? 'on' : ''}" aria-pressed="${selected.includes(id)}">${esc(label)}</button>`).join('')
    + `<button type="button" data-v="council" class="council ${thread?.target === 'council' ? 'on' : ''}" aria-pressed="${thread?.target === 'council'}" title="Debate and plan with the selected agents">Council</button>`;
}

export function bindSelection(element, thread, tools, onChange = async () => {}) {
  let selected = selectedAgents(thread, tools), council = thread?.target === 'council', pending = false;
  const paint = () => element.querySelectorAll('button').forEach(b => {
    const active = b.dataset.v === 'council' ? council : selected.includes(b.dataset.v);
    b.classList.toggle('on', active); b.setAttribute('aria-pressed', String(active)); b.disabled = pending;
  });
  const value = () => ({target: council ? 'council' : selected[0], settings:{responders:[...selected],members:[...selected],chair:selected.includes(thread?.settings?.chair) ? thread.settings.chair : selected[0]}});
  element.querySelectorAll('button').forEach(b => b.onclick = async () => {
    if (pending) return;
    const previous = {selected:[...selected],council};
    if (b.dataset.v === 'council') council = !council;
    else if (selected.includes(b.dataset.v)) { if (selected.length > 1) selected = selected.filter(id => id !== b.dataset.v); }
    else selected.push(b.dataset.v);
    pending = true; paint();
    try { await onChange(value()); } catch (error) { selected=previous.selected;council=previous.council; toast(error.message,true); }
    finally {pending=false;paint();}
  });
  value.sync = next => { if(pending)return; thread=next; selected=selectedAgents(next,tools);council=next.target==='council';paint(); };
  paint();return value;
}

export function selectionLabel(thread, tools) {
  const selected=selectedAgents(thread,tools);
  return thread.target==='council' ? `Council (${selected.length})` : selected.map(id=>tools[id]).join(' + ');
}
