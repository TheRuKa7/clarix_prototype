/**
 * Public demo build (`npm run build:demo`): no backend and no Microsoft sign in.
 * A service worker (mock/browser/sw.mjs) answers every API call with the local
 * mock, in the browser, under the app's own path.
 */
// One file opened from disk has no address of its own: calls go to a made up origin the page answers itself.
const base = (globalThis as any).__SINGLE_FILE__ ? 'https://clarix.local/__mock/' : new URL('./__mock/', document.baseURI).href;

export const environment = {
  production: true,
  demo: true,
  microsoft: { KEY: '', authorityUrl: '', tenentId: '' },
  backendServices: {
    financeAp: { baseURL: base + 'finance' },
    financeAr: { baseURL: base + 'finance' },
    clarix: { baseURL: base + 'api' },
    genbi: { baseURL: base + 'genbi' },
  },
  casApi: { baseUrl: base + 'cas/api/v1' },
  genbiApi: { baseUrl: '/api/v1' },
  features: { genbi: true, workflows: true, analytics: true },
};
