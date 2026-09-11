const CACHE_NAME = 'wingo-v13-flat100';
const ASSETS = [
  './',
  './index.html',
  './index.css?v=flat100-20260911',
  './app.js?v=flat100-20260911',
  './manifest.json',
  './icon.png'
];

// Install Service Worker and cache essential assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Pre-caching offline assets');
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate Service Worker and clear old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Removing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Assets from Cache first, fallback to network
self.addEventListener('fetch', (event) => {
  // Only intercept HTTP/S requests, ignore browser extension schemes
  if (!event.request.url.startsWith(self.location.origin)) return;

  // Let API proxy requests go straight to the network without caching
  if (event.request.url.includes('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Fetch new version in background to update cache
        fetch(event.request).then((networkResponse) => {
          if (networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
          }
        }).catch(() => {/* Offline */});
        
        return cachedResponse;
      }
      return fetch(event.request);
    })
  );
});

// Handle notification actions (e.g. click to focus window)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If window is open, focus it
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // If window is closed, open the app
      if (clients.openWindow) {
        return clients.openWindow('./');
      }
    })
  );
});
