import { esc, toast } from '../lib.js';

export function selectedAgents(thread = {}, tools = {}) {
  const isCouncil = thread.target === 'council';
  const selected = isCouncil
    ? (thread.settings?.members?.length ? thread.settings.members : Object.keys(tools))
    : (thread.settings?.responders?.includes(thread.target) ? thread.settings.responders : [thread.target]);
  const valid = [...new Set((selected || []).filter(id => Object.hasOwn(tools, id)))];
  return valid.length ? valid : [Object.keys(tools)[0]].filter(Boolean);
}

export function selectionHtml(thread, tools) {
  const isCouncil = thread?.target === 'council';
  const selected = selectedAgents(thread, tools);
  return Object.entries(tools).map(([id, label]) => {
    const on = !isCouncil && selected.includes(id);
    return `<button type="button" data-v="${esc(id)}" class="${esc(id)} ${on ? 'on' : ''}" aria-pressed="${on}">${esc(label)}</button>`;
  }).join('')
    + `<button type="button" data-v="council" class="council ${isCouncil ? 'on' : ''}" aria-pressed="${isCouncil}" title="Debate and plan with the selected agents">Council</button>`;
}

export function bindSelection(element, thread, tools, onChange = async () => {}) {
  const validTools = Object.keys(tools || {});
  const getDirectResponders = t => {
    const list = t?.settings?.responders?.length ? t.settings.responders : (t?.target && t.target !== 'council') ? [t.target] : [];
    const valid = [...new Set(list.filter(id => Object.hasOwn(tools, id)))];
    return valid.length ? valid : [validTools[0]].filter(Boolean);
  };
  const getCouncilMembers = t => {
    const list = t?.settings?.members?.length
      ? t.settings.members
      : (t?.target === 'council' ? validTools : getDirectResponders(t));
    const valid = [...new Set(list.filter(id => Object.hasOwn(tools, id)))];
    return valid.length ? valid : [...validTools];
  };

  let council = thread?.target === 'council';
  let directResponders = getDirectResponders(thread);
  let councilMembers = getCouncilMembers(thread);
  let pending = false;

  const paint = () => element.querySelectorAll('button').forEach(b => {
    const isCouncilBtn = b.dataset.v === 'council';
    const active = isCouncilBtn ? council : (!council && directResponders.includes(b.dataset.v));
    b.classList.toggle('on', active);
    b.setAttribute('aria-pressed', String(active));
    b.disabled = pending;
  });

  const value = () => {
    const responders = [...directResponders];
    const members = [...councilMembers];
    const chair = members.includes(thread?.settings?.chair) ? thread.settings.chair : (members[0] || responders[0]);
    return {
      target: council ? 'council' : responders[0],
      settings: {
        responders,
        members,
        chair
      }
    };
  };

  element.querySelectorAll('button').forEach(b => b.onclick = async () => {
    if (pending) return;
    const previous = { directResponders: [...directResponders], councilMembers: [...councilMembers], council };
    if (b.dataset.v === 'council') {
      council = !council;
      if (council && directResponders.length) {
        councilMembers = [...directResponders];
      }
    } else {
      // User clicked an agent button
      if (council) {
        // Exit council mode immediately, selecting this agent
        council = false;
        directResponders = [b.dataset.v];
      } else if (directResponders.includes(b.dataset.v)) {
        if (directResponders.length > 1) {
          directResponders = directResponders.filter(id => id !== b.dataset.v);
        }
      } else {
        directResponders.push(b.dataset.v);
      }
    }
    pending = true;
    paint();
    try {
      await onChange(value());
    } catch (error) {
      directResponders = previous.directResponders;
      councilMembers = previous.councilMembers;
      council = previous.council;
      toast(error.message, true);
    } finally {
      pending = false;
      paint();
    }
  });

  value.sync = next => {
    if (pending) return;
    thread = next;
    council = next.target === 'council';
    if (next.target !== 'council') {
      directResponders = getDirectResponders(next);
    } else if (next.settings?.responders?.length) {
      const resp = next.settings.responders.filter(id => Object.hasOwn(tools, id));
      if (resp.length) directResponders = [...new Set(resp)];
    }
    councilMembers = getCouncilMembers(next);
    paint();
  };

  paint();
  return value;
}

export function selectionLabel(thread, tools) {
  if (thread.target === 'council') {
    const members = selectedAgents(thread, tools);
    return `Council (${members.length})`;
  }
  const responders = selectedAgents(thread, tools);
  return responders.map(id => tools[id] || id).join(' + ');
}
