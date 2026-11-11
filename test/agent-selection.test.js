import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedAgents,selectionLabel} from '../public/views/selection.js';
const tools={claude:'Claude',codex:'Codex',antigravity:'Antigravity'};
test('selection represents solo, combinations, council subsets and a target switched outside an old combination',()=>{
  assert.deepEqual(selectedAgents({target:'codex'},tools),['codex']);
  assert.deepEqual(selectedAgents({target:'codex',settings:{responders:['codex','claude','codex']}},tools),['codex','claude']);
  assert.equal(selectionLabel({target:'codex',settings:{responders:['codex','claude']}},tools),'Codex + Claude');
  assert.deepEqual(selectedAgents({target:'council',settings:{members:['claude','codex']}},tools),['claude','codex']);
  assert.deepEqual(selectedAgents({target:'codex',settings:{responders:['claude']}},tools),['codex']);
});
