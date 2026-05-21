// Stock Manager service worker.
//
// Why this exists: Chrome/Edge desktop won't show the "Install app" button
// unless the site has a registered service worker with a `fetch` event
// handler. Mobile browsers are more lenient — the manifest alone is enough
// for "Add to Home Screen". This file is the desktop-install ticket.
//
// What it does today: passes every request straight through to the network.
// No caching. The app is online-only (Supabase data, GitHub Pages assets);
// we don't want to serve stale shells while the team is mid-edit.
//
// What it could do later: cache-first for static assets so the app shell
// opens instantly, then revalidate. Out of scope for this turn.

const VERSION = "v1-2026-05-22";

// Skip the standard "wait for tabs to close" dance — first install should
// claim immediately so the next reload counts as controlled.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Fetch handler is the install-eligibility key. Even an empty handler counts;
// passing through to the network keeps behavior identical to "no SW at all"
// for now.
self.addEventListener("fetch", (event) => {
  // Default behavior — fetch from the network. No event.respondWith() means
  // the browser handles it as normal. This still registers with Chrome as
  // "has a fetch event handler", which is all the install check needs.
  void event;
});

// Bumping VERSION on each meaningful change forces clients to re-evaluate
// and pick up the new SW.
void VERSION;
