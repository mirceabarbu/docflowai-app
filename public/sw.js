/**
 * DocFlowAI — Service Worker v2.0
 * - Push Notifications (existent)
 * - PWA Offline: cache-first pentru assets statice, network-first pentru API
 * - Offline fallback pentru HTML pages
 */

const CACHE_VERSION = 'docflowai-v85';
const CACHE_STATIC = `${CACHE_VERSION}-static`;

// Assets de pre-cacheuit la install
const PRECACHE_ASSETS = [
  '/login.html',
  '/flow.html',
  '/Logo.png',
  '/icon-192.png',
  '/icon-72.png',
  '/mobile.css',
  '/notif-widget.js',
  '/js/df-utils.js',
  '/js/admin/users.js',
  '/js/admin/flows.js',
  '/js/admin/archive.js',
  '/js/admin/audit.js',
  '/js/admin/activity.js',
  '/js/admin/outreach.js',
  '/js/admin/primarii.js',
  '/js/admin/organizations.js',
  '/js/admin/analytics.js',
  '/offline.html',
];

// ── Install: pre-cache assets ─────────────────────────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_STATIC).then(cache => {
      // Ignorăm erorile individuale — assets pot lipsi în dev
      return Promise.allSettled(
        PRECACHE_ASSETS.map(url => cache.add(url).catch(() => null))
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: curăță cache-uri vechi ─────────────────────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('docflowai-') && k !== CACHE_STATIC)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: strategie diferită per tip request ─────────────────────────────
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Ignorăm: alte origini, WebSocket, POST/DELETE (nu se cachează)
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;

  // API calls → Network-first (cu fallback la cache dacă offline)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') ||
      url.pathname.startsWith('/flows/') || url.pathname.startsWith('/admin/')) {
    e.respondWith(networkFirst(e.request));
    return;
  }

  // Assets statice — CSS/JS: stale-while-revalidate (update în background)
  // Imagini/fonturi: cache-first (se schimbă rar)
  if (/\.(css|js)$/.test(url.pathname)) {
    e.respondWith(staleWhileRevalidate(e.request));
    return;
  }
  if (/\.(png|ico|jpg|jpeg|svg|woff|woff2)$/.test(url.pathname)) {
    e.respondWith(cacheFirst(e.request));
    return;
  }

  // HTML pages → Network-first cu fallback offline
  if (url.pathname.endsWith('.html') || url.pathname === '/') {
    e.respondWith(networkFirstWithOfflineFallback(e.request));
    return;
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(request, response.clone());
    }
    return response;
  } catch(e) {
    return new Response('Offline — asset indisponibil', { status: 503 });
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const networkFetch = fetch(request).then(response => {
    if (response.ok) {
      caches.open(CACHE_STATIC).then(cache => cache.put(request, response.clone()));
    }
    return response;
  }).catch(() => cached);
  return cached || networkFetch;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(request, response.clone());
    }
    return response;
  } catch(e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline', message: 'Nu există conexiune la internet.' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function networkFirstWithOfflineFallback(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(request, response.clone());
    }
    return response;
  } catch(e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Fallback la pagina offline
    const offline = await caches.match('/offline.html');
    if (offline) return offline;
    return new Response('<h1>Offline</h1><p>Nu există conexiune. Reîncarcă pagina când ai internet.</p>', {
      status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
}

// ── Push handler ─────────────────────────────────────────────────────────
self.addEventListener('push', (e) => {
  let data = { title: 'DocFlowAI', body: 'Ai o notificare nouă.' };
  try { if (e.data) data = e.data.json(); } catch(err) {}
  const opts = {
    body: data.body || 'Notificare nouă',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-72.png',
    tag: data.type || 'docflowai',
    data: data.data || {},
    requireInteraction: data.type === 'YOUR_TURN',
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
