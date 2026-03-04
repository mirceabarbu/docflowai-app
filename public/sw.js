/**
 * DocFlowAI — Service Worker pentru Push Notifications
 * Versiune: 1.0
 */

const CACHE_NAME = 'docflowai-v1';

self.addEventListener('install', (e) => {
  console.log('[SW] Instalat');
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  console.log('[SW] Activat');
  e.waitUntil(self.clients.claim());
});

// ── Push handler ─────────────────────────────────────────────────────────
self.addEventListener('push', (e) => {
  let data = { title: 'DocFlowAI', body: 'Ai o notificare nouă.' };
  try { if (e.data) data = e.data.json(); } catch(err) {}
  const opts = {
    body: data.body || 'Notificare nouă',
    icon: data.icon || '/favicon.ico',
    badge: data.badge || '/favicon.ico',
    tag: data.type || 'docflowai',
    data: data.data || {},
    requireInteraction: data.type === 'YOUR_TURN', // persistent pentru documente de semnat
    actions: data.type === 'YOUR_TURN'
      ? [{ action: 'open', title: 'Deschide' }, { action: 'dismiss', title: 'Ignoră' }]
      : [],
  };
  e.waitUntil(self.registration.showNotification(data.title || 'DocFlowAI', opts));
});

// ── Notification click handler ────────────────────────────────────────────
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  const flowId = e.notification.data?.flowId;
  const url = flowId ? `/flow.html?flow=${flowId}` : '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
