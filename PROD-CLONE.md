# Clarix demo: the live app on sample data

https://theruka7.github.io/clarix_prototype/ runs today's live Clarix screens (build of 30 Oct 2026) against the mock in this repo. Nothing on it talks to a real backend.

- `site/` is what Pages serves: the live app's built files, plus `mock-sw.js`, a service worker that answers every API call with `mock/server.mjs` inside the browser. The app's backend addresses point at that worker, and the Microsoft sign-in ids are blanked.
- The page signs in on its own as a local admin. Data is synthetic and resets when the browser restarts the worker.
- The source under `src/` is an older prototype; `site/` does not use it.
- Rebuild `site/` with `node mock/browser/build-prod-site.mjs site /clarix_prototype/`. It needs the live build in `prod/`, which is kept locally and not committed.

## What the mock adds for the live screens

Overview and Call Logs (`/api/v1/dashboard/voice`, `/calls`, `/calls/values`, `/calls.xlsx`), the campaign page's call data and results (`/workflows/sheets/:id/campaign`, `/results.xlsx`), Execution Reports with mail schedules, data functions, permission and module editing, and orchestration "Preview matching".

## Known gaps

- Microsoft sign-in is not available.
- Names, numbers and counts are sample data.
- Report e-mails and data function tests are simulated.
