import { esc } from '../lib.js';

const LOGOS = Object.freeze({
  claude: 'claude', anthropic: 'claude',
  codex: 'openai', openai: 'openai', chatgpt: 'openai',
  antigravity: 'antigravity', agy: 'antigravity',
  copilot: 'githubcopilot', 'github-copilot': 'githubcopilot',
  gemini: 'gemini', google: 'gemini',
  ollama: 'ollama', qwen: 'qwen',
});

export function agentAvatar(id, label = id, small = false) {
  const brand = String(id).replace(/-(?:cli|code)$/, '');
  const logo = Object.hasOwn(LOGOS, brand) ? LOGOS[brand] : null;
  return `<span class="av ${small ? 'sm' : ''} ${esc(id)} ${logo ? 'brand-avatar' : ''}" aria-hidden="true">${logo
    ? `<img class="agent-logo" src="/brand/${logo}.svg" width="16" height="16" alt="" draggable="false">`
    : esc(String(label || '?')[0].toUpperCase())}</span>`;
}
