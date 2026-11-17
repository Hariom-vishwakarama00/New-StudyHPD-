// StudyHPD: offline mode was removed. This file is a kill-switch for phones that installed the old
// offline service worker. When their browser checks for an update it gets this version, which:
//   install  -> takes over at once (skipWaiting)
//   activate -> deletes ALL caches (app shell, saved lists, saved PDFs), unregisters itself,
//               and reloads open StudyHPD pages once so they load fresh from the network.
// It has no fetch handler, so it never answers a request. Served with Cache-Control: no-cache by _worker.js.
self.addEventListener("install", () => self.skipWaiting());
const wipe = async () => { try { const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); } catch (er) {} };
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    await wipe();
    try { await self.clients.claim(); } catch (er) {}
    try { await self.registration.unregister(); } catch (er) {}
    try {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      await Promise.all(list.map(c => (c.navigate ? c.navigate(c.url) : null)).map(p => p && p.catch(() => {})));
    } catch (er) {}
    // the old worker can still be finishing a cache write it started just before; sweep once more
    await new Promise(r => setTimeout(r, 4000)); await wipe();
  })());
});
