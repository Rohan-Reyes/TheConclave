// Jarvis Inbox (approvals, proposals, reconciliation, notifications, email drafts) and Notes.
import { api, toast, date, el, button, card, field, select, form, item, tag, actions, empty, grid, voiceControls, render, mountPage } from './ui.js';

export const renderInbox = view => mountPage(view, 'Inbox', inbox);
export const renderNotes = view => mountPage(view, 'Notes', notes);

async function inbox() {
  const data = await api('/inbox');
  for (const proposal of data.proposals) {
    const p = JSON.parse(proposal.payload), c = card(p.title, `${p.interpreted} · ${p.timezone}`);
    c.append(el('p', `UTC: ${p.utc} · ${p.original_text} · Missed runs: deliver one latest occurrence`, 'muted'));
    actions(c, [
      button('Confirm & save schedule', async () => { await api(`/proposals/${proposal.id}`, { decision: 'confirm' }); toast('Reminder scheduled'); await render(); }, 'primary'),
      button('Reject proposal', async () => { await api(`/proposals/${proposal.id}`, { decision: 'reject' }); await render(); }),
    ]);
  }
  for (const u of data.uncertain) {
    const c = card('Action needs reconciliation', `${u.kind}: ${u.error}`);
    c.append(el('p', 'Check the provider’s Sent folder or calendar before recording the outcome. This action will not be automatically retried.'));
    actions(c, [
      button('Provider performed the action', async () => { await api(`/jobs/${u.id}/reconcile`, { resolution: 'completed' }); await render(); }),
      button('Confirmed not performed', async () => { await api(`/jobs/${u.id}/reconcile`, { resolution: 'failed' }); await render(); }),
    ]);
  }
  const approvals = card('Your approval matters', 'Review the final contents before authorizing an external action.');
  for (const a of data.approvals) {
    const d = item(approvals, a.subject, a.kind === 'email_send' ? `To: ${a.recipients}` : 'Calendar event');
    d.append(el('pre', a.body), el('p', `Attachments: ${JSON.parse(a.attachments || '[]').length ? a.attachments : 'None'}`, 'muted'), tag(a.state));
    if (a.state === 'pending') actions(d, [
      button(a.kind === 'email_send' ? 'Approve sending email' : 'Approve creating event', async () => { await api(`/approvals/${a.id}`, { decision: 'approved' }); toast('Approved and queued for the worker'); await render(); }, 'primary'),
      button('Reject', async () => { await api(`/approvals/${a.id}`, { decision: 'rejected' }); await render(); }, 'danger'),
    ]);
  }
  if (!data.approvals.length) empty(approvals, 'Nothing awaiting your approval.');
  const notifications = card('Results & reminders', 'Inbox notifications persist even when push is unavailable.');
  for (const n of data.notifications) {
    const d = item(notifications, n.title, n.body); d.append(el('small', date(n.created_at), 'muted'));
    if (!n.read_at) actions(d, [button('Mark read', async () => { await api(`/notifications/${n.id}`, {}, 'PATCH'); await render(); })]);
  }
  if (!data.notifications.length) empty(notifications, 'You’re all caught up.');
  const compose = card('Prepare an email', 'The draft is saved, then reviewed here before the worker sends it through your connected account.');
  const f = form(compose, 'Save draft for approval', async (b, f) => { await api('/drafts', b); f.reset(); toast('Draft saved for review'); await render(); });
  select(f, 'From connected provider', 'provider', [['google', 'Gmail'], ['microsoft', 'Outlook']]); field(f, 'Recipients (comma-separated)', 'recipients'); field(f, 'Subject', 'subject'); field(f, 'Final message', 'body', 'textarea'); f.addButton();
}

async function notes() {
  const intro = el('p', 'Keep notes here, then prepare a coding request for a chat. Sending it remains your choice.', 'muted'); intro.style.marginTop = '0';
  const g = grid(); g.before(intro);
  const create = card('New note', null, g);
  const f = form(create, 'Save note', async b => { await api('/notes', b); await render(); });
  field(f, 'Title', 'title'); const input = field(f, 'Note or task', 'content', 'textarea'); input.maxLength = 20000; voiceControls(f, input); f.addButton();
  for (const note of await api('/notes')) {
    const c = card(note.title, null, g), edit = document.createElement('textarea'); edit.value = note.content; edit.setAttribute('aria-label', note.title); edit.className = 'jx-note'; c.append(edit);
    actions(c, [
      button('Save', async () => { await api('/notes', { id: note.id, title: note.title, content: edit.value }); toast('Note saved'); }),
      button('Prepare coding request', () => {
        const key = 'conclave:draft:welcome';
        if (localStorage.getItem(key) && !confirm('Replace the existing unsent coding draft with this note?')) return;
        localStorage.setItem(key, `Task: ${note.title}\n\n${edit.value}\n\nSource: Conclave note ${note.id}\nReview the scope and workspace before starting.`);
        location.hash = '/hub?new=1';
      }),
      button('Delete', async () => { if (!confirm('Delete this note?')) return; await api(`/notes/${note.id}`, {}, 'DELETE'); await render(); }, 'danger'),
    ]);
  }
}
