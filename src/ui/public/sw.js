// Installable window for the Studio server on this machine.
// index.html carries a launch token that changes every start, so nothing is cached.
// Slides, git, export, and AI all need that Node process.
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
