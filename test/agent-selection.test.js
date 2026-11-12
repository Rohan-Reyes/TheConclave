import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedAgents,selectionLabel,selectionHtml,bindSelection} from '../public/views/selection.js';
const tools={claude:'Claude',codex:'Codex',antigravity:'Antigravity'};
test('selection represents solo, combinations, council subsets and a target switched outside an old combination',()=>{
  assert.deepEqual(selectedAgents({target:'codex'},tools),['codex']);
  assert.deepEqual(selectedAgents({target:'codex',settings:{responders:['codex','claude','codex']}},tools),['codex','claude']);
  assert.equal(selectionLabel({target:'codex',settings:{responders:['codex','claude']}},tools),'Codex + Claude');
  assert.deepEqual(selectedAgents({target:'council',settings:{members:['claude','codex']}},tools),['claude','codex']);
  assert.deepEqual(selectedAgents({target:'codex',settings:{responders:['claude']}},tools),['codex']);
});

test('selectionHtml lights only council when active, and only selected agents when direct',()=>{
  const councilHtml = selectionHtml({target:'council',settings:{members:['claude','codex']}},tools);
  assert.match(councilHtml, /class="council on"/);
  assert.match(councilHtml, /data-v="council"[^>]*aria-pressed="true"/);
  assert.doesNotMatch(councilHtml, /data-v="claude"[^>]*class="[^"]*\bon\b/);
  assert.doesNotMatch(councilHtml, /data-v="codex"[^>]*class="[^"]*\bon\b/);
  assert.match(councilHtml, /data-v="claude"[^>]*aria-pressed="false"/);

  const directHtml = selectionHtml({target:'codex',settings:{responders:['codex','claude']}},tools);
  assert.match(directHtml, /class="council "/);
  assert.match(directHtml, /data-v="council"[^>]*aria-pressed="false"/);
  assert.match(directHtml, /data-v="codex"[^>]*class="[^"]*\bon\b/);
  assert.match(directHtml, /data-v="claude"[^>]*class="[^"]*\bon\b/);
  assert.doesNotMatch(directHtml, /data-v="antigravity"[^>]*class="[^"]*\bon\b/);
});

test('bindSelection toggles council as sole active, clicking agent exits council and preserves members',async ()=>{
  const buttons = ['claude','codex','antigravity','council'].map(id => {
    const classes = new Set();
    const attrs = {};
    return {
      dataset: { v: id },
      classList: {
        toggle(cls, on) { if (on) classes.add(cls); else classes.delete(cls); },
        contains(cls) { return classes.has(cls); }
      },
      setAttribute(k, v) { attrs[k] = String(v); },
      getAttribute(k) { return attrs[k]; },
      disabled: false,
      onclick: null
    };
  });
  const root = {
    querySelectorAll: sel => sel === 'button' ? buttons : []
  };

  let thread = {
    target: 'council',
    settings: { members: ['claude', 'codex'], responders: ['antigravity'], chair: 'claude' }
  };
  let lastSaved = null;
  const syncChange = async val => { lastSaved = val; };

  const control = bindSelection(root, thread, tools, syncChange);
  const byId = id => buttons.find(b => b.dataset.v === id);

  // 1. In council mode, ONLY council button is on and aria-pressed="true"
  assert.equal(byId('council').classList.contains('on'), true);
  assert.equal(byId('council').getAttribute('aria-pressed'), 'true');
  assert.equal(byId('claude').classList.contains('on'), false);
  assert.equal(byId('codex').classList.contains('on'), false);
  assert.equal(byId('antigravity').classList.contains('on'), false);

  // 2. Click an agent button ('codex'): exits council mode, lights codex only, preserves council members
  await byId('codex').onclick();
  assert.equal(byId('council').classList.contains('on'), false);
  assert.equal(byId('council').getAttribute('aria-pressed'), 'false');
  assert.equal(byId('codex').classList.contains('on'), true);
  assert.equal(byId('codex').getAttribute('aria-pressed'), 'true');
  assert.equal(byId('claude').classList.contains('on'), false);

  assert.equal(lastSaved.target, 'codex');
  assert.deepEqual(lastSaved.settings.responders, ['codex']);
  assert.deepEqual(lastSaved.settings.members, ['claude', 'codex']); // preserved!

  // 3. Click council button: enters council mode with the direct selection
  await byId('council').onclick();
  assert.equal(byId('council').classList.contains('on'), true);
  assert.equal(byId('codex').classList.contains('on'), false);
  assert.equal(lastSaved.target, 'council');
  assert.deepEqual(lastSaved.settings.responders, ['codex']);
  assert.deepEqual(lastSaved.settings.members, ['codex']);
});

test('bindSelection on new chat syncs council members from direct selection when toggling council',async ()=>{
  const buttons = ['claude','codex','antigravity','council'].map(id => {
    const classes = new Set();
    const attrs = {};
    return {
      dataset: { v: id },
      classList: {
        toggle(cls, on) { if (on) classes.add(cls); else classes.delete(cls); },
        contains(cls) { return classes.has(cls); }
      },
      setAttribute(k, v) { attrs[k] = String(v); },
      getAttribute(k) { return attrs[k]; },
      disabled: false,
      onclick: null
    };
  });
  const root = { querySelectorAll: sel => sel === 'button' ? buttons : [] };
  const byId = id => buttons.find(b => b.dataset.v === id);

  let lastSaved = null;
  // New chat with single agent selected (e.g. claude default)
  const control = bindSelection(root, { target: 'claude' }, tools, async val => { lastSaved = val; });

  assert.equal(byId('claude').classList.contains('on'), true);
  assert.equal(byId('council').classList.contains('on'), false);

  // User selects codex as well (claude + codex)
  await byId('codex').onclick();
  assert.deepEqual(lastSaved.settings.responders, ['claude', 'codex']);

  // User toggles Council: council members must sync to ['claude', 'codex'], NOT all tools
  await byId('council').onclick();
  assert.equal(byId('council').classList.contains('on'), true);
  assert.equal(byId('claude').classList.contains('on'), false);
  assert.equal(byId('codex').classList.contains('on'), false);
  assert.equal(lastSaved.target, 'council');
  assert.deepEqual(lastSaved.settings.members, ['claude', 'codex']);
});
