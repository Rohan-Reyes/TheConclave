// Jarvis Telegram userbot settings (ported from the former /assistant app).
import { api, toast, date, el, button, card, field, select, form, item, tag, actions, empty, checkbox, render, mountPage } from './ui.js';

export const renderTelegram = view => mountPage(view, 'Telegram', telegram);

async function telegram() {
  const status = await api('/telegram');
  const c = card('Telegram userbot', 'Chat with Jarvis from your allowed Telegram account. Session credentials are stored encrypted and never shown here.');
  c.append(tag(status.configured ? status.health.state : 'authorization_required'));
  c.append(el('p', 'Needed: a Telegram API ID and hash, your numeric owner ID, and a logged-in userbot session. Calls need a userbot account separate from the one receiving them.', 'muted'));

  // What is still missing
  const list = el('ul', undefined, 'jx-checklist');
  for (const step of status.checklist || []) {
    const li = el('li', undefined, step.done ? 'done' : step.optional ? 'optional' : 'todo');
    li.append(el('span', step.done ? '✓' : step.optional ? '○' : '•', 'jx-check-mark'), el('b', step.label));
    if (!step.done) li.append(el('small', step.hint, 'muted'));
    list.append(li);
  }
  c.append(list);
  if(status.voice_health?.state)c.append(el('p',`Last voice call: ${status.voice_health.state}`,'muted'));

  loginCard(status);

  const credentials = card('Telegram credentials', 'Edit these privately here. Saved API hashes and sessions are never displayed. Changing credentials turns delivery off until you enable it again.');
  const credentialForm = form(credentials, 'Save encrypted credentials', async (b, f) => { await api('/telegram/config', b); f.reset(); toast('Credentials saved; enable Telegram when ready'); await render(); });
  const appId = field(credentialForm, 'Telegram API ID', 'api_id', 'number', status.api_id || '', !status.api_id && !status.app_file); appId.min = '1';
  const hash = field(credentialForm, status.has_api_hash || status.app_file ? 'API hash (saved; blank keeps it)' : 'API hash', 'api_hash', 'password', '', !status.has_api_hash && !status.app_file); hash.autocomplete = 'new-password';
  const owner = field(credentialForm, 'Your Telegram numeric user ID', 'owner_id', 'number', status.owner_id || '', false); owner.min = '1';
  const session = field(credentialForm, 'Authorized Telethon session (optional; blank keeps saved value)', 'session', 'password', '', false); session.autocomplete = 'new-password';
  credentialForm.addButton();
  credentials.append(el('p', 'Prefer the browser login above. Fallback: run npm run telegram:setup in a private terminal on the server. Never paste login codes or sessions into chat.', 'muted'));
  if (!status.configured) return;

  c.append(el('p', `Allowed owner: ${status.owner_id}. In Saved Messages on the same account, prefix requests with /conclave. A separate userbot account can receive ordinary private messages from this owner.`));
  const f = form(c, 'Save Telegram settings', async b => { await api('/telegram/config', { enabled: b.enabled === 'on', calls_enabled: b.calls_enabled === 'on', notifications: b.notifications === 'on',conversation_enabled:b.conversation_enabled==='on',voice:b.voice }); toast('Telegram settings saved'); await render(); });
  checkbox(f, 'enabled', 'Enable owner-only Telegram chat', status.enabled);
  checkbox(f, 'calls_enabled', 'Allow outbound spoken-message calls', status.calls_enabled);
  checkbox(f, 'notifications', 'Send new reminder and automation notifications', status.notifications);
  checkbox(f,'conversation_enabled','Answer my incoming calls for spoken conversation (English)',status.conversation_enabled);
  select(f,'Call voice','voice',(status.voice_choices || []).map(v=>[v,({'en-US-AndrewMultilingualNeural':'Andrew · natural male','en-GB-RyanNeural':'Ryan · British male','en-US-AvaMultilingualNeural':'Ava · natural female','fil-PH-AngeloNeural':'Angelo · Filipino male','fil-PH-BlessicaNeural':'Blessica · Filipino female'})[v] || v]),status.voice);
  f.addButton();
  c.append(el('p', 'Outbound alerts speak the supplied message. Enable conversational calls to phone the userbot from your owner account and take turns speaking with Jarvis. Speech recognition runs locally in English; reply text is sent to Microsoft Edge TTS. Call transcripts are kept in your Jarvis chat. Pause after speaking and wait for the reply; interruption is not supported yet.', 'muted'));
  actions(c, [button('Disconnect Telegram', async () => { if (!confirm('Disconnect Telegram and remove the saved session?')) return; await api('/telegram', {}, 'DELETE'); await render(); }, 'danger')]);

  const send = card('Contact me', 'Only your configured owner account can be contacted. /call followed by a message also requests a spoken call from Telegram.');
  const compose = form(send, 'Queue for delivery', async (b, f) => { await api('/telegram/outbox', { ...b, request_id: crypto.randomUUID() }); f.reset(); toast('Queued; delivery runs in the background'); await render(); });
  select(compose, 'Action', 'kind', [['message', 'Send message'], ['call', 'Call and speak this message']]);
  const text = field(compose, 'Message (calls: 800 characters maximum)', 'text', 'textarea'); text.maxLength = 3800; compose.addButton();

  const history = card('Delivery history', 'Uncertain actions are not automatically retried. Check Telegram before requesting another delivery.');
  for (const job of status.outbox) item(history, `${job.kind} · ${job.state}`, `${date(job.created_at)}${job.error ? ' · ' + job.error : ''}`);
  if (!status.outbox.length) empty(history, 'No deliveries yet.');
}

// Phone -> code -> optional two-step password. Nothing typed here is stored; only the resulting
// session is saved (encrypted) by the server.
let loginState = null; // { login_id, step, error }
function loginCard(status) {
  if (status.login && (!loginState || loginState.login_id !== status.login.login_id)) loginState = { ...status.login };
  const c = card(status.configured ? 'Log in a different userbot' : 'Log in the userbot', 'Use the account that will act as Jarvis on Telegram. For calls, this must be a different account from yours.');
  const done = res => { loginState = null; toast(res.same_as_owner ? 'Logged in. This is your own account: chat works via Saved Messages, but calls need a separate account.' : 'Userbot logged in. Session saved encrypted; enable delivery below.'); return render(); };
  const cancel = () => button('Cancel login', async () => { await api('/telegram/login', {}, 'DELETE'); loginState = null; await render(); }, 'ghost');
  if (!loginState) {
    const f = form(c, 'Send login code →', async b => {
      loginState = await api('/telegram/login/start', b);
      if (loginState.step === 'done') return done(loginState);
      await render();
    });
    const phone = field(f, 'Userbot phone number (international format)', 'phone', 'tel'); phone.placeholder = '+639171234567'; phone.autocomplete = 'off';
    if (!status.owner_id) { const o = field(f, 'Your numeric Telegram user ID (who Jarvis talks to)', 'owner_id', 'number', '', false); o.min = '1'; }
    if (!status.has_api_hash && !status.app_file) { field(f, 'Telegram API ID', 'api_id', 'number'); const h = field(f, 'API hash', 'api_hash', 'password'); h.autocomplete = 'new-password'; }
    f.append(el('p', 'Telegram sends a code to that account (in the Telegram app or by SMS). Logins are rate-limited and expire after 10 minutes.', 'muted'));
    f.addButton();
    return;
  }
  if (loginState.error) c.append(el('p', loginState.error, 'jx-error'));
  const isCode = loginState.step === 'code';
  const f = form(c, isCode ? 'Verify code →' : 'Verify password →', async (b, f) => {
    try {
      const res = await api(`/telegram/login/${isCode ? 'code' : 'password'}`, { login_id: loginState.login_id, [isCode ? 'code' : 'password']: b.value });
      f.reset();
      if (res.step === 'done') return done(res);
      loginState = res; await render();
    } catch (e) { f.reset(); if (/expired|cancelled|Start/.test(e.message)) loginState = null; await render(); throw e; }
  });
  const input = field(f, isCode ? 'Login code from Telegram' : 'Two-step verification password', 'value', isCode ? 'text' : 'password');
  input.autocomplete = isCode ? 'one-time-code' : 'current-password'; if (isCode) { input.inputMode = 'numeric'; input.maxLength = 8; }
  f.addButton(); f.querySelector('.jx-actions').append(cancel());
  setTimeout(() => input.focus(), 0);
}
