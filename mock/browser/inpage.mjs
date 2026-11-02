// Single file build: the mock backend runs inside the page instead of a service worker, so the whole
// prototype works from one HTML file opened straight from disk (no server, no install).
// API calls go to a made up origin; fetch, downloads, new tabs and media that point at it are answered here.
import { Buffer } from 'buffer';
import { handler, casHandler, genbiHandler } from '../server.mjs';

export const ORIGIN = 'https://clarix.local';
const BASES = [
  { prefix: '/__mock/api', serve: handler },
  { prefix: '/__mock/cas', serve: casHandler },
  { prefix: '/__mock/genbi', serve: genbiHandler },
  { prefix: '/__mock/finance', serve: handler },
];
installInPageBackend(ORIGIN, BASES);

export function installInPageBackend(origin, bases) {
  const realFetch = window.fetch.bind(window);
  const isMock = (u) => typeof u === 'string' && u.startsWith(origin + '/');
  const baseOf = (url) => bases.find((b) => url.pathname.startsWith(b.prefix));

  async function answer(request) {
    const url = new URL(request.url); const base = baseOf(url);
    if (!base) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    const body = Buffer.from(request.method === 'GET' || request.method === 'HEAD' ? new ArrayBuffer(0) : await request.arrayBuffer());
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
  window.fetch = (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return isMock(href) ? answer(new Request(input, init)) : realFetch(input, init);
  };

  const nameOf = (res, fallback) => /filename="?([^";]+)"?/.exec(res.headers.get('Content-Disposition') || '')?.[1] || fallback;
  async function blobOf(href) { const res = await answer(new Request(href)); return { blob: await res.blob(), res }; }
  async function save(href, name) {
    const { blob, res } = await blobOf(href); const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = nameOf(res, name || href.split('/').pop().split('?')[0] || 'download'); a.dataset.inpage = '1';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  // Download links and plain links that point at the backend.
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!a || a.dataset.inpage || !isMock(a.href)) return;
    e.preventDefault(); save(a.href, a.getAttribute('download') || '');
  }, true);

  // Pages opened in a new tab: backend files open as a blob; app pages open this same file at that route.
  const realOpen = window.open.bind(window);
  window.open = (url, ...rest) => {
    const href = String(url ?? '');
    if (isMock(href)) { blobOf(href).then(({ blob }) => realOpen(URL.createObjectURL(blob), ...rest)); return null; }
    if (href.startsWith('/')) return realOpen(`${location.href.split('#')[0]}#${href}`, ...rest);
    return realOpen(url, ...rest);
  };

  // Recordings: audio and video elements pointed at the backend get the bytes as a blob.
  const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  const load = (el, value) => { el.__inpage = value; blobOf(value).then(({ blob }) => { if (el.__inpage === value) src.set.call(el, URL.createObjectURL(blob)); }); };
  Object.defineProperty(HTMLMediaElement.prototype, 'src', {
    configurable: true, enumerable: true,
    get() { return this.__inpage || src.get.call(this); },
    set(value) { if (isMock(String(value))) load(this, String(value)); else { this.__inpage = null; src.set.call(this, value); } },
  });
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (this instanceof HTMLMediaElement && name === 'src' && isMock(String(value))) return load(this, String(value));
    return setAttribute.call(this, name, value);
  };
}
