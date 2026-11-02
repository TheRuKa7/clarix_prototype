// Builds the demo service worker into the built app: node mock/browser/build-sw.mjs <dist dir>
import { build } from 'esbuild';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const out = process.argv[2] || 'dist/demo/browser';
await build({
  entryPoints: [here('./sw.mjs')], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true,
  outfile: `${out}/mock-sw.js`, inject: [here('./globals.mjs')], define: { 'globalThis.__CLARIX_DEMO__': 'true', 'import.meta.url': '"file:///mock/server.mjs"' },
  alias: { 'node:fs': here('./fs.mjs'), 'node:http': here('./http.mjs'), 'node:crypto': here('./crypto.mjs'), 'node:zlib': here('./zlib.mjs') },
  loader: { '.json': 'json' }, logLevel: 'warning',
});
// GitHub Pages serves 404.html for deep links; the app routes from there.
copyFileSync(`${out}/index.html`, `${out}/404.html`);
console.log('demo service worker built in', out);
