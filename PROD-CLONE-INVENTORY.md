# Clarix prod clone: inventory (30 Oct 2026)

Local clone of https://clarix.moglix.com, frontend only.

## How it works

- This folder is the `TheRuKa7/clarix_prototype` repo from GitHub (main branch, downloaded 30 Oct 2026), rebuilt here after the earlier copy under `Products/clarix-clarix-revamp-new-ui` was deleted.
- `prod/` holds the live Clarix build, copied from the live site on 30 Oct 2026 (`index.html`, `main-UZGW6STF.js`, `styles-P5J64YMI.css`, favicons, manifest). The saved pages under `Products/Clarix/clarix.moglix.com` use the same build.
- `mock/prod.mjs` serves `prod/` on http://localhost:4340 and starts the mock backend (`mock/server.mjs`: API on 8081, CAS on 9000). When it serves the JS it rewrites `clarixapi.moglix.com`, `fingateway.moglix.com` and `graph.microsoft.com` to the mock, so nothing reaches a live backend. `/__local/*` and `/cas/*` are proxied to the mock on the same origin.
- Run: `npm run start:prod` (or `node mock/prod.mjs`), or the `clarix-prod-clone` entry in `C:\rushilProcess\.claude\launch.json`. Then open http://localhost:4340/__local/signin. It stores a local session in the browser and opens the Overview. There is no Microsoft sign-in locally.
- The screens, copy, buttons and flows are the live code itself. Only the data is mock data (`mock/scenario.json` and `mock/rows-seed.mjs`, both synthetic).
- To change the UI later (for example the statuses in the call outcome PRD), get the current source from engineering or edit `prod/main-*.js`. Data and status changes can go in `mock/server.mjs`.
- The page needs a visible window. Angular waits for `requestAnimationFrame`, which a hidden or minimized browser pane never fires, so the page stays blank there. Checks below were run in headless Chrome.

## Mock changes made to match live

| Live call | Change |
| --- | --- |
| `GET /api/v1/dashboard/voice?from&to&status&filters&templateId` | New. Funnel (Dialled → Reached → Completed, talk time, dials per contact), the 8 tiles (Planned cohorts, Will dial, Goal achieved, Action Required, Callbacks open, Tech failures, Avg duration, Total tokens) and `call_status`: the 12 Echo buckets plus Bad data and Not yet classified. |
| `GET /api/v1/dashboard/voice/calls` | New. Call log rows (Call Date, Agent, Campaign, Uploaded by, Caller Name, Phone, Email, Call Summary, Call Status, Status Reason, Call back, Duration, Retries, Goal Reached), with period, status chips, column filters and paging. One row per dialled execution; rows open the execution by its id. |
| `GET /api/v1/dashboard/voice/calls/values` | New. `{values:[{value,count}], truncated}` for column filter lists. |
| `GET /api/v1/dashboard/voice/calls.xlsx` | New. The filtered call log as a spreadsheet (Share > sheet on Overview, Export on Call Logs). |
| `GET /api/v1/workflows/sheets/:id/campaign` | New. Echo's view of a campaign (contacts with call status and group, answers, call status bar), which the campaign page shows. |
| `GET /api/v1/workflows/sheets/:id/results.xlsx` | New. Campaign "Results" download. |
| `/api/v1/workflows/reports` (+ `/:id`, `/download`, `/schedules`, `/schedules/:sid`, `/enabled`, `/run-now`, `/schedules/upcoming`) | Was an empty list. Now full create, read, update and delete, CSV download and mail schedules with the next send times. Two reports are seeded, one with a daily 09:00 schedule. "Send now" only records the run; no e-mail is sent. |
| `/api/v1/admin/data-functions` (+ `/:id`, `/enabled`, `/test`) | Was an empty list. Two seeded functions (one SQL, one REST), with create, edit, enable and delete. Test returns sample values; nothing is queried. |
| `/api/v1/admin/permissions` and `/api/v1/admin/modules` | Create, edit, delete and module enable added. Modules show updated by and updated date. |
| `POST /api/v1/workflows/orchestration/:id/preview` | New. Preview matching: for each lane, how the pasted CSV headers match the lane agent's inputs (exact, fuzzy or none). Lanes now keep "Sort by" and "Group into one call by". |
| Local sign-in | Opens `/dashboard/overview`, the live home page. |

## GitHub Pages build (not published)

- `node mock/browser/build-prod-site.mjs site /clarix_prototype/` builds `site/`: the live build with its backend bases pointed at a service worker (`mock-sw.js`) that runs this mock in the browser, the Microsoft sign-in ids blanked, and a local admin session stored before the app starts. The build fails if any non-public host is left. Needs esbuild, buffer and fflate (set `ESBUILD_PATH` and `NODE_PATH` if they are not installed here).
- `.github/workflows/pages.yml` now publishes `site/` as is, and `PROD-CLONE.md` is the public readme. Neither has been pushed: publishing the live build on a public repo was blocked and needs your decision.
- Checked locally under a Pages-like server in headless Chrome from a fresh profile: Overview, Campaigns, a campaign, Reports, deep links, and the call log export.

## Screens and actions (live vs clone, 30 Oct)

| Screen (route) | Elements compared | Result |
| --- | --- | --- |
| Overview (`/dashboard/overview`) | Period Today/7 days/30 days, Share, funnel, Talk time, Dials per contact, Still in progress, CALL STATUS bar with clickable chips (Bad data included), 8 tiles, Calls table with a filter on every column header, View all calls, Newer/Older | Same. Status chip filter checked (Not picked shows only Not picked rows). |
| Agents (`/workflows/agents`) | New campaign, KPI row (Agents live, Campaigns running, Calls placed, Answered, Commitments), agent cards with Get sheet and Upload & run (New campaign dialog: Agent, Template, Sheet, Start campaign) | Same. |
| Campaigns (`/workflows/campaigns`) | New campaign, Any agent, Any time/Today/7 days/30 days/Pick dates, All/Running/Finished, columns CAMPAIGN, AGENT, PROGRESS, CAMPAIGN STATUS, ACTIONS, paging | Same. Live's Download report and Stop open calls buttons come from the same live code; they were not seen in the clone's text check. |
| Campaign (`/workflows/campaigns/:batchId`) | Template, Uploaded file, Results, Stop calls, tiles (Contacts, Captured, Output variables, Campaign status), CALL STATUS bar, Calls table (Contact, Call status, Answers, Dials, Talk, Last dial, actions), Export | Same. |
| Call Logs & Confirmations (`/workflows/calls`) | Today/7/30 days, Export, column filters, call rows | Same. Export file and filter values checked through the mock. |
| Execution details (`/workflows/templates/:tid/executions/:eid`) | Voice AI Analysis, Event Timeline, Call Recording (Download), Transcript (Copy, .txt, Simple Chat/Detailed View), Answers, Dials, Call Data, Action Items | Same. |
| Build > Agents (`/workflows/build/agents`) | "Workflow Templates", Refresh, New Template, KPI cards (Total workflows, Active, Inactive / Draft, Total steps), All/Active/Draft, template cards, 12/24/48 per page | Same. |
| Build > Data (`/workflows/build/data`) | Enrichments / Transformations tabs; Data Functions table (Name, Type, Inputs → Outputs, Enabled, Updated, Actions), New Data Function form (inputs, outputs, SQL or REST, Test / dry-run) | Same. |
| Build > Orchestration (`/workflows/build/orchestration`) | Lanes / Call agenda / Who does what; New orchestration, Save, lanes with rules, Sort by, Group into one call by, Send to agent, Add lane, Preview matching | Same. The agent picker shows the template id until opened, which is also how live behaves. |
| Execution Reports (`/workflows/reports`, `/new`, `/:id/edit`) | New Report; columns TITLE, WORKFLOW TEMPLATE, CREATED BY, CREATED, ACTIONS (Download CSV, Edit, Delete); editor tabs Basic Details / Report Data / Mail Schedules with next-send countdown and Add schedule | Same. |
| Manage Permissions (`/admin/permissions`) | New Permission, Permissions / Account Service Modules tabs, category filter, columns KEY, DISPLAY NAME, CATEGORY, DESCRIPTION, UPDATED, ACTIONS, paging; New Module | Same layout. Live has 23 permissions; the mock has 17. |
| Redirects | `/workflows/sheets` → campaigns, `/workflows/templates` → build/agents, `/admin/data-functions` → build/data | Same (live router). |

Every action runs against the mock: uploads, stopping calls, template edits, reports, schedules, data functions, permissions, modules and orchestration all change in-memory state, and downloads are generated (.xlsx, .csv, .wav, .txt). Restart to reset.

## Gaps (not reached or not replicated)

- Microsoft sign-in is not available locally; use `/__local/signin`. The login page itself renders, as live.
- Live data is not copied: names, numbers and counts are synthetic (for example 17 permission keys vs 23 live; 113 dialled in 30 days in the mock).
- Status Reason wording for Busy, Unreachable, Blocked, Rejected and Bad data is assumed (no live rows of those on 30 Oct). Same wording as the echo clone.
- Rows of the Order tracker campaign that are still waiting or will retry show "Not yet classified", as live does for calls without a matched telephony report.
- Report mail schedules: "Send now" and the schedule times are simulated; no e-mail leaves the machine.
- Data function "Test" returns sample values; no SQL or REST call is made.
- Destructive or outward actions were not clicked on live (delete, upload, start campaign, stop calls, save). Their clone behaviour comes from the live code plus the mock, not from watching live.
- Transformations tab shows the live explainer only; the transformation catalogue is empty in the mock (`/api/v1/transformation-catalog` returns `[]`).
- The single-file build (`npm run build:single`) builds the GitHub prototype source, not the live copy in `prod/`.
