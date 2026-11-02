# Local mock backend

Runs the live Clarix UI code unchanged on your machine, with no access to the
real backend, Microsoft sign in or the database.

```
npm ci
npm run start:local        # mock on :8081 (api), :9000 (CAS), :8000 (GenBI); app on http://localhost:4310
```

Then open **http://localhost:4310/__local/signin** once. It stores a local
session in the browser (the same place the real sign in stores it) and opens
Sheets. The session lasts 30 days. Microsoft sign in does not work locally.

## Files

| File | What it does |
| --- | --- |
| `server.mjs` | Serves every endpoint in `src/app/enpoints.service.ts` from memory, plus the local sign in page. |
| `scenario.json` | Same synthetic data as the Echo mock (copied from its `mock/` folder). Clarix run ids equal Echo contact ids. |
| `xlsx.mjs` | Tiny .xlsx reader and writer for uploads and reports. |
| `proxy.local.json` | Dev server proxy so `/__local/signin` runs on the app's own origin. |
| `dev.mjs` | Starts the mock and `ng serve` together. |

## Behaviour

Two behaviours, picked with `MOCK_BEHAVIOUR` (use the same value for both mocks):

- `target` (default, for demos): Echo sends its status, result, reason, attempt
  and answers for every change (PRD-ECHO-11). Runs show "No answer", "Busy",
  "Completed: hung up early" and so on; campaigns finish; no endless status
  checks. Agents saved in Echo update their setup here (Basic, Input, Report).
- `live`: today's live gaps. Exchange rows that never connect stay IN_PROGRESS
  with a STATUS_SYNC every 30 minutes for ever; completed rows have no
  transcript, duration or answers; "Answered" shows 100%.

An older Voxera batch shows the richer data Voxera used to send.

## Running with the Echo mock

Start both (`echo-live` and `clarix-live` in `.claude/launch.json`). A sheet
uploaded in Clarix is handed to the Echo mock (`ECHO_URL`, default
http://localhost:8090), which creates a Clarix campaign and dials it. For each
connected call Echo posts `{referenceId, status: "COMPLETED"}` back, exactly as
live. Without the Echo mock, Clarix simulates the same result on its own.

State lives in memory. Restart to reset.
