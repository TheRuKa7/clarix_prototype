# Clarix prototype

Clarix: run calling campaigns with your agents, follow every call and download the results.
This is a clickable prototype for developers. It matches the local build exactly.

**Live demo:** https://theruka7.github.io/clarix_prototype/ (signs you in to a demo workspace automatically;
Microsoft sign in is off in the demo)

## What to look at

- **Campaigns**: New campaign popup (pick an agent, download its template, upload the sheet), progress by call
  status, campaign page with every call.
- **Call page**: outcome first: answers, dials, details. Built for business users, not engineers.
- **Dashboard** (first in the side bar) and reports: call analytics, execution sheets, call logs. No page header; each page carries its own title.
- **Side bar**: hover to open, pin, theme switch (system, light, dark).

## How the demo works

There is no backend. A service worker (`mock/browser/sw.mjs`) runs the local mock (`mock/server.mjs`) inside the
browser and answers every API call under the app's own path (`__mock/...`). All data is invented sample data.

- Data lives in memory. It resets when the browser stops the worker (usually after a few idle minutes) or when you
  clear site data.
- Calls are simulated: dials, ringing, answers, statuses and retries play out over seconds, not real minutes.
- Nothing is dialled and nothing leaves the browser.

## Run locally

```bash
npm ci
npm run start:local      # mock backend + dev server, same data as the demo
npm run build:demo       # the static demo, as deployed (output: dist/demo/browser)
npm run build:single     # the whole prototype as ONE html file that opens from disk, no server (output: dist/*-Prototype.html)
```

## Design system

Colours, type, components, motion and the checks before merging: `docs/DESIGN-SYSTEM.md`. Paste `docs/ui-audit.js` into the
browser console to check contrast, clipped text and sideways scroll on any page.

## Checks

- `node mock/e2e-pi.mjs` (Echo): PI end to end against `npm run mock`.
- `node mock/e2e-status.mjs` (Echo): Ozonetel to Echo to Clarix status run with scripted Ozonetel results; needs the Echo and Clarix mocks running with
  `ECHO_API_PORT=18090 CLARIX_URL=http://localhost:18081` and `CLARIX_API_PORT=18081 ECHO_URL=http://localhost:18090`.

## Deploy

Every push to `main` runs `.github/workflows/pages.yml`: `npm ci`, `npm run build:demo`, then GitHub Pages.

## Pointing at a real backend

Hosts live in `src/environments/`. The values here are placeholders; set your own before a real build
(`npm run build`). Never commit real keys or tenant ids.
