import { api, esc, toast, modal, $, $$ } from '../lib.js';

async function runtimes(includeRunner = false) {
  const agents = await api('/api/members');
  return [
    ...agents.map((agent) => ({
      id: agent.id,
      label: agent.label || agent.name || agent.id,
    })),
    ...(!includeRunner
      ? [{ id: 'assistant', label: 'Personal assistant' }]
      : []),
    ...(includeRunner ? [{ id: 'runner', label: 'Runner commands' }] : []),
  ];
}
const choices = (items, selected) =>
  items
    .map(
      (item) =>
        `<label class="small"><input class="global-target" type="checkbox" value="${esc(item.id)}" ${selected.includes(item.id) ? 'checked' : ''}> ${esc(item.label)}</label>`,
    )
    .join('');
const selected = (root) =>
  $$('.global-target:checked', root).map((input) => input.value);

export async function renderVariables(box) {
  const [{ variables }, targets] = await Promise.all([
    api('/api/globals/variables'),
    runtimes(true),
  ]);
  box.innerHTML = `<div class="head"><div><h2>Global variables & secrets</h2><p class="muted">Shared across projects on this installation. Grant each variable to the agents or Runner that need it. Changes apply when a new process starts.</p></div><button id="variable-add" class="primary">＋ Add variable</button></div>
    <div class="panel list">${variables.map((v) => `<div class="item globals-item"><div><b class="mono">${esc(v.name)}</b><div class="small mono">${v.secret ? '••••••••' : esc(v.value)}</div><div class="tiny muted">${v.secret ? 'Encrypted secret' : 'Variable'} · ${v.targets.map((id) => esc(targets.find((t) => t.id === id)?.label || id)).join(', ')}</div></div><div class="row"><button data-variable-edit="${esc(v.name)}">Edit</button><button class="danger" data-variable-delete="${esc(v.name)}">Delete</button></div></div>`).join('') || '<div class="empty">No shared variables yet. Add CLOUDFLARE_API_TOKEN or another integration credential privately here.</div>'}</div>
    <p class="tiny muted">Values are encrypted at rest. Secrets are never returned in this list or inserted into prompts. The selected runtime receives the environment variable. Manage email and calendar authorization under Connections.</p>`;
  $('#variable-add', box).onclick = () =>
    variableDialog(null, targets, () => renderVariables(box));
  $$('[data-variable-edit]', box).forEach(
    (button) =>
      (button.onclick = () =>
        variableDialog(
          variables.find((v) => v.name === button.dataset.variableEdit),
          targets,
          () => renderVariables(box),
        )),
  );
  $$('[data-variable-delete]', box).forEach(
    (button) =>
      (button.onclick = async () => {
        if (!confirm(`Delete ${button.dataset.variableDelete}?`)) return;
        try {
          await api(
            '/api/globals/variables/' +
              encodeURIComponent(button.dataset.variableDelete),
            { method: 'DELETE' },
          );
          await renderVariables(box);
        } catch (error) {
          toast(error.message, true);
        }
      }),
  );
}
function variableDialog(variable, targets, reload) {
  modal(
    `<h2>${variable ? 'Edit' : 'Add'} global variable</h2><form id="variable-form" class="form-grid">
    <label class="field">Environment name<input name="name" required pattern="[A-Z][A-Z0-9_]*" value="${esc(variable?.name || '')}" ${variable ? 'readonly' : ''} placeholder="CLOUDFLARE_API_TOKEN"></label>
    <label class="field">${variable ? 'Replacement value (leave blank to keep)' : 'Value'}<input name="value" type="password" autocomplete="new-password" ${variable ? '' : 'required'} value="${esc(variable && !variable.secret ? variable.value : '')}"></label>
    <label><input name="secret" type="checkbox" ${variable?.secret !== false ? 'checked' : ''}> Secret — hide its saved value</label>
    <fieldset><legend>Available to</legend><div class="row">${choices(targets, variable?.targets || [])}</div></fieldset>
    <div class="modal-actions"><button type="button" id="variable-cancel">Cancel</button><button class="primary" type="submit">Save variable</button></div></form>`,
    (root, close) => {
      $('#variable-cancel', root).onclick = close;
      $('#variable-form', root).onsubmit = async (event) => {
        event.preventDefault();
        const f = event.target,
          button = f.querySelector('[type="submit"]');
        button.disabled = true;
        try {
          await api('/api/globals/variables', {
            method: 'POST',
            body: {
              name: f.elements.name.value,
              secret: f.elements.secret.checked,
              targets: selected(root),
              ...(f.elements.value.value
                ? { value: f.elements.value.value }
                : {}),
            },
          });
          f.elements.value.value = '';
          close();
          toast('Variable saved for new processes');
          await reload();
        } catch (error) {
          toast(error.message, true);
        } finally {
          button.disabled = false;
        }
      };
    },
  );
}
export async function renderGlobalPrompts(box) {
  const [{ prompts }, targets] = await Promise.all([
    api('/api/globals/prompts'),
    runtimes(),
  ]);
  box.innerHTML = `<div class="head"><div><h2>Global prompts</h2><p class="muted">Owner instructions shared across projects and applied on each new model turn. Toggle them without editing individual tool files.</p></div><button id="prompt-add" class="primary">＋ Add prompt</button></div>
    <div class="grid">${prompts.map((p) => `<section class="panel pad"><h3>${esc(p.title)} <span class="chip">${p.enabled ? 'On' : 'Off'}</span></h3><p class="small prompt-preview">${esc(p.content)}</p><p class="tiny muted">${p.targets.map((id) => esc(targets.find((t) => t.id === id)?.label || id)).join(', ')}</p><div class="row"><button data-prompt-edit="${esc(p.id)}">Edit</button><button data-prompt-toggle="${esc(p.id)}">${p.enabled ? 'Disable' : 'Enable'}</button><button class="danger" data-prompt-delete="${esc(p.id)}">Delete</button></div></section>`).join('') || '<div class="empty">Add your working preferences, writing style or project-independent instructions.</div>'}</div>`;
  $('#prompt-add', box).onclick = () =>
    promptDialog(null, targets, () => renderGlobalPrompts(box));
  $$('[data-prompt-edit]', box).forEach(
    (button) =>
      (button.onclick = () =>
        promptDialog(
          prompts.find((p) => p.id === button.dataset.promptEdit),
          targets,
          () => renderGlobalPrompts(box),
        )),
  );
  $$('[data-prompt-toggle]', box).forEach(
    (button) =>
      (button.onclick = async () => {
        const p = prompts.find((p) => p.id === button.dataset.promptToggle);
        try {
          await api('/api/globals/prompts', {
            method: 'POST',
            body: { ...p, enabled: !p.enabled },
          });
          await renderGlobalPrompts(box);
        } catch (error) {
          toast(error.message, true);
        }
      }),
  );
  $$('[data-prompt-delete]', box).forEach(
    (button) =>
      (button.onclick = async () => {
        if (!confirm('Delete this prompt?')) return;
        try {
          await api(
            '/api/globals/prompts/' +
              encodeURIComponent(button.dataset.promptDelete),
            { method: 'DELETE' },
          );
          await renderGlobalPrompts(box);
        } catch (error) {
          toast(error.message, true);
        }
      }),
  );
}
function promptDialog(prompt, targets, reload) {
  modal(
    `<h2>${prompt ? 'Edit' : 'Add'} global prompt</h2><form id="global-prompt-form" class="form-grid"><label class="field">Title<input name="title" maxlength="160" required value="${esc(prompt?.title || '')}"></label><label class="field">Instructions<textarea name="content" rows="8" maxlength="12000" required>${esc(prompt?.content || '')}</textarea></label><label><input name="enabled" type="checkbox" ${prompt?.enabled !== false ? 'checked' : ''}> Enabled</label><fieldset><legend>Apply to</legend><div class="row">${choices(targets, prompt?.targets || targets.map((t) => t.id))}</div></fieldset><p class="tiny muted">Store API keys in Variables & secrets.</p><div class="modal-actions"><button type="button" id="prompt-cancel">Cancel</button><button type="submit" class="primary">Save prompt</button></div></form>`,
    (root, close) => {
      $('#prompt-cancel', root).onclick = close;
      $('#global-prompt-form', root).onsubmit = async (event) => {
        event.preventDefault();
        const f = event.target,
          button = f.querySelector('[type="submit"]');
        button.disabled = true;
        try {
          await api('/api/globals/prompts', {
            method: 'POST',
            body: {
              ...(prompt ? { id: prompt.id } : {}),
              title: f.elements.title.value,
              content: f.elements.content.value,
              enabled: f.elements.enabled.checked,
              targets: selected(root),
            },
          });
          close();
          toast('Prompt saved');
          await reload();
        } catch (error) {
          toast(error.message, true);
        } finally {
          button.disabled = false;
        }
      };
    },
  );
}
