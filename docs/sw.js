// DA Logbook service worker: keeps the app shell on the phone so it opens without signal.
// Only same-origin GET requests for the app's own files are handled. API traffic is never touched.
const VERSION = 'dalog-v0.2.2';
const SHELL = ['./', './index.html', './app.js', './vendor/supabase.min.js', './vendor/xlsx.mini.min.js', './manifest.webmanifest', './icon.svg', './icon-180.png', './icon-192.png', './icon-512.png'];
const BASE = new URL('./', self.location.href).pathname;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    // one missing file must not stop the rest from being cached
    await Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => { for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k); await self.clients.claim(); })());
});
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;
  // Network first, and always revalidated with the host ('no-cache' = ask "has this changed?", a cheap 304 when it has not).
  // Without that the browser may reuse its own copy for ten minutes after a new version is published.
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    try {
      let r = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
      if (r.redirected) r = await fetch(req);            // a redirected response may not answer a page navigation
      if (r.ok) c.put(req, r.clone());
      return r;
    }
    catch (err) { return (await c.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await c.match('./index.html') : null) || Response.error(); }
  })());
});
