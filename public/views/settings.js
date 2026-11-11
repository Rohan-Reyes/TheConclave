// Settings: account security (password, passkeys, devices), appearance,
// keyboard shortcuts and about. Talks to /api/auth/* for the account parts.
import { api, esc, ago, toast, modal, $, $$ } from '../lib.js';

export const SHORTCUTS = [
  ['<kbd>Ctrl</kbd> <kbd>K</kbd>', 'Search chats, projects and memories'],
  ['<kbd>Enter</kbd>', 'Send a message (or queue it while agents work)'],
  ['<kbd>Alt</kbd> <kbd>M</kbd>', 'Add details without stopping the active AI; focus the composer if empty'],
  ['<kbd>Ctrl</kbd> <kbd>Enter</kbd>', 'Add details while the AI works; otherwise send a message'],
  ['<kbd>Shift</kbd> <kbd>Enter</kbd>', 'New line in the message box'],
  ['<kbd>/</kbd>', 'Message templates (at the start of a message)'],
  ['<kbd>Ctrl</kbd> <kbd>B</kbd>', 'Show or hide the chat list'],
  ['<kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>F</kbd>', 'Focus mode (chat only, full screen)'],
  ['<kbd>Esc</kbd>', 'Close menus and dialogs, leave focus mode'],
  ['<kbd>?</kbd>', 'Show these shortcuts'],
];

const TABS = [
  ['security', 'Password & passkeys'],
  ['appearance', 'Appearance'],
  ['shortcuts', 'Keyboard shortcuts'],
  ['about', 'About'],
];

const WebAuthn = () => (typeof window !== 'undefined' ? window.SimpleWebAuthnBrowser : null);

function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'This device';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}
const uaLabel = ua => {
  if (!ua) return 'Unknown browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /curl|node|fetch/i.test(ua) ? 'Script' : 'Browser';
  return `${br} on ${os}`;
};

// 0-4 score: length first, then variety. Advisory only; the server enforces the minimum.
function strength(pw) {
  if (!pw) return 0;
  let s = pw.length >= 20 ? 3 : pw.length >= 16 ? 2 : pw.length >= 12 ? 1 : 0;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  if (kinds >= 3 && s > 0) s++;
  return Math.min(4, s);
}
const STRENGTH = [['Too short', 'var(--danger)', 8], ['Weak', 'var(--danger)', 30], ['Fair', 'var(--warn)', 55], ['Good', 'var(--ok)', 80], ['Strong', 'var(--ok)', 100]];

function suggestPassword() {
  const words = 'amber,atlas,beacon,cedar,comet,delta,ember,falcon,garnet,harbor,indigo,juniper,kestrel,lumen,meadow,nimbus,onyx,orbit,pebble,quartz,raven,saffron,summit,tundra,umber,vertex,willow,zephyr'.split(',');
  const r = new Uint32Array(6); crypto.getRandomValues(r);
  return `${words[r[0] % words.length]}-${words[r[1] % words.length]}-${words[r[2] % words.length]}-${words[r[3] % words.length]}-${(r[4] % 900) + 100}${'!#%&*+?'[r[5] % 7]}`;
}

export async function renderSettings(view, params) {
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'security';
  view.innerHTML = `
    <div class="head"><div><h1>Settings</h1><p class="muted">Your sign-in, appearance and shortcuts.</p></div></div>
    <div class="settings-layout">
      <div class="settings-tabs" role="tablist" aria-label="Settings sections">
        ${TABS.map(([k, label]) => `<button role="tab" aria-selected="${k === tab}" data-tab="${k}">${label}</button>`).join('')}
      </div>
      <div class="settings-body" id="settings-body" role="tabpanel"></div>
    </div>`;
  $$('[data-tab]', view).forEach(b => b.onclick = () => { location.hash = `#/settings?tab=${b.dataset.tab}`; });
  const body = $('#settings-body', view);
  if (tab === 'security') return renderSecurity(body);
  if (tab === 'appearance') return renderAppearance(body);
  if (tab === 'shortcuts') {
    body.innerHTML = `<section class="card"><h2>Keyboard shortcuts</h2><p class="desc">Available everywhere unless you are typing in a field.</p>
      <div class="shortcut-list">${SHORTCUTS.map(([k, d]) => `<span>${k}</span><span>${d}</span>`).join('')}</div></section>`;
    return;
  }
  return renderAbout(body);
}

// ---------- security
async function renderSecurity(body) {
  body.innerHTML = '<div class="empty">Loading…</div>';
  const status = await api('/api/auth/status').catch(() => ({ enabled: false }));
  if (!status.enabled) {
    body.innerHTML = `<section class="card"><h2>Sign-in is off on this computer</h2>
      <p class="desc">This copy of Conclave only listens on this computer (127.0.0.1), so it doesn't ask for a password.
      Password and passkey settings apply to the copy you reach from the internet (for example your Raspberry Pi); open its Settings page there.</p></section>`;
    return;
  }
  const acc = await api('/api/auth/account');
  const secureContext = window.isSecureContext;
  const webauthnReady = secureContext && !!WebAuthn()?.browserSupportsWebAuthn?.();

  body.innerHTML = `
    <section class="card" aria-labelledby="pw-h">
      <h2 id="pw-h">Password</h2>
      <p class="desc">Signed in as <b>${esc(acc.username)}</b>. ${acc.passwordUpdated ? `Password last changed ${esc(ago(acc.passwordUpdated))}.` : 'Your password has not been changed since setup.'}</p>
      <form class="form-grid" id="pw-form" autocomplete="on">
        <input type="text" name="username" value="${esc(acc.username)}" autocomplete="username" hidden>
        <label>Current password<input type="password" id="pw-current" autocomplete="current-password" required></label>
        <label>New password<input type="password" id="pw-new" autocomplete="new-password" minlength="${acc.minPasswordLength}" required aria-describedby="pw-meter-text"></label>
        <div><div class="strength" aria-hidden="true"><i id="pw-meter"></i></div><div class="form-hint" id="pw-meter-text">At least ${acc.minPasswordLength} characters. A few random words work well.</div></div>
        <label>Confirm new password<input type="password" id="pw-confirm" autocomplete="new-password" required></label>
        <label class="check-row small"><input type="checkbox" id="pw-show"> Show passwords</label>
        <div class="form-actions">
          <button class="primary" type="submit" id="pw-save">Change password</button>
          <button type="button" id="pw-suggest">Suggest a strong password</button>
        </div>
        <div class="form-hint">Changing your password signs out every other device. This one stays signed in.</div>
      </form>
    </section>

    <section class="card" aria-labelledby="pk-h">
      <div class="row" style="justify-content:space-between;align-items:center;gap:10px">
        <div><h2 id="pk-h">Passkeys</h2><p class="desc" style="margin:0">Sign in with your fingerprint, face or device PIN instead of typing your password.</p></div>
        <button class="primary" id="pk-add" ${webauthnReady ? '' : 'disabled'}>Add a passkey</button>
      </div>
      ${!secureContext ? '<div class="notice warn" style="margin-top:14px">Passkeys need a secure connection. Open Conclave through its https:// address to add one.</div>'
        : !webauthnReady ? '<div class="notice warn" style="margin-top:14px">This browser does not support passkeys.</div>' : ''}
      <div id="pk-list" style="margin-top:12px">${acc.passkeys.length ? acc.passkeys.map(p => `
        <div class="card-row" data-pk="${esc(p.id)}">
          <div class="grow"><div class="title">${esc(p.name)} ${p.backedUp ? '<span class="pill ok" title="Synced to your password manager or cloud keychain">Synced</span>' : ''}</div>
            <div class="sub">Added ${esc(p.created ? ago(p.created) : 'unknown')} · ${p.lastUsed ? `last used ${esc(ago(p.lastUsed))}` : 'never used'}</div></div>
          <div class="form-actions"><button class="small" data-pk-rename>Rename</button><button class="small danger" data-pk-delete>Remove</button></div>
        </div>`).join('') : '<p class="form-hint" style="margin:6px 0 0">No passkeys yet.</p>'}</div>
    </section>

    <section class="card" aria-labelledby="ss-h">
      <div class="row" style="justify-content:space-between;align-items:center;gap:10px">
        <div><h2 id="ss-h">Signed-in devices</h2><p class="desc" style="margin:0">Sessions last 12 hours. Restarting the server signs everyone out.</p></div>
        <button id="ss-revoke" ${acc.sessions.length > 1 ? '' : 'disabled'}>Sign out other devices</button>
      </div>
      <div style="margin-top:12px">${acc.sessions.map(s => `
        <div class="card-row"><div class="grow"><div class="title">${esc(uaLabel(s.userAgent))} ${s.current ? '<span class="pill accent">This device</span>' : ''}</div>
          <div class="sub">Signed in ${esc(ago(s.created))} with ${s.method === 'passkey' ? 'a passkey' : 'a password'} · active ${esc(ago(s.lastSeen))}</div></div></div>`).join('')}</div>
    </section>`;

  // Password form
  const meter = () => {
    const s = strength($('#pw-new', body).value);
    const [label, color, width] = STRENGTH[s];
    $('#pw-meter', body).style.width = `${$('#pw-new', body).value ? width : 0}%`;
    $('#pw-meter', body).style.background = color;
    $('#pw-meter-text', body).textContent = $('#pw-new', body).value ? `${label}. At least ${acc.minPasswordLength} characters.` : `At least ${acc.minPasswordLength} characters. A few random words work well.`;
  };
  $('#pw-new', body).addEventListener('input', meter);
  $('#pw-show', body).onchange = e => $$('#pw-form input[type=password], #pw-form input[data-shown]', body).forEach(i => { i.type = e.target.checked ? 'text' : 'password'; i.toggleAttribute('data-shown', e.target.checked); });
  $('#pw-suggest', body).onclick = () => {
    const pw = suggestPassword();
    $('#pw-new', body).value = pw; $('#pw-confirm', body).value = pw;
    $('#pw-show', body).checked = true; $('#pw-show', body).onchange({ target: { checked: true } });
    meter();
    toast('Suggested a password. Save it in your password manager before you continue.');
  };
  $('#pw-form', body).onsubmit = async e => {
    e.preventDefault();
    const current = $('#pw-current', body).value, next = $('#pw-new', body).value;
    if (next !== $('#pw-confirm', body).value) return toast('The new passwords do not match', true);
    if (next.length < acc.minPasswordLength) return toast(`Use at least ${acc.minPasswordLength} characters`, true);
    const btn = $('#pw-save', body); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await api('/api/auth/password', { method: 'POST', body: { current, next } });
      toast('Password changed. Other devices were signed out.');
      renderSecurity(body);
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Change password'; }
  };

  // Passkeys
  $('#pk-add', body).onclick = () => confirmPassword({
    title: 'Add a passkey', action: 'Continue', withName: deviceName(),
    note: 'Your browser will ask you to confirm with your fingerprint, face, device PIN or a security key.',
  }, async ({ password, name }) => {
    const { challengeId, options } = await api('/api/auth/passkeys/register/options', { method: 'POST', body: { password, name } });
    let response;
    try { response = await WebAuthn().startRegistration({ optionsJSON: options }); }
    catch (err) { throw new Error(err?.name === 'NotAllowedError' ? 'Passkey setup was cancelled.' : err?.name === 'InvalidStateError' ? 'This device already has a passkey for Conclave.' : `Passkey setup failed: ${err.message}`); }
    await api('/api/auth/passkeys/register/verify', { method: 'POST', body: { challengeId, response } });
    toast('Passkey added. You can now use it on the sign-in page.');
    renderSecurity(body);
  });
  $$('[data-pk-rename]', body).forEach(b => b.onclick = () => {
    const id = b.closest('[data-pk]').dataset.pk;
    const current = acc.passkeys.find(p => p.id === id)?.name || '';
    modal(`<h2 style="margin:0">Rename passkey</h2>
      <label class="field">Name<input id="pk-name" maxlength="60" value="${esc(current)}"></label>
      <div class="modal-actions"><button id="pk-cancel">Cancel</button><button class="primary" id="pk-save">Save</button></div>`, (root, close) => {
      $('#pk-cancel', root).onclick = close;
      const save = async () => {
        try { await api(`/api/auth/passkeys/${encodeURIComponent(id)}/rename`, { method: 'POST', body: { name: $('#pk-name', root).value } }); close(); renderSecurity(body); }
        catch (err) { toast(err.message, true); }
      };
      $('#pk-save', root).onclick = save;
      $('#pk-name', root).onkeydown = e => { if (e.key === 'Enter') save(); };
      $('#pk-name', root).select();
    });
  });
  $$('[data-pk-delete]', body).forEach(b => b.onclick = () => {
    const id = b.closest('[data-pk]').dataset.pk;
    const name = acc.passkeys.find(p => p.id === id)?.name || 'this passkey';
    confirmPassword({ title: `Remove ${name}?`, action: 'Remove passkey', danger: true,
      note: 'You won\'t be able to sign in with it any more. Also delete it from your device or password manager.' },
    async ({ password }) => {
      await api(`/api/auth/passkeys/${encodeURIComponent(id)}/delete`, { method: 'POST', body: { password } });
      toast('Passkey removed');
      renderSecurity(body);
    });
  });

  // Devices
  $('#ss-revoke', body).onclick = async () => {
    try { const r = await api('/api/auth/sessions/revoke-others', { method: 'POST', body: {} }); toast(`Signed out ${r.count} other device${r.count === 1 ? '' : 's'}`); renderSecurity(body); }
    catch (err) { toast(err.message, true); }
  };
}

// Ask for the password before a sensitive change (adding or removing a passkey).
function confirmPassword({ title, action, note, danger, withName }, run) {
  modal(`
    <h2 style="margin:0">${esc(title)}</h2>
    ${note ? `<p class="muted small" style="margin:0">${esc(note)}</p>` : ''}
    <form class="form-grid" id="cp-form" style="max-width:none">
      ${withName !== undefined ? `<label>Passkey name<input id="cp-name" maxlength="60" value="${esc(withName)}"></label>` : ''}
      <label>Your password<input type="password" id="cp-pass" autocomplete="current-password" required></label>
      <div class="modal-actions"><button type="button" id="cp-cancel">Cancel</button><button type="submit" class="${danger ? 'danger solid' : 'primary'}" id="cp-go">${esc(action)}</button></div>
    </form>`, (root, close) => {
    $('#cp-cancel', root).onclick = close;
    $('#cp-pass', root).focus();
    $('#cp-form', root).onsubmit = async e => {
      e.preventDefault();
      const go = $('#cp-go', root); go.disabled = true;
      try { await run({ password: $('#cp-pass', root).value, name: $('#cp-name', root)?.value }); close(); }
      catch (err) { toast(err.message, true); go.disabled = false; }
    };
  });
}

// ---------- appearance
function renderAppearance(body) {
  const theme = document.documentElement.dataset.theme || '';
  const collapsed = document.body.classList.contains('sidebar-collapsed');
  body.innerHTML = `
    <section class="card"><h2>Theme</h2><p class="desc">System follows your device's light or dark setting.</p>
      <div class="seg-choice" role="group" aria-label="Theme">${[['', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button data-theme-choice="${k}" aria-pressed="${k === theme}">${l}</button>`).join('')}</div>
    </section>
    <section class="card"><h2>Sidebar</h2><p class="desc">On computers, show the full sidebar or icons only. Phones always use the menu and bottom bar.</p>
      <div class="seg-choice" role="group" aria-label="Sidebar">${[['open', 'Full'], ['collapsed', 'Icons only']].map(([k, l]) => `<button data-sidebar-choice="${k}" aria-pressed="${(k === 'collapsed') === collapsed}">${l}</button>`).join('')}</div>
    </section>`;
  $$('[data-theme-choice]', body).forEach(b => b.onclick = async () => {
    const { applyTheme } = await import('../app.js');
    applyTheme(b.dataset.themeChoice);
    renderAppearance(body);
  });
  $$('[data-sidebar-choice]', body).forEach(b => b.onclick = () => {
    const on = b.dataset.sidebarChoice === 'collapsed';
    document.body.classList.toggle('sidebar-collapsed', on);
    try { localStorage.setItem('cv-sidebar', on ? 'collapsed' : 'open'); } catch {}
    renderAppearance(body);
  });
}

// ---------- about
async function renderAbout(body) {
  const [stats, status] = await Promise.all([api('/api/stats').catch(() => null), api('/api/auth/status').catch(() => ({}))]);
  const chats = stats ? stats.chats.reduce((a, c) => a + c.n, 0) : '—';
  body.innerHTML = `
    <section class="card"><h2>About this Conclave</h2>
      <div class="card-row"><div class="grow"><div class="title">Address</div><div class="sub">${esc(location.origin)}</div></div></div>
      <div class="card-row"><div class="grow"><div class="title">Sign-in</div><div class="sub">${status.enabled ? 'Required (owner only)' : 'Off: this copy only listens on this computer'}</div></div></div>
      <div class="card-row"><div class="grow"><div class="title">Indexed</div><div class="sub">${esc(chats)} chats · ${esc(stats?.memories ?? '—')} memories</div></div></div>
      <div class="card-row"><div class="grow"><div class="title">Source</div><div class="sub"><a href="https://github.com/Rohan-Reyes/TheConclave" target="_blank" rel="noopener">github.com/Rohan-Reyes/TheConclave</a></div></div></div>
    </section>`;
}
