import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/core/app/app.component';
import { environment } from './environments/environment';

/**
 * Demo build only: a link with `download` is fetched by the browser's own download code, which does not ask the
 * service worker, so it would save the host's "not found" page. Fetch the file through the worker and save the bytes.
 */
function saveDemoDownloads(): void {
  const prefix = new URL('./__mock/', document.baseURI).href;
  document.addEventListener('click', async (event) => {
    const link = (event.target as Element | null)?.closest?.('a[href][download]') as HTMLAnchorElement | null;
    if (!link || link.dataset['demoSaved'] || !link.href.startsWith(prefix)) return;
    event.preventDefault();
    const res = await fetch(link.href);
    const name = /filename="?([^";]+)"?/.exec(res.headers.get('Content-Disposition') || '')?.[1] || link.getAttribute('download') || link.pathname.split('/').pop() || 'download';
    const saved = document.createElement('a');
    saved.href = URL.createObjectURL(await res.blob()); saved.download = name; saved.dataset['demoSaved'] = '1';
    document.body.appendChild(saved); saved.click(); saved.remove();
    setTimeout(() => URL.revokeObjectURL(saved.href), 4000);
  }, true);
}

/** Demo build only: start the in-browser mock before the app makes its first call. */
async function startDemoMock(): Promise<void> {
  // Single file build (mock/browser/build-single.mjs): the mock already answers inside the page.
  if (!environment.demo || (globalThis as any).__SINGLE_FILE__ || !('serviceWorker' in navigator)) return;
  saveDemoDownloads();
  await navigator.serviceWorker.register(new URL('mock-sw.js', document.baseURI));
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((done) => navigator.serviceWorker.addEventListener('controllerchange', done, { once: true }));
  }
}

startDemoMock()
  .then(() => bootstrapApplication(AppComponent, appConfig))
  .catch((err) => console.error(err));
