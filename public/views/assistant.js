const pages = {management:'management',mind:'dashboard',connectors:'connections',automations:'tasks',telegram:'telegram','assistant-notes':'notes','assistant-inbox':'inbox','assistant-settings':'settings'};
let cleanup;
export function leaveAssistant() { cleanup?.(); cleanup = null; }
export async function renderAssistant(root, params, route) {
  const frame = document.createElement('iframe');
  frame.className = 'assistant-frame'; frame.title = 'Jarvis · Conclave';
  frame.allow = 'microphone; autoplay';
  frame.src = `/assistant/?embedded=1#${pages[route] || 'management'}`;
  root.replaceChildren(frame);
  const listener = event => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== 'conclave-assistant-route') return;
    const target = Object.keys(pages).find(key => pages[key] === event.data.page);
    if (target && location.hash !== '#/'+target) location.hash = '/'+target;
  };
  window.addEventListener('message', listener);
  cleanup = () => window.removeEventListener('message', listener);
}
