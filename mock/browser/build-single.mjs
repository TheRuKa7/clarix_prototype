// Packs the built demo into ONE html file that runs from disk: node mock/browser/build-single.mjs <dist dir> <out file> <flag name>
// Everything is inlined: the app (all chunks in one script), the styles, the fonts, the icons and the mock backend,
// which runs inside the page (mock/browser/inpage.mjs). Routing switches to the # style so file:// works.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const dist = process.argv[2] || 'dist/frontend/browser';
const outFile = process.argv[3] || 'dist/Echo-Prototype.html';
const demoFlag = process.argv[4] || '__ECHO_DEMO__';
const MIME = { '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const dataUri = (file) => `data:${MIME[path.extname(file)]};base64,${readFileSync(file).toString('base64')}`;
const safe = (js) => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

// 1. The backend, in the page.
const mock = (await build({
  entryPoints: [here('./inpage.mjs')], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true, write: false,
  inject: [here('./globals.mjs')], define: { [`globalThis.${demoFlag}`]: 'true', 'import.meta.url': '"file:///mock/server.mjs"' },
  alias: { 'node:fs': here('./fs.mjs'), 'node:http': here('./http.mjs'), 'node:crypto': here('./crypto.mjs'), 'node:zlib': here('./zlib.mjs') },
  loader: { '.json': 'json' }, logLevel: 'warning',
})).outputFiles[0].text;

// 2. The app: every chunk in one classic script, in the order the page loads them.
let html = readFileSync(`${dist}/index.html`, 'utf8');
const files = readdirSync(dist);
const scripts = [...html.matchAll(/<script src="([^"]+)" type="module"><\/script>/g)].map((m) => m[1]);
const worker = files.find((f) => /^worker-.*\.js$/.test(f));
const bundles = [];
for (const s of scripts) {
  let code = (await build({ entryPoints: [`${dist}/${s}`], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: false, write: false,
    define: { 'import.meta.url': 'document.baseURI' }, logLevel: 'error' })).outputFiles[0].text;
  // A web worker file cannot be loaded from disk: start it from its own source instead.
  if (worker) code = code.replace(/new URL\("worker-[^"]+\.js",\s*document\.baseURI\)/g, 'URL.createObjectURL(new Blob([window.__WORKER_SRC__], { type: "text/javascript" }))');
  bundles.push(code);
}

// 3. Images the app points at by name become data, wherever the name is quoted.
const assets = files.filter((f) => MIME[path.extname(f)] && statSync(`${dist}/${f}`).size < 400_000);
const inlineAssets = (text) => assets.reduce((t, f) => t.replace(new RegExp(`(["'\`(=])(?:\\.?/)?${f.replace(/[.]/g, '\\.')}(?=["'\`)])`, 'g'), (_, q) => q + dataUri(`${dist}/${f}`)), text);

// 4. Styles and fonts. Font files are fetched once at build time and embedded, so the file looks the same offline.
let css = [...html.matchAll(/<link rel="stylesheet" href="([^"]+\.css)"[^>]*>/g)].map((m) => readFileSync(`${dist}/${m[1]}`, 'utf8')).join('\n');
const cacheFile = here('./.fonts.json'); const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
async function embedFonts(text) {
  for (const url of new Set([...text.matchAll(/https:\/\/fonts\.gstatic\.com\/[^)"'\s]+/g)].map((m) => m[0]))) {
    try { cache[url] ||= Buffer.from(await (await fetch(url)).arrayBuffer()).toString('base64'); text = text.split(url).join(`data:font/woff2;base64,${cache[url]}`); }
    catch (e) { console.warn('font not embedded (offline build?):', url, e.message); }
  }
  return text;
}
// The builder may have left a link to the font stylesheet, or already inlined its @font-face rules: handle both.
const fontLink = /<link[^>]+href="(https:\/\/fonts\.googleapis\.com\/css2[^"]+)"[^>]*>/s.exec(html)?.[1]?.replace(/&amp;/g, '&');
let fonts = '';
if (fontLink) { try { fonts = cache[fontLink] ||= await (await fetch(fontLink, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' } })).text(); } catch (e) { console.warn('font stylesheet not fetched:', e.message); } }
fonts = await embedFonts(fonts); html = await embedFonts(html); css = await embedFonts(css);
writeFileSync(cacheFile, JSON.stringify(cache));

// 5. One document.
html = html
  .replace(/<base href="[^"]*"\s*\/?>/, '')
  .replace(/<link rel="(?:manifest|apple-touch-icon|preconnect|modulepreload)"[^>]*>\s*/g, '')
  .replace(/<link[^>]+fonts\.googleapis\.com\/css2[^>]*>\s*/s, '')
  .replace(/<meta property="og:image"[^>]*>\s*/g, '')
  .replace(/<link rel="stylesheet" href="[^"]+\.css"[^>]*>(<noscript>.*?<\/noscript>)?/g, '')
  .replace(/<script src="[^"]+" type="module"><\/script>/g, '')
  .replace(/<link rel="icon"[^>]*href="([^"]+)"[^>]*>/g, (m, f) => (existsSync(`${dist}/${f}`) && MIME[path.extname(f)] ? m.replace(f, dataUri(`${dist}/${f}`)) : ''));
const note = `<!--
  ${path.basename(outFile)}: the whole prototype in one file. Double click to open; nothing to install and no internet needed.
  The data is invented sample data kept in memory: it starts fresh every time the file is opened or reloaded.
  Phone calls are simulated. Nothing is dialled and nothing leaves this computer.
-->`;
const head = `<script>window.__SINGLE_FILE__ = true;${worker ? `window.__WORKER_SRC__ = ${JSON.stringify(readFileSync(`${dist}/${worker}`, 'utf8'))};` : ''}</script>\n<style>${fonts}${inlineAssets(css)}</style>`;
// Function replacers: the inlined code is full of $ signs, which a replacement string would treat as patterns.
const body = `<script>${safe(mock)}</script>\n${bundles.map((b) => `<script>${safe(inlineAssets(b))}</script>`).join('\n')}\n</body>`;
html = html.replace(/<!doctype html>/i, () => `<!doctype html>\n${note}`).replace('</head>', () => `${head}\n</head>`).replace('</body>', () => body);
if (/fonts\.g(static|oogleapis)\.com/.test(html)) console.warn('warning: the file still points at online fonts');
mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, html);
console.log(`single file built: ${outFile} (${(Buffer.byteLength(html) / 1048576).toFixed(1)} MB)`);
