import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {agentAvatar} from '../public/views/agent-avatar.js';

test('agent circles use bundled logos, with escaped initials for unknown agents',()=>{
  for(const [id,asset] of Object.entries({claude:'claude',codex:'openai',antigravity:'antigravity',copilot:'githubcopilot',gemini:'gemini',ollama:'ollama',qwen:'qwen'})) {
    assert.match(agentAvatar(id,id),new RegExp(`/brand/${asset}\\.svg`));
    const path=new URL(`../public/brand/${asset}.svg`,import.meta.url);assert.ok(existsSync(path));assert.match(readFileSync(path,'utf8'),/<svg/);
  }
  assert.match(agentAvatar('custom','<Example'),/&lt;/);assert.doesNotMatch(agentAvatar('constructor','Unknown'),/<img/);
});
