// Never cache authenticated API responses or private conversations.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let data = { title: 'Jarvis', body: 'Open Jarvis to see your notification.' };
  try { data = { ...data, ...e.data.json() }; } catch { /* Generic notification. */ }
  e.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: '/assistant/icon.svg', tag: data.tag || 'jarvis', data: { url: '/assistant/#inbox' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close(); e.waitUntil(self.clients.matchAll({ type: 'window' }).then(clients => {
    const client = clients.find(c => new URL(c.url).origin === self.location.origin);
    if (client) { client.navigate('/assistant/#inbox'); return client.focus(); }
    return self.clients.openWindow('/assistant/#inbox');
  }));
});
