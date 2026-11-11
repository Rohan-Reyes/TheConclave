import * as webpush from 'web-push';
import { id, audit } from './db.js';
import { getSecret, setSecret } from './integrations.js';
// Only known push services may receive requests; arbitrary endpoints could target the private LAN.
function validEndpoint(endpoint) {
  let u; try { u = new URL(endpoint); } catch { return false; }
  return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com'].some(host => u.hostname === host || u.hostname.endsWith(`.${host}`));
}
export async function handlePush(db, path, b, session, key, method) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  let config = getSecret(db, 'vapid', key);
  if (path === '/api/push/key' && method === 'GET') return { public_key: config?.publicKey || null };
  if (path === '/api/push/setup' && method === 'POST') {
    if (!config) {
      if (typeof b.contact !== 'string' || !/^(mailto:[^\s]+@[^\s]+|https:\/\/[^\s]+)$/.test(b.contact)) fail('A mailto: or HTTPS contact is required for Web Push');
      config = { ...webpush.generateVAPIDKeys(), subject: b.contact }; setSecret(db, 'vapid', config, key); audit(db, 'push.configured');
    }
    return { public_key: config.publicKey };
  }
  if (path === '/api/push/subscribe' && method === 'POST') {
    if (!config) fail('Configure Web Push first');
    const sub = b.subscription;
    if (!validEndpoint(sub?.endpoint) || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string' || sub.keys.p256dh.length > 200 || sub.keys.auth.length > 100) fail('Unsupported push service or invalid subscription');
    db.prepare('DELETE FROM push_subscriptions WHERE session_id=?').run(session);
    db.prepare('INSERT INTO push_subscriptions VALUES(?,?,?)').run(id(), session, JSON.stringify(sub)); audit(db, 'push.subscribed'); return { ok: true };
  }
  if (path === '/api/push/subscribe' && method === 'DELETE') { db.prepare('DELETE FROM push_subscriptions WHERE session_id=?').run(session); return { ok: true }; }
  fail('Unknown push operation');
}
export async function deliverPush(db, key, now = Date.now()) {
  const config = getSecret(db, 'vapid', key); if (!config) return;
  db.prepare(`INSERT OR IGNORE INTO push_deliveries SELECT n.id,s.id,'queued',0,? FROM notifications n CROSS JOIN push_subscriptions s JOIN sessions se ON se.id=s.session_id WHERE n.created_at>? AND se.expires_at>?`).run(now, now - 86400_000, now);
  const due = db.prepare("SELECT d.*,s.subscription FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id JOIN sessions se ON se.id=s.session_id WHERE d.state='queued' AND d.next_attempt<=? AND se.expires_at>? LIMIT 10").all(now, now);
  for (const item of due) {
    const claimed = db.prepare("UPDATE push_deliveries SET state='running',attempts=attempts+1,next_attempt=? WHERE notification_id=? AND subscription_id=? AND state='queued'").run(now + 60_000, item.notification_id, item.subscription_id);
    if (!claimed.changes) continue;
    try {
      await webpush.sendNotification(JSON.parse(item.subscription), JSON.stringify({ title: 'Jarvis', body: 'You have a new result or reminder. Open your private inbox.', tag: item.notification_id }), { vapidDetails: config, TTL: 3600, timeout: 10_000 });
      db.prepare("UPDATE push_deliveries SET state='completed' WHERE notification_id=? AND subscription_id=?").run(item.notification_id, item.subscription_id);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(item.subscription_id);
      else db.prepare('UPDATE push_deliveries SET state=?,next_attempt=? WHERE notification_id=? AND subscription_id=?').run(item.attempts >= 2 ? 'failed' : 'queued', now + 60_000 * 2 ** item.attempts, item.notification_id, item.subscription_id);
    }
  }
  db.prepare("UPDATE push_deliveries SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END WHERE state='running' AND next_attempt<?").run(now);
}
