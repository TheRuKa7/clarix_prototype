// Builds the GitHub Pages copy of the live clone: the live build in prod/ plus the mock in a
// service worker, with the live API hosts and Microsoft sign-in ids taken out.
//   node mock/browser/build-prod-site.mjs [out=site] [base=/clarix_prototype/]
// ESBUILD_PATH / NODE_PATH may point at an esbuild and node_modules outside this repo.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { build } = await import(process.env.ESBUILD_PATH ? pathToFileURL(process.env.ESBUILD_PATH).href : 'esbuild');
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const OUT = process.argv[2] || 'site';
const BASE = process.argv[3] || '/clarix_prototype/';
const PROD = here('../../prod/');

// The build's backend bases -> the service worker's mock paths, matched by setting name so the live hosts
// are never written here. The Microsoft sign-in ids are blanked.
const REWRITE = [
  [/clarix:\{baseURL:"https:\/\/[^"]+"/g, `clarix:{baseURL:"${BASE}__mock/api"`],
  [/(finance(?:Ap|Ar):\{baseURL:)"https:\/\/[^/"]+/g, `$1"${BASE}__mock/finance`],
  [/"https:\/\/graph\.microsoft\.com/g, `"${BASE}__mock/api`],
  [/baseUrl:"\/cas\/api\/v1"/g, `baseUrl:"${BASE}__mock/cas"`],
  [/(KEY:"|tenentId:"|microsoftonline\.com\/)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '$100000000-0000-0000-0000-000000000000'],
];
// Any other https host left in the app or the mock fails the build, apart from these public ones.
const PUBLIC_HOSTS = ['angular.dev', 'www.w3.org', 'fonts.googleapis.com', 'fonts.gstatic.com', 'example.com',
  'login.microsoftonline.com', 'alcdn.msauth.net', 'accounts.google.com', 'developers.google.com', // sign-in libraries
  'erp.internal', // a placeholder in the Data Functions form
  'schemas.openxmlformats.org', 'purl.org', 'schemas.microsoft.com', // .xlsx XML namespaces
  'feross.org']; // the buffer package's licence comment
const liveHost = (s) => [...s.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase()).find((h) => !PUBLIC_HOSTS.some((p) => h === p || h.endsWith('.' + p)));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let main = '';
for (const f of readdirSync(PROD)) {
  if (f.endsWith('.js')) {
    let s = readFileSync(PROD + f, 'utf8');
    for (const [a, b] of REWRITE) s = s.replace(a, b);
    if (liveHost(s)) throw new Error(`${f} still names a live host: ${liveHost(s)}`);
    writeFileSync(`${OUT}/${f}`, s);
    if (f.startsWith('main-')) main = f;
  } else if (f !== 'index.html') copyFileSync(PROD + f, `${OUT}/${f}`);
}

// The local session the app restores at start (same shape as /__local/signin in the mock).
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const session = (exp) => ({
  user: { userId: 'admin@example.com', microsoftId: 'local', email: 'admin@example.com', name: 'Local Admin', displayName: 'Local Admin', photoUrl: null, roles: ['ADMIN'], permissions: [],
    countries: [{ idCountry: 356, name: 'India', countryCode: 91, idSubsidiary: 1, subsidiary: 'Local', idCurrency: 1, currency: 'INR', idTaxType: 1, taxType: 'GST' }] },
  tokens: { microsoftToken: 'local', casToken: `${b64({ alg: 'none' })}.${b64({ sub: 'admin@example.com', exp: Math.floor(exp / 1000) })}.local`, expiresAt: exp },
  savedAt: 0,
});
const exp = Date.UTC(2099, 0, 1);
// Start the mock first, sign in locally, then load the app.
const boot = `<script>
(async () => {
  const base = document.baseURI;
  // GitHub Pages answers every unknown path with this page, including deep links into next/: send those to next/.
  const next = new URL('next/', base);
  if (location.pathname.startsWith(next.pathname)) { location.replace(next.href); return; }
  try {
    const reg = await navigator.serviceWorker.register(new URL('mock-sw.js', base), { scope: new URL('./', base).pathname });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  } catch (e) { document.body.textContent = 'This demo needs a browser with service workers.'; return; }
  await new Promise((done) => {
    const r = indexedDB.open('clarix-db', 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('auth')) r.result.createObjectStore('auth'); };
    r.onsuccess = () => { const tx = r.result.transaction('auth', 'readwrite'); const st = tx.objectStore('auth'); const g = st.get('session');
      g.onsuccess = () => { if (!g.result) st.put(${JSON.stringify(session(exp))}, 'session'); }; tx.oncomplete = done; tx.onerror = done; };
    r.onerror = done;
  });
  const s = document.createElement('script'); s.type = 'module'; s.src = '${main}'; document.body.appendChild(s);
})();
</script>`;
let html = readFileSync(PROD + 'index.html', 'utf8')
  .replace('<base href="/">', `<base href="${BASE}">`)
  .replace(new RegExp(`<script src="${main}" type="module"></script>`), boot);
if (!html.includes('mock-sw.js')) throw new Error('index.html: app script tag not found');
writeFileSync(`${OUT}/index.html`, html);
// GitHub Pages serves 404.html for deep links; it boots the same app.
copyFileSync(`${OUT}/index.html`, `${OUT}/404.html`);

await build({
  entryPoints: [here('./sw.mjs')], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true,
  outfile: `${OUT}/mock-sw.js`, inject: [here('./globals.mjs')], define: { 'globalThis.__CLARIX_DEMO__': 'true', 'import.meta.url': '"file:///mock/server.mjs"' },
  alias: { 'node:fs': here('./fs.mjs'), 'node:http': here('./http.mjs'), 'node:crypto': here('./crypto.mjs'), 'node:zlib': here('./zlib.mjs') },
  nodePaths: process.env.NODE_PATH ? process.env.NODE_PATH.split(';') : [],
  loader: { '.json': 'json' }, logLevel: 'warning',
});
const sw = readFileSync(`${OUT}/mock-sw.js`, 'utf8');
if (liveHost(sw)) throw new Error(`mock-sw.js names a live host: ${liveHost(sw)}`);
console.log(`Pages site built in ${OUT} for ${BASE}`);
