import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { CallingReportComponent, CallingReportSource, CampaignColumns, ReportCallRow } from '../calling-report/calling-report.component';

/**
 * The screens Echo and Clarix share (plan phase 3): Campaigns, Campaign, New campaign and Follow ups. The Call logs page is
 * the calling report in log mode. Both apps use this same file, each with its own sources. Keep the two copies identical.
 */

export interface CampaignLine {
  campaign_id: string; campaign: string; agent: string; agent_key: string; uploaded_by: string; created_at: string | null; uploaded: number; planned: number; picked_up: number;
  answered: number; success: number; success_rate: number | null; not_finished: number; bad_data: number; status: 'Running' | 'Paused' | 'Completed' | 'Stopped' | 'Failed';
  /** Set when an alert paused the campaign: why and when. */
  paused?: { reason: string; at: string; rule_id: string } | null;
  /** The agent's custom stats for this campaign: total in the sheet, covered on answered calls, accepted. */
  stats?: { field: string; label: string; total: number; covered: number; accepted: number }[];
  /** One campaign only: its sheet's columns and the agent's answers, for its table. */
  columns?: CampaignColumns;
}
export interface CampaignsSource {
  list(p: { from: string | null; to: string | null; state: string; q: string; skip: number; limit: number }): Promise<{ rows: CampaignLine[]; total: number; running: number }>;
  get(id: string): Promise<CampaignLine>;
  stop(id: string): Promise<{ stopped: number }>;
  /** Resumes a campaign an alert paused. */
  resume?(id: string): Promise<unknown>;
  /** Every row of the campaign with its call status (the 14-column export). */
  results(id: string): Promise<Blob>;
  open(c: CampaignLine): void;
  newCampaign(): void;
  /** The campaign's funnel, call status and call log: the calling report scoped to it. */
  report: CallingReportSource;
  /** Where Back goes from a campaign. */
  listPath: string;
}
/** A short note for the person uploading: from the agent's template, or from this sheet's check (the AI note). */
export interface UploadNote { title: string; summary?: string; lines: string[]; source: string }
/** One editable row in the on-screen sheet editor (Step 2 of New Campaign). */
export interface EditableSheetRow {
  row: number;
  is_dummy?: boolean;
  cells: Record<string, string>;
  status: 'ok' | 'fixed' | 'warn' | 'bad' | 'test' | 'dummy';
  issue: string;
  best_practice: string;
}
/** How a row that was not reached is called again: the gaps grow linearly, stay the same or double. */
export interface RetryRule {
  schedule: 'linear' | 'increasing' | 'doubling';
  base_minutes: number;
  retries: number;
  from: string;
  to: string;
  skip_sunday: boolean;
  avoid_saturday?: boolean;
  avoid_lunch: boolean;
  prefer_prime_slots?: boolean;
  retry_silent?: boolean;
  retry_system_issue?: boolean;
  retry_cut_short?: boolean;
  voicemail_drop?: boolean;
  dnd_unblock_after?: number;
  callback_cta?: boolean;
  caller_id?: string;
  branded_name?: string;
  call_reason?: string;
  branding_providers?: string[];
  /** Stop calling a supplier once any of their rows reaches the goal. */
  stop_on_goal?: boolean;
  /** What to do after each call result. gap null = the schedule's own gaps. */
  by_result?: Record<string, ResultRule>;
}
export interface ResultRule { act: 'retry' | 'stop' | 'callback'; tries: number; gap: number | null; message: 'none' | 'whatsapp' | 'both' }
export const RESULT_ROWS: { key: string; label: string; hint: string }[] = [
  { key: 'no_answer', label: 'No answer', hint: 'Rang out' }, { key: 'voicemail', label: 'Voicemail', hint: 'An answering machine picked up' },
  { key: 'silent', label: 'Silent line', hint: 'Connected, nobody spoke' }, { key: 'system', label: 'System issue', hint: 'The line or our side failed' },
  { key: 'dnd', label: 'DND / blocked', hint: 'The number blocks unknown callers' }, { key: 'cut_short', label: 'Hung up early', hint: 'Under 15 s, agent not heard' },
  { key: 'partial', label: 'Partial answer', hint: 'Some POs confirmed' }, { key: 'callback', label: 'Callback asked', hint: 'The supplier named a time' },
];
export const BRANDING_PROVIDER_LIST: { key: string; label: string; sub: string }[] = [
  { key: 'truecaller', label: 'Truecaller Verified Business', sub: 'Green verified badge + brand logo on Android/iOS' },
  { key: 'cnam', label: 'Operator CNAM / TRAI CNAP', sub: 'Carrier-level caller name display ("Moglix Procurement")' },
  { key: 'hiya', label: 'Hiya Connect / First Orion (STIR/SHAKEN)', sub: 'Global carrier branded call + call reason' },
  { key: 'google_apple', label: 'Google Verified Calls & Apple Business Caller ID', sub: 'Native OS dialer brand identity' },
];
export const RETRY_SCHEDULES: { key: RetryRule['schedule']; label: string; hint: string }[] = [
  { key: 'linear', label: 'Linear', hint: 'the same gap every time' }, { key: 'increasing', label: 'Linear increasing', hint: 'each gap one step longer' }, { key: 'doubling', label: 'Doubling', hint: 'each gap twice the last' }];
/** Minutes between retries, as the mock and the product work them out. */
export function retryGaps(r: RetryRule): number[] {
  const b = Math.max(1, Number(r.base_minutes) || 30); const n = Math.min(10, Math.max(0, Number(r.retries) || 0));
  return Array.from({ length: n }, (_, i) => (r.schedule === 'linear' ? b : r.schedule === 'doubling' ? b * 2 ** i : b * (i + 1)));
}
/** Retry times after a missed call at `start`, moved into calling hours (IST), skipping lunch, Saturdays, Sundays and snapping to 10–12 / 2–5 pm prime slots when set. */
export function retryTimes(r: RetryRule, start: number): number[] {
  const IST = 330 * 60000; const hm = (x: string) => { const [h, m] = x.split(':').map(Number); return h * 60 + (m || 0); }; const open = hm(r.from || '10:00'), close = hm(r.to || '18:00');
  const fit = (ms: number) => {
    for (let g = 0; g < 20; g += 1) {
      const l = new Date(ms + IST); const mins = l.getUTCHours() * 60 + l.getUTCMinutes(); const wd = l.getUTCDay();
      const day = ms - mins * 60000 - l.getUTCSeconds() * 1000 - l.getUTCMilliseconds();
      if (r.skip_sunday && wd === 0) { ms = day + 86400000 + open * 60000; continue; }
      if (r.avoid_saturday !== false && wd === 6) { ms = day + 86400000 + open * 60000; continue; }
      if (mins < open) { ms = day + open * 60000; continue; }
      if (mins >= close) { ms = day + 86400000 + open * 60000; continue; }
      if (r.avoid_lunch && mins >= 780 && mins < 840) { ms = day + 840 * 60000; continue; }
      if (r.prefer_prime_slots !== false) {
        if (mins < 600 && close > 600) { ms = day + 600 * 60000; continue; }
        if (mins >= 720 && mins < 840 && close > 840) { ms = day + 840 * 60000; continue; }
        if (mins >= 1020) { ms = day + 86400000 + Math.max(open, 600) * 60000; continue; }
      }
      return ms;
    }
    return ms;
  };
  let t = start; return retryGaps(r).map((g) => (t = fit(t + g * 60000)));
}
export interface RetryPreview { country: string; name: string; tz_label: string; start: string; times: { at: string; local: string; moved: string[] }[] }
export interface NewCampaignSource {
  agents(): Promise<{ key: string; label: string; inputs: string[] }[]>;
  template(agent: string): Promise<Blob>;
  /** Re-check rows after an on-screen edit. Dummy rows the person removed stay removed. */
  recheck?(agent: string, rows: { row: number; is_dummy?: boolean; cells: Record<string, string> }[]): Promise<Awaited<ReturnType<NewCampaignSource['check']>>>;
  check(agent: string, file: File): Promise<{ file: string; rows: number; will_dial: number; calls: number; bad: { row: number; reason: string }[]; tests: number; matched: string[]; missing: string[];
    headers?: string[]; sheet_rows?: EditableSheetRow[]; columns?: { key: string; label: string }[]; dummies?: number;
    fixed?: { row: number; notes: string[] }[]; warnings?: { row: number; notes: string[] }[]; note?: UploadNote; countries?: { code: string; name: string; rows: number }[] }>;
  /** Tips for the agent's template, shown when it is picked. */
  tips?(agent: string): Promise<UploadNote>;
  /** Each agent's retry rule, and saving one. */
  retryRules?(): Promise<{ agents: { agent: string; label: string; rule: RetryRule }[] }>;
  saveRetryRule?(agent: string, rule: RetryRule): Promise<unknown>;
  /** Retry times for a rule in a country, each with why it was moved (rest day, holiday, hours). */
  retryPreview?(rule: RetryRule, country: string): Promise<RetryPreview>;
  start(agent: string, file: File): Promise<{ campaign_id: string; dialled: number }>;
  /** The agent's data source, when it has one: a run reads rows from it instead of a sheet. */
  dataSource?(agent: string): Promise<DsView>;
  previewSource?(agent: string, setup: DsSetup): Promise<DsPreview>;
  runSource?(agent: string): Promise<{ campaign_id: string | null; calls: number; after_filters: number }>;
  editSource?(agent: string): void;
  opened(campaignId: string): void;
  cancel(): void;
}
export type FollowRow = ReportCallRow & { email?: string; kind: 'Callback' | 'Follow-up'; task: string; owner: string; follow: { state: string; by?: string; at?: string } };
export interface FollowUpsSource {
  list(show: string, kind: string): Promise<{ rows: FollowRow[]; counts: { open: number; callback: number; follow_up: number; done: number } }>;
  act(id: string, action: 'done' | 'open'): Promise<unknown>;
  exportXlsx(show: string, kind: string): Promise<Blob>;
  openCall(row: ReportCallRow): void;
}

const CSS = `
  :host { display: block; --s-text: var(--ds-text, var(--text, #0c0a09)); --s-muted: var(--ds-text-muted, var(--muted, #5c5752)); --s-line: var(--ds-border, var(--line, #e7e5e2));
    --s-bg: var(--ds-surface, var(--card, #fff)); --s-soft: var(--ds-surface-sunken, var(--bg-2, #f5f5f4)); --s-good: var(--ds-success-fg, #146c34); --s-accent: var(--ds-accent, var(--accent, #4c4184)); color: var(--s-text); }
  .s { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .s > * { min-width: 0; }
  .s-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .s-title { margin: 0; font-size: 22px; font-weight: 700; }
  .s-sub { margin: 2px 0 0; color: var(--s-muted); font-size: 13px; }
  .s-grow { flex: 1; }
  .s-muted { color: var(--s-muted); font-size: 12.5px; }
  .s-btn { border: 1px solid var(--s-line); background: var(--s-bg); color: var(--s-text); border-radius: 8px; padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer; text-decoration: none; }
  .s-btn:disabled { opacity: .45; cursor: default; }
  .s-primary { background: var(--s-text); color: var(--s-bg); border-color: var(--s-text); }
  .s-danger { color: var(--ds-danger-fg, #b91c1c); }
  .s-link { border: 0; background: none; color: var(--s-muted); text-decoration: underline; cursor: pointer; font: inherit; font-size: 13px; padding: 0; }
  .s-seg { display: inline-flex; border: 1px solid var(--s-line); border-radius: 8px; overflow: hidden; }
  .s-seg button { border: 0; background: var(--s-bg); color: var(--s-text); padding: 6px 11px; font: inherit; font-size: 13px; cursor: pointer; }
  .s-seg button.on { background: var(--s-text); color: var(--s-bg); }
  .s-search { border: 1px solid var(--s-line); border-radius: 8px; padding: 6px 10px; font: inherit; font-size: 13px; background: var(--s-bg); color: var(--s-text); width: 240px; }
  .s-card { border: 1px solid var(--s-line); border-radius: 12px; background: var(--s-bg); }
  .s-pad { padding: 14px 16px; display: grid; gap: 10px; }
  .s-scroll { overflow-x: auto; }
  @media (max-width: 720px) {
    .s-seg { flex-wrap: wrap; }
    .s-search { width: 100%; }
    table.s-stack thead { display: none; }
    table.s-stack, table.s-stack tbody, table.s-stack tr, table.s-stack td { display: block; width: auto; }
    table.s-stack tr { border-top: 1px solid var(--s-line); padding: 8px 4px; }
    table.s-stack td { border: 0; padding: 3px 12px; white-space: normal; max-width: none; text-align: left; }
    table.s-stack td[data-l]::before { content: attr(data-l) ': '; color: var(--s-muted); font-size: 12px; }
    table.s-stack td.num { display: inline-block; }
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-weight: 500; color: var(--s-muted); background: var(--s-soft); padding: 8px 12px; white-space: nowrap; font-size: 12.5px; }
  td { padding: 9px 12px; border-top: 1px solid var(--s-line); white-space: nowrap; }
  tbody tr.click { cursor: pointer; }
  tbody tr.click:hover { background: var(--s-soft); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td small { display: block; color: var(--s-muted); font-size: 12px; }
  .cut { max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
  .s-chip { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 2px 10px; font-size: 12px; border: 1px solid var(--s-line); }
  .s-chip i { width: 7px; height: 7px; border-radius: 50%; background: var(--c, #a8a29e); }
  .s-pager { display: flex; justify-content: flex-end; align-items: center; gap: 10px; padding: 10px 12px; font-size: 13px; color: var(--s-muted); }
  .s-empty { margin: 0; padding: 16px; color: var(--s-muted); font-size: 13px; }
  .s-note { margin: 0; padding: 8px 12px; border-radius: 8px; background: var(--s-soft); font-size: 13px; }
  .s-actions { display: flex; gap: 6px; justify-content: flex-end; }
  .s-cov { font-size: 12.5px; }
  .s-cov small { display: inline; color: var(--s-muted); }
  .s-check { width: 24px; height: 24px; cursor: pointer; accent-color: var(--s-accent); }
  td.s-caller { white-space: normal; min-width: 200px; max-width: 300px; }
  .s-cut { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 300px; }
  .s-pager { display: flex; gap: 10px; align-items: center; justify-content: flex-end; padding: 8px 12px; font-size: 13px; color: var(--s-muted); }
  tr.done td { color: var(--s-muted); }
  tr.done .s-task { text-decoration: line-through; }
  .s-task { font-weight: 500; white-space: normal; min-width: 220px; }
  td.s-wrap { white-space: normal; min-width: 260px; max-width: 420px; color: var(--s-muted); font-size: 12.5px; }
  .s-actions .s-btn { padding: 4px 10px; font-size: 12.5px; }
`;
const STATUS_COLOR: Record<string, string> = { Paused: '#dc2626', Running: '#d97706', Completed: '#16a34a', Stopped: '#a8a29e', Failed: '#dc2626' };
const pctText = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
function save(blob: Blob, name: string): void { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }

// ── Campaigns ─────────────────────────────────────────────────────────────────
const CAMPAIGN_PERIODS = [{ key: 'all', label: 'Any time', days: 0 }, { key: 'today', label: 'Today', days: 1 }, { key: '7d', label: 'Last 7 days', days: 7 }, { key: '30d', label: 'Last 30 days', days: 30 }];
@Component({
  selector: 'app-campaigns-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [CSS],
  template: `
    <div class="s">
      <div class="s-head">
        <div><h1 class="s-title">Campaigns</h1><p class="s-sub">Each uploaded sheet is one campaign. Open one to see its funnel, call status and every call.</p></div>
        <span class="s-grow"></span>
        <button type="button" class="s-btn s-primary" (click)="source().newCampaign()">New campaign</button>
      </div>
      <div class="s-head">
        <div class="s-seg" role="group" aria-label="Created">@for (p of PERIODS; track p.key) { <button type="button" [class.on]="period() === p.key" (click)="period.set(p.key); reset()">{{ p.label }}</button> }</div>
        <div class="s-seg" role="group" aria-label="State">@for (st of STATES; track st.key) { <button type="button" [class.on]="state() === st.key" (click)="state.set(st.key); reset()">{{ st.label }}</button> }</div>
        <input class="s-search" type="search" placeholder="Search file, agent or uploader" [value]="q()" (input)="setQ($any($event.target).value)" aria-label="Search campaigns">
        <span class="s-grow"></span>
        @if (running()) { <span class="s-muted">{{ running() }} running</span> }
      </div>
      @if (error()) { <p class="s-note">{{ error() }}</p> }
      <div class="s-card">
        <div class="s-scroll">
          <table class="s-stack">
            <thead><tr><th>Campaign</th><th>Agent</th><th>Status</th><th class="num">Uploaded</th><th class="num">Planned</th><th class="num">Picked up</th><th class="num">Answered</th><th class="num">Success rate</th><th>Coverage</th><th></th></tr></thead>
            <tbody>
              @for (c of rows(); track c.campaign_id) {
                <tr class="click" (click)="source().open(c)" tabindex="0" (keydown.enter)="source().open(c)">
                  <td class="cut" [title]="c.campaign">{{ c.campaign }}<small>{{ c.uploaded_by || '—' }} · {{ when(c.created_at) }}</small></td>
                  <td class="cut" data-l="Agent" [title]="c.agent">{{ c.agent }}</td>
                  <td><span class="s-chip" [style.--c]="color(c.status)"><i></i>{{ c.status }}</span></td>
                  <td class="num" data-l="Uploaded">{{ c.uploaded }}</td><td class="num" data-l="Planned">{{ c.planned }}</td><td class="num" data-l="Picked up">{{ c.picked_up }}</td><td class="num" data-l="Answered">{{ c.answered }}</td><td class="num" data-l="Success rate">{{ pct(c.success_rate) }}</td>
                  <td data-l="Coverage">@for (st of c.stats ?? []; track st.field) { <div class="s-cov" [title]="st.label + ': ' + st.covered + ' of ' + st.total + ' on answered calls, ' + st.accepted + ' accepted'">{{ st.label }} <b>{{ st.covered }}/{{ st.total }}</b> <small>{{ st.accepted }} accepted</small></div> } @empty { <span class="s-muted">—</span> }</td>
                  <td><div class="s-actions">
                    <button type="button" class="s-btn" (click)="$event.stopPropagation(); results(c)">Results</button>
                    @if (c.status === 'Running') { <button type="button" class="s-btn s-danger" (click)="$event.stopPropagation(); stop(c)">Stop</button> }
                  </div></td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (!rows().length) { <p class="s-empty">{{ loading() ? 'Loading…' : 'No campaigns match.' }}</p> }
        @else {
          <div class="s-pager">
            <button type="button" class="s-btn" [disabled]="page() === 0" (click)="go(-1)">Newer</button>
            <span>{{ page() * PAGE + 1 }}–{{ page() * PAGE + rows().length }} of {{ total() }}</span>
            <button type="button" class="s-btn" [disabled]="(page() + 1) * PAGE >= total()" (click)="go(1)">Older</button>
          </div>
        }
      </div>
    </div>
  `,
})
export class CampaignsListComponent {
  readonly source = input.required<CampaignsSource>();
  protected readonly PERIODS = CAMPAIGN_PERIODS;
  protected readonly STATES = [{ key: 'all', label: 'All' }, { key: 'running', label: 'Running' }, { key: 'finished', label: 'Finished' }];
  protected readonly PAGE = 20;
  protected readonly period = signal('all');
  protected readonly state = signal('all');
  protected readonly q = signal('');
  protected readonly page = signal(0);
  protected readonly rows = signal<CampaignLine[]>([]);
  protected readonly total = signal(0);
  protected readonly running = signal(0);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  private typing: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  protected readonly when = when;
  protected readonly pct = pctText;
  constructor() { effect(() => { this.period(); this.state(); this.page(); untracked(() => this.load()); }); }
  protected color(s: string): string { return STATUS_COLOR[s] || '#a8a29e'; }
  protected reset(): void { this.page.set(0); }
  protected go(step: number): void { this.page.set(Math.max(0, this.page() + step)); }
  protected setQ(v: string): void { this.q.set(v); if (this.typing) clearTimeout(this.typing); this.typing = setTimeout(() => { this.page.set(0); this.load(); }, 300); }
  async load(): Promise<void> {
    const my = ++this.seq; const days = CAMPAIGN_PERIODS.find((p) => p.key === this.period())?.days || 0;
    const from = days ? new Date(new Date().setHours(0, 0, 0, 0) - (days - 1) * 86400000).toISOString() : null;
    this.loading.set(true); this.error.set('');
    try { const r = await this.source().list({ from, to: null, state: this.state(), q: this.q(), skip: this.page() * this.PAGE, limit: this.PAGE }); if (my !== this.seq) return; this.rows.set(r.rows); this.total.set(r.total); this.running.set(r.running); }
    catch { if (my === this.seq) this.error.set('Could not load campaigns.'); } finally { if (my === this.seq) this.loading.set(false); }
  }
  protected async results(c: CampaignLine): Promise<void> { save(await this.source().results(c.campaign_id), `${c.campaign.replace(/\.\w+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_')}_results.xlsx`); }
  protected async stop(c: CampaignLine): Promise<void> { if (!confirm(`Stop the calls still waiting in ${c.campaign}?`)) return; await this.source().stop(c.campaign_id); this.load(); }
}

// ── One campaign ──────────────────────────────────────────────────────────────
@Component({
  selector: 'app-campaign-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CallingReportComponent],
  styles: [CSS + `
    .cp-paused { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; border: 1px solid #fca5a5; background: color-mix(in srgb, #dc2626 8%, var(--s-bg)); border-radius: 10px; padding: 10px 14px; font-size: 13.5px; }
    .cp-paused b { color: #b91c1c; }
    .cp-progress { gap: 8px; }
    .cp-line { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: baseline; }
    .cp-line b { font-size: 15px; }
    .cp-good { color: var(--s-good, #146c34); font-weight: 600; }
    .cp-bar { display: flex; height: 10px; border-radius: 999px; overflow: hidden; background: var(--s-soft); }
    .cp-done { background: #16a34a; } .cp-open { background: #a8a29e; } .cp-bad { background: #d6d3d1; }
    .cp-stats { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--s-muted); }
    .cp-stats b { color: var(--s-text); }
  `],
  template: `
    <div class="s">
      <div class="s-head"><button type="button" class="s-btn" (click)="back()">← Campaigns</button></div>
      @if (c(); as camp) {
        <div class="s-head">
          <div>
            <h1 class="s-title">{{ camp.campaign }} <span class="s-chip" [style.--c]="color(camp.status)"><i></i>{{ camp.status }}</span></h1>
            <p class="s-sub">{{ camp.agent }} · uploaded by {{ camp.uploaded_by || '—' }} · {{ when(camp.created_at) }} · {{ camp.uploaded }} rows</p>
          </div>
          <span class="s-grow"></span>
          <button type="button" class="s-btn" (click)="results(camp)">Results (.xlsx)</button>
          @if (camp.status === 'Running') { <button type="button" class="s-btn s-danger" (click)="stop(camp)">Stop calls</button> }
        </div>
        @if (camp.paused; as pz) {
          <div class="cp-paused" role="alert"><b>Paused by an alert</b><span>{{ pz.reason }} · {{ when(pz.at) }}. Calls still waiting are held; nothing is lost.</span>
            @if (source().resume) { <button type="button" class="s-btn s-primary" (click)="resume(camp)">Resume calls</button> }</div>
        }
        @if (note()) { <p class="s-note">{{ note() }}</p> }
        <!-- Where the campaign stands, before any detail: rows done, still dialling, not dialled, and the result so far. -->
        <div class="s-card s-pad cp-progress">
          <div class="cp-line">
            <b>{{ camp.planned - camp.not_finished }} of {{ camp.planned }} rows called</b>
            <span class="s-muted">@if (camp.not_finished) { {{ camp.not_finished }} still being dialled · }{{ camp.bad_data }} not dialled (bad data) · {{ camp.answered }} answered · <span class="cp-good">{{ camp.success }} success{{ camp.success_rate == null ? '' : ' (' + pct(camp.success_rate) + ')' }}</span></span>
          </div>
          <div class="cp-bar" role="img" [attr.aria-label]="(camp.planned - camp.not_finished) + ' of ' + camp.planned + ' rows called'">
            <span class="cp-done" [style.width.%]="share(camp.planned - camp.not_finished, camp.uploaded)"></span><span class="cp-open" [style.width.%]="share(camp.not_finished, camp.uploaded)"></span><span class="cp-bad" [style.width.%]="share(camp.bad_data, camp.uploaded)"></span>
          </div>
          @if (camp.stats?.length) {
            <div class="cp-stats">@for (st of camp.stats; track st.field) { <span>{{ st.label }}: <b>{{ st.covered }}</b> of {{ st.total }} covered · {{ st.accepted }} accepted</span> }</div>
          }
        </div>
        <app-calling-report [source]="source().report" [campaign]="camp.campaign_id" [columns]="camp.columns ?? null"></app-calling-report>
      } @else { <p class="s-empty">{{ error() || 'Loading the campaign…' }}</p> }
    </div>
  `,
})
export class CampaignPageComponent {
  readonly source = input.required<CampaignsSource>();
  protected readonly pct = pctText;
  protected share(n: number, of: number): number { return of ? (100 * n) / of : 0; }
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly c = signal<CampaignLine | null>(null);
  protected readonly error = signal('');
  protected readonly note = signal('');
  protected readonly when = when;
  private readonly id = signal('');
  constructor() {
    this.route.paramMap.subscribe((p) => this.id.set(p.get('id') || p.get('batchId') || ''));
    effect(() => { const id = this.id(); if (id) untracked(() => this.load(id)); });
  }
  private async load(id: string): Promise<void> { try { this.c.set(await this.source().get(id)); } catch { this.error.set('Could not load this campaign.'); } }
  protected color(s: string): string { return STATUS_COLOR[s] || '#a8a29e'; }
  protected back(): void { this.router.navigate([this.source().listPath]); }
  protected async results(c: CampaignLine): Promise<void> { save(await this.source().results(c.campaign_id), `${c.campaign.replace(/\.\w+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_')}_results.xlsx`); }
  protected async resume(c: CampaignLine): Promise<void> { await this.source().resume?.(c.campaign_id); this.note.set('Calls resumed. The alert will trip again only on new calls.'); this.load(c.campaign_id); }
  protected async stop(c: CampaignLine): Promise<void> {
    if (!confirm(`Stop the calls still waiting in ${c.campaign}?`)) return;
    const r = await this.source().stop(c.campaign_id); this.note.set(`${r.stopped} call${r.stopped === 1 ? '' : 's'} stopped.`); this.load(c.campaign_id);
  }
}

// ── New campaign: pick an agent and get its template, upload and check, start ─
@Component({
  selector: 'app-new-campaign',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [CSS + `
    .nc-steps { display: flex; gap: 8px; }
    .nc-steps span { flex: 1; padding: 8px 12px; border-radius: 8px; background: var(--s-soft); font-size: 13px; color: var(--s-muted); }
    .nc-steps span.on { background: var(--s-text); color: var(--s-bg); }
    .nc-agents { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; }
    .nc-agent { text-align: left; border: 1px solid var(--s-line); border-radius: 10px; padding: 10px 12px; background: var(--s-bg); font: inherit; color: var(--s-text); cursor: pointer; display: grid; gap: 2px; }
    .nc-agent.on { border-color: var(--s-accent); box-shadow: 0 0 0 1px var(--s-accent); }
    .nc-agent small { color: var(--s-muted); font-size: 12px; }
    .nc-nums { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
    .nc-nums div { background: var(--s-soft); border-radius: 8px; padding: 8px 12px; display: grid; }
    .nc-nums span { font-size: 12px; color: var(--s-muted); }
    .nc-nums b { font-size: 20px; }
    .nc-bad { max-height: 200px; overflow: auto; font-size: 12.5px; display: grid; gap: 4px; }
    .nc-foot { display: flex; gap: 8px; justify-content: flex-end; }
    .nc-stop { color: var(--ds-danger-fg, #b91c1c); }
    .nc-note { border: 1px solid color-mix(in srgb, var(--s-accent) 35%, var(--s-line)); background: color-mix(in srgb, var(--s-accent) 5%, var(--s-bg)); border-radius: 10px; padding: 10px 14px; display: grid; gap: 6px; font-size: 13px; }
    .nc-note ul { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
    .nc-note small { color: var(--s-muted); }
    .nc-note-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .nc-ai { font-size: 11px; font-weight: 600; letter-spacing: .04em; color: var(--s-accent); border: 1px solid currentColor; border-radius: 999px; padding: 0 7px; }
    .nc-fixed { max-height: 160px; overflow: auto; font-size: 12.5px; display: grid; gap: 4px; color: var(--s-good); }
    .nc-warn { max-height: 120px; overflow: auto; font-size: 12.5px; display: grid; gap: 4px; color: #a16207; }
    .nc-src { border: 2px solid var(--s-accent); background: color-mix(in srgb, var(--s-accent) 5%, var(--s-bg)); border-radius: 10px; padding: 10px 14px; display: grid; gap: 6px; font-size: 13px; }
    .nc-src-head { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
    .nc-src-foot { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .nc-retry { border: 1px solid var(--s-line); border-radius: 10px; padding: 12px 14px; display: grid; gap: 10px; font-size: 13px; }
    .nc-retry-row { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
    .nc-retry input[type=number] { width: 72px; } .nc-retry input[type=number], .nc-retry input[type=time] { border: 1px solid var(--s-line); border-radius: 6px; padding: 4px 6px; font: inherit; background: var(--s-bg); color: var(--s-text); }
    .nc-retry label { display: inline-flex; gap: 6px; align-items: center; }
    .nc-times { display: flex; flex-wrap: wrap; gap: 6px; }
    .nc-times span { background: var(--s-soft); border-radius: 6px; padding: 3px 8px; font-size: 12.5px; }
    .nc-times small { color: var(--s-muted); font-size: 12px; }
    .nc-sheet { display: grid; gap: 8px; }
    .nc-grid { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    .nc-grid th, .nc-grid td { border-bottom: 1px solid var(--s-line); padding: 4px 6px; text-align: left; vertical-align: top; }
    .nc-grid th { color: var(--s-muted); font-weight: 600; white-space: nowrap; }
    .nc-grid input { width: 148px; max-width: 28vw; border: 1px solid var(--s-line); border-radius: 6px; padding: 4px 6px; font: inherit; font-size: 12.5px; background: var(--s-bg); color: var(--s-text); }
    .nc-grid tr.bad input { border-color: #fca5a5; }
    .nc-grid tr.dummy { background: var(--s-soft); }
    .nc-pill { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 11.5px; border: 1px solid var(--s-line); white-space: nowrap; }
    .nc-more { border-top: 1px solid var(--s-line); padding-top: 8px; display: grid; gap: 8px; }
    .nc-more summary { cursor: pointer; font-weight: 600; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; list-style: none; }
    .nc-more summary::-webkit-details-marker { display: none; }
    .nc-more summary::before { content: '▸'; color: var(--s-muted); width: 12px; transition: transform .15s; }
    .nc-more[open] summary::before { transform: rotate(90deg); }
    .nc-st { white-space: nowrap; } .nc-rm { margin-left: 6px; padding: 2px 8px; font-size: 12px; }
    .s input[type=file], :host input[type=file] { font: inherit; font-size: 13px; color: var(--s-muted); }
    :host input[type=file]::file-selector-button { border: 1px solid var(--s-line); background: var(--s-bg); color: var(--s-text); border-radius: 8px; padding: 6px 12px; margin-right: 10px; font: inherit; font-size: 13px; cursor: pointer; }
    .nc-more summary .s-muted { font-weight: 400; font-size: 12.5px; }
    .nc-res { border-collapse: collapse; font-size: 13px; width: 100%; }
    .nc-res th { text-align: left; font-weight: 500; color: var(--s-muted); font-size: 12px; padding: 4px 6px; border-bottom: 1px solid var(--s-line); }
    .nc-res td { padding: 5px 6px; border-bottom: 1px solid var(--s-line); }
    .nc-res td small { display: block; color: var(--s-muted); font-size: 12px; }
    .nc-res input { width: 76px; } .nc-res select, .nc-res input { border: 1px solid var(--s-line); border-radius: 6px; padding: 4px 6px; font: inherit; font-size: 13px; background: var(--s-bg); color: var(--s-text); }
    .nc-res input:disabled { opacity: .45; }
    .nc-pill.bad { color: #b91c1c; } .nc-pill.warn, .nc-pill.fixed { color: #a16207; } .nc-pill.ok { color: var(--s-good); } .nc-pill.dummy, .nc-pill.test { color: var(--s-muted); }
    .nc-hint td { color: var(--s-muted); font-size: 12px; }
    .nc-brand { display: grid; gap: 8px; border-top: 1px solid var(--s-line); padding-top: 8px; }
    .nc-brand input[type=text] { border: 1px solid var(--s-line); border-radius: 6px; padding: 4px 8px; font: inherit; min-width: 200px; background: var(--s-bg); color: var(--s-text); }
    .nc-brand small { display: block; color: var(--s-muted); font-size: 11.5px; }
  `],
  template: `
    <div class="s">
      <div class="s-head"><div><h1 class="s-title">New campaign</h1><p class="s-sub">Pick an agent, fill its template, upload it, check it, start.</p></div></div>
      <div class="nc-steps"><span [class.on]="step() === 1">1 · Agent and template</span><span [class.on]="step() === 2">2 · Upload and check</span><span [class.on]="step() === 3">3 · Start</span></div>
      @if (error()) { <p class="s-note">{{ error() }}</p> }
      <div class="s-card s-pad">
        @if (step() === 1) {
          <b>Which agent makes these calls?</b>
          <div class="nc-agents">
            @for (a of agents(); track a.key) { <button type="button" class="nc-agent" [class.on]="agent() === a.key" (click)="agent.set(a.key)">{{ a.label }}<small>{{ a.inputs.length }} columns in its template</small></button> }
          </div>
          @if (agent() && ds(); as v) {
            <!-- This agent reads its rows from a connected system: no sheet needed. -->
            <div class="nc-src">
              <div class="nc-src-head"><b>From {{ v.connector_name || 'its data source' }}</b><span class="s-muted">{{ v.setup.schedule.on ? scheduleText(v) : 'No schedule: runs when started' }}</span></div>
              @if (dsPreview(); as p) { <span>Right now: <b>{{ p.after_filters }}</b> rows match → <b>{{ p.total_calls }}</b> call{{ p.total_calls === 1 ? '' : 's' }}@if (p.skipped_recent) { · {{ p.skipped_recent }} called recently, skipped }</span> }
              <div class="nc-src-foot">
                @if (source().editSource) { <button type="button" class="s-btn" (click)="source().editSource!(agent())">Edit data source</button> }
                <button type="button" class="s-btn s-primary" [disabled]="dsBusy() || !dsPreview()?.total_calls" (click)="runSource()">{{ dsBusy() ? 'Starting…' : 'Run now from ' + (v.connector_name || 'the source') }}</button>
              </div>
              <small class="s-muted">Or upload a sheet below for a one-off list.</small>
            </div>
          }
          @if (agent() && tips(); as t) {
            <div class="nc-note"><div class="nc-note-head"><span class="nc-ai">AI NOTE</span><b>{{ t.title }}</b></div><ul>@for (l of t.lines; track $index) { <li>{{ l }}</li> }</ul><small>{{ t.source }}</small></div>
          }
          <div class="nc-foot">
            <button type="button" class="s-btn" (click)="source().cancel()">Cancel</button>
            <button type="button" class="s-btn" [disabled]="!agent()" (click)="template()">Download template</button>
            <button type="button" class="s-btn s-primary" [disabled]="!agent()" (click)="step.set(2)">Next</button>
          </div>
        }
        @if (step() === 2) {
          <b>Upload the filled template ({{ agentLabel() }})</b>
          <input type="file" accept=".xlsx,.xls,.csv" (change)="pick($any($event.target).files?.[0])" aria-label="Sheet to upload">
          @if (check(); as k) {
            <div class="nc-nums">
              <div><span>Rows</span><b>{{ k.rows }}</b></div><div><span>Will be dialled</span><b>{{ k.will_dial }}</b></div>
              <div><span>Bad data</span><b>{{ k.bad.length }}</b></div><div><span>Internal tests</span><b>{{ k.tests }}</b></div>
            </div>
            @if (k.countries?.length) { <span class="s-muted">Numbers by country: @for (c of k.countries!; track c.code; let last = $last) { {{ c.name }} {{ c.rows }}{{ last ? '' : ' · ' }} }. Each is called under its country's rules (Settings › Calling rules).</span> }
            @if (sheet().length) {
              <div class="nc-sheet">
                <b>Sheet</b>
                <span class="s-muted">Every column is here. Edit a cell and it is checked again. A sample row is included so the format is obvious: it is never called, and one click removes it. Bad rows are not called — fix them here, or continue without them.</span>
                <div class="s-scroll">
                  <table class="nc-grid">
                    <thead><tr><th>Row</th><th>Status</th>@for (c of columns(); track c.key) { <th>{{ c.label }}</th> }</tr></thead>
                    <tbody>
                      @for (r of sheet(); track $index; let i = $index) {
                        <tr [class]="r.status">
                          <td>{{ r.is_dummy ? '—' : r.row }}</td>
                          <td class="nc-st"><span class="nc-pill" [class]="'nc-pill ' + r.status">{{ statusWord(r.status) }}</span>@if (r.is_dummy) { <button type="button" class="s-btn nc-rm" (click)="removeRow(i)" aria-label="Remove the sample row">Remove</button> }</td>
                          @for (c of columns(); track c.key) { <td><input [value]="r.cells[c.key] || ''" (change)="editCell(i, c.key, $any($event.target).value)" [attr.aria-label]="c.label + ', ' + (r.is_dummy ? 'sample row' : 'row ' + r.row)"></td> }
                        </tr>
                        @if (r.issue && !r.is_dummy) { <tr class="nc-hint"><td [attr.colspan]="columns().length + 2"><b>{{ r.issue }}</b> {{ r.issue.startsWith('On your do-not-call') ? 'Remove the row, or take the number off the list in the do-not-call settings.' : r.best_practice }}</td></tr> }
                      }
                    </tbody>
                  </table>
                </div>
              </div>
            }
            @if (k.missing.includes('contact_phone')) { <p class="s-note nc-stop" role="alert"><b>contact_phone is missing.</b> Every row needs the supplier's 10-digit mobile: it is the number called and it ties each call to the row's POs and items. Add the column and upload again.</p> }
            @if (missingOther(k).length) { <p class="s-note">Columns not found in the file: {{ missingOther(k).join(', ') }}. Rows that need them will fail the check.</p> }
            @if (!sheet().length && k.fixed?.length) { <b class="s-muted">Fixed for you ({{ k.fixed!.length }} row{{ k.fixed!.length === 1 ? '' : 's' }}): these will be called</b><div class="nc-fixed">@for (f of k.fixed!; track f.row) { <span>Row {{ f.row }}: {{ f.notes.join('; ') }}</span> }</div> }
            @if (!sheet().length && k.warnings?.length) { <b class="s-muted">Check these ({{ k.warnings!.length }}): they will still be called</b><div class="nc-warn">@for (w of k.warnings!; track w.row) { <span>Row {{ w.row }}: {{ w.notes.join('; ') }}</span> }</div> }
            @if (!sheet().length && k.bad.length) { <b class="s-muted">Not called ({{ k.bad.length }})</b><div class="nc-bad">@for (b of k.bad; track b.row) { <span>Row {{ b.row }}: {{ b.reason }}</span> }</div> }
            @if (k.note; as n) {
              <div class="nc-note">
                <div class="nc-note-head"><span class="nc-ai">AI NOTE</span><b>{{ n.title }}</b><span class="s-muted">{{ n.summary }}</span><span class="s-grow"></span>
                  <button type="button" class="s-btn" (click)="noteSent.set(true)" [disabled]="noteSent()">{{ noteSent() ? 'Emailed to you (demo)' : 'Email me this note' }}</button></div>
                <ul>@for (l of n.lines; track $index) { <li>{{ l }}</li> }</ul><small>{{ n.source }}</small>
              </div>
            }
          }
          <div class="nc-foot">
            <button type="button" class="s-btn" (click)="step.set(1)">Back</button>
            <button type="button" class="s-btn s-primary" [disabled]="!check()?.will_dial || check()?.missing?.includes('contact_phone')" (click)="step.set(3)">Next</button>
          </div>
        }
        @if (step() === 3) {
          <b>Start calling {{ check()?.will_dial }} contacts with {{ agentLabel() }}?</b>
          <p class="s-muted">{{ file()?.name }} · bad data and test rows are not dialled. Calls start now and the campaign page shows them as they finish.</p>
          @if (rule(); as ru) {
            <div class="nc-retry">
              <div class="nc-note-head"><b>If a call is not answered</b><span class="s-muted">{{ agentLabel() }}'s retry rule, used for every campaign of this agent</span></div>
              <div class="nc-retry-row">
                <div class="s-seg" role="group" aria-label="Retry schedule">@for (sc of SCHEDULES; track sc.key) { <button type="button" [class.on]="ru.schedule === sc.key" (click)="setRule({ schedule: sc.key })" [title]="sc.hint">{{ sc.label }}</button> }</div>
                <label>First gap <input type="number" min="1" max="1440" [value]="ru.base_minutes" (change)="setRule({ base_minutes: +$any($event.target).value })" aria-label="First gap in minutes"> min</label>
                <label><input type="number" min="0" max="10" [value]="ru.retries" (change)="setRule({ retries: +$any($event.target).value })" aria-label="Number of retries"> retries</label>
              </div>
              <div class="nc-retry-row">
                <label>Calling hours <input type="time" [value]="ru.from" (change)="setRule({ from: $any($event.target).value })" aria-label="From"> to <input type="time" [value]="ru.to" (change)="setRule({ to: $any($event.target).value })" aria-label="To"></label>
                <label><input type="checkbox" [checked]="ru.skip_sunday" (change)="setRule({ skip_sunday: $any($event.target).checked })"> No Sundays</label>
                <label><input type="checkbox" [checked]="ru.avoid_saturday !== false" (change)="setRule({ avoid_saturday: $any($event.target).checked })"> No Saturdays</label>
                <label><input type="checkbox" [checked]="ru.avoid_lunch" (change)="setRule({ avoid_lunch: $any($event.target).checked })"> Not 1–2 pm</label>
              </div>
              <!-- The rest is set once per agent and rarely changed: folded so the start step stays short. -->
              <details class="nc-more">
                <summary>More retry options <span class="s-muted">voicemail, silent and short calls, DND unblock, best hours</span></summary>
                <div class="nc-retry-row">
                  <label><input type="checkbox" [checked]="ru.prefer_prime_slots !== false" (change)="setRule({ prefer_prime_slots: $any($event.target).checked })"> Prefer 10–12 and 2–5</label>
                  <label><input type="checkbox" [checked]="ru.voicemail_drop !== false" (change)="setRule({ voicemail_drop: $any($event.target).checked })"> Leave a 15s voicemail</label>
                  <label><input type="checkbox" [checked]="ru.retry_silent !== false" (change)="setRule({ retry_silent: $any($event.target).checked })"> Retry silent calls</label>
                  <label><input type="checkbox" [checked]="ru.retry_system_issue !== false" (change)="setRule({ retry_system_issue: $any($event.target).checked })"> Retry system issues</label>
                  <label><input type="checkbox" [checked]="ru.retry_cut_short !== false" (change)="setRule({ retry_cut_short: $any($event.target).checked })"> Retry calls under 15s</label>
                  <label><input type="checkbox" [checked]="ru.callback_cta !== false" (change)="setRule({ callback_cta: $any($event.target).checked })"> Callback link in messages</label>
                  <label>Unblock request after <input type="number" min="1" max="5" [value]="ru.dnd_unblock_after ?? 2" (change)="setRule({ dnd_unblock_after: +$any($event.target).value })" aria-label="DND results before the unblock request"> DND results</label>
                </div>
              </details>
              <details class="nc-more">
                <summary>By call result <span class="s-muted">{{ resultSummary(ru) }}</span></summary>
                <span class="s-muted">Each result can have its own number of tries, gap and message. A blank gap uses the schedule above.</span>
                <div class="s-scroll"><table class="nc-res">
                  <thead><tr><th>After</th><th>Then</th><th>Tries</th><th>Gap (min)</th><th>Message</th></tr></thead>
                  <tbody>@for (rr of RESULTS; track rr.key) { @if (resOf(ru, rr.key); as x) {
                    <tr><td><b>{{ rr.label }}</b><small>{{ rr.hint }}</small></td>
                      <td><select (change)="setRes(rr.key, { act: $any($event.target).value })" [attr.aria-label]="'After ' + rr.label">
                        @if (rr.key === 'callback') { <option value="callback" [selected]="x.act === 'callback'">Call at the agreed time</option> }
                        <option value="retry" [selected]="x.act === 'retry'">Try again</option><option value="stop" [selected]="x.act === 'stop'">Stop calling</option></select></td>
                      <td><input type="number" min="0" max="10" [value]="x.tries" [disabled]="x.act === 'stop'" (change)="setRes(rr.key, { tries: +$any($event.target).value })" [attr.aria-label]="'Tries after ' + rr.label"></td>
                      <td><input type="number" min="5" max="2880" [value]="x.gap ?? ''" placeholder="schedule" [disabled]="x.act !== 'retry'" (change)="setRes(rr.key, { gap: $any($event.target).value === '' ? null : +$any($event.target).value })" [attr.aria-label]="'Gap after ' + rr.label"></td>
                      <td><select (change)="setRes(rr.key, { message: $any($event.target).value })" [attr.aria-label]="'Message after ' + rr.label"><option value="none" [selected]="x.message === 'none'">None</option><option value="whatsapp" [selected]="x.message === 'whatsapp'">WhatsApp</option><option value="both" [selected]="x.message === 'both'">WhatsApp and email</option></select></td></tr>
                  } }</tbody></table></div>
                <label><input type="checkbox" [checked]="ru.stop_on_goal !== false" (change)="setRule({ stop_on_goal: $any($event.target).checked })"> Stop calling a supplier once any of their rows reaches the goal</label>
              </details>
              <details class="nc-more nc-brand">
                <summary>Branded caller ID <span class="s-muted">{{ ru.branded_name ? ru.branded_name + (ru.caller_id ? ' · ' + ru.caller_id : '') : 'Not set' }}</span></summary>
                <span class="s-muted">One number for this workspace, registered with the providers you tick. The contact card goes out with unblock and callback messages.</span>
                <div class="nc-retry-row">
                  <label>Name on the phone <input type="text" [value]="ru.branded_name || ''" (change)="setRule({ branded_name: $any($event.target).value })" aria-label="Branded name"></label>
                  <label>Number <input type="text" [value]="ru.caller_id || ''" (change)="setRule({ caller_id: $any($event.target).value })" aria-label="Caller ID"></label>
                  <label>Call reason <input type="text" [value]="ru.call_reason || ''" (change)="setRule({ call_reason: $any($event.target).value })" aria-label="Call reason"></label>
                </div>
                @for (p of BRANDS; track p.key) {
                  <label><input type="checkbox" [checked]="(ru.branding_providers || []).includes(p.key)" (change)="toggleBrand(p.key, $any($event.target).checked)"> {{ p.label }}<small>{{ p.sub }}</small></label>
                }
                <div><button type="button" class="s-btn" (click)="downloadVcard(ru)">Download contact card (.vcf)</button></div>
              </details>
              @if (preview(); as pv) {
                <span class="s-muted">Gaps: {{ gapsText() }} minutes, inside {{ pv.name }}'s calling rules ({{ pv.tz_label }}). The agent's hours can only narrow the country's. Missed at {{ pv.start.slice(11) }} on {{ dayName(pv.start) }}, it is called again at:</span>
                <div class="nc-times">@for (t of pv.times; track $index) { <span [title]="t.moved.length ? 'Moved: ' + t.moved.join('; ') : ''">{{ dayName(t.local) }} {{ t.local.slice(11) }}@if (t.moved.length) { <small> · {{ t.moved[0] }}</small> }</span> } @empty { <span>No retries</span> }</div>
              } @else {
                <span class="s-muted">Gaps: {{ gapsText() }} minutes. Missed at 10:00 today, it is called again at:</span>
                <div class="nc-times">@for (t of example(); track $index) { <span>{{ t }}</span> } @empty { <span>No retries</span> }</div>
              }
            </div>
          }
          <div class="nc-foot">
            <button type="button" class="s-btn" (click)="step.set(2)">Back</button>
            <button type="button" class="s-btn s-primary" [disabled]="busy()" (click)="start()">{{ busy() ? 'Starting…' : 'Save rule and start' }}</button>
          </div>
        }
      </div>
    </div>
  `,
})
export class NewCampaignComponent {
  readonly source = input.required<NewCampaignSource>();
  protected readonly step = signal(1);
  protected readonly agents = signal<{ key: string; label: string; inputs: string[] }[]>([]);
  protected readonly agent = signal('');
  protected readonly file = signal<File | null>(null);
  protected readonly check = signal<Awaited<ReturnType<NewCampaignSource['check']>> | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly agentLabel = computed(() => this.agents().find((a) => a.key === this.agent())?.label ?? '');
  protected readonly tips = signal<UploadNote | null>(null);
  /** The picked agent's data source, when it has a saved one, and what a run would call right now. */
  protected readonly ds = signal<DsView | null>(null);
  protected readonly dsPreview = signal<DsPreview | null>(null);
  protected readonly dsBusy = signal(false);
  protected scheduleText(v: DsView): string {
    const s = v.setup.schedule; const days = { once: 'Once', daily: 'Every day', weekdays: 'Weekdays', days: 'On chosen days' }[s.cadence];
    return `${days} at ${s.time} IST${v.next_runs[0] ? ' · next ' + v.next_runs[0].label : ''}`;
  }
  protected async runSource(): Promise<void> {
    const a = this.agent(); if (!a || !this.source().runSource) return; this.dsBusy.set(true); this.error.set('');
    try { const r = await this.source().runSource!(a); if (r.campaign_id) this.source().opened(r.campaign_id); else this.error.set('Nothing to call right now: no row matches, or all were called recently.'); }
    catch { this.error.set('Could not start the run.'); } finally { this.dsBusy.set(false); }
  }
  protected readonly noteSent = signal(false);
  protected readonly SCHEDULES = RETRY_SCHEDULES;
  protected readonly BRANDS = BRANDING_PROVIDER_LIST;
  protected readonly RESULTS = RESULT_ROWS;
  private readonly DEFAULT_RESULTS: Record<string, ResultRule> = {
    no_answer: { act: 'retry', tries: 5, gap: null, message: 'whatsapp' }, voicemail: { act: 'retry', tries: 2, gap: 1440, message: 'both' }, silent: { act: 'retry', tries: 3, gap: 15, message: 'none' },
    system: { act: 'retry', tries: 3, gap: 10, message: 'none' }, dnd: { act: 'retry', tries: 2, gap: null, message: 'both' }, cut_short: { act: 'retry', tries: 2, gap: null, message: 'whatsapp' },
    partial: { act: 'retry', tries: 1, gap: 240, message: 'whatsapp' }, callback: { act: 'callback', tries: 1, gap: null, message: 'none' },
  };
  protected resOf(ru: RetryRule, k: string): ResultRule { return { ...this.DEFAULT_RESULTS[k], ...(ru.by_result?.[k] || {}) }; }
  protected setRes(k: string, part: Partial<ResultRule>): void { const ru = this.rule(); if (!ru) return; this.setRule({ by_result: { ...(ru.by_result || {}), [k]: { ...this.resOf(ru, k), ...part } } }); }
  /** "No answer: 5 tries · Voicemail: 2 next day · DND: stop…" in a few words. */
  protected resultSummary(ru: RetryRule): string {
    const stops = RESULT_ROWS.filter((r) => this.resOf(ru, r.key).act === 'stop').map((r) => r.label.toLowerCase());
    return `${RESULT_ROWS.length - stops.length} results retried${stops.length ? ' · stop after ' + stops.join(', ') : ''}${ru.stop_on_goal !== false ? ' · stops once the goal is reached' : ''}`;
  }
  protected readonly columns = signal<{ key: string; label: string }[]>([]);
  protected readonly sheet = signal<EditableSheetRow[]>([]);
  private sheetDirty = false;
  private recheckSeq = 0;
  protected readonly rule = signal<RetryRule | null>(null);
  private rules: { agent: string; rule: RetryRule }[] = [];
  protected readonly gapsText = computed(() => { const r = this.rule(); return r ? retryGaps(r).join(', ') || 'none' : ''; });
  /** Example retry times for a call missed at 10:00 today (IST). */
  protected readonly example = computed(() => {
    const r = this.rule(); if (!r) return [];
    const ist = new Date(Date.now() + 330 * 60000); const ten = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 10, 0) - 330 * 60000;
    return retryTimes(r, ten).map((t) => new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }));
  });
  constructor() {
    effect(() => { const s = this.source(); untracked(() => s.agents().then((a) => this.agents.set(a)).catch(() => this.error.set('Could not load the agents.'))); });
    effect(() => { const s = this.source(); untracked(() => s.retryRules?.().then((r) => { this.rules = r.agents; this.pickRule(); }).catch(() => {})); });
    // The picked agent's tips and retry rule.
    effect(() => { const a = this.agent(); untracked(() => {
      this.tips.set(null); this.ds.set(null); this.dsPreview.set(null); this.pickRule(); if (!a) return;
      this.source().dataSource?.(a).then((v) => { if (this.agent() !== a || !v.saved) return; this.ds.set(v); this.source().previewSource?.(a, v.setup).then((p) => { if (this.agent() === a) this.dsPreview.set(p); }).catch(() => {}); }).catch(() => {});
      this.source().tips?.(a).then((t) => { if (this.agent() === a) this.tips.set(t); }).catch(() => {});
      // The rules may not have loaded with the page (first visit after an update): ask again.
      if (!this.rules.length) this.source().retryRules?.().then((r) => { this.rules = r.agents; this.pickRule(); }).catch(() => {});
    }); });
  }
  private pickRule(): void { const a = this.agent(); const r = this.rules.find((x) => x.agent === a)?.rule; this.rule.set(a && r ? { ...r } : null); }
  /** A sheet row's status in words: the check's codes (ok, warn…) mean nothing to a reader. */
  protected statusWord(s: string): string { return ({ ok: 'Will be called', fixed: 'Fixed', warn: 'Check', bad: 'Not called', test: 'Test number', dummy: 'Sample' } as Record<string, string>)[s] ?? s; }
  protected missingOther(k: { missing: string[] }): string[] { return k.missing.filter((m) => m !== 'contact_phone'); }
  protected setRule(part: Partial<RetryRule>): void { const r = this.rule(); if (r) this.rule.set({ ...r, ...part }); }
  /** The retry preview, from the server: the sheet's main country, else the workspace's home country. */
  protected readonly preview = signal<RetryPreview | null>(null);
  private previewSeq = 0;
  private readonly previewEffect = effect(() => {
    const r = this.rule(); const country = this.check()?.countries?.[0]?.code || 'IN'; if (!r || !this.source().retryPreview) return;
    const my = ++this.previewSeq; untracked(() => this.source().retryPreview!(r, country).then((p) => { if (my === this.previewSeq) this.preview.set(p); }).catch(() => this.preview.set(null)));
  });
  protected dayName(local: string): string { const d = new Date(local.slice(0, 10) + 'T12:00:00Z'); return d.toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }); }
  protected async template(): Promise<void> { save(await this.source().template(this.agent()), `${this.agentLabel().replace(/[^A-Za-z0-9]+/g, '_')}_template.xlsx`); }
  protected async pick(f: File | undefined): Promise<void> {
    this.file.set(f ?? null); this.check.set(null); this.sheet.set([]); this.columns.set([]); this.sheetDirty = false; this.error.set(''); this.noteSent.set(false); if (!f) return;
    try { this.applySheet(await this.source().check(this.agent(), f)); } catch (e) { this.error.set(e instanceof Error ? e.message : 'Could not read that file.'); }
  }
  private applySheet(k: Awaited<ReturnType<NewCampaignSource['check']>>): void {
    this.check.set(k); this.columns.set(k.columns || []); this.sheet.set(k.sheet_rows || []);
  }
  protected editCell(i: number, key: string, value: string): void {
    this.sheet.set(this.sheet().map((r, j) => (j === i ? { ...r, cells: { ...r.cells, [key]: value } } : r)));
    this.sheetDirty = true; this.queueRecheck();
  }
  protected removeRow(i: number): void {
    const row = this.sheet()[i];
    this.sheet.set(this.sheet().filter((_, j) => j !== i));
    if (!(row?.is_dummy && row.row === 0)) this.sheetDirty = true;
    this.queueRecheck();
  }
  private queueRecheck(): void {
    const fn = this.source().recheck; if (!fn) return; const my = ++this.recheckSeq;
    const rows = this.sheet().map((r) => ({ row: r.row, is_dummy: !!r.is_dummy, cells: { ...r.cells } }));
    fn(this.agent(), rows).then((k) => { if (my === this.recheckSeq) this.applySheet(k); }).catch(() => {});
  }
  protected toggleBrand(key: string, on: boolean): void {
    const r = this.rule(); if (!r) return; const cur = new Set(r.branding_providers || []);
    if (on) cur.add(key); else cur.delete(key); this.setRule({ branding_providers: [...cur] });
  }
  protected downloadVcard(ru: RetryRule): void {
    const name = ru.branded_name || 'Moglix Procurement'; const tel = ru.caller_id || '';
    const vcf = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${name}`, `ORG:${name}`, `TEL;TYPE=WORK,VOICE:${tel}`, 'EMAIL;TYPE=WORK:procurement@moglix.com', `NOTE:${ru.call_reason || 'Purchase order follow-up'}. Save this number and unblock it.`, 'END:VCARD'].join('\r\n');
    save(new Blob([vcf], { type: 'text/vcard' }), `${name.replace(/[^A-Za-z0-9]+/g, '_')}.vcf`);
  }
  private editedFile(current: File): File {
    const cols = this.columns(); const lines = [cols.map((c) => c.key).join(',')];
    for (const r of this.sheet()) {
      if (r.is_dummy) continue;
      lines.push(cols.map((c) => { const v = r.cells[c.key] || ''; return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(','));
    }
    return new File([lines.join('\n')], `${current.name.replace(/\.\w+$/, '')}-edited.csv`, { type: 'text/csv' });
  }
  protected async start(): Promise<void> {
    const current = this.file(); if (!current) return; this.busy.set(true);
    const f = this.sheetDirty && this.columns().length ? this.editedFile(current) : current;
    try {
      const ru = this.rule(); if (ru && this.source().saveRetryRule) await this.source().saveRetryRule!(this.agent(), ru);
      const r = await this.source().start(this.agent(), f); this.source().opened(r.campaign_id);
    } catch { this.error.set('Could not start the campaign.'); } finally { this.busy.set(false); }
  }
}

// ── Follow ups: one checklist ─────────────────────────────────────────────────
@Component({
  selector: 'app-follow-ups-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [CSS],
  template: `
    <div class="s">
      <div class="s-head">
        <div><h1 class="s-title">Follow ups</h1><p class="s-sub">What a person does next after a call: tick it off when done. The owner is whoever uploaded the sheet.</p></div>
        <span class="s-grow"></span>
        <button type="button" class="s-btn" (click)="exportList()">Export</button>
      </div>
      <div class="s-head">
        <div class="s-seg" role="group" aria-label="Type">
          <button type="button" [class.on]="kind() === 'all'" (click)="kind.set('all')">All ({{ counts().open }})</button>
          <button type="button" [class.on]="kind() === 'callback'" (click)="kind.set('callback')">Callbacks ({{ counts().callback }})</button>
          <button type="button" [class.on]="kind() === 'follow_up'" (click)="kind.set('follow_up')">Follow-up required ({{ counts().follow_up }})</button>
        </div>
        <div class="s-seg" role="group" aria-label="Show"><button type="button" [class.on]="show() === 'open'" (click)="show.set('open')">To do</button><button type="button" [class.on]="show() === 'done'" (click)="show.set('done')">Done ({{ counts().done }})</button></div>
      </div>
      <div class="s-card">
        <div class="s-scroll">
          <table class="s-stack">
            <thead><tr><th></th><th>Action task</th><th>Summary</th><th>Owner</th><th>Caller</th><th>Last call</th></tr></thead>
            <tbody>
              @for (r of pageRows(); track r.id) {
                <tr class="click" [class.done]="r.follow.state === 'done'" (click)="source().openCall(r)" [title]="'Open the call with ' + (r.caller_name || r.phone)">
                  <td (click)="$event.stopPropagation()"><input type="checkbox" class="s-check" [checked]="r.follow.state === 'done'" (change)="toggle(r)" [attr.aria-label]="'Done: ' + r.task"></td>
                  <td class="s-task">{{ r.task }}<small>{{ r.kind }}@if (r.follow.state === 'done' && r.follow.by) { · done by {{ r.follow.by }} }</small></td>
                  <td class="s-wrap" data-l="Summary">{{ r.summary || r.status_reason }}</td>
                  <td data-l="Owner">{{ r.owner }}</td>
                  <td class="s-caller" data-l="Caller">{{ r.caller_name || '—' }}<small>{{ r.phone }}{{ r.email ? ' · ' + r.email : '' }}</small><small class="s-cut" [title]="r.agent + ' · ' + r.campaign">{{ r.agent }} · {{ r.campaign }}</small></td>
                  <td data-l="Last call">{{ when(r.call_date) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (!rows().length) { <p class="s-empty">{{ show() === 'open' ? 'Nothing to do here.' : 'Nothing done yet.' }}</p> }
        @if (rows().length > PAGE) {
          <div class="s-pager"><button type="button" class="s-btn" [disabled]="page() === 0" (click)="page.set(page() - 1)">Previous</button>
            <span>{{ page() * PAGE + 1 }}–{{ Math.min((page() + 1) * PAGE, rows().length) }} of {{ rows().length }}</span>
            <button type="button" class="s-btn" [disabled]="(page() + 1) * PAGE >= rows().length" (click)="page.set(page() + 1)">Next</button></div>
        }
      </div>
    </div>
  `,
})
export class FollowUpsListComponent {
  protected readonly PAGE = 20;
  protected readonly Math = Math;
  protected readonly page = signal(0);
  protected readonly pageRows = computed(() => this.rows().slice(this.page() * this.PAGE, (this.page() + 1) * this.PAGE));
  readonly source = input.required<FollowUpsSource>();
  protected readonly kind = signal('all');
  protected readonly show = signal('open');
  protected readonly rows = signal<FollowRow[]>([]);
  protected readonly counts = signal({ open: 0, callback: 0, follow_up: 0, done: 0 });
  protected readonly when = when;
  constructor() { effect(() => { this.kind(); this.show(); untracked(() => { this.page.set(0); this.load(); }); }); }
  private async load(): Promise<void> { const r = await this.source().list(this.show(), this.kind()); this.rows.set(r.rows); this.counts.set(r.counts); if (this.page() * this.PAGE >= r.rows.length) this.page.set(0); }
  protected async toggle(r: FollowRow): Promise<void> { await this.source().act(r.id, r.follow.state === 'done' ? 'open' : 'done'); this.load(); }
  protected async exportList(): Promise<void> { save(await this.source().exportXlsx(this.show(), this.kind()), `follow-ups-${this.kind()}-${this.show()}.xlsx`); }
}

// ── Agent metrics: what an agent's campaigns can be counted in, beside calls ──
export interface AgentMetric { field: string; how: 'sum' | 'entries' | 'rows'; label: string }
export interface AgentMetricsRow { agent: string; label: string; columns: { field: string; label: string; suggest: string }[]; hows: { key: string; label: string; example: string }[]; stats: AgentMetric[] }
export interface AgentMetricsSource { load(): Promise<AgentMetricsRow[]>; save(agent: string, stats: AgentMetric[]): Promise<unknown> }
@Component({
  selector: 'app-agent-metrics',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [CSS + `
    .am { display: grid; gap: 12px; }
    .am-row { display: grid; grid-template-columns: minmax(140px, 1.1fr) minmax(140px, 1fr) minmax(170px, 1.1fr) minmax(150px, 1.2fr) auto; gap: 10px; align-items: end; border: 1px solid var(--s-line); border-radius: 10px; padding: 10px 12px; }
    .am-row label { display: grid; gap: 4px; font-size: 12px; color: var(--s-muted); }
    .am-row input, .am-row select { border: 1px solid var(--s-line); border-radius: 6px; padding: 6px 8px; font: inherit; font-size: 13px; background: var(--s-bg); color: var(--s-text); min-width: 0; }
    .am-ex { font-size: 12.5px; color: var(--s-muted); align-self: center; }
    .am-add { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 13px; }
    .am-chip { border: 1px dashed var(--s-line); background: var(--s-bg); color: var(--s-text); border-radius: 999px; padding: 4px 10px; font: inherit; font-size: 12.5px; cursor: pointer; }
    .am-chip:hover { border-color: var(--s-accent); color: var(--s-accent); }
    .am-foot { display: flex; gap: 8px; align-items: center; justify-content: flex-end; }
    .am-ok { color: var(--s-good); font-size: 13px; }
    @media (max-width: 760px) { .am-row { grid-template-columns: 1fr 1fr; } }
  `],
  template: `
    <div class="am">
      <div><b>Metrics</b>
        <p class="s-muted">What {{ row()?.label || 'this agent' }}'s campaigns can be counted in, beside calls: POs, items, quantities. A campaign page's "Count in" and the Campaigns list use them. Each metric counts one column of the agent's sheet.</p></div>
      @if (row(); as a) {
        @for (m of draft(); track $index; let i = $index) {
          <div class="am-row">
            <label>Name<input [value]="m.label" maxlength="30" (input)="set(i, { label: $any($event.target).value })" [attr.aria-label]="'Name of metric ' + (i + 1)"></label>
            <label>Column in the sheet<select (change)="set(i, { field: $any($event.target).value })" [attr.aria-label]="'Column of metric ' + (i + 1)">@for (c of a.columns; track c.field) { <option [value]="c.field" [selected]="c.field === m.field">{{ c.label }}</option> }</select></label>
            <label>How to count it<select (change)="set(i, { how: $any($event.target).value })" [attr.aria-label]="'How metric ' + (i + 1) + ' counts'">@for (h of a.hows; track h.key) { <option [value]="h.key" [selected]="h.key === m.how">{{ h.label }}</option> }</select></label>
            <span class="am-ex">{{ example(m) }}</span>
            <button type="button" class="s-btn" (click)="remove(i)" [attr.aria-label]="'Remove ' + m.label">Remove</button>
          </div>
        } @empty { <p class="s-note">No metrics yet: this agent's campaigns are counted in calls only.</p> }
        <div class="am-add"><span class="s-muted">Add:</span>
          @for (c of suggestions(); track c.field) { <button type="button" class="am-chip" (click)="add(c.field, c.suggest)">+ {{ nameFor(c.field, c.suggest) }}</button> }
          <button type="button" class="am-chip" (click)="add(a.columns[0]?.field || '', 'sum')" [disabled]="!a.columns.length">+ Other metric</button>
        </div>
        <div class="am-foot">@if (saved()) { <span class="am-ok">Saved</span> }@if (error()) { <span class="s-muted">{{ error() }}</span> }
          <button type="button" class="s-btn" (click)="reset()" [disabled]="!dirty()">Undo changes</button>
          <button type="button" class="s-btn s-primary" (click)="save()" [disabled]="!dirty() || busy()">{{ busy() ? 'Saving…' : 'Save metrics' }}</button></div>
      } @else { <p class="s-empty">{{ error() || 'Loading the metrics…' }}</p> }
    </div>
  `,
})
export class AgentMetricsComponent {
  readonly source = input.required<AgentMetricsSource>();
  readonly agent = input.required<string>();
  protected readonly row = signal<AgentMetricsRow | null>(null);
  protected readonly draft = signal<AgentMetric[]>([]);
  protected readonly saved = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly dirty = computed(() => JSON.stringify(this.draft()) !== JSON.stringify(this.clean(this.row()?.stats ?? [])));
  /** Columns not counted yet, each with the way it most likely counts. */
  protected readonly suggestions = computed(() => { const used = new Set(this.draft().map((m) => m.field)); return (this.row()?.columns ?? []).filter((c) => !used.has(c.field)).slice(0, 8); });
  constructor() { effect(() => { const a = this.agent(); const s = this.source(); untracked(() => this.load(s, a)); }); }
  private clean(list: AgentMetric[]): AgentMetric[] { return list.map((m) => ({ field: m.field, how: m.how || 'sum', label: m.label })); }
  private async load(s: AgentMetricsSource, a: string): Promise<void> {
    try { const r = (await s.load()).find((x) => x.agent === a) ?? null; this.row.set(r); this.draft.set(this.clean(r?.stats ?? [])); if (!r) this.error.set('This agent has no sheet columns to count.'); }
    catch { this.error.set('Could not load the metrics.'); }
  }
  protected nameFor(field: string, how: string): string { const f = field.replace(/_/g, ' ').replace(/ count$| numbers$| nos?$/i, ''); const n = f.charAt(0).toUpperCase() + f.slice(1); return how === 'rows' ? `Rows with ${f}` : /^po$/i.test(f) ? 'POs' : n.endsWith('s') ? n : n + 's'; }
  protected example(m: AgentMetric): string { return { sum: 'Adds up the numbers: "1, 2" counts 3', entries: 'Counts entries: "2044120, 2044121" counts 2', rows: 'Each row with a value counts 1' }[m.how] ?? ''; }
  protected set(i: number, part: Partial<AgentMetric>): void { this.saved.set(false); this.draft.set(this.draft().map((m, j) => (j === i ? { ...m, ...part } : m))); }
  protected add(field: string, how: string): void { if (!field) return; this.saved.set(false); this.draft.set([...this.draft(), { field, how: how as AgentMetric['how'], label: this.nameFor(field, how) }]); }
  protected remove(i: number): void { this.saved.set(false); this.draft.set(this.draft().filter((_, j) => j !== i)); }
  protected reset(): void { this.draft.set(this.clean(this.row()?.stats ?? [])); }
  protected async save(): Promise<void> {
    const a = this.row(); if (!a) return; this.busy.set(true); this.error.set('');
    try { await this.source().save(a.agent, this.draft()); await this.load(this.source(), a.agent); this.saved.set(true); } catch { this.error.set('Could not save the metrics.'); } finally { this.busy.set(false); }
  }
}

// ── Calling rules per country: when numbers may be called at all ──────────────
export interface CountryRule {
  code: string; name: string; tz_label: string; offset_min: number; law: string; edited?: boolean;
  days: { day: number; on: boolean; from: string; to: string }[];
  holidays: { date: string; name: string }[];
  register: { name: string; check: boolean; action: 'block' | 'warn' };
}
export interface CallingRulesSource {
  list(): Promise<{ countries: CountryRule[] }>;
  save(code: string, rule: CountryRule): Promise<CountryRule>;
  reset(code: string): Promise<CountryRule>;
  preview?(rule: RetryRule, country: string, startHour?: number): Promise<RetryPreview>;
}
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
@Component({
  selector: 'app-calling-rules',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [CSS + `
    .cr2 { display: grid; gap: 14px; }
    .cr2-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
    .cr2-tab { border: 1px solid var(--s-line); background: var(--s-bg); color: var(--s-text); border-radius: 999px; padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer; display: inline-flex; gap: 6px; align-items: center; }
    .cr2-tab.on { background: var(--s-text); color: var(--s-bg); border-color: var(--s-text); }
    .cr2-tab i { width: 7px; height: 7px; border-radius: 50%; background: var(--s-accent); }
    .cr2-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 14px; align-items: start; }
    .cr2-days { display: grid; gap: 6px; }
    .cr2-day { display: grid; grid-template-columns: 130px 1fr; gap: 10px; align-items: center; font-size: 13px; }
    .cr2-day label { display: inline-flex; gap: 8px; align-items: center; min-height: 28px; cursor: pointer; }
    .cr2-day input[type=checkbox] { width: 22px; height: 22px; accent-color: var(--s-accent); cursor: pointer; }
    .cr2-day input[type=time], .cr2-add input, .cr2 select { border: 1px solid var(--s-line); border-radius: 6px; padding: 5px 8px; font: inherit; font-size: 13px; background: var(--s-bg); color: var(--s-text); }
    .cr2-day input:disabled { opacity: .45; }
    .cr2-hols { display: flex; flex-wrap: wrap; gap: 6px; }
    .cr2-hol { display: inline-flex; gap: 6px; align-items: center; background: var(--s-soft); border-radius: 999px; padding: 4px 6px 4px 10px; font-size: 12.5px; }
    .cr2-hol button { border: 0; background: none; cursor: pointer; color: var(--s-muted); min-width: 26px; min-height: 26px; border-radius: 50%; }
    .cr2-hol button:hover { background: var(--s-line); color: var(--s-text); }
    .cr2-add { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .cr2-law { font-size: 13px; }
    .cr2-times { display: grid; gap: 4px; font-size: 13px; }
    .cr2-times small { color: var(--s-muted); font-size: 12px; }
    .cr2-foot { display: flex; gap: 8px; align-items: center; justify-content: flex-end; }
    h3 { margin: 0; font-size: 14px; }
    @media (max-width: 900px) { .cr2-grid { grid-template-columns: minmax(0, 1fr); } .cr2-day { grid-template-columns: 1fr; } }
  `],
  template: `
    <div class="cr2">
      <div><h2 class="s-title" role="heading" [attr.aria-level]="page() ? 1 : 2">Calling rules</h2>
        <p class="s-sub">When numbers in each country may be called. Every first call, retry and callback is moved into these hours, skipping rest days and holidays. Numbers on a country's do-not-call register are stopped or flagged when a sheet is uploaded. An agent's own retry hours can only narrow these.</p></div>
      <div class="cr2-tabs" role="tablist" aria-label="Country">
        @for (c of list(); track c.code) { <button type="button" role="tab" class="cr2-tab" [class.on]="code() === c.code" [attr.aria-selected]="code() === c.code" (click)="pick(c.code)">{{ c.name }}@if (c.edited) { <i title="Changed from the country's defaults"></i> }</button> }
      </div>
      @if (draft(); as d) {
        <p class="s-note cr2-law"><b>{{ d.name }}:</b> {{ d.law }} Times are in {{ d.tz_label }}.</p>
        <div class="cr2-grid">
          <div class="s-card s-pad">
            <h3>Calling days and hours</h3>
            <div class="cr2-days">
              @for (day of ordered(d); track day.day) {
                <div class="cr2-day">
                  <label><input type="checkbox" [checked]="day.on" (change)="setDay(day.day, { on: $any($event.target).checked })"> {{ DAY_NAMES[day.day] }}</label>
                  <span>@if (day.on) { <input type="time" [value]="day.from" (change)="setDay(day.day, { from: $any($event.target).value })" [attr.aria-label]="DAY_NAMES[day.day] + ' from'"> to <input type="time" [value]="day.to" (change)="setDay(day.day, { to: $any($event.target).value })" [attr.aria-label]="DAY_NAMES[day.day] + ' to'"> } @else { <span class="s-muted">No calls (rest day)</span> }</span>
                </div>
              }
            </div>
          </div>
          <div class="s-card s-pad">
            <h3>Holidays: no calls</h3>
            <div class="cr2-hols">@for (h of d.holidays; track h.date) { <span class="cr2-hol">{{ dateText(h.date) }} · {{ h.name }}<button type="button" (click)="removeHoliday(h.date)" [attr.aria-label]="'Remove ' + h.name">✕</button></span> } @empty { <span class="s-muted">None set.</span> }</div>
            <div class="cr2-add"><input type="date" [value]="newDate()" (change)="newDate.set($any($event.target).value)" aria-label="Holiday date"><input type="text" placeholder="Name, e.g. Diwali" [value]="newName()" (input)="newName.set($any($event.target).value)" aria-label="Holiday name">
              <button type="button" class="s-btn" [disabled]="!newDate()" (click)="addHoliday()">Add holiday</button></div>
            <span class="s-muted">Examples for the coming months. The product loads each country's official list every year.</span>
            <h3>Do-not-call register</h3>
            <span>{{ d.register.name }}</span>
            <label class="cr2-add"><input type="checkbox" [checked]="d.register.check" (change)="setRegister({ check: $any($event.target).checked })"> Check every number when a sheet is uploaded</label>
            <label class="cr2-add">Numbers on it <select [value]="d.register.action" [disabled]="!d.register.check" (change)="setRegister({ action: $any($event.target).value })" aria-label="What happens to numbers on the register">
              <option value="block">are not called</option><option value="warn">are called, with a warning to check it is a service call</option></select></label>
          </div>
        </div>
        @if (preview(); as pv) {
          <div class="s-card s-pad">
            <h3>Try it: a call missed at {{ pv.start.slice(11) }} on {{ dayText(pv.start) }}, retried after 1, 2, 4, 8 and 16 hours</h3>
            <div class="cr2-times">@for (t of pv.times; track $index) { <span>{{ dayText(t.local) }}, {{ t.local.slice(11) }} @if (t.moved.length) { <small>· moved: {{ t.moved.join('; ') }}</small> }</span> }</div>
          </div>
        }
        <div class="cr2-foot">@if (saved()) { <span class="s-muted">Saved. New retries and uploads use these rules.</span> }@if (error()) { <span class="s-muted">{{ error() }}</span> }
          <button type="button" class="s-btn" (click)="resetCountry()" [disabled]="!d.edited && !dirty()">Back to {{ d.name }}'s defaults</button>
          <button type="button" class="s-btn" (click)="undo()" [disabled]="!dirty()">Undo changes</button>
          <button type="button" class="s-btn s-primary" (click)="save()" [disabled]="!dirty() || busy()">{{ busy() ? 'Saving…' : 'Save rules' }}</button></div>
      } @else { <p class="s-empty">{{ error() || 'Loading the calling rules…' }}</p> }
    </div>
  `,
})
export class CallingRulesComponent {
  readonly source = input.required<CallingRulesSource>();
  /** True when this is the whole page (Clarix Admin), not a tab in Settings: the title is then the page heading. */
  readonly page = input(false);
  protected readonly DAY_NAMES = DAY_NAMES;
  protected readonly list = signal<CountryRule[]>([]);
  protected readonly code = signal('IN');
  protected readonly draft = signal<CountryRule | null>(null);
  protected readonly preview = signal<RetryPreview | null>(null);
  protected readonly saved = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly newDate = signal('');
  protected readonly newName = signal('');
  protected readonly dirty = computed(() => { const d = this.draft(); const o = this.list().find((c) => c.code === d?.code); return !!d && !!o && JSON.stringify(this.core(d)) !== JSON.stringify(this.core(o)); });
  private seq = 0;
  constructor() {
    effect(() => { const s = this.source(); untracked(() => this.load(s)); });
    // The preview follows the draft: what the default retry rule does under these rules.
    effect(() => {
      const d = this.draft(); if (!d || !this.source().preview) return; const my = ++this.seq;
      // Missed late in the day with doubling gaps, so the retries run into the next days and show rest days and holidays.
      const rule: RetryRule = { schedule: 'doubling', base_minutes: 60, retries: 5, from: '00:00', to: '23:59', skip_sunday: false, avoid_lunch: false };
      untracked(() => this.previewFor(d, rule, my));
    });
  }
  private core(c: CountryRule) { return { days: c.days, holidays: c.holidays, register: { check: c.register.check, action: c.register.action } }; }
  private async load(s: CallingRulesSource): Promise<void> {
    try { const r = await s.list(); this.list.set(r.countries); this.pick(this.code()); } catch { this.error.set('Could not load the calling rules.'); }
  }
  /** Previews against the saved rules on the server, so the draft is saved quietly first only when asked; here: the saved country. */
  private async previewFor(d: CountryRule, rule: RetryRule, my: number): Promise<void> {
    try { const p = await this.source().preview!(rule, d.code, 16); if (my === this.seq) this.preview.set(p); } catch { this.preview.set(null); }
  }
  protected pick(code: string): void { const c = this.list().find((x) => x.code === code); this.code.set(code); this.draft.set(c ? JSON.parse(JSON.stringify(c)) : null); this.saved.set(false); }
  /** Monday first, as people read a week. */
  protected ordered(d: CountryRule) { return [...d.days.slice(1), d.days[0]]; }
  protected setDay(day: number, part: Partial<CountryRule['days'][number]>): void { const d = this.draft(); if (!d) return; this.saved.set(false); this.draft.set({ ...d, days: d.days.map((x) => (x.day === day ? { ...x, ...part } : x)) }); }
  protected setRegister(part: Partial<CountryRule['register']>): void { const d = this.draft(); if (!d) return; this.saved.set(false); this.draft.set({ ...d, register: { ...d.register, ...part } }); }
  protected addHoliday(): void {
    const d = this.draft(); const date = this.newDate(); if (!d || !date || d.holidays.some((h) => h.date === date)) return; this.saved.set(false);
    this.draft.set({ ...d, holidays: [...d.holidays, { date, name: this.newName().trim() || 'Holiday' }].sort((a, b) => a.date.localeCompare(b.date)) }); this.newDate.set(''); this.newName.set('');
  }
  protected removeHoliday(date: string): void { const d = this.draft(); if (!d) return; this.saved.set(false); this.draft.set({ ...d, holidays: d.holidays.filter((h) => h.date !== date) }); }
  protected undo(): void { this.pick(this.code()); }
  protected async save(): Promise<void> {
    const d = this.draft(); if (!d) return; this.busy.set(true); this.error.set('');
    try { const r = await this.source().save(d.code, d); this.list.set(this.list().map((c) => (c.code === d.code ? { ...r, edited: true } : c))); this.pick(d.code); this.saved.set(true); }
    catch { this.error.set('Could not save the rules.'); } finally { this.busy.set(false); }
  }
  protected async resetCountry(): Promise<void> {
    const d = this.draft(); if (!d) return;
    try { const r = await this.source().reset(d.code); this.list.set(this.list().map((c) => (c.code === d.code ? { ...r, edited: false } : c))); this.pick(d.code); this.saved.set(true); } catch { this.error.set('Could not reset the rules.'); }
  }
  protected dateText(ymd: string): string { return new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }); }
  protected dayText(local: string): string { return new Date(local.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }); }
}

// ── Agent data source: connect a system once, then campaigns run on a schedule without a sheet ──
export interface DsField { key: string; label: string; type: string; placeholder?: string }
export interface DsConnector { key: string; group: string; name: string; how: string; fields: DsField[]; objects: string[]; oauth?: boolean; push?: boolean; query?: boolean }
export interface DsFilter { field: string; op: string; value?: string }
export interface DsSetup {
  connector: string; fields: Record<string, string>; object: string; has_secret?: boolean; authorised?: boolean; test_event?: { rows: number; at: string } | null; tested?: boolean;
  mapping: { input: string; column: string }[]; filters: DsFilter[]; group: { mode: 'row' | 'group'; by: string[]; max_lines: number; order: string };
  dedupe: { key: string; days: number }; write_back: { mode: 'off' | 'each' | 'batch'; mapping: { output: string; field: string }[] };
  schedule: { on: boolean; cadence: 'once' | 'daily' | 'weekdays' | 'days'; days: number[]; time: string; start: string; end: string };
}
export interface DsView { agent: string; label: string; connector_name?: string; inputs: string[]; outputs: string[]; setup: DsSetup; saved: boolean; webhook_url: string; filter_ops: [string, string][];
  columns: { key: string; label: string; type: string; sample: string }[]; runs: { at: string; by: string; read: number; after_filters: number; calls: number; campaign_id?: string; status: string }[]; next_runs: { at: string; label: string }[] }
export interface DsTest { ok: boolean; steps: { key: string; label: string; ok: boolean; detail: string }[]; columns?: DsView['columns']; sample?: Record<string, unknown>[] }
export interface DsPreview { read: number; after_filters: number; skipped_recent: number; no_phone: number; do_not_call?: number; total_calls: number; calls: { key: string; part: number; parts: number; lines: number; phone: string; inputs: Record<string, string> }[];
  write_back: { key: string; set: Record<string, string> }[]; next_runs: { at: string; label: string }[] }
export interface DataSourceSource {
  catalog(): Promise<{ connectors: DsConnector[] }>;
  load(agent: string): Promise<DsView>;
  save(agent: string, setup: DsSetup): Promise<DsView>;
  test(conn: Partial<DsSetup>): Promise<DsTest>;
  preview(agent: string, setup: DsSetup): Promise<DsPreview>;
  run(agent: string): Promise<{ campaign_id: string | null; dialled: number; calls: number; read: number; after_filters: number }>;
  openCampaign?(id: string): void;
}
const DS_STEPS = ['Connect', 'Fields', 'Which rows', 'One call per', 'Results back', 'Schedule'];
const WEEKDAYS: [number, string][] = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const WB_MODES: [DsSetup['write_back']['mode'], string][] = [['off', 'Off'], ['each', 'After every call'], ['batch', 'Once, after the run']];
const CADENCES: [DsSetup['schedule']['cadence'], string][] = [['once', 'Once'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['days', 'On these days']];
@Component({
  selector: 'app-agent-data-source',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [CSS + `
    .ds { display: grid; gap: 14px; }
    .ds-steps { display: flex; flex-wrap: wrap; gap: 6px; }
    .ds-steps button { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--s-line); background: var(--s-bg); color: var(--s-muted); border-radius: 999px; padding: 5px 12px 5px 6px; font: inherit; font-size: 13px; cursor: pointer; }
    .ds-steps button i { font-style: normal; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; background: var(--s-soft); font-size: 11px; font-weight: 600; }
    .ds-steps button.on { border-color: var(--s-accent); color: var(--s-accent); font-weight: 600; }
    .ds-steps button.on i { background: var(--s-accent); color: #fff; }
    .ds-steps button.done i { background: var(--s-good); color: #fff; }
    .ds-sum { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 13px; border: 1px solid var(--s-line); background: var(--s-soft); border-radius: 10px; padding: 8px 12px; }
    .ds-sum b { font-variant-numeric: tabular-nums; }
    .ds-sum .ar { color: var(--s-muted); }
    .ds-sec { display: grid; gap: 10px; min-width: 0; }
    .ds-sec h3 { margin: 4px 0 0; font-size: 15px; }
    .ds-group { display: grid; gap: 6px; }
    .ds-group > span { font-size: 11.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--s-muted); }
    .ds-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; }
    .ds-tile { text-align: left; border: 1px solid var(--s-line); background: var(--s-bg); color: var(--s-text); border-radius: 10px; padding: 9px 11px; font: inherit; cursor: pointer; display: grid; gap: 2px; }
    .ds-tile small { color: var(--s-muted); font-size: 12px; }
    .ds-tile:hover { border-color: var(--s-accent); }
    .ds-tile.on { border: 2px solid var(--s-accent); padding: 8px 10px; background: color-mix(in srgb, var(--s-accent) 7%, var(--s-bg)); }
    .ds-form { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
    .ds-form label, .ds-l { display: grid; gap: 4px; font-size: 12px; color: var(--s-muted); }
    .ds input, .ds select { border: 1px solid var(--s-line); border-radius: 6px; padding: 6px 8px; font: inherit; font-size: 13px; background: var(--s-bg); color: var(--s-text); min-width: 0; }
    .ds-check { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
    .ds-check li { display: grid; grid-template-columns: 22px 1fr; gap: 2px 8px; font-size: 13px; }
    .ds-check li i { font-style: normal; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; color: #fff; background: var(--s-good); grid-row: span 2; }
    .ds-check li.bad i { background: #dc2626; }
    .ds-check li small { color: var(--s-muted); }
    .ds-hook { display: grid; gap: 6px; border: 1px dashed var(--s-line); border-radius: 10px; padding: 10px 12px; font-size: 13px; }
    .ds-hook code { word-break: break-all; background: var(--s-soft); padding: 4px 6px; border-radius: 6px; font-size: 12px; }
    .ds-scroll { overflow-x: auto; }
    .ds-tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
    .ds-tbl th { text-align: left; font-weight: 500; color: var(--s-muted); font-size: 12px; padding: 6px 8px; border-bottom: 1px solid var(--s-line); }
    .ds-tbl td { padding: 6px 8px; border-bottom: 1px solid var(--s-line); vertical-align: middle; }
    .ds-tbl td.v { color: var(--s-muted); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ds-badge { font-size: 11.5px; border-radius: 999px; padding: 1px 8px; border: 1px solid var(--s-line); white-space: nowrap; }
    .ds-badge.high { color: var(--s-good); border-color: color-mix(in srgb, var(--s-good) 40%, transparent); }
    .ds-badge.need { color: #b91c1c; border-color: #fca5a5; }
    .ds-row { display: grid; grid-template-columns: minmax(130px, 1fr) minmax(150px, 1fr) minmax(110px, 1fr) auto; gap: 8px; align-items: center; }
    .ds-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .ds-chips button { border: 1px solid var(--s-line); background: var(--s-bg); color: var(--s-text); border-radius: 999px; padding: 4px 10px; font: inherit; font-size: 12.5px; cursor: pointer; }
    .ds-chips button.on { border-color: var(--s-accent); background: color-mix(in srgb, var(--s-accent) 10%, var(--s-bg)); color: var(--s-accent); font-weight: 600; }
    .ds-calls { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px; }
    .ds-call { border: 1px solid var(--s-line); border-radius: 10px; padding: 9px 11px; display: grid; gap: 4px; align-content: start; font-size: 12.5px; min-width: 0; }
    .ds-call b { font-size: 13.5px; }
    .ds-call dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; }
    .ds-call dt { color: var(--s-muted); }
    .ds-call dd { margin: 0; overflow-wrap: anywhere; }
    .ds-modes { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; }
    .ds-modes button { text-align: left; border: 1px solid var(--s-line); background: var(--s-bg); color: var(--s-text); border-radius: 10px; padding: 10px 12px; font: inherit; cursor: pointer; display: grid; gap: 3px; }
    .ds-modes button small { color: var(--s-muted); font-size: 12.5px; }
    .ds-modes button.on { border: 2px solid var(--s-accent); padding: 9px 11px; background: color-mix(in srgb, var(--s-accent) 7%, var(--s-bg)); }
    .ds-inline { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
    .ds-foot { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; border-top: 1px solid var(--s-line); padding-top: 10px; }
    .ds-foot .grow { flex: 1; }
    .ds-ok { color: var(--s-good); font-size: 13px; }
    .ds-err { color: #b91c1c; font-size: 13px; }
    .ds-switch { display: inline-flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 600; cursor: pointer; }
    .ds-switch input { width: 18px; height: 18px; }
    .ds-link { border: 0; background: none; padding: 0; color: var(--s-accent); text-decoration: underline; font: inherit; cursor: pointer; }
    @media (max-width: 640px) { .ds-row { grid-template-columns: 1fr 1fr; } .ds-tbl td.v { max-width: 120px; } }
  `],
  template: `
    <div class="ds">
      <div><b>Data source</b>
        <p class="s-muted">Connect {{ view()?.label || 'this agent' }} to the system that holds the work: an ERP, CRM, database, API or webhook. Each run reads the rows, keeps the ones that need a call, groups their lines into calls and starts a campaign. No sheet to upload.</p></div>
      @if (view(); as v) {
        <nav class="ds-steps" aria-label="Setup steps">
          @for (s of STEPS; track s; let i = $index) { <button type="button" [class.on]="step() === i" [class.done]="step() !== i && stepDone(i)" [attr.aria-current]="step() === i ? 'step' : null" (click)="go(i)"><i>{{ stepDone(i) && step() !== i ? '✓' : i + 1 }}</i>{{ s }}</button> }
        </nav>
        @if (step() >= 2 && preview(); as p) {
          <div class="ds-sum" aria-live="polite"><span><b>{{ p.read }}</b> rows read</span><span class="ar">→</span><span><b>{{ p.after_filters }}</b> match</span>
            @if (p.skipped_recent) { <span class="ar">→</span><span><b>{{ p.skipped_recent }}</b> called recently, skipped</span> }
            @if (p.no_phone) { <span class="ar">→</span><span><b>{{ p.no_phone }}</b> without a phone</span> }
            @if (p.do_not_call) { <span class="ar">→</span><span><b>{{ p.do_not_call }}</b> on the do-not-call list</span> }
            <span class="ar">→</span><span><b>{{ p.total_calls }}</b> call{{ p.total_calls === 1 ? '' : 's' }}</span></div>
        }

        @switch (step()) {
          @case (0) {
            <section class="ds-sec">
              <h3>Where do the rows come from?</h3>
              @for (g of groups(); track g.name) {
                <div class="ds-group"><span>{{ g.name }}</span>
                  <div class="ds-tiles">@for (c of g.list; track c.key) { <button type="button" class="ds-tile" [class.on]="d().connector === c.key" [attr.aria-pressed]="d().connector === c.key" (click)="pick(c)"><b>{{ c.name }}</b><small>{{ c.how }}</small></button> }</div>
                </div>
              }
              @if (conn(); as c) {
                <h3>{{ c.name }}</h3>
                @if (c.push) {
                  <div class="ds-hook">
                    <b>Send rows to this address</b>
                    <code>{{ v.webhook_url }}</code>
                    <span class="s-muted">POST a JSON body: one object per row, or a "rows" list. Sign it with the secret below in the X-Echo-Signature header (HMAC SHA-256).</span>
                    <span>Signing secret: <code>whsec_••••••••••••3f9a</code></span>
                    <div><button type="button" class="s-btn" (click)="sendTestEvent()">Send test event</button></div>
                  </div>
                } @else {
                  @if (c.oauth) {
                    <div class="ds-inline"><button type="button" class="s-btn" [class.s-primary]="!d().authorised" (click)="patch({ authorised: true })">{{ d().authorised ? 'Connected to ' + c.name + ' ✓' : 'Connect ' + c.name + ' account' }}</button><span class="s-muted">Opens {{ c.name }} sign-in and asks for read access. (Demo: no window opens.)</span></div>
                  }
                  @if (c.fields.length) {
                    <div class="ds-form">
                      @for (f of c.fields; track f.key) {
                        <label>{{ f.label }}<input [type]="f.type === 'secret' ? 'password' : 'text'" autocomplete="off" [placeholder]="f.type === 'secret' && d().has_secret ? 'Stored: leave blank to keep' : (f.placeholder || '')" [value]="f.type === 'secret' ? '' : (d().fields[f.key] || '')" (input)="setField(f.key, $any($event.target).value)"></label>
                      }
                    </div>
                  }
                  <label class="ds-l">What to read<select (change)="patch({ object: $any($event.target).value })">@for (o of c.objects; track o) { <option [value]="o" [selected]="o === d().object">{{ o }}</option> }</select></label>
                  <p class="s-muted">Use a read-only user. Secrets are stored encrypted and never shown again.</p>
                }
                <div class="ds-inline"><button type="button" class="s-btn s-primary" (click)="runTest()" [disabled]="testing()">{{ testing() ? 'Testing…' : 'Test connection' }}</button></div>
                @if (test(); as t) {
                  <ul class="ds-check" aria-label="Connection test">
                    @for (s of t.steps; track s.key) { <li [class.bad]="!s.ok"><i>{{ s.ok ? '✓' : '✕' }}</i><b>{{ s.label }}</b><small>{{ s.detail }}</small></li> }
                  </ul>
                  @if (t.ok) { <p class="ds-ok">The connection works. Next, match the fields.</p> }
                }
              }
            </section>
          }
          @case (1) {
            <section class="ds-sec">
              <h3>Fill each input of the agent from a column</h3>
              <p class="s-muted">Matched by name: check the sample value. A list input (POs, items) gets every line of a call, joined.</p>
              <div class="ds-scroll"><table class="ds-tbl">
                <thead><tr><th>Agent input</th><th>Column in {{ conn()?.name || 'the source' }}</th><th>Sample</th><th></th></tr></thead>
                <tbody>@for (m of d().mapping; track m.input) {
                  <tr><td><b>{{ m.input }}</b>@if (m.input === 'contact_phone') { <span class="s-muted"> (required)</span> }</td>
                    <td><select (change)="setMap(m.input, $any($event.target).value)" [attr.aria-label]="'Column for ' + m.input"><option value="">Not used</option>@for (c of v.columns; track c.key) { <option [value]="c.key" [selected]="c.key === m.column">{{ c.key }}</option> }</select></td>
                    <td class="v" [title]="sampleOf(m.column)">{{ sampleOf(m.column) || (!m.column && isCount(m.input) ? 'Counted from the lines of each call' : '—') }}</td>
                    <td>@if (!m.column && m.input === 'contact_phone') { <span class="ds-badge need">Needed</span> } @else if (m.column && autoOf(m.input) === m.column) { <span class="ds-badge high">Matched</span> } @else if (m.column) { <span class="ds-badge">Set by you</span> }</td></tr>
                }</tbody></table></div>
            </section>
          }
          @case (2) {
            <section class="ds-sec">
              <h3>Which rows need a call?</h3>
              <p class="s-muted">Dates count from the day of each run, so "on or before today + 3" stays right on every schedule.</p>
              @for (f of d().filters; track $index; let i = $index) {
                <div class="ds-row">
                  <select (change)="setFilter(i, { field: $any($event.target).value })" [attr.aria-label]="'Column of condition ' + (i + 1)">@for (c of v.columns; track c.key) { <option [value]="c.key" [selected]="c.key === f.field">{{ c.key }}</option> }</select>
                  <select (change)="setFilter(i, { op: $any($event.target).value })" [attr.aria-label]="'Condition ' + (i + 1)">@for (o of v.filter_ops; track o[0]) { <option [value]="o[0]" [selected]="o[0] === f.op">{{ o[1] }}</option> }</select>
                  @if (f.op !== 'blank' && f.op !== 'notblank' && f.op !== 'overdue') { <input [value]="f.value || ''" (input)="setFilter(i, { value: $any($event.target).value })" [placeholder]="f.op === 'due' || f.op === 'since' ? 'days' : f.op === 'is' || f.op === 'isnot' ? 'value, or a, b' : 'value'" [attr.aria-label]="'Value of condition ' + (i + 1)"> } @else { <span></span> }
                  <button type="button" class="s-btn" (click)="removeFilter(i)" [attr.aria-label]="'Remove condition ' + (i + 1)">Remove</button>
                </div>
              } @empty { <p class="s-note">No conditions: every row is called.</p> }
              <div><button type="button" class="s-btn" (click)="addFilter()">+ Add condition</button></div>
              <h3>Do not call the same line twice</h3>
              <div class="ds-inline">
                <label class="ds-l">Each line is unique by<select (change)="patch({ dedupe: { key: $any($event.target).value, days: d().dedupe.days } })"><option value="">Do not check</option>@for (c of v.columns; track c.key) { <option [value]="c.key" [selected]="c.key === d().dedupe.key">{{ c.key }}</option> }</select></label>
                <label class="ds-l">Skip if called in the last (days)<input type="number" min="0" max="60" [value]="d().dedupe.days" (input)="patch({ dedupe: { key: d().dedupe.key, days: +$any($event.target).value } })"></label>
              </div>
            </section>
          }
          @case (3) {
            <section class="ds-sec">
              <h3>One call per…</h3>
              <div class="ds-modes">
                <button type="button" [class.on]="d().group.mode === 'row'" [attr.aria-pressed]="d().group.mode === 'row'" (click)="setGroup({ mode: 'row' })"><b>Each row</b><small>One call per record. For single-line cases: a payment due, an appointment.</small></button>
                <button type="button" [class.on]="d().group.mode === 'group'" [attr.aria-pressed]="d().group.mode === 'group'" (click)="setGroup({ mode: 'group' })"><b>Group lines into one call</b><small>One call per supplier (or supplier and PO) with all their lines. POs and items are joined into the agent's list inputs.</small></button>
              </div>
              @if (d().group.mode === 'group') {
                <span class="ds-l">Group by (one or more)</span>
                <div class="ds-chips">@for (c of groupable(); track c) { <button type="button" [class.on]="d().group.by.includes(c)" [attr.aria-pressed]="d().group.by.includes(c)" (click)="toggleBy(c)">{{ c }}</button> }</div>
                <div class="ds-inline">
                  <label class="ds-l">Most lines per call<input type="number" min="1" max="30" [value]="d().group.max_lines" (input)="setGroup({ max_lines: +$any($event.target).value })"></label>
                  <label class="ds-l">Lines in order of<select (change)="setGroup({ order: $any($event.target).value })"><option value="">As read</option>@for (c of v.columns; track c.key) { <option [value]="c.key" [selected]="c.key === d().group.order">{{ c.key }}</option> }</select></label>
                </div>
                <p class="s-muted">A supplier with more lines than that gets more than one call, each with its part of the list.</p>
              }
              @if (preview(); as p) {
                <h3>First calls of a run</h3>
                <div class="ds-calls">@for (c of p.calls; track c.key + '-' + c.part) {
                  <div class="ds-call"><b>{{ c.inputs['contact_name'] || c.phone }}</b><span class="s-muted">{{ c.phone }} · {{ c.lines }} line{{ c.lines === 1 ? '' : 's' }}{{ c.parts > 1 ? ' · part ' + c.part + ' of ' + c.parts : '' }}</span>
                    <dl>@for (e of entries(c.inputs); track e[0]) { @if (e[0] !== 'contact_name' && e[0] !== 'contact_phone') { <dt>{{ e[0] }}</dt><dd>{{ e[1] || '—' }}</dd> } }</dl></div>
                } @empty { <p class="s-note">No calls: no row matches the conditions.</p> }</div>
              }
            </section>
          }
          @case (4) {
            <section class="ds-sec">
              <h3>Send the answers back to {{ conn()?.name || 'the source' }}</h3>
              <div class="s-seg" role="group" aria-label="When to send results">
                @for (m of WB_MODES; track m[0]) { <button type="button" [class.on]="d().write_back.mode === m[0]" [attr.aria-pressed]="d().write_back.mode === m[0]" (click)="setWbMode(m[0])">{{ m[1] }}</button> }
              </div>
              @if (d().write_back.mode !== 'off') {
                @for (w of d().write_back.mapping; track $index; let i = $index) {
                  <div class="ds-row">
                    <select (change)="setWb(i, { output: $any($event.target).value })" aria-label="Agent answer">@for (o of v.outputs; track o) { <option [value]="o" [selected]="o === w.output">{{ o }}</option> }</select>
                    <input [value]="w.field" (input)="setWb(i, { field: $any($event.target).value })" placeholder="Field in the source, e.g. ZZ_SUPPLIER_STATUS" aria-label="Field in the source">
                    <span></span><button type="button" class="s-btn" (click)="removeWb(i)">Remove</button>
                  </div>
                }
                <div><button type="button" class="s-btn" (click)="addWb()" [disabled]="!v.outputs.length">+ Add a field to update</button></div>
                @if (preview()?.write_back?.length) {
                  <b>Dry run: the first updates</b>
                  <div class="ds-scroll"><table class="ds-tbl"><thead><tr><th>Line</th><th>Would set</th></tr></thead><tbody>@for (u of preview()!.write_back; track u.key) { <tr><td>{{ u.key }}</td><td>@for (e of entries(u.set); track e[0]) { <span>{{ e[0] }} = {{ e[1] }}; </span> }</td></tr> }</tbody></table></div>
                }
              } @else { <p class="s-note">Answers stay in {{ appName() }}: on the call page, the campaign and its export.</p> }
            </section>
          }
          @case (5) {
            <section class="ds-sec">
              <h3>When to run</h3>
              <label class="ds-switch"><input type="checkbox" [checked]="d().schedule.on" (change)="setSch({ on: $any($event.target).checked })"> Run on a schedule</label>
              <div class="ds-inline">
                <label class="ds-l">Repeat<select (change)="setSch({ cadence: $any($event.target).value })">@for (o of CADENCES; track o[0]) { <option [value]="o[0]" [selected]="o[0] === d().schedule.cadence">{{ o[1] }}</option> }</select></label>
                <label class="ds-l">At (IST)<input type="time" [value]="d().schedule.time" (change)="setSch({ time: $any($event.target).value })"></label>
                <label class="ds-l">Starting<input type="date" [value]="d().schedule.start" (change)="setSch({ start: $any($event.target).value })"></label>
                @if (d().schedule.cadence !== 'once') { <label class="ds-l">Until (optional)<input type="date" [value]="d().schedule.end" (change)="setSch({ end: $any($event.target).value })"></label> }
              </div>
              @if (d().schedule.cadence === 'days') { <div class="ds-chips">@for (w of WEEKDAYS; track w[0]) { <button type="button" [class.on]="d().schedule.days.includes(w[0])" [attr.aria-pressed]="d().schedule.days.includes(w[0])" (click)="toggleDay(w[0])">{{ w[1] }}</button> }</div> }
              <p class="s-muted">Each run reads fresh rows. Its calls then follow the calling rules of each number's country and the agent's retry rule.</p>
              @if (d().schedule.on && preview()?.next_runs?.length) { <div><b>Next runs</b><ul>@for (r of preview()!.next_runs; track r.at) { <li>{{ r.label }}</li> }</ul></div> }
              <b>Past runs</b>
              @if (v.runs.length) {
                <div class="ds-scroll"><table class="ds-tbl"><thead><tr><th>When</th><th>By</th><th>Rows read</th><th>Matched</th><th>Calls</th><th>Result</th></tr></thead><tbody>
                  @for (r of v.runs; track r.at) { <tr><td>{{ when(r.at) }}</td><td>{{ r.by }}</td><td>{{ r.read }}</td><td>{{ r.after_filters }}</td><td>{{ r.calls }}</td>
                    <td>@if (r.campaign_id && source().openCampaign) { <button type="button" class="ds-link" (click)="openRun(r.campaign_id)">{{ r.status }}: open campaign</button> } @else { {{ r.status }} }</td></tr> }
                </tbody></table></div>
              } @else { <p class="s-note">No runs yet.</p> }
            </section>
          }
        }

        <div class="ds-foot">
          @if (msg()) { <span [class.ds-ok]="!msgBad()" [class.ds-err]="msgBad()" role="status">{{ msg() }}</span> }
          <span class="grow"></span>
          @if (step() > 0) { <button type="button" class="s-btn" (click)="go(step() - 1)">Back</button> }
          @if (step() < STEPS.length - 1) { <button type="button" class="s-btn" (click)="go(step() + 1)" [disabled]="step() === 0 && !test()?.ok && !v.saved">Next</button> }
          <button type="button" class="s-btn" (click)="runNow()" [disabled]="busy() || !v.saved || dirty()" [title]="!v.saved || dirty() ? 'Save the setup first' : 'Read the rows now and start the calls'">Run now</button>
          <button type="button" class="s-btn s-primary" (click)="save()" [disabled]="busy() || !dirty() || !d().connector">{{ busy() ? 'Saving…' : d().schedule.on ? 'Save and turn on' : 'Save' }}</button>
        </div>
      } @else { <p class="s-empty">{{ msg() || 'Loading the data source…' }}</p> }
    </div>
  `,
})
export class AgentDataSourceComponent {
  readonly source = input.required<DataSourceSource>();
  readonly agent = input.required<string>();
  readonly appName = input('the app');
  protected readonly STEPS = DS_STEPS;
  protected readonly WEEKDAYS = WEEKDAYS;
  protected readonly WB_MODES = WB_MODES;
  protected readonly CADENCES = CADENCES;
  protected readonly view = signal<DsView | null>(null);
  protected readonly connectors = signal<DsConnector[]>([]);
  protected readonly d = signal<DsSetup>({} as DsSetup);
  protected readonly step = signal(0);
  protected readonly test = signal<DsTest | null>(null);
  protected readonly testing = signal(false);
  protected readonly preview = signal<DsPreview | null>(null);
  protected readonly busy = signal(false);
  protected readonly msg = signal('');
  protected readonly msgBad = signal(false);
  private readonly secret = signal('');
  private timer: ReturnType<typeof setTimeout> | null = null;
  protected readonly conn = computed(() => this.connectors().find((c) => c.key === this.d().connector) ?? null);
  protected readonly groups = computed(() => { const out = new Map<string, DsConnector[]>(); for (const c of this.connectors()) (out.get(c.group) || out.set(c.group, []).get(c.group)!).push(c); return [...out.entries()].map(([name, list]) => ({ name, list })); });
  protected readonly dirty = computed(() => !!this.secret() || JSON.stringify(this.d()) !== JSON.stringify(this.view()?.setup ?? {}));
  protected readonly groupable = computed(() => (this.view()?.columns ?? []).filter((c) => c.type === 'text' && !/summary|item_name|line_id|email/.test(c.key)).map((c) => c.key));
  constructor() { effect(() => { const a = this.agent(); const s = this.source(); untracked(() => this.load(s, a)); }); }
  private async load(s: DataSourceSource, a: string): Promise<void> {
    try {
      const [cat, v] = await Promise.all([s.catalog(), s.load(a)]); this.connectors.set(cat.connectors); this.view.set(v); this.d.set(structuredClone(v.setup)); this.secret.set('');
      if (v.saved) { this.step.set(5); this.refresh(); }
    } catch { this.msg.set('Could not load the data source.'); this.msgBad.set(true); }
  }
  protected stepDone(i: number): boolean {
    const d = this.d(); if (!d.connector) return false; const saved = !!this.view()?.saved;
    return [!!this.test()?.ok || saved, !!d.mapping?.some((m) => m.input === 'contact_phone' && m.column), saved, saved, saved, saved][i];
  }
  protected go(i: number): void { this.step.set(Math.max(0, Math.min(DS_STEPS.length - 1, i))); this.refresh(); }
  protected patch(part: Partial<DsSetup>): void { this.d.set({ ...this.d(), ...part }); this.msg.set(''); this.refresh(); }
  protected pick(c: DsConnector): void { if (this.d().connector === c.key) return; this.test.set(null); this.secret.set(''); this.patch({ connector: c.key, fields: {}, object: c.objects[0], has_secret: false, authorised: false, test_event: null }); }
  protected setField(k: string, v: string): void { if (k === 'secret') { this.secret.set(v); this.test.set(null); return; } this.test.set(null); this.patch({ fields: { ...this.d().fields, [k]: v } }); }
  private withSecret(): DsSetup { return { ...this.d(), fields: { ...this.d().fields, ...(this.secret() ? { secret: this.secret() } : {}) } }; }
  protected async runTest(): Promise<void> {
    this.testing.set(true);
    try { this.test.set(await this.source().test(this.withSecret())); }
    catch { this.test.set({ ok: false, steps: [{ key: 'x', label: 'The test could not run', ok: false, detail: 'Try again in a moment.' }] }); }
    finally { this.testing.set(false); }
  }
  protected sendTestEvent(): void { this.patch({ test_event: { rows: 3, at: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) } }); this.runTest(); }
  protected setMap(input: string, column: string): void { this.patch({ mapping: this.d().mapping.map((m) => (m.input === input ? { ...m, column } : m)) }); }
  protected sampleOf(col: string): string { return col ? this.view()?.columns.find((c) => c.key === col)?.sample ?? '' : ''; }
  protected isCount(input: string): boolean { return /^po_?(count|total)$|^(item|line)s?_?(count|total)$|^no_of_/i.test(input); }
  protected autoOf(input: string): string { return this.view()?.setup.mapping.find((m) => m.input === input)?.column ?? ''; }
  protected setFilter(i: number, part: Partial<DsFilter>): void { this.patch({ filters: this.d().filters.map((f, j) => (j === i ? { ...f, ...part } : f)) }); }
  protected addFilter(): void { this.patch({ filters: [...this.d().filters, { field: 'status', op: 'is', value: '' }] }); }
  protected removeFilter(i: number): void { this.patch({ filters: this.d().filters.filter((_, j) => j !== i) }); }
  protected setGroup(part: Partial<DsSetup['group']>): void { this.patch({ group: { ...this.d().group, ...part } }); }
  protected toggleBy(c: string): void { const by = this.d().group.by; this.setGroup({ by: by.includes(c) ? by.filter((x) => x !== c) : [...by, c] }); }
  protected setWbMode(mode: DsSetup['write_back']['mode']): void { this.patch({ write_back: { ...this.d().write_back, mode } }); }
  protected setWb(i: number, part: Partial<{ output: string; field: string }>): void { this.patch({ write_back: { ...this.d().write_back, mapping: this.d().write_back.mapping.map((m, j) => (j === i ? { ...m, ...part } : m)) } }); }
  protected addWb(): void { const o = this.view()?.outputs ?? []; const used = new Set(this.d().write_back.mapping.map((m) => m.output)); this.patch({ write_back: { ...this.d().write_back, mapping: [...this.d().write_back.mapping, { output: o.find((x) => !used.has(x)) || o[0], field: '' }] } }); }
  protected removeWb(i: number): void { this.patch({ write_back: { ...this.d().write_back, mapping: this.d().write_back.mapping.filter((_, j) => j !== i) } }); }
  protected setSch(part: Partial<DsSetup['schedule']>): void { this.patch({ schedule: { ...this.d().schedule, ...part } }); }
  protected toggleDay(n: number): void { const ds = this.d().schedule.days; this.setSch({ days: ds.includes(n) ? ds.filter((x) => x !== n) : [...ds, n] }); }
  protected entries(o: Record<string, string>): [string, string][] { return Object.entries(o); }
  protected openRun(id: string): void { this.source().openCampaign?.(id); }
  protected when(iso: string): string { return new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }); }
  private refresh(): void {
    if (this.timer) clearTimeout(this.timer); if (this.step() < 2 || !this.d().connector) return;
    this.timer = setTimeout(async () => { try { this.preview.set(await this.source().preview(this.agent(), this.d())); } catch { /* keep the last preview */ } }, 250);
  }
  protected async save(): Promise<void> {
    this.busy.set(true); this.msg.set('');
    try {
      const v = await this.source().save(this.agent(), { ...this.withSecret(), has_secret: !!this.secret() || !!this.d().has_secret, tested: !!this.test()?.ok || !!this.view()?.saved });
      this.view.set(v); this.d.set(structuredClone(v.setup)); this.secret.set(''); this.msgBad.set(false);
      this.msg.set(v.setup.schedule.on && v.next_runs.length ? `Saved. Next run: ${v.next_runs[0].label}.` : 'Saved.'); this.refresh();
    } catch { this.msg.set('Could not save.'); this.msgBad.set(true); } finally { this.busy.set(false); }
  }
  protected async runNow(): Promise<void> {
    this.busy.set(true); this.msg.set('');
    try {
      const r = await this.source().run(this.agent()); this.msgBad.set(false);
      this.msg.set(r.calls ? `Run started: ${r.calls} call${r.calls === 1 ? '' : 's'} from ${r.after_filters} matching rows.` : 'Nothing to call right now: no row matches, or all were called recently.');
      const v = await this.source().load(this.agent()); this.view.set(v); this.step.set(5); this.refresh();
    } catch (e) { this.msg.set((e as { error?: { message?: string }; message?: string })?.error?.message || 'Could not start the run.'); this.msgBad.set(true); } finally { this.busy.set(false); }
  }
}

// ── Do-not-call list: one per workspace; uploads, data source runs and retries skip these numbers ──
export interface DncEntry { phone: string; name: string; reason: string; source: 'auto' | 'manual'; at: string; by: string; call_id: string | null; removed_at?: string; removed_by?: string; removed_reason?: string }
export interface DncView { list: DncEntry[]; removed: DncEntry[]; settings: { auto: boolean; phrases: string[] } }
export interface DncSource { load(q: string): Promise<DncView>; add(e: { phone: string; name: string; reason: string }): Promise<DncView>; remove(phone: string, reason: string): Promise<DncView>; setAuto(on: boolean): Promise<DncView>; openCall?(id: string): void }
@Component({
  selector: 'app-dnc-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [CSS + `
    .w1 { display: grid; gap: 14px; }
    .w1 input, .w1 select { border: 1px solid var(--s-line); border-radius: 6px; padding: 6px 8px; font: inherit; font-size: 13px; background: var(--s-bg); color: var(--s-text); min-width: 0; }
    .w1-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
    .w1-row label { display: grid; gap: 4px; font-size: 12px; color: var(--s-muted); }
    .w1-switch { display: inline-flex; gap: 8px; align-items: center; font-weight: 600; font-size: 13.5px; cursor: pointer; }
    .w1-switch input { width: 20px; height: 20px; accent-color: var(--s-accent); }
    .w1-tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
    .w1-tbl th { text-align: left; font-weight: 500; font-size: 12px; color: var(--s-muted); padding: 6px 8px; border-bottom: 1px solid var(--s-line); }
    .w1-tbl td { padding: 7px 8px; border-bottom: 1px solid var(--s-line); vertical-align: top; }
    .w1-tag { font-size: 11.5px; border: 1px solid var(--s-line); border-radius: 999px; padding: 1px 8px; white-space: nowrap; }
    .w1-tag.auto { color: var(--s-accent); border-color: color-mix(in srgb, var(--s-accent) 40%, transparent); }
    .w1-err { color: #b91c1c; font-size: 13px; } .w1-ok { color: var(--s-good); font-size: 13px; }
    .w1-scroll { overflow-x: auto; }
    .w1-link { border: 0; background: none; padding: 0; color: var(--s-accent); text-decoration: underline; font: inherit; cursor: pointer; }
  `],
  template: `
    <div class="w1">
      <div><h2 class="s-title" role="heading" [attr.aria-level]="page() ? 1 : 2">Do-not-call list</h2>
        <p class="s-muted">Numbers nobody in this workspace calls again: uploads stop them, data source runs skip them and no retry is planned. The country registers (NCPR, DNC Registry…) are checked as well, in Calling rules.</p></div>
      @if (v(); as view) {
        <label class="w1-switch"><input type="checkbox" [checked]="view.settings.auto" (change)="setAuto($any($event.target).checked)"> Add a number when the person asks not to be called</label>
        <span class="s-muted">The agent confirms once, closes the call politely and the number joins the list. Listens for: {{ view.settings.phrases.join(', ') }}.</span>
        <form class="w1-row" (submit)="$event.preventDefault(); add()">
          <label>Number<input [value]="phone()" (input)="phone.set($any($event.target).value)" placeholder="10-digit mobile" inputmode="tel"></label>
          <label>Name (optional)<input [value]="name()" (input)="name.set($any($event.target).value)"></label>
          <label style="flex: 1 1 220px">Why<input [value]="reason()" (input)="reason.set($any($event.target).value)" placeholder="e.g. Asked by email to stop calls"></label>
          <button type="submit" class="s-btn s-primary" [disabled]="busy()">Add to the list</button>
        </form>
        @if (msg()) { <span [class.w1-err]="bad()" [class.w1-ok]="!bad()" role="status">{{ msg() }}</span> }
        <div class="w1-row"><label style="flex: 1 1 260px">Search<input type="search" [value]="q()" (input)="search($any($event.target).value)" placeholder="Number, name or reason"></label><span class="s-muted">{{ view.list.length }} number{{ view.list.length === 1 ? '' : 's' }}</span></div>
        <div class="w1-scroll"><table class="w1-tbl">
          <thead><tr><th>Number</th><th>Why</th><th>Added</th><th></th></tr></thead>
          <tbody>@for (d of view.list; track d.phone) {
            <tr><td><b>{{ d.phone }}</b>@if (d.name) { <br><span class="s-muted">{{ d.name }}</span> }</td>
              <td>{{ d.reason }} <span class="w1-tag" [class.auto]="d.source === 'auto'">{{ d.source === 'auto' ? 'Asked on a call' : 'Added by a person' }}</span>
                @if (d.call_id && source().openCall) { <br><button type="button" class="w1-link" (click)="source().openCall!(d.call_id!)">Open the call</button> }</td>
              <td>{{ when(d.at) }}<br><span class="s-muted">{{ d.by }}</span></td>
              <td>@if (removing() === d.phone) {
                  <div class="w1-row"><input [value]="why()" (input)="why.set($any($event.target).value)" placeholder="Why calls are allowed again" aria-label="Why calls are allowed again">
                    <button type="button" class="s-btn s-primary" (click)="remove(d.phone)" [disabled]="!why().trim()">Remove</button><button type="button" class="s-btn" (click)="removing.set('')">Cancel</button></div>
                } @else { <button type="button" class="s-btn" (click)="removing.set(d.phone); why.set('')">Remove…</button> }</td></tr>
          } @empty { <tr><td colspan="4" class="s-muted">No numbers{{ q() ? ' match' : ' yet' }}.</td></tr> }</tbody>
        </table></div>
        @if (view.removed.length) {
          <details><summary class="s-muted">Removed recently ({{ view.removed.length }})</summary>
            <ul>@for (d of view.removed; track d.phone + d.removed_at) { <li>{{ d.phone }}: removed {{ when(d.removed_at!) }} by {{ d.removed_by }}: "{{ d.removed_reason }}"</li> }</ul></details>
        }
      } @else { <p class="s-empty">{{ msg() || 'Loading the list…' }}</p> }
    </div>
  `,
})
export class DncListComponent {
  readonly source = input.required<DncSource>();
  readonly page = input(false);
  protected readonly v = signal<DncView | null>(null);
  protected readonly q = signal(''); protected readonly phone = signal(''); protected readonly name = signal(''); protected readonly reason = signal('');
  protected readonly removing = signal(''); protected readonly why = signal('');
  protected readonly busy = signal(false); protected readonly msg = signal(''); protected readonly bad = signal(false);
  private t: ReturnType<typeof setTimeout> | null = null;
  constructor() { effect(() => { const s = this.source(); untracked(() => this.load(s)); }); }
  private async load(s = this.source(), again = true): Promise<void> { try { this.v.set(await s.load(this.q())); this.msg.set(''); } catch { if (again) setTimeout(() => this.load(s, false), 1200); else this.say('Could not load the list.', true); } }
  private say(m: string, bad = false): void { this.msg.set(m); this.bad.set(bad); }
  protected search(v: string): void { this.q.set(v); if (this.t) clearTimeout(this.t); this.t = setTimeout(() => this.load(), 200); }
  protected async add(): Promise<void> {
    this.busy.set(true);
    try { this.v.set(await this.source().add({ phone: this.phone(), name: this.name(), reason: this.reason() })); this.say(`Added ${this.phone().replace(/\D/g, '').slice(-10)}.`); this.phone.set(''); this.name.set(''); this.reason.set(''); }
    catch (e) { this.say(errText(e, 'Could not add the number.'), true); } finally { this.busy.set(false); }
  }
  protected async remove(phone: string): Promise<void> {
    try { this.v.set(await this.source().remove(phone, this.why())); this.removing.set(''); this.say(`${phone} can be called again.`); } catch (e) { this.say(errText(e, 'Could not remove it.'), true); }
  }
  protected async setAuto(on: boolean): Promise<void> { try { this.v.set(await this.source().setAuto(on)); this.say(on ? 'Numbers are added when a person asks.' : 'Only people add numbers now.'); } catch { this.say('Could not save.', true); } }
  protected when(iso: string): string { return iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'; }
}
/** The server's message from a failed request, else a fallback. */
function errText(e: unknown, fallback: string): string { const x = e as { error?: { message?: string; error?: { message?: string } }; message?: string }; return x?.error?.message || x?.error?.error?.message || fallback; }

// ── Alerts: watch running campaigns, tell the owner, and pause a campaign that is going wrong ──
export interface AlertRule { id: string; on: boolean; metric: string; threshold: number; window: number; action: 'notify' | 'pause'; channels: string[] }
export interface AlertsView { rules: AlertRule[]; metrics: { key: string; label: string; unit: string; dir: 'above' | 'below'; hint: string }[]; credits: number;
  live?: { campaign_id: string; campaign: string; dialled: number; failure_rate: number | null; connect_rate: number | null; system_issues: number | null }[];
  events: { key: string; at: string; campaign_id: string; campaign: string; message: string; action: string; channels: string[]; cleared: boolean }[]; paused: { campaign_id: string; reason: string; at: string }[] }
export interface AlertsSource { load(): Promise<AlertsView>; save(rules: AlertRule[]): Promise<AlertsView>; resume(campaignId: string): Promise<unknown>; openCampaign?(id: string): void }
@Component({
  selector: 'app-alerts',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [CSS + `
    .w1 { display: grid; gap: 14px; }
    .w1 input, .w1 select { border: 1px solid var(--s-line); border-radius: 6px; padding: 6px 8px; font: inherit; font-size: 13px; background: var(--s-bg); color: var(--s-text); min-width: 0; }
    .al-rule { display: grid; grid-template-columns: auto minmax(150px, 1.2fr) auto minmax(90px, .6fr) minmax(110px, .8fr) minmax(170px, 1fr) auto; gap: 8px; align-items: center; border: 1px solid var(--s-line); border-radius: 10px; padding: 10px 12px; font-size: 13px; }
    .al-rule.off { opacity: .6; }
    .al-rule input[type=checkbox] { width: 20px; height: 20px; accent-color: var(--s-accent); }
    .al-ch { display: inline-flex; gap: 10px; } .al-ch label { display: inline-flex; gap: 5px; align-items: center; }
    .al-ev { display: grid; gap: 6px; }
    .al-live { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
    .al-live th { text-align: left; font-weight: 500; font-size: 12px; color: var(--s-muted); padding: 5px 8px; border-bottom: 1px solid var(--s-line); }
    .al-live td { padding: 6px 8px; border-bottom: 1px solid var(--s-line); }
    .al-p { color: #b91c1c; } .w1-scroll { overflow-x: auto; }
    .al-e { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; border-left: 3px solid #dc2626; padding: 6px 10px; background: var(--s-soft); border-radius: 0 8px 8px 0; font-size: 13px; }
    .al-e.done { border-left-color: var(--s-line); opacity: .75; }
    .w1-err { color: #b91c1c; font-size: 13px; } .w1-ok { color: var(--s-good); font-size: 13px; }
    @media (max-width: 900px) { .al-rule { grid-template-columns: auto 1fr 1fr; } }
  `],
  template: `
    <div class="w1">
      <div><h2 class="s-title" role="heading" [attr.aria-level]="page() ? 1 : 2">Alerts</h2>
        <p class="s-muted">Watch every running campaign. When a rule trips, the campaign owner is told and, if the rule says so, the campaign pauses before a bad line or an empty balance burns the whole sheet.</p></div>
      @if (v(); as view) {
        @for (r of draft(); track r.id; let i = $index) {
          <div class="al-rule" [class.off]="!r.on">
            <input type="checkbox" [checked]="r.on" (change)="set(i, { on: $any($event.target).checked })" [attr.aria-label]="'Rule ' + (i + 1) + ' on'">
            <select (change)="set(i, { metric: $any($event.target).value })" [attr.aria-label]="'What rule ' + (i + 1) + ' watches'">@for (m of view.metrics; track m.key) { <option [value]="m.key" [selected]="m.key === r.metric">{{ m.label }}</option> }</select>
            <span>{{ metric(r).dir === 'below' ? 'below' : 'above' }}</span>
            <input type="number" min="0" [value]="r.threshold" (change)="set(i, { threshold: +$any($event.target).value })" [attr.aria-label]="'Limit for rule ' + (i + 1)">
            @if (r.metric !== 'credits') { <label class="s-muted">over last <input type="number" min="10" max="200" style="width: 64px" [value]="r.window" (change)="set(i, { window: +$any($event.target).value })" aria-label="Calls to look at"> calls</label> } @else { <span class="s-muted">now: {{ view.credits.toLocaleString('en-IN') }}</span> }
            <select (change)="set(i, { action: $any($event.target).value })" [attr.aria-label]="'What rule ' + (i + 1) + ' does'"><option value="notify" [selected]="r.action === 'notify'">Tell the owner</option><option value="pause" [selected]="r.action === 'pause'">Tell the owner and pause</option></select>
            <span class="al-ch"><label><input type="checkbox" [checked]="r.channels.includes('email')" (change)="channel(i, 'email', $any($event.target).checked)"> Email</label><label><input type="checkbox" [checked]="r.channels.includes('slack')" (change)="channel(i, 'slack', $any($event.target).checked)"> Slack</label>
              <button type="button" class="s-btn" (click)="removeRule(i)" [attr.aria-label]="'Remove rule ' + (i + 1)">Remove</button></span>
          </div>
        }
        <div class="w1-row" style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center">
          <button type="button" class="s-btn" (click)="addRule()">+ Add a rule</button><span style="flex: 1"></span>
          @if (msg()) { <span [class.w1-err]="bad()" [class.w1-ok]="!bad()" role="status">{{ msg() }}</span> }
          <button type="button" class="s-btn" (click)="undo()" [disabled]="!dirty()">Undo changes</button>
          <button type="button" class="s-btn s-primary" (click)="save()" [disabled]="!dirty() || busy()">{{ busy() ? 'Saving…' : 'Save rules' }}</button>
        </div>
        @if (view.live?.length) {
          <b>Running now</b>
          <div class="w1-scroll"><table class="al-live"><thead><tr><th>Campaign</th><th>Calls dialled</th><th>Failure rate</th><th>Connect rate</th><th>System issues</th><th></th></tr></thead><tbody>
            @for (l of view.live!; track l.campaign_id) { <tr><td>{{ l.campaign }}</td><td>{{ l.dialled }}</td><td>{{ l.failure_rate ?? '—' }}{{ l.failure_rate == null ? '' : '%' }}</td><td>{{ l.connect_rate ?? '—' }}{{ l.connect_rate == null ? '' : '%' }}</td><td>{{ l.system_issues ?? '—' }}</td>
              <td>@if (isPaused(l.campaign_id)) { <b class="al-p">Paused</b> }</td></tr> }
          </tbody></table></div>
          <span class="s-muted">Over each campaign's last 20 dialled calls; "—" until it has 5. Rules are checked again when you save them.</span>
        }
        <b>What happened</b>
        <div class="al-ev">
          @for (e of view.events; track e.key + e.at) {
            <div class="al-e" [class.done]="e.cleared"><b>{{ e.campaign }}</b><span>{{ e.message }}</span><span class="s-muted">{{ e.action }}{{ e.channels.length ? ' (' + e.channels.join(', ') + ')' : '' }} · {{ when(e.at) }}</span>
              @if (!e.cleared && isPaused(e.campaign_id)) { <button type="button" class="s-btn s-primary" (click)="resume(e.campaign_id)">Resume calls</button> }
              @if (source().openCampaign) { <button type="button" class="s-btn" (click)="source().openCampaign!(e.campaign_id)">Open campaign</button> }
              @if (e.cleared) { <span class="s-muted">Resumed</span> }</div>
          } @empty { <p class="s-note">No alert has fired. Running campaigns are checked each time their numbers update.</p> }
        </div>
      } @else { <p class="s-empty">{{ msg() || 'Loading the alerts…' }}</p> }
    </div>
  `,
})
export class AlertsComponent {
  readonly source = input.required<AlertsSource>();
  readonly page = input(false);
  protected readonly v = signal<AlertsView | null>(null);
  protected readonly draft = signal<AlertRule[]>([]);
  protected readonly busy = signal(false); protected readonly msg = signal(''); protected readonly bad = signal(false);
  protected readonly dirty = computed(() => JSON.stringify(this.draft()) !== JSON.stringify(this.v()?.rules ?? []));
  constructor() { effect(() => { const s = this.source(); untracked(() => this.load(s)); }); }
  private async load(s = this.source(), again = true): Promise<void> { try { const v = await s.load(); this.v.set(v); this.draft.set(structuredClone(v.rules)); } catch { if (again) setTimeout(() => this.load(s, false), 1200); else { this.msg.set('Could not load the alerts.'); this.bad.set(true); } } }
  protected metric(r: AlertRule) { return this.v()?.metrics.find((m) => m.key === r.metric) ?? { key: r.metric, label: r.metric, unit: '', dir: 'above' as const, hint: '' }; }
  protected set(i: number, part: Partial<AlertRule>): void { this.msg.set(''); this.draft.set(this.draft().map((r, j) => (j === i ? { ...r, ...part } : r))); }
  protected channel(i: number, ch: string, on: boolean): void { const c = new Set(this.draft()[i].channels); if (on) c.add(ch); else c.delete(ch); this.set(i, { channels: [...c] }); }
  protected addRule(): void { this.draft.set([...this.draft(), { id: 'new' + Date.now(), on: true, metric: 'failure_rate', threshold: 50, window: 20, action: 'notify', channels: ['email'] }]); }
  protected removeRule(i: number): void { this.draft.set(this.draft().filter((_, j) => j !== i)); }
  protected undo(): void { this.draft.set(structuredClone(this.v()?.rules ?? [])); }
  protected isPaused(id: string): boolean { return !!this.v()?.paused.some((p) => p.campaign_id === id); }
  protected async save(): Promise<void> {
    this.busy.set(true);
    try { const v = await this.source().save(this.draft()); this.v.set(v); this.draft.set(structuredClone(v.rules)); this.msg.set('Saved.'); this.bad.set(false); } catch { this.msg.set('Could not save.'); this.bad.set(true); } finally { this.busy.set(false); }
  }
  protected async resume(id: string): Promise<void> { try { await this.source().resume(id); await this.load(); this.msg.set('Calls resumed.'); this.bad.set(false); } catch { this.msg.set('Could not resume.'); this.bad.set(true); } }
  protected when(iso: string): string { return new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }); }
}

// ── Call handling per agent: answer guardrail, phone menus (IVR), words to listen for, pronunciation ──
export interface CallHandling {
  guardrail: { on: boolean; min_seconds: number; need_speech: boolean };
  ivr: { on: boolean; action: 'press' | 'wait' | 'hangup'; hint: string; digits: string; wait_seconds: number };
  speech: { boost: string[]; pronounce: { word: string; say: string }[] };
}
export interface CallHandlingSource { load(agent: string): Promise<{ agent: string; label: string; inputs: string[]; handling: CallHandling }>; save(agent: string, h: CallHandling): Promise<{ agent: string; label: string; inputs: string[]; handling: CallHandling }> }
@Component({
  selector: 'app-call-handling',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [CSS + `
    .w1 { display: grid; gap: 16px; }
    .w1 input, .w1 select { border: 1px solid var(--s-line); border-radius: 6px; padding: 6px 8px; font: inherit; font-size: 13px; background: var(--s-bg); color: var(--s-text); min-width: 0; }
    .ch-sec { border: 1px solid var(--s-line); border-radius: 12px; padding: 12px 14px; display: grid; gap: 10px; }
    .ch-sec h3 { margin: 0; font-size: 15px; display: flex; gap: 10px; align-items: center; }
    .ch-sec h3 label { margin-left: auto; font-size: 13px; font-weight: 500; display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
    .ch-sec input[type=checkbox] { width: 20px; height: 20px; accent-color: var(--s-accent); }
    .ch-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; font-size: 13px; }
    .ch-row label { display: grid; gap: 4px; font-size: 12px; color: var(--s-muted); }
    .ch-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .ch-chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--s-line); border-radius: 999px; padding: 3px 4px 3px 10px; font-size: 12.5px; }
    .ch-chip.var { border-style: dashed; color: var(--s-accent); }
    .ch-chip button { border: 0; background: none; color: var(--s-muted); cursor: pointer; min-width: 24px; min-height: 24px; border-radius: 50%; }
    .ch-add { border: 1px dashed var(--s-line); background: var(--s-bg); color: var(--s-muted); border-radius: 999px; padding: 4px 10px; font: inherit; font-size: 12.5px; cursor: pointer; }
    .ch-pr { display: grid; grid-template-columns: minmax(120px, 1fr) auto minmax(120px, 1fr) auto; gap: 8px; align-items: center; font-size: 13px; }
    .ch-hear { background: var(--s-soft); border-radius: 8px; padding: 8px 10px; font-size: 13px; display: grid; gap: 4px; }
    .ch-off { opacity: .55; pointer-events: none; }
    .w1-err { color: #b91c1c; font-size: 13px; } .w1-ok { color: var(--s-good); font-size: 13px; }
  `],
  template: `
    <div class="w1">
      <div><b>Call handling</b><p class="s-muted">How {{ v()?.label || 'this agent' }} copes with short calls, phone menus and hard words. These apply to every campaign of the agent.</p></div>
      @if (v(); as view) {
        <section class="ch-sec">
          <h3>Answer guardrail <label><input type="checkbox" [checked]="d().guardrail.on" (change)="g({ on: $any($event.target).checked })"> On</label></h3>
          <p class="s-muted">No answers are saved from a call that never really happened, so reports do not fill with empty or made-up answers.</p>
          <div class="ch-row" [class.ch-off]="!d().guardrail.on">
            <label>Skip calls shorter than (seconds)<input type="number" min="1" max="60" [value]="d().guardrail.min_seconds" (change)="g({ min_seconds: +$any($event.target).value })"></label>
            <label style="display: inline-flex; gap: 6px; align-items: center; color: var(--s-text)"><input type="checkbox" [checked]="d().guardrail.need_speech" (change)="g({ need_speech: $any($event.target).checked })"> Skip calls where the caller never spoke</label>
          </div>
          <p class="s-muted">Changed the answers or this rule? Use "Re-run answers" above a call log to apply it to past calls without calling again.</p>
        </section>
        <section class="ch-sec">
          <h3>Phone menus (IVR) <label><input type="checkbox" [checked]="d().ivr.on" (change)="i({ on: $any($event.target).checked })"> Detect</label></h3>
          <p class="s-muted">Company numbers often answer with "Press 1 for sales…". The agent stays quiet, listens to the menu and reaches the right person.</p>
          <div class="ch-row" [class.ch-off]="!d().ivr.on">
            <label>When a menu answers<select (change)="i({ action: $any($event.target).value })"><option value="press" [selected]="d().ivr.action === 'press'">Press the key for the department</option><option value="wait" [selected]="d().ivr.action === 'wait'">Wait for a person</option><option value="hangup" [selected]="d().ivr.action === 'hangup'">Hang up and retry later</option></select></label>
            @if (d().ivr.action === 'press') {
              <label>Department to reach<input [value]="d().ivr.hint" (input)="i({ hint: $any($event.target).value })" placeholder="Purchase or accounts"></label>
              <label>Or always press<input style="width: 90px" [value]="d().ivr.digits" (input)="i({ digits: $any($event.target).value })" placeholder="e.g. 2,1"></label>
            }
            <label>Give up after (seconds)<input type="number" min="5" max="90" style="width: 80px" [value]="d().ivr.wait_seconds" (change)="i({ wait_seconds: +$any($event.target).value })"></label>
          </div>
          <p class="s-muted">Answering machines are handled under Calling flow › Voicemail.</p>
        </section>
        <section class="ch-sec">
          <h3>Words to listen for</h3>
          <p class="s-muted">Names, plants, SKUs and codes the agent must hear right. A sheet column in braces, such as {{ VAR_EXAMPLE }}, uses each row's own value.</p>
          <div class="ch-chips">
            @for (w of d().speech.boost; track w) { <span class="ch-chip" [class.var]="isVar(w)">{{ w }}<button type="button" (click)="unboost(w)" [attr.aria-label]="'Remove ' + w">✕</button></span> }
          </div>
          <form class="ch-row" (submit)="$event.preventDefault(); boost(word()); word.set('')"><label>Add a word<input [value]="word()" (input)="word.set($any($event.target).value)" placeholder="e.g. Hindustan Zinc"></label><button type="submit" class="s-btn" [disabled]="!word().trim()">Add</button></form>
          <div class="ch-chips"><span class="s-muted">From the sheet:</span>@for (k of unusedVars(); track k) { <button type="button" class="ch-add" (click)="addVar(k)">+ {{ k }}</button> }</div>
        </section>
        <section class="ch-sec">
          <h3>Pronunciation</h3>
          <p class="s-muted">How the agent says brands, acronyms and Indian names. Spell it the way it sounds.</p>
          @for (p of d().speech.pronounce; track $index; let k = $index) {
            <div class="ch-pr"><input [value]="p.word" (input)="pr(k, { word: $any($event.target).value })" aria-label="Word"><span class="s-muted">say</span><input [value]="p.say" (input)="pr(k, { say: $any($event.target).value })" aria-label="Say it as"><button type="button" class="s-btn" (click)="unpr(k)">Remove</button></div>
          }
          <div><button type="button" class="s-btn" (click)="addPr()">+ Add a word</button></div>
          <div class="ch-hear"><label style="display: grid; gap: 4px; font-size: 12px; color: var(--s-muted)">Try a sentence<input [value]="sample()" (input)="sample.set($any($event.target).value)"></label>
            <span>Spoken as: <i>{{ spoken() }}</i></span>
            <div><button type="button" class="s-btn" (click)="hear()">▶ Hear it</button> <span class="s-muted">Uses your browser's voice as a stand-in for the agent's.</span></div></div>
        </section>
        <div class="ch-row" style="justify-content: flex-end">
          @if (msg()) { <span [class.w1-err]="bad()" [class.w1-ok]="!bad()" role="status">{{ msg() }}</span> }
          <button type="button" class="s-btn" (click)="undo()" [disabled]="!dirty()">Undo changes</button>
          <button type="button" class="s-btn s-primary" (click)="save()" [disabled]="!dirty() || busy()">{{ busy() ? 'Saving…' : 'Save call handling' }}</button>
        </div>
      } @else { <p class="s-empty">{{ msg() || 'Loading…' }}</p> }
    </div>
  `,
})
export class CallHandlingComponent {
  readonly source = input.required<CallHandlingSource>();
  readonly agent = input.required<string>();
  protected readonly v = signal<{ agent: string; label: string; inputs: string[]; handling: CallHandling } | null>(null);
  protected readonly d = signal<CallHandling>({} as CallHandling);
  protected readonly word = signal('');
  protected readonly VAR_EXAMPLE = '{{plant_name}}';
  protected varOf(k: string): string { return '{{' + k + '}}'; }
  protected isVar(w: string): boolean { return w.startsWith('{{'); }
  protected addVar(k: string): void { this.boost(this.varOf(k)); }
  protected readonly sample = signal('Hello, this is Saniya from Moglix about PO 4500120000 and the GRN for Hindustan Zinc.');
  protected readonly busy = signal(false); protected readonly msg = signal(''); protected readonly bad = signal(false);
  protected readonly dirty = computed(() => JSON.stringify(this.d()) !== JSON.stringify(this.v()?.handling ?? {}));
  protected readonly unusedVars = computed(() => (this.v()?.inputs ?? []).filter((k) => !/email|phone/.test(k) && !this.d().speech?.boost.includes(this.varOf(k))).slice(0, 8));
  protected readonly spoken = computed(() => (this.d().speech?.pronounce ?? []).reduce((t, p) => (p.word.trim() ? t.replace(new RegExp(`\\b${p.word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), p.say) : t), this.sample()));
  constructor() { effect(() => { const a = this.agent(); const s = this.source(); untracked(() => this.load(s, a)); }); }
  private async load(s: CallHandlingSource, a: string, again = true): Promise<void> { try { const v = await s.load(a); this.v.set(v); this.d.set(structuredClone(v.handling)); } catch { if (again) setTimeout(() => this.load(s, a, false), 1200); else { this.msg.set('Could not load call handling.'); this.bad.set(true); } } }
  private patch(part: Partial<CallHandling>): void { this.msg.set(''); this.d.set({ ...this.d(), ...part }); }
  protected g(part: Partial<CallHandling['guardrail']>): void { this.patch({ guardrail: { ...this.d().guardrail, ...part } }); }
  protected i(part: Partial<CallHandling['ivr']>): void { this.patch({ ivr: { ...this.d().ivr, ...part } }); }
  protected boost(w: string): void { const t = w.trim(); if (!t || this.d().speech.boost.includes(t)) return; this.patch({ speech: { ...this.d().speech, boost: [...this.d().speech.boost, t] } }); }
  protected unboost(w: string): void { this.patch({ speech: { ...this.d().speech, boost: this.d().speech.boost.filter((x) => x !== w) } }); }
  protected pr(k: number, part: Partial<{ word: string; say: string }>): void { this.patch({ speech: { ...this.d().speech, pronounce: this.d().speech.pronounce.map((p, j) => (j === k ? { ...p, ...part } : p)) } }); }
  protected addPr(): void { this.patch({ speech: { ...this.d().speech, pronounce: [...this.d().speech.pronounce, { word: '', say: '' }] } }); }
  protected unpr(k: number): void { this.patch({ speech: { ...this.d().speech, pronounce: this.d().speech.pronounce.filter((_, j) => j !== k) } }); }
  protected undo(): void { this.d.set(structuredClone(this.v()?.handling ?? ({} as CallHandling))); }
  protected hear(): void {
    try { const synth = window.speechSynthesis; if (!synth) { this.msg.set('This browser cannot speak.'); return; } synth.cancel(); const u = new SpeechSynthesisUtterance(this.spoken()); u.lang = 'en-IN'; u.rate = 0.95; synth.speak(u); }
    catch { this.msg.set('This browser cannot speak.'); }
  }
  protected async save(): Promise<void> {
    this.busy.set(true);
    try { const v = await this.source().save(this.agent(), this.d()); this.v.set(v); this.d.set(structuredClone(v.handling)); this.msg.set('Saved.'); this.bad.set(false); } catch { this.msg.set('Could not save.'); this.bad.set(true); } finally { this.busy.set(false); }
  }
}
