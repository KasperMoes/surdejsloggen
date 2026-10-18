// Surdejsloggen – gør appen tilgængelig uden internet.
// Hæv versionsnummeret, når du lægger en ny udgave op, så telefonerne henter den.
const CACHE = "surdejsloggen-v13";
const FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./vendor/supabase.js",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./fonts/dm-serif-display-latin-400-normal.woff2",
  "./fonts/dm-sans-latin-400-normal.woff2",
  "./fonts/dm-sans-latin-500-normal.woff2",
  "./fonts/dm-sans-latin-700-normal.woff2"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    // Siden selv: prøv nettet først, så nye udgaver kommer frem; ellers den gemte.
    e.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put("./index.html", copy)); return res; })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});

// Push-beskeder (venneanmodninger og nye bagninger fra venner)
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: "Surdejsloggen", body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Surdejsloggen", {
    body: d.body || "",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    data: { url: d.url || "./" },
    tag: d.tag || undefined
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.registration.scope)) { await c.focus(); c.postMessage({ type: "open", url }); return; }
    }
    await self.clients.openWindow(url);
  })());
});
