// `npm run start:prod`: today's live Clarix (the built files copied from clarix.moglix.com
// into prod/) served against the local mock. Nothing reaches the real backend: the live API
// origins are rewritten to the mock. Open http://localhost:4340/__local/signin to sign in.
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import './server.mjs'; // starts the mock on :8081 (api) and :9000 (cas)

const APP_PORT = Number(process.env.CLARIX_PROD_PORT || 4340);
const API_PORT = Number(process.env.CLARIX_API_PORT || 8081);
const CAS_PORT = Number(process.env.CLARIX_CAS_PORT || 9000);
const DIR = fileURLToPath(new URL('../prod/', import.meta.url));
const REWRITE = [
  ['https://clarixapi.moglix.com', `http://localhost:${API_PORT}`],
  // Finance gateway is configured in the live build but not used by these screens; point it at the mock too.
  ['https://fingateway.moglix.com', `http://localhost:${API_PORT}`],
  // Profile photo lookup: the mock answers 404, so the avatar shows initials as it does without a photo.
  ['https://graph.microsoft.com', `http://localhost:${API_PORT}`],
];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

// Same-origin paths the app (or the local sign-in page) calls: hand them to the mock.
function proxy(req, res, port) {
  const up = http.request({ host: 'localhost', port, path: req.url, method: req.method, headers: { ...req.headers, host: `localhost:${port}` } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end('Mock not running'); });
  req.pipe(up);
}

http.createServer((req, res) => {
  if (req.url.startsWith('/__local/')) return proxy(req, res, API_PORT);
  if (req.url.startsWith('/cas/')) return proxy(req, res, CAS_PORT);
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[\\/]+/, '');
  let file = join(DIR, path);
  // App routes (no file extension) get the app shell, like nginx try_files.
  if (!file.startsWith(DIR) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIR, 'index.html');
  let body = readFileSync(file);
  if (file.endsWith('.js')) { let s = body.toString('utf8'); for (const [a, b] of REWRITE) s = s.split(a).join(b); body = Buffer.from(s); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
}).listen(APP_PORT, () => console.log(`[clarix-prod] live Clarix on http://localhost:${APP_PORT} (mock data). Sign in: http://localhost:${APP_PORT}/__local/signin`));
