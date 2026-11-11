// Jarvis Connectors, Devices and assistant Settings (ported from the former /assistant app).
import { api, toast, date, el, button, card, field, select, form, item, tag, actions, empty, grid, checkbox, render, mountPage, root } from './ui.js';

export const renderConnectors = view => mountPage(view, 'Connectors', connections);
export const renderDevices = view => mountPage(view, 'Devices', devices);
export const renderJarvisSettings = view => mountPage(view, 'Jarvis settings', settings);

const PROVIDER_TITLE = { google: 'Google Workspace', microsoft: 'Microsoft Outlook', weather: 'Open-Meteo Weather', model: 'Model provider' };

async function connections() {
  root().append(el('div', 'Connect only what you need. Credentials are encrypted on the server and never returned to this page. Remote messages and websites cannot grant permissions.', 'jx-notice'));
  const links = el('p', undefined, 'jx-links');
  for (const [href, text] of [['#/telegram', 'Telegram userbot →'], ['#/jarvis/devices', 'Devices & companions →'], ['#/assistant-settings', 'Jarvis settings →']]) { const a = el('a', text); a.href = href; links.append(a); }
  root().append(links);
  const list = await api('/connections'), g = grid();
  for (const p of list) {
    const c = card(PROVIDER_TITLE[p.provider] || p.provider, null, g); c.append(tag(p.status));
    if (p.provider === 'google' || p.provider === 'microsoft') {
      c.append(el('p', 'Email search, calendar commitments and approved sending. Authorize your own account with OAuth.', 'muted'));
      const details = document.createElement('details'); if (!p.configured) details.open = true;
      details.append(el('summary', p.configured ? 'Replace application credentials' : 'Set up OAuth application')); c.append(details);
      details.append(el('p', 'Register this exact callback in the provider’s developer console:', 'muted'), el('p', p.callback, 'jx-code'));
      const link = el('a', p.provider === 'google' ? 'Open Google Cloud Console ↗' : 'Open Microsoft Entra portal ↗');
      link.href = p.provider === 'google' ? 'https://console.cloud.google.com/apis/credentials' : 'https://entra.microsoft.com/'; link.target = '_blank'; link.rel = 'noreferrer'; details.append(link);
      const f = form(details, 'Save encrypted credentials', async (b, f) => { await api('/connections', { ...b, provider: p.provider }); f.reset(); toast('Credentials stored. Continue with account authorization.'); await render(); });
      field(f, 'Application / Client ID', 'client_id'); field(f, 'Client secret', 'client_secret', 'password');
      if (p.provider === 'microsoft') field(f, 'Tenant (common, consumers, organizations or tenant ID)', 'tenant', 'text', 'common');
      if (p.provider === 'google') f.append(el('p', 'Enable Gmail API and Google Calendar API. Configure the OAuth consent screen and add your owner account as a test user if required.', 'muted'));
      f.addButton();
      const authorize = form(c, 'Connect account →', async b => { const result = await api(`/connections/${p.provider}/authorize`, b); location.assign(result.url); });
      select(authorize, 'Jarvis permission', 'permission', [['read', 'Read email & calendar'], ['prepare', 'Read + prepare actions for individual approval']], p.permission); authorize.addButton();
    } else if (p.provider === 'model') {
      c.append(el('p', p.model_provider ? `Configured: ${p.model_provider} · ${p.model || 'CLI default model'}` : 'Connect an API account or an existing server CLI login to enable assistant responses.', 'muted'));
      const f = form(c, 'Save model connection', async (b, f) => { await api('/connections', { ...b, provider: 'model' }); f.reset(); toast('Model configuration saved'); await render(); });
      const provider = select(f, 'Provider', 'model_provider', [['openai', 'OpenAI API'], ['anthropic', 'Anthropic API'], ['claude-cli', 'Claude Code CLI · existing server login'], ['codex-cli', 'Codex CLI · existing server login'], ['antigravity-cli', 'Antigravity CLI · existing server login']], p.model_provider);
      const model = field(f, 'Model ID (optional for CLI default)', 'model', 'text', p.model || ''), apiKey = field(f, 'API key (API providers only)', 'api_key', 'password');
      model.autocomplete = 'off'; apiKey.autocomplete = 'new-password';
      const update = () => { const cli = provider.value.endsWith('-cli'); model.required = !cli; apiKey.required = !cli; apiKey.parentElement.hidden = cli; };
      provider.onchange = update; update(); f.addButton();
      const inventoryBox = el('div');
      actions(c, [button('Check CLIs on this server', async () => { const inv = await api('/connections/cli'); inventoryBox.replaceChildren(); for (const i of inv) item(inventoryBox, i.label || i.provider, i.installed ? `${i.version} · ${i.note}` : (i.note || 'Not found on the agent bridge')); })]);
      c.append(inventoryBox, el('p', 'Chat text and selected personal memory are sent to this provider. API billing belongs to your account.', 'muted'));
    } else {
      c.append(el('p', 'Current conditions and a three-day forecast, cached for 15 minutes. No API key is needed for eligible personal use.', 'muted'));
      const f = form(c, 'Connect weather', async b => { await api('/connections', { ...b, provider: 'weather', accept_terms: b.accept_terms === 'on' }); toast('Weather location saved'); await render(); });
      field(f, 'Location name', 'name');
      const lat = field(f, 'Latitude', 'latitude', 'number'); lat.min = -90; lat.max = 90; lat.step = 'any';
      const lon = field(f, 'Longitude', 'longitude', 'number'); lon.min = -180; lon.max = 180; lon.step = 'any';
      const terms = checkbox(f, 'accept_terms', 'I use this privately for noncommercial purposes and accept the Open-Meteo terms. '); terms.required = true;
      const a = el('a', 'Read terms ↗'); a.href = 'https://open-meteo.com/en/terms'; a.target = '_blank'; a.rel = 'noreferrer'; terms.parentElement.append(a);
      f.addButton();
    }
    if (p.configured || p.status === 'connected') actions(c, [button('Disconnect & remove local credentials', async () => {
      if (!confirm(`Disconnect ${PROVIDER_TITLE[p.provider] || p.provider}?`)) return;
      await api(`/connections/${p.provider}`, {}, 'DELETE'); toast('Local credentials removed. You can also revoke access in your provider account.'); await render();
    }, 'danger')]);
  }
}

async function devices() {
  const c = card('Your devices', 'Every browser login has its own revocable session. “Recently seen” means an authenticated request arrived within two minutes.');
  for (const d of await api('/devices')) {
    const row = item(c, `${d.name}${d.current ? ' · this device' : ''}`, `Last seen ${date(d.last_seen)} · Capabilities: ${JSON.parse(d.capabilities).join(', ')}`); row.append(tag(d.connection_state));
  }
  const manage = el('a', 'Manage browser sessions in Settings → Security'); manage.href = '#/settings?tab=security'; c.append(manage);
  const companions = await api('/companions');
  const enrollment = card('Enroll a companion', 'Optional Windows/Linux agent. It connects outbound with its own revocable credential. Selected-file access and allowlisted commands also require local interactive confirmation. Clipboard access is not enabled.');
  const secretBox = el('div');
  const f = form(enrollment, 'Generate unique device credential', async b => {
    const capabilities = ['notify', ...(b.read_file === 'on' ? ['read_file'] : []), ...(b.command === 'on' ? ['command'] : [])];
    const result = await api('/companions', { name: b.name, capabilities });
    secretBox.replaceChildren(el('p', 'Save this credential privately on the companion. It is shown once; it cannot be retrieved later.'));
    const text = document.createElement('textarea'); text.readOnly = true; text.className = 'jx-note'; text.setAttribute('aria-label', 'One-time companion configuration');
    text.value = JSON.stringify({ origin: location.origin + '/assistant', token: result.token, capabilities, allowed_roots: [], commands: {} }, null, 2); secretBox.append(text);
    actions(secretBox, [button('Copy configuration', async () => { await navigator.clipboard.writeText(text.value); toast('Copied. Save it in a private config file outside the repository.'); })]);
    secretBox.append(el('p', 'Run: node companion/agent.mjs /private/path/companion.json. Enroll another credential if this one is lost.', 'muted'));
  });
  field(f, 'Companion name', 'name');
  checkbox(f, 'read_file', 'Allow selected-file requests (requires local allowed roots)');
  checkbox(f, 'command', 'Allow command requests (requires local command allowlist)');
  f.addButton(); enrollment.append(secretBox);
  const list = card('Companion connections', 'Queued work expires after five minutes. Interrupted work becomes uncertain and is never silently replayed.');
  for (const d of companions) {
    const row = item(list, d.name, `Capabilities: ${JSON.parse(d.capabilities).join(', ')} · Last seen: ${d.last_seen ? date(d.last_seen) : 'Never'}`);
    row.append(tag(d.revoked_at ? 'revoked' : d.last_seen && Date.now() - d.last_seen < 30000 ? 'recently_seen' : 'offline'));
    if (!d.revoked_at) actions(row, [button('Revoke companion', async () => { if (!confirm(`Revoke ${d.name}?`)) return; await api(`/companions/${d.id}`, {}, 'DELETE'); await render(); }, 'danger')]);
  }
  if (!companions.length) empty(list, 'No companion has been enrolled. Conclave works without one.');
  const active = companions.filter(d => !d.revoked_at);
  if (active.length) {
    const work = card('Request a local capability', 'Only an explicitly enrolled capability and a local allowlist can execute.');
    const q = form(work, 'Queue request (expires in 5 minutes)', async b => { await api('/companions/work', b); toast('Request queued'); await render(); });
    select(q, 'Companion', 'device_id', active.map(d => [d.id, d.name]));
    select(q, 'Capability', 'kind', [['notify', 'Notification'], ['read_file', 'Read a selected file'], ['command', 'Run a local allowlisted command ID']]);
    field(q, 'Notification title', 'title', 'text', 'Conclave', false); field(q, 'Notification body', 'body', 'text', '', false);
    field(q, 'Selected absolute file path (file requests)', 'path', 'text', '', false); field(q, 'Local command ID (command requests)', 'command_id', 'text', '', false); q.addButton();
  }
  const results = await api('/companions/work');
  if (results.length) { const history = card('Companion results'); for (const r of results) { const d = item(history, `${r.kind} · ${date(r.created_at)}`, r.result || `Expires ${date(r.expires_at)}`); d.append(tag(r.state)); } }
}

// Push uses the /assistant/ service worker (its scope covers the push endpoint and notification clicks).
async function assistantWorker() {
  if (!('serviceWorker' in navigator)) return null;
  return await navigator.serviceWorker.getRegistration('/assistant/') || await navigator.serviceWorker.register('/assistant/sw.js', { scope: '/assistant/' });
}

async function settings() {
  const g = grid();
  const memories = card('Personal memory', 'Facts you choose to keep. Edit them here or on the 3D Memory map.', g);
  const f = form(memories, 'Remember this', async (b, f) => { await api('/memories', b); f.reset(); toast('Remembered'); await render(); });
  field(f, 'A preference or fact', 'content', 'textarea'); f.addButton();
  const upload = field(memories, 'Import memory phrases (.md or .txt, max 50 KB)', 'memory_file', 'file', '', false); upload.accept = '.md,.txt,text/markdown,text/plain';
  const importPreview = el('div'); memories.append(importPreview);
  upload.onchange = async () => {
    importPreview.replaceChildren(); importPreview.className = '';
    try {
      const file = upload.files[0]; if (!file) return; if (file.size > 50_000) throw new Error('Use a file smaller than 50 KB');
      const request = { name: file.name, content: await file.text() }, result = await api('/memories/import/preview', request);
      importPreview.className = 'jx-preview';
      importPreview.append(el('h3', `${result.new_memories} new memory nodes`), el('p', `${result.total_phrases} phrases · ${result.skipped_duplicates} duplicates · ${Object.keys(result.topics).length} topics`), el('p', 'Source context stays with every imported statement. Plans, estimates and hypothetical templates are labeled separately.', 'muted'));
      for (const [kind, count] of Object.entries(result.kinds)) importPreview.append(tag(`${kind}: ${count}`));
      for (const phrase of result.phrases.slice(0, 8)) item(importPreview, phrase.topic || 'General', phrase.content);
      actions(importPreview, [
        button('Import these memory nodes', async () => { const saved = await api('/memories/import', request); toast(`Imported ${saved.imported} nodes; ${saved.skipped_duplicates} duplicates skipped`); await render(); }, 'primary'),
        button('Cancel import', async () => { importPreview.replaceChildren(); importPreview.className = ''; upload.value = ''; }),
      ]);
    } catch (e) { toast(e.message, true); }
  };
  const mapLink = el('a', 'Open the 3D memory map →'); mapLink.href = '#/mind'; memories.append(mapLink);
  const all = await api('/memories');
  const recent = all.slice(0, 25);
  for (const m of recent) {
    const d = item(memories, m.topic || 'Remembered fact', null), edit = document.createElement('textarea'); edit.value = m.content; edit.className = 'jx-note'; edit.setAttribute('aria-label', 'Edit remembered fact'); d.append(edit);
    if (m.source) { let md = {}; try { md = JSON.parse(m.metadata || '{}'); } catch {} d.append(el('p', `${md.kind || 'statement'} · ${m.source}${md.source_line ? ` · line ${md.source_line}` : ''}`, 'muted')); }
    if (m.source === 'conclave-shared') { d.append(el('p', 'Shared from Conclave Memory; edit it there.', 'muted')); edit.readOnly = true; continue; }
    actions(d, [
      button('Save edit', async () => { await api('/memories', { id: m.id, content: edit.value }); toast('Memory updated'); }),
      button('Forget', async () => { if (!confirm('Forget this memory?')) return; await api(`/memories/${m.id}`, {}, 'DELETE'); await render(); }, 'danger'),
    ]);
  }
  if (all.length > recent.length) memories.append(el('p', `Showing the 25 most recent of ${all.length}. Use the 3D Memory map to search all of them.`, 'muted'));

  const security = card('Account & passkeys', 'Password changes revoke other browser sessions.', g);
  const accountLink = el('a', 'Manage Conclave account, passkeys and sessions'); accountLink.href = '#/settings?tab=security'; security.append(accountLink);

  const push = card('Notifications', 'Inbox delivery is always available. Web Push requires browser support and permission; on iOS use an installed Home Screen web app.', g);
  const pf = form(push, 'Enable push on this device', async b => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser does not support Web Push. Use the persistent Inbox.');
    if (await Notification.requestPermission() !== 'granted') throw new Error('Notification permission was not granted. Inbox remains available.');
    const { public_key } = await api('/push/setup', b), reg = await assistantWorker();
    const bytes = Uint8Array.from(atob(public_key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const subscription = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    await api('/push/subscribe', { subscription: subscription.toJSON() }); toast('Web Push enabled');
  });
  field(pf, 'Push service contact (mailto:you@example.com)', 'contact'); pf.addButton();
  actions(push, [button('Disable push on this device', async () => {
    await api('/push/subscribe', {}, 'DELETE');
    const reg = await navigator.serviceWorker?.getRegistration('/assistant/'); const sub = await reg?.pushManager.getSubscription(); await sub?.unsubscribe();
    toast('Push disabled; Inbox remains available');
  })]);

  const privacy = card('Privacy & audit', 'Private credentials are encrypted separately from conversation content. Protect your server backups and encryption key.', g);
  const log = await api('/audit'); for (const a of log.slice(0, 15)) item(privacy, a.event.replaceAll('.', ' · '), date(a.created_at));
}
