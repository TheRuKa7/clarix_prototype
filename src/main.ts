import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/core/app/app.component';
import { environment } from './environments/environment';

/** Demo build only: start the in-browser mock before the app makes its first call. */
async function startDemoMock(): Promise<void> {
  if (!environment.demo || !('serviceWorker' in navigator)) return;
  await navigator.serviceWorker.register(new URL('mock-sw.js', document.baseURI));
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((done) => navigator.serviceWorker.addEventListener('controllerchange', done, { once: true }));
  }
}

startDemoMock()
  .then(() => bootstrapApplication(AppComponent, appConfig))
  .catch((err) => console.error(err));
