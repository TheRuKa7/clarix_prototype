// Demo service worker: answers the app's API calls with the local mock, in the browser.
// Data lives in memory, so it resets when the browser stops the worker.
import { Buffer } from 'buffer';
import { handler, casHandler, genbiHandler } from '../server.mjs';

const scope = new URL(self.registration.scope).pathname;
const BASES = [
  { prefix: `${scope}__mock/api`, serve: handler },
  { prefix: `${scope}__mock/cas`, serve: casHandler },
  { prefix: `${scope}__mock/genbi`, serve: genbiHandler },
  { prefix: `${scope}__mock/finance`, serve: handler },
];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  const base = BASES.find((b) => url.pathname.startsWith(b.prefix));
  if (base) return e.respondWith(answer(e.request, url, base));
  // App routes load the app shell, so deep links and reloads answer 200 instead of the 404 page.
  if (e.request.mode === 'navigate' && url.pathname.startsWith(scope) && !/\.[a-z0-9]+$/i.test(url.pathname)) e.respondWith(fetch(`${scope}index.html`));
});

async function answer(request, url, base) {
  const body = Buffer.from(await request.arrayBuffer());
  const headers = Object.fromEntries(request.headers.entries());
  return new Promise((resolve) => {
    const listeners = {};
    const req = { method: request.method, url: url.pathname.slice(base.prefix.length) + url.search, headers, on: (ev, fn) => { listeners[ev] = fn; } };
    let status = 200, head = {};
    const res = {
      writeHead: (s, h = {}) => { status = s; head = h; },
      setHeader: (k, v) => { head[k] = v; },
      end: (b) => resolve(new Response(status === 204 || b === undefined ? null : b, { status, headers: head })),
    };
    base.serve(req, res);
    if (body.length) listeners.data?.(body);
    listeners.end?.();
  });
}
