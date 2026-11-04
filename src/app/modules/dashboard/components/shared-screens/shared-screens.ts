import { ChangeDetectionStrategy, Component, computed, effect, inject, input, OnDestroy, signal, untracked } from '@angular/core';
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

// ── Action needed: what a person must do after the calls, beside what the agent is already handling ──
export interface ActionRow {
  id: string; caller: string; phone: string; email: string; campaign: string; agent: string; owner: string; last_call: string | null; status: string; reason: string; summary: string;
  made: number; total: number; since: string | null; next_at: string | null; lane: 'you' | 'agent' | 'done'; group: string; title: string; detail: string; state?: string;
  assignee: string; assigned_by?: string; closed?: 'done' | 'dismissed'; closed_by?: string; closed_at?: string; note?: string;
}
export interface ActionList { rows: ActionRow[]; counts: { you: number; agent: number; done: number; mine?: number; overdue?: number; by_group: Record<string, Record<string, number>> }; groups: { key: string; label: string; hint: string }[]; owners: string[]; me?: string }
export interface ActionQuery { lane: string; group: string; owner: string; q: string }
export type ActionVerb = 'done' | 'dismiss' | 'reopen' | 'requeue' | 'assign';
export interface FollowUpsSource {
  list(p: ActionQuery): Promise<ActionList>;
  act(id: string, a: { action: ActionVerb; to?: string; note?: string }): Promise<unknown>;
  /** The same action on many rows at once. */
  bulk?(ids: string[], a: { action: ActionVerb; to?: string }): Promise<unknown>;
  exportXlsx(p: ActionQuery): Promise<Blob>;
  openCall(row: { id: string }): void;
  /** One page for a supplier: every call, PO, promise and open action. */
  openSupplier?(phone: string): void;
}
/** A per-viewer choice kept in the browser (falls back quietly when storage is blocked). */
function remembered(key: string, fallback: string): string { try { return localStorage.getItem('echo.' + key) ?? fallback; } catch { return fallback; } }
function remember(key: string, v: string): void { try { localStorage.setItem('echo.' + key, v); } catch { /* storage blocked */ } }
const DAY = 864e5;

@Component({
  selector: 'app-follow-ups-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:click)': 'menuId.set("")', '(document:keydown.escape)': 'menuId.set("")' },
  styles: [CSS + `
    .an-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .an-tab { text-align: left; border: 1px solid var(--s-line); background: var(--s-bg); color: var(--s-text); border-radius: 12px; padding: 10px 14px; font: inherit; cursor: pointer; display: grid; gap: 2px; }
    .an-tab b { font-size: 24px; line-height: 1.1; font-variant-numeric: tabular-nums; } .an-tab span { font-size: 13px; color: var(--s-muted); }
    .an-tab.on { border: 2px solid var(--s-accent); padding: 9px 13px; background: color-mix(in srgb, var(--s-accent) 6%, var(--s-bg)); } .an-tab.on span { color: var(--s-text); }
    .an-tab small { color: #b91c1c; font-size: 12px; font-weight: 600; }
    :host .s { align-content: start; grid-auto-rows: max-content; }
    .an-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; overflow: visible; min-height: max-content; }
    .an-bar select, .an-bar input { border: 1px solid var(--s-line); border-radius: 8px; padding: 6px 10px; font: inherit; font-size: 13px; background: var(--s-bg); color: var(--s-text); min-width: 0; }
    .an-bar input[type=search] { flex: 1 1 200px; }
    .an-chip { border: 1px solid var(--s-line); background: var(--s-bg); color: var(--s-text); border-radius: 999px; padding: 4px 11px; font: inherit; font-size: 12.5px; cursor: pointer; }
    .an-chip b { font-variant-numeric: tabular-nums; margin-left: 5px; color: var(--s-muted); font-weight: 600; }
    .an-chip.on { border-color: var(--s-accent); background: color-mix(in srgb, var(--s-accent) 10%, var(--s-bg)); color: var(--s-accent); font-weight: 600; } .an-chip.on b { color: var(--s-accent); }
    .an-list { display: grid; }
    .an-h, .an-r { display: grid; grid-template-columns: 28px minmax(160px, 1.1fr) minmax(200px, 1.6fr) 96px 150px 112px; gap: 10px; align-items: center; padding: 9px 14px; }
    .an-list.agent .an-h, .an-list.agent .an-r { grid-template-columns: minmax(160px, 1.1fr) minmax(150px, 1fr) 150px minmax(120px, .8fr) minmax(140px, 1fr); }
    .an-list.done .an-h, .an-list.done .an-r { grid-template-columns: minmax(160px, 1.1fr) minmax(200px, 1.5fr) 120px minmax(160px, 1fr) 44px; }
    .an-h { font-size: 12px; color: var(--s-muted); border-bottom: 1px solid var(--s-line); padding-top: 8px; padding-bottom: 8px; }
    .an-r { border-bottom: 1px solid var(--s-line); font-size: 13px; cursor: pointer; }
    .an-r:hover { background: var(--s-soft); } .an-r.picked { background: color-mix(in srgb, var(--s-accent) 7%, var(--s-bg)); }
    .an-list.agent .an-r { cursor: default; }
    .an-who b { display: block; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .an-who span { color: var(--s-muted); font-size: 12px; }
    .an-what b { display: block; font-weight: 600; } .an-what span { color: var(--s-muted); font-size: 12px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .an-age { font-size: 12.5px; color: var(--s-muted); } .an-age.late { color: #b91c1c; font-weight: 600; }
    .an-av { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; min-width: 0; } .an-av i { font-style: normal; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; background: var(--s-soft); font-size: 11px; font-weight: 600; flex: none; }
    .an-av span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .an-ic { display: flex; gap: 4px; justify-content: flex-end; position: relative; }
    .an-ib { width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--s-line); background: var(--s-bg); color: var(--s-muted); display: grid; place-items: center; cursor: pointer; padding: 0; }
    .an-ib:hover { color: var(--s-text); border-color: var(--s-text); } .an-ib.ok:hover { color: var(--s-good); border-color: var(--s-good); } .an-ib.no:hover { color: #b91c1c; border-color: #b91c1c; }
    .an-ib svg { width: 16px; height: 16px; }
    .an-menu { position: fixed; z-index: 960; min-width: 220px; background: var(--s-bg); border: 1px solid var(--s-line); border-radius: 10px; box-shadow: 0 12px 32px -12px rgba(0, 0, 0, .35); padding: 4px; display: grid; }
    .an-menu button, .an-menu label { text-align: left; border: 0; background: none; color: var(--s-text); font: inherit; font-size: 13px; padding: 8px 10px; border-radius: 6px; cursor: pointer; }
    .an-menu button:hover { background: var(--s-soft); } .an-menu hr { border: 0; border-top: 1px solid var(--s-line); margin: 4px 0; }
    .an-menu select { margin: 2px 10px 6px; border: 1px solid var(--s-line); border-radius: 6px; padding: 5px 8px; font: inherit; font-size: 13px; background: var(--s-bg); color: var(--s-text); }
    .an-menu small { color: var(--s-muted); font-size: 12px; padding: 4px 10px 0; }
    .an-more { grid-column: 2 / -1; display: grid; gap: 6px; padding: 2px 0 10px; font-size: 13px; cursor: default; }
    .an-more p { margin: 0; } .an-kv { display: flex; flex-wrap: wrap; gap: 4px 16px; color: var(--s-muted); font-size: 12.5px; }
    .an-state { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; } .an-state i { width: 8px; height: 8px; border-radius: 50%; background: var(--s-accent); }
    .an-dots { display: inline-flex; gap: 3px; align-items: center; } .an-dots i { width: 9px; height: 9px; border-radius: 50%; background: var(--s-line); } .an-dots i.on { background: var(--s-accent); }
    .an-dots span { margin-left: 6px; font-size: 12px; color: var(--s-muted); }
    .an-lock { display: flex; gap: 8px; align-items: center; padding: 10px 14px; font-size: 13px; color: var(--s-muted); border-bottom: 1px solid var(--s-line); background: var(--s-soft); border-radius: 12px 12px 0 0; }
    .an-out { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12.5px; border-radius: 999px; padding: 2px 10px; }
    .an-out.done { color: var(--s-good); background: color-mix(in srgb, var(--s-good) 10%, var(--s-bg)); } .an-out.dismissed { color: #b91c1c; background: color-mix(in srgb, #dc2626 9%, var(--s-bg)); }
    .an-bulk { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 12px; border: 1px solid var(--s-accent); background: color-mix(in srgb, var(--s-accent) 6%, var(--s-bg)); border-radius: 10px; font-size: 13px; position: sticky; top: 8px; z-index: 5; }
    .an-bulk select { border: 1px solid var(--s-line); border-radius: 8px; padding: 6px 10px; font: inherit; font-size: 13px; background: var(--s-bg); color: var(--s-text); }
    .an-ok { color: var(--s-good); font-size: 13px; }
    .an-check { width: 18px; height: 18px; accent-color: var(--s-accent); cursor: pointer; }
    @media (max-width: 860px) {
      .an-tabs { grid-template-columns: 1fr 1fr 1fr; } .an-tab b { font-size: 20px; }
      .an-h { display: none; }
      .an-r, .an-list.agent .an-r, .an-list.done .an-r { grid-template-columns: 28px minmax(0, 1fr) auto; grid-template-areas: 'c w i' 'c t t' 'c m m'; row-gap: 4px; }
      .an-list.agent .an-r, .an-list.done .an-r { grid-template-columns: minmax(0, 1fr) auto; }
      .an-r > .an-what { grid-column: 2 / -1; } .an-r > .an-age, .an-r > .an-av { grid-column: 2 / -1; }
      .an-more { grid-column: 1 / -1; }
    }
  `],
  template: `
    <div class="s">
      <div class="s-head">
        <div><h1 class="s-title">Action needed</h1><p class="s-sub">Calls the agent cannot settle on its own, and what it is already handling.</p></div>
        <span class="s-grow"></span>
        <button type="button" class="s-btn" (click)="exportList()" [title]="'Export the ' + rows().length + ' rows shown'">Export</button>
      </div>
      <div class="an-tabs" role="tablist" aria-label="List">
        <button type="button" role="tab" class="an-tab" [class.on]="lane() === 'you'" [attr.aria-selected]="lane() === 'you'" (click)="setLane('you')"><b>{{ count('you') }}</b><span>To do</span>@if (data()?.counts?.overdue) { <small>{{ data()!.counts.overdue }} waiting over 2 days</small> }</button>
        <button type="button" role="tab" class="an-tab" [class.on]="lane() === 'agent'" [attr.aria-selected]="lane() === 'agent'" (click)="setLane('agent')"><b>{{ count('agent') }}</b><span>With the agent</span></button>
        <button type="button" role="tab" class="an-tab" [class.on]="lane() === 'done'" [attr.aria-selected]="lane() === 'done'" (click)="setLane('done')"><b>{{ count('done') }}</b><span>Closed</span></button>
      </div>
      <div class="an-bar">
        <button type="button" class="an-chip" [class.on]="group() === 'all'" [attr.aria-pressed]="group() === 'all'" (click)="group.set('all')">All<b>{{ count(lane()) }}</b></button>
        @for (g of groupsHere(); track g.key) { <button type="button" class="an-chip" [class.on]="group() === g.key" [attr.aria-pressed]="group() === g.key" (click)="group.set(g.key)" [title]="g.hint">{{ g.label }}<b>{{ g.count }}</b></button> }
        <span class="s-grow"></span>
        @if (lane() === 'you') { <select (change)="setOwner($any($event.target).value)" aria-label="Assigned to"><option value="all" [selected]="owner() === 'all'">Everyone</option><option value="mine" [selected]="owner() === 'mine'">Assigned to me ({{ data()?.counts?.mine ?? 0 }})</option><option value="" [selected]="owner() === ''">Unassigned</option>@for (o of owners(); track o) { <option [value]="o" [selected]="o === owner()">{{ o }}</option> }</select> }
        <input type="search" [value]="q()" (input)="setQ($any($event.target).value)" placeholder="Search supplier, phone, campaign" aria-label="Search">
      </div>
      @if (msg()) { <span class="an-ok" role="status">{{ msg() }}</span> }
      @if (sel().length) {
        <div class="an-bulk"><b>{{ sel().length }} selected</b>
          <button type="button" class="s-btn s-primary" (click)="bulk('done')">Mark done</button><button type="button" class="s-btn" (click)="bulk('dismiss')">Dismiss</button>
          <select (change)="bulkTo.set($any($event.target).value)" aria-label="Assign to"><option value="">Assign to…</option>@for (o of owners(); track o) { <option [value]="o">{{ o }}</option> }</select>
          <button type="button" class="s-btn" [disabled]="!bulkTo()" (click)="bulk('assign')">Assign</button><span class="s-grow"></span><button type="button" class="s-btn" (click)="sel.set([])">Clear</button>
        </div>
      }

      <div class="s-card an-list" [class.agent]="lane() === 'agent'" [class.done]="lane() === 'done'">
        @if (lane() === 'you') {
          <div class="an-h"><input type="checkbox" class="an-check" [checked]="allPicked()" (change)="pickAll($any($event.target).checked)" aria-label="Select every row on this page"><span>Supplier</span><span>What to do</span><span>Waiting</span><span>Assigned to</span><span></span></div>
          @for (r of pageRows(); track r.id) {
            <div class="an-r" [class.picked]="sel().includes(r.id)" (click)="toggleOpen(r.id)">
              <input type="checkbox" class="an-check" [checked]="sel().includes(r.id)" (click)="$event.stopPropagation()" (change)="pick(r.id, $any($event.target).checked)" [attr.aria-label]="'Select ' + r.caller">
              <div class="an-who"><b>{{ r.caller }}</b><span>{{ r.phone }}</span></div>
              <div class="an-what"><b>{{ r.title }}</b><span>{{ subline(r) }}</span></div>
              <span class="an-age" [class.late]="late(r)">{{ age(r.since) }}</span>
              <span class="an-av" [title]="r.assignee || 'Unassigned'"><i>{{ initials(r.assignee) }}</i><span>{{ r.assignee ? (r.assignee === me() ? 'Me' : short(r.assignee)) : 'Unassigned' }}</span></span>
              <div class="an-ic" (click)="$event.stopPropagation()">
                <button type="button" class="an-ib ok" (click)="act(r, 'done')" title="Mark done" aria-label="Mark done"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.2 3L13 4.5"/></svg></button>
                <button type="button" class="an-ib no" (click)="act(r, 'dismiss')" title="Dismiss: will not be done" aria-label="Dismiss"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
                <button type="button" class="an-ib" (click)="openMenu($event, r.id)" [attr.aria-expanded]="menuId() === r.id" aria-label="More actions" title="More"><svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></svg></button>
              </div>
              @if (openId() === r.id) {
                <div class="an-more" (click)="$event.stopPropagation()"><p>{{ r.detail }}</p>
                  <div class="an-kv"><span>Campaign: {{ r.campaign }}</span><span>Agent: {{ r.agent }}</span>@if (r.made) { <span>Calls made: {{ r.made }}</span> }<span>Last call: {{ r.last_call ? when(r.last_call) : 'not called' }}</span><span>Uploaded by: {{ r.owner }}</span></div>
                  @if (r.summary && r.summary !== r.detail) { <p class="s-muted">Call summary: {{ r.summary }}</p> }</div>
              }
            </div>
          } @empty { <p class="s-empty">{{ emptyText() }}</p> }
        }
        @if (lane() === 'agent') {
          <div class="an-lock"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/></svg>The agent is handling these: retries and booked callbacks run on their own and cannot be changed here. Anything it cannot settle moves to To do.</div>
          <div class="an-h"><span>Supplier</span><span>The agent is</span><span>Next attempt</span><span>Attempts</span><span>Campaign</span></div>
          @for (r of pageRows(); track r.id) {
            <div class="an-r">
              <div class="an-who"><b>{{ r.caller }}</b><span>{{ r.phone }}</span></div>
              <div class="an-what"><span class="an-state"><i></i>{{ r.state }}</span><span>{{ r.title }}</span></div>
              <span class="an-age">{{ r.next_at ? nextText(r.next_at) : 'In the current run' }}</span>
              <span class="an-dots" [attr.aria-label]="r.made + ' of ' + r.total + ' attempts'">@for (d of dots(r); track $index) { <i [class.on]="d"></i> }<span>{{ r.made }}/{{ r.total }}</span></span>
              <span class="an-what"><span>{{ r.campaign }}</span></span>
            </div>
          } @empty { <p class="s-empty">The agent has nothing queued.</p> }
        }
        @if (lane() === 'done') {
          <div class="an-h"><span>Supplier</span><span>What it was</span><span>Outcome</span><span>Closed by</span><span></span></div>
          @for (r of pageRows(); track r.id) {
            <div class="an-r" (click)="source().openCall(r)">
              <div class="an-who"><b>{{ r.caller }}</b><span>{{ r.phone }}</span></div>
              <div class="an-what"><b>{{ r.title }}</b><span>{{ groupLabel(r.group) }}</span></div>
              <span><span class="an-out" [class.done]="r.closed === 'done'" [class.dismissed]="r.closed === 'dismissed'">{{ r.closed === 'done' ? '✓ Done' : '✕ Dismissed' }}</span></span>
              <span class="an-age">{{ short(r.closed_by || '') }} · {{ when(r.closed_at || null) }}</span>
              <div class="an-ic" (click)="$event.stopPropagation()"><button type="button" class="an-ib" (click)="act(r, 'reopen')" title="Reopen" aria-label="Reopen"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 8a5 5 0 109-3"/><path d="M12 2v3H9"/></svg></button></div>
            </div>
          } @empty { <p class="s-empty">Nothing closed yet.</p> }
        }
        @if (rows().length > PAGE) {
          <div class="s-pager"><button type="button" class="s-btn" [disabled]="page() === 0" (click)="page.set(page() - 1)">Previous</button>
            <span>{{ page() * PAGE + 1 }}–{{ Math.min((page() + 1) * PAGE, rows().length) }} of {{ rows().length }}</span>
            <button type="button" class="s-btn" [disabled]="(page() + 1) * PAGE >= rows().length" (click)="page.set(page() + 1)">Next</button></div>
        }
      </div>
      @if (menuRow(); as r) {
        <div class="an-menu" role="menu" [style.top.px]="menuAt().y" [style.left.px]="menuAt().x" (click)="$event.stopPropagation()">
          <button type="button" role="menuitem" (click)="menuId.set(''); source().openCall(r)">Open the call</button>
          @if (source().openSupplier) { <button type="button" role="menuitem" (click)="menuId.set(''); source().openSupplier!(r.phone)">All about this supplier</button> }
          @if (r.group === 'not_reached' || r.group === 'not_successful' || r.group === 'callback') { <button type="button" role="menuitem" (click)="act(r, 'requeue')">Let the agent try once more</button> }
          <hr><small>Assign to</small>
          <select (change)="assignTo(r, $any($event.target).value)" aria-label="Assign to"><option value="">{{ r.assignee ? (r.assignee === me() ? 'Me' : r.assignee) : 'Unassigned' }}</option>@for (o of owners(); track o) { @if (o !== r.assignee) { <option [value]="o">{{ o === me() ? 'Me (' + o + ')' : o }}</option> } }</select>
        </div>
      }
    </div>
  `,
})
export class FollowUpsListComponent {
  readonly source = input.required<FollowUpsSource>();
  protected readonly PAGE = 20;
  protected readonly Math = Math;
  protected readonly when = when;
  protected readonly lane = signal('you'); protected readonly group = signal('all'); protected readonly owner = signal(remembered('an.owner', 'all')); protected readonly q = signal('');
  protected readonly page = signal(0);
  protected readonly data = signal<ActionList | null>(null);
  protected readonly sel = signal<string[]>([]); protected readonly bulkTo = signal('');
  protected readonly openId = signal(''); protected readonly menuId = signal(''); protected readonly menuAt = signal({ x: 0, y: 0 });
  protected readonly msg = signal('');
  protected readonly rows = computed(() => this.data()?.rows ?? []);
  protected readonly owners = computed(() => this.data()?.owners ?? []);
  protected readonly me = computed(() => this.data()?.me ?? '');
  protected readonly pageRows = computed(() => this.rows().slice(this.page() * this.PAGE, (this.page() + 1) * this.PAGE));
  protected readonly allPicked = computed(() => this.pageRows().length > 0 && this.pageRows().every((r) => this.sel().includes(r.id)));
  protected readonly menuRow = computed(() => this.rows().find((r) => r.id === this.menuId()) ?? null);
  protected readonly groupsHere = computed(() => { const d = this.data(); const by = d?.counts.by_group[this.lane()] ?? {}; return (d?.groups ?? []).filter((g) => by[g.key]).map((g) => ({ ...g, count: by[g.key] })); });
  private t: ReturnType<typeof setTimeout> | null = null;
  constructor() { effect(() => { this.lane(); this.group(); this.owner(); untracked(() => { this.page.set(0); this.load(); }); }); }
  private query(): ActionQuery { return { lane: this.lane(), group: this.group(), owner: this.owner(), q: this.q().trim() }; }
  private async load(again = true): Promise<void> {
    try { this.data.set(await this.source().list(this.query())); if (this.page() * this.PAGE >= this.rows().length) this.page.set(0); }
    catch { if (again) setTimeout(() => this.load(false), 1200); }
  }
  protected count(l: string): number { const c = this.data()?.counts as unknown as Record<string, number> | undefined; return c?.[l] ?? 0; }
  protected setLane(l: string): void { this.lane.set(l); this.group.set('all'); this.msg.set(''); this.sel.set([]); this.openId.set(''); }
  protected setOwner(o: string): void { this.owner.set(o); remember('an.owner', o); this.sel.set([]); }
  protected setQ(v: string): void { this.q.set(v); if (this.t) clearTimeout(this.t); this.t = setTimeout(() => { this.page.set(0); this.load(); }, 200); }
  protected pick(id: string, on: boolean): void { this.sel.set(on ? [...this.sel(), id] : this.sel().filter((x) => x !== id)); }
  protected pickAll(on: boolean): void { const ids = this.pageRows().map((r) => r.id); this.sel.set(on ? [...new Set([...this.sel(), ...ids])] : this.sel().filter((x) => !ids.includes(x))); }
  protected toggleOpen(id: string): void { this.openId.set(this.openId() === id ? '' : id); }
  protected openMenu(ev: MouseEvent, id: string): void {
    ev.stopPropagation(); if (this.menuId() === id) { this.menuId.set(''); return; }
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect(); const w = 240, h = 220;
    this.menuAt.set({ x: Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)), y: r.bottom + h > window.innerHeight ? Math.max(8, r.top - h) : r.bottom + 4 });
    this.menuId.set(id);
  }
  /** Type, then the call result only when it adds something ("Follow-up required" twice says nothing). */
  protected subline(r: ActionRow): string { const g = this.groupLabel(r.group); const why = r.reason.replace(/^Success: /, ''); return why && why.toLowerCase() !== g.toLowerCase() && why !== r.title ? `${g} · ${why}` : g; }
  protected groupLabel(k: string): string { return this.data()?.groups.find((g) => g.key === k)?.label ?? k; }
  protected initials(e: string): string { if (!e) return '–'; const n = e.split('@')[0].split(/[._-]/).filter(Boolean); return ((n[0]?.[0] || '') + (n[1]?.[0] || '')).toUpperCase() || e[0].toUpperCase(); }
  protected short(e: string): string { return e.split('@')[0]; }
  protected late(r: ActionRow): boolean { return !!r.since && Date.now() - Date.parse(r.since) > 2 * DAY; }
  protected age(iso: string | null): string { if (!iso) return '—'; const m = Math.max(0, Date.now() - Date.parse(iso)) / 60000; return m < 60 ? `${Math.round(m)} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; }
  protected nextText(iso: string): string { const t = Date.parse(iso); return t <= Date.now() + 60000 ? 'Next free slot' : when(iso); }
  protected dots(r: ActionRow): boolean[] { const n = Math.min(10, Math.max(r.total, r.made)); return Array.from({ length: n }, (_, i) => i < r.made); }
  protected emptyText(): string { return this.q() || this.owner() !== 'all' || this.group() !== 'all' ? 'Nothing matches these filters.' : `Nothing needs a person right now. The agent is handling ${this.count('agent')} call${this.count('agent') === 1 ? '' : 's'}.`; }
  protected async act(r: ActionRow, action: ActionVerb): Promise<void> {
    this.menuId.set(''); await this.source().act(r.id, { action });
    this.msg.set({ done: `✓ Done: ${r.caller}.`, dismiss: `✕ Dismissed: ${r.caller}. Reopen it from Closed if needed.`, reopen: `${r.caller} is back in To do.`, requeue: `${r.caller}: the agent tries once more in about 30 minutes.`, assign: '' }[action]);
    this.load();
  }
  protected async assignTo(r: ActionRow, to: string): Promise<void> { if (!to) return; this.menuId.set(''); await this.source().act(r.id, { action: 'assign', to }); this.msg.set(`${r.caller} assigned to ${to === this.me() ? 'you' : to}.`); this.load(); }
  protected async bulk(action: 'done' | 'dismiss' | 'assign'): Promise<void> {
    const ids = this.sel(); if (!ids.length) return; const to = this.bulkTo();
    if (this.source().bulk) await this.source().bulk!(ids, { action, to }); else for (const id of ids) await this.source().act(id, { action, to });
    this.msg.set(action === 'done' ? `✓ ${ids.length} marked done.` : action === 'dismiss' ? `✕ ${ids.length} dismissed.` : `${ids.length} assigned to ${to === this.me() ? 'you' : to}.`);
    this.sel.set([]); this.bulkTo.set(''); this.load();
  }
  protected async exportList(): Promise<void> { save(await this.source().exportXlsx(this.query()), `action-needed-${this.lane()}.xlsx`); }
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
  dedupe: { key: string; days: number }; recheck?: { on: boolean }; write_back: { mode: 'off' | 'each' | 'batch'; mapping: { output: string; field: string }[] };
  schedule: { on: boolean; cadence: 'once' | 'daily' | 'weekdays' | 'days'; days: number[]; time: string; start: string; end: string };
}
export interface DsView { agent: string; label: string; connector_name?: string; inputs: string[]; outputs: string[]; setup: DsSetup; saved: boolean; webhook_url: string; filter_ops: [string, string][];
  columns: { key: string; label: string; type: string; sample: string }[]; runs: { at: string; by: string; read: number; after_filters: number; calls: number; campaign_id?: string; status: string }[]; next_runs: { at: string; label: string }[] }
export interface DsTest { ok: boolean; steps: { key: string; label: string; ok: boolean; detail: string }[]; columns?: DsView['columns']; sample?: Record<string, unknown>[] }
export interface DsPreview { read: number; after_filters: number; skipped_recent: number; no_phone: number; do_not_call?: number; rechecked?: number; total_calls: number; calls: { key: string; part: number; parts: number; lines: number; phone: string; inputs: Record<string, string> }[];
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
            @if (p.rechecked) { <span class="ar">→</span><span><b>{{ p.rechecked }}</b> changed since the run, dropped at dial time</span> }
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
              <h3>Check again right before dialling</h3>
              <label class="ds-switch"><input type="checkbox" [checked]="d().recheck?.on !== false" (change)="patch({ recheck: { on: $any($event.target).checked } })"> Ask {{ conn()?.name || 'the source' }} about each row just before its call</label>
              <p class="s-muted">A PO accepted on the portal between the run and the call is dropped, so a supplier is never called about something already done.</p>
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
  memory?: { on: boolean; days: number };
  anytime?: { flex: boolean; topics: AnytimeTopic[] };
  speech: { boost: string[]; pronounce: { word: string; say: string }[] };
}
export interface AnytimeTopic { id: string; name: string; says: string; action: 'answer' | 'callback' | 'transfer' | 'message' | 'dnc' | 'note'; note: string }
const ANYTIME_ACTIONS: [AnytimeTopic['action'], string][] = [['answer', 'Answer, then go back'], ['callback', 'Book a callback and end'], ['transfer', 'Offer a person (warm transfer)'], ['message', 'Send a WhatsApp and carry on'], ['dnc', 'End and add to do-not-call'], ['note', 'Take a note for the team']];
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
    .ch-topic { display: grid; grid-template-columns: minmax(120px, .8fr) minmax(160px, 1.2fr) minmax(170px, 1fr) auto; gap: 6px; align-items: center; border-bottom: 1px solid var(--s-line); padding-bottom: 8px; }
    .ch-topic .ch-note { grid-column: 1 / -1; }
    @media (max-width: 760px) { .ch-topic { grid-template-columns: 1fr 1fr; } }
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
          <h3>Any-time topics <label><input type="checkbox" [checked]="d().anytime?.flex !== false" (change)="at({ flex: $any($event.target).checked })"> Several answers at once</label></h3>
          <p class="s-muted">Things a supplier may bring up at any point in the call. The agent handles the topic, then goes back to where it was. With "several answers at once", a supplier who says "accepted, dispatch Friday, but the rate is wrong" gets all three handled from one sentence.</p>
          @for (t of d().anytime?.topics ?? []; track t.id; let k = $index) {
            <div class="ch-topic">
              <input [value]="t.name" (input)="topic(k, { name: $any($event.target).value })" aria-label="Topic" placeholder="Topic">
              <input [value]="t.says" (input)="topic(k, { says: $any($event.target).value })" aria-label="When the supplier says" placeholder="When the supplier says…">
              <select (change)="topic(k, { action: $any($event.target).value })" aria-label="What the agent does">@for (a of ACTIONS; track a[0]) { <option [value]="a[0]" [selected]="a[0] === t.action">{{ a[1] }}</option> }</select>
              <button type="button" class="s-btn" (click)="untopic(k)" [attr.aria-label]="'Remove ' + t.name">Remove</button>
              <input class="ch-note" [value]="t.note" (input)="topic(k, { note: $any($event.target).value })" aria-label="How" placeholder="How the agent handles it">
            </div>
          }
          <div><button type="button" class="s-btn" (click)="addTopic()">+ Add a topic</button></div>
        </section>
        <section class="ch-sec">
          <h3>Contact memory <label><input type="checkbox" [checked]="d().memory?.on !== false" (change)="m({ on: $any($event.target).checked })"> On</label></h3>
          <p class="s-muted">Before each call the agent gets a short brief from earlier calls to the same number: what was confirmed, what was promised, when they like to be called. It never asks again for what is already confirmed. The brief is the {{ MEMORY_VAR }} input, and the call page shows it.</p>
          <div class="ch-row" [class.ch-off]="d().memory?.on === false"><label>Look back (days)<input type="number" min="1" max="365" [value]="d().memory?.days ?? 30" (change)="m({ days: +$any($event.target).value })"></label></div>
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
  protected readonly MEMORY_VAR = '{{contact_memory}}';
  protected readonly ACTIONS = ANYTIME_ACTIONS;
  private any(): { flex: boolean; topics: AnytimeTopic[] } { return this.d().anytime ?? { flex: true, topics: [] }; }
  protected at(part: Partial<{ flex: boolean; topics: AnytimeTopic[] }>): void { this.patch({ anytime: { ...this.any(), ...part } }); }
  protected topic(k: number, part: Partial<AnytimeTopic>): void { this.at({ topics: this.any().topics.map((t, j) => (j === k ? { ...t, ...part } : t)) }); }
  protected addTopic(): void { this.at({ topics: [...this.any().topics, { id: 'n' + Date.now(), name: '', says: '', action: 'answer', note: '' }] }); }
  protected untopic(k: number): void { this.at({ topics: this.any().topics.filter((_, j) => j !== k) }); }
  protected m(part: Partial<{ on: boolean; days: number }>): void { this.patch({ memory: { on: true, days: 30, ...(this.d().memory || {}), ...part } }); }
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

// ── Agent quality: AI QA scorecard, persona tests, versions with a diff and an A/B split ──
export interface QaCheck { key: string; label: string; hint: string; pass_rate: number | null; fails: number }
export interface QaCard {
  config: { sample_pct: number; min_seconds: number; checks: { key: string; on: boolean }[]; custom: { id: string; text: string; on: boolean }[] };
  builtin: { key: string; label: string; hint: string }[]; eligible: number; sampled: number; score: number | null; by_check: QaCheck[];
  calls: { id: string; caller: string; phone: string; date: string | null; version: number; score: number; fails: { key: string; label: string; why: string }[] }[];
}
export interface TestRun { at: string; version: number; passed: number; total: number; results: { id: string; name: string; expect: string; got: string; pass: boolean; why: string; seconds: number; transcript: { who: string; text: string }[] }[] }
export interface TestsView { scenarios: { id: string; name: string; who: string; expect: string; source: string; call_id?: string }[]; last: TestRun | null; runs: { at: string; version: number; passed: number; total: number }[]; versions: { v: number; status: string }[]; added?: number }
export interface VersionsView {
  list: { v: number; status: 'published' | 'draft' | 'old'; at: string; by: string; note: string; prompt: string; settings: Record<string, string | number> }[]; published: number | null; draft: number | null;
  split: { on: boolean; a: number; b: number; b_pct: number };
  diff: { from: number; to: number; prompt: { type: 'same' | 'add' | 'del'; text: string }[]; settings: { key: string; from: unknown; to: unknown }[] } | null;
  arms: { v: number; calls: number; answered_pct: number | null; success_pct: number | null; qa: number | null; enough: boolean }[];
}
export interface QualitySource {
  quality(agent: string): Promise<QaCard>; saveQuality(agent: string, cfg: QaCard['config']): Promise<QaCard>;
  tests(agent: string): Promise<TestsView>; runTests(agent: string, ids: string[], version: number): Promise<TestRun>; testsFromCalls(agent: string): Promise<TestsView>;
  versions(agent: string): Promise<VersionsView>; saveDraft(agent: string, d: { prompt?: string; note?: string }): Promise<VersionsView>; publish(agent: string): Promise<VersionsView>;
  split(agent: string, s: { on: boolean; b_pct: number }): Promise<VersionsView>; openCall?(id: string): void;
}
@Component({
  selector: 'app-agent-quality',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [CSS + `
    .q { display: grid; gap: 14px; }
    .q input, .q select, .q textarea { border: 1px solid var(--s-line); border-radius: 6px; padding: 6px 8px; font: inherit; font-size: 13px; background: var(--s-bg); color: var(--s-text); min-width: 0; }
    .q textarea { width: 100%; box-sizing: border-box; min-height: 170px; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; line-height: 1.5; }
    .q-head { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; }
    .q-score { display: grid; gap: 2px; } .q-score b { font-size: 34px; line-height: 1; font-variant-numeric: tabular-nums; } .q-score small { color: var(--s-muted); font-size: 12.5px; }
    .q-good { color: var(--s-good); } .q-mid { color: #b45309; } .q-bad { color: #b91c1c; }
    .q-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; font-size: 13px; }
    .q-row label { display: grid; gap: 4px; font-size: 12px; color: var(--s-muted); }
    .q-checks { display: grid; gap: 6px; }
    .q-check { display: grid; grid-template-columns: auto minmax(160px, 1.3fr) minmax(120px, 1fr) auto; gap: 10px; align-items: center; font-size: 13px; padding: 6px 0; border-bottom: 1px solid var(--s-line); }
    .q-check input[type=checkbox] { width: 20px; height: 20px; accent-color: var(--s-accent); }
    .q-check small { display: block; color: var(--s-muted); font-size: 12px; }
    .q-bar { height: 8px; border-radius: 4px; background: var(--s-soft); overflow: hidden; } .q-bar i { display: block; height: 100%; background: var(--s-good); }
    .q-bar.low i { background: #f59e0b; }
    .q-tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
    .q-tbl th { text-align: left; font-weight: 500; font-size: 12px; color: var(--s-muted); padding: 6px 8px; border-bottom: 1px solid var(--s-line); }
    .q-tbl td { padding: 7px 8px; border-bottom: 1px solid var(--s-line); vertical-align: top; }
    .q-fail { display: block; color: #b91c1c; font-size: 12.5px; }
    .q-pill { font-size: 11.5px; border-radius: 999px; padding: 1px 8px; border: 1px solid var(--s-line); white-space: nowrap; }
    .q-pill.pass { color: var(--s-good); border-color: color-mix(in srgb, var(--s-good) 40%, transparent); } .q-pill.fail { color: #b91c1c; border-color: #fca5a5; }
    .q-pill.pub { color: var(--s-good); } .q-pill.draft { color: var(--s-accent); border-color: color-mix(in srgb, var(--s-accent) 40%, transparent); }
    .q-scen { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: start; font-size: 13px; padding: 6px 0; border-bottom: 1px solid var(--s-line); }
    .q-scen input { width: 20px; height: 20px; accent-color: var(--s-accent); grid-row: span 2; }
    .q-scen small { color: var(--s-muted); font-size: 12.5px; }
    .q-res { border: 1px solid var(--s-line); border-radius: 10px; padding: 8px 12px; display: grid; gap: 4px; font-size: 13px; }
    .q-res.fail { border-color: #fca5a5; }
    .q-tr { display: grid; gap: 3px; margin: 6px 0 0; padding: 8px 10px; background: var(--s-soft); border-radius: 8px; font-size: 12.5px; }
    .q-diff { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; line-height: 1.55; border: 1px solid var(--s-line); border-radius: 8px; overflow: hidden; }
    .q-diff div { padding: 1px 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .q-diff .add { background: color-mix(in srgb, #16a34a 14%, transparent); } .q-diff .del { background: color-mix(in srgb, #dc2626 12%, transparent); text-decoration: line-through; opacity: .85; }
    .q-diff .add::before { content: '+ '; } .q-diff .del::before { content: '− '; } .q-diff .same::before { content: '  '; }
    .q-scroll { overflow-x: auto; }
    .nc-more { border-top: 1px solid var(--s-line); padding-top: 8px; display: grid; gap: 8px; }
    .nc-more summary { cursor: pointer; font-weight: 600; list-style: none; }
    .nc-more summary::-webkit-details-marker { display: none; }
    .nc-more summary::before { content: '▸ '; color: var(--s-muted); }
    .nc-more[open] summary::before { content: '▾ '; }
    .q-err { color: #b91c1c; font-size: 13px; } .q-ok { color: var(--s-good); font-size: 13px; }
    .q-link { border: 0; background: none; padding: 0; color: var(--s-accent); text-decoration: underline; font: inherit; cursor: pointer; }
    @media (max-width: 640px) { .q-check { grid-template-columns: auto 1fr; } }
  `],
  template: `
    <div class="q">
      <div class="q-head"><div><b>Quality</b><p class="s-muted">Check real calls, test new versions before they go live, and compare versions on live traffic.</p></div><span class="s-grow"></span>
        <div class="s-seg" role="tablist" aria-label="Quality">
          @for (t of TABS; track t[0]) { <button type="button" role="tab" [class.on]="tab() === t[0]" [attr.aria-selected]="tab() === t[0]" (click)="go(t[0])">{{ t[1] }}</button> }
        </div></div>
      @if (msg()) { <span [class.q-err]="bad()" [class.q-ok]="!bad()" role="status">{{ msg() }}</span> }

      @if (tab() === 'qa') {
        @if (qa(); as c) {
          <div class="q-head">
            <div class="q-score"><b [class]="tone(c.score)">{{ c.score ?? '—' }}</b><small>quality score, out of 100</small></div>
            <span class="s-muted">{{ c.sampled }} of {{ c.eligible }} answered calls checked ({{ c.config.sample_pct }}% sample, calls of {{ c.config.min_seconds }} s or more). Each call is graded on every check below.</span>
          </div>
          <div class="q-checks">
            @for (k of c.by_check; track k.key) {
              <div class="q-check"><span></span><span>{{ k.label }}<small>{{ k.hint }}</small></span>
                <div class="q-bar" [class.low]="(k.pass_rate ?? 100) < 85" [attr.aria-label]="k.pass_rate + '% pass'"><i [style.width.%]="k.pass_rate ?? 0"></i></div>
                <span><b>{{ k.pass_rate ?? '—' }}%</b> <span class="s-muted">{{ k.fails }} failed</span></span></div>
            }
          </div>
          <b>Calls to look at first</b>
          <div class="q-scroll"><table class="q-tbl"><thead><tr><th>Call</th><th>Version</th><th>Score</th><th>What went wrong</th></tr></thead><tbody>
            @for (call of c.calls; track call.id) { <tr><td>{{ call.caller }}<br><span class="s-muted">{{ when(call.date) }}</span>@if (source().openCall) { <br><button type="button" class="q-link" (click)="source().openCall!(call.id)">Open the call</button> }</td>
              <td>v{{ call.version }}</td><td><b [class]="tone(call.score)">{{ call.score }}</b></td>
              <td>@for (f of call.fails; track f.key) { <span class="q-fail">{{ f.label }}: {{ f.why }}</span> } @empty { <span class="s-muted">Passed every check</span> }</td></tr> }
          </tbody></table></div>
          <details class="nc-more"><summary>Checks and sampling</summary>
            <div class="q-row"><label>Calls to check (%)<input type="number" min="5" max="100" [value]="qaDraft().sample_pct" (change)="setQa({ sample_pct: +$any($event.target).value })"></label>
              <label>Only calls of at least (seconds)<input type="number" min="0" max="120" [value]="qaDraft().min_seconds" (change)="setQa({ min_seconds: +$any($event.target).value })"></label></div>
            @for (b of c.builtin; track b.key) { <label class="q-row" style="align-items: center"><input type="checkbox" style="width: 20px; height: 20px" [checked]="checkOn(b.key)" (change)="toggleCheck(b.key, $any($event.target).checked)"> {{ b.label }} <span class="s-muted">{{ b.hint }}</span></label> }
            <b>Your own checks</b>
            @for (cu of qaDraft().custom; track cu.id; let i = $index) { <div class="q-row"><input type="checkbox" style="width: 20px; height: 20px" [checked]="cu.on" (change)="setCustom(i, { on: $any($event.target).checked })" aria-label="Check on">
              <input style="flex: 1 1 260px" [value]="cu.text" (input)="setCustom(i, { text: $any($event.target).value })" aria-label="Check"><button type="button" class="s-btn" (click)="removeCustom(i)">Remove</button></div> }
            <div class="q-row"><button type="button" class="s-btn" (click)="addCustom()">+ Add a check</button><span class="s-grow"></span>
              <button type="button" class="s-btn s-primary" (click)="saveQa()" [disabled]="busy() || !qaDirty()">Save and re-grade</button></div>
          </details>
        } @else { <p class="s-empty">Grading calls…</p> }
      }

      @if (tab() === 'test') {
        @if (tv(); as t) {
          <div class="q-row">
            <label>Test version<select (change)="testVersion.set(+$any($event.target).value)">@for (v of t.versions; track v.v) { <option [value]="v.v" [selected]="v.v === testVersion()">v{{ v.v }} · {{ v.status }}</option> }</select></label>
            <button type="button" class="s-btn" (click)="fromCalls()" [disabled]="busy()">+ Add scenarios from failing real calls</button><span class="s-grow"></span>
            <button type="button" class="s-btn s-primary" (click)="run()" [disabled]="busy() || !picked().length">{{ busy() ? 'Running…' : 'Run ' + picked().length + ' test' + (picked().length === 1 ? '' : 's') }}</button>
          </div>
          <span class="s-muted">Each test is an AI caller playing a supplier against the version you pick. Nothing is dialled and no credits are used.</span>
          <div>@for (s of t.scenarios; track s.id) {
            <label class="q-scen"><input type="checkbox" [checked]="picked().includes(s.id)" (change)="pick(s.id, $any($event.target).checked)"><b>{{ s.name }}@if (s.source === 'call') { <span class="q-pill draft">from a real call</span> }</b><small>{{ s.who }} · expects {{ s.expect }}</small></label>
          }</div>
          @if (t.last; as r) {
            <div class="q-head"><div class="q-score"><b [class]="r.passed === r.total ? 'q-good' : 'q-mid'">{{ r.passed }}/{{ r.total }}</b><small>passed on v{{ r.version }} · {{ when(r.at) }}</small></div>
              @if (t.runs.length > 1) { <span class="s-muted">Earlier: @for (x of t.runs.slice(1); track x.at) { v{{ x.version }} {{ x.passed }}/{{ x.total }}; } </span> }</div>
            @for (x of r.results; track x.id) {
              <div class="q-res" [class.fail]="!x.pass"><div class="q-row" style="align-items: center"><span class="q-pill" [class.pass]="x.pass" [class.fail]="!x.pass">{{ x.pass ? 'Passed' : 'Failed' }}</span><b>{{ x.name }}</b><span class="s-muted">expected {{ x.expect }} · got {{ x.got }} · {{ x.seconds }} s</span></div>
                @if (x.why) { <span class="q-fail">{{ x.why }}</span> }
                <details><summary class="s-muted">Transcript</summary><div class="q-tr">@for (l of x.transcript; track $index) { <span><b>{{ l.who }}:</b> {{ l.text }}</span> }</div></details></div>
            }
          }
        } @else { <p class="s-empty">Loading tests…</p> }
      }

      @if (tab() === 'versions') {
        @if (vv(); as v) {
          <div class="q-scroll"><table class="q-tbl"><thead><tr><th>Version</th><th>Status</th><th>Note</th><th>Saved</th></tr></thead><tbody>
            @for (x of v.list; track x.v) { <tr><td><b>v{{ x.v }}</b></td><td><span class="q-pill" [class.pub]="x.status === 'published'" [class.draft]="x.status === 'draft'">{{ x.status === 'published' ? 'Live' : x.status === 'draft' ? 'Draft' : 'Earlier' }}</span></td><td>{{ x.note }}</td><td>{{ when(x.at) }}<br><span class="s-muted">{{ x.by }}</span></td></tr> }
          </tbody></table></div>
          @if (v.diff; as d) {
            <b>What changes from v{{ d.from }} (live) to v{{ d.to }} (draft)</b>
            <div class="q-diff">@for (l of d.prompt; track $index) { <div [class]="l.type">{{ l.text }}</div> }</div>
            @if (d.settings.length) { <span class="s-muted">Settings: @for (st of d.settings; track st.key) { {{ st.key }} {{ st.from }} → {{ st.to }}; } </span> }
          }
          @if (draftOf(v); as dr) {
            <details class="nc-more" [open]="editOpen()" (toggle)="editOpen.set($any($event.target).open)"><summary>Edit the draft (v{{ dr.v }})</summary>
              <label class="q-row" style="display: grid">Note<input [value]="draftNote()" (input)="draftNote.set($any($event.target).value)"></label>
              <textarea [value]="draftPrompt()" (input)="draftPrompt.set($any($event.target).value)" aria-label="Draft prompt"></textarea>
              <div class="q-row"><span class="s-muted">Edits go to the draft only; live calls keep using v{{ v.published }}.</span><span class="s-grow"></span>
                <button type="button" class="s-btn" (click)="saveDraft()" [disabled]="busy()">Save draft</button></div>
            </details>
            <div class="q-row"><button type="button" class="s-btn" (click)="go('test'); testVersion.set(dr.v)">Test v{{ dr.v }} first</button><span class="s-grow"></span>
              <button type="button" class="s-btn s-primary" (click)="publish(dr.v)" [disabled]="busy()">Publish v{{ dr.v }}</button></div>
          } @else { <div class="q-row"><span class="s-muted">No draft. Start one from the live version to change the prompt safely.</span><button type="button" class="s-btn" (click)="newDraft()">Start a draft</button></div> }
          <b>Split live traffic (A/B)</b>
          <div class="q-row" style="align-items: center">
            <label style="display: inline-flex; gap: 6px; align-items: center; color: var(--s-text)"><input type="checkbox" style="width: 20px; height: 20px" [checked]="v.split.on" [disabled]="!v.draft" (change)="setSplit($any($event.target).checked, splitPct())"> Send part of each campaign to the draft</label>
            <label>Share to v{{ v.split.b }} (%)<input type="number" min="5" max="50" style="width: 80px" [value]="splitPct()" (change)="splitPct.set(+$any($event.target).value)"></label>
            <button type="button" class="s-btn" (click)="setSplit(v.split.on, splitPct())" [disabled]="busy() || !v.draft">Save split</button>
          </div>
          <div class="q-scroll"><table class="q-tbl"><thead><tr><th>Version</th><th>Calls</th><th>Answered</th><th>Success</th><th>Quality</th><th></th></tr></thead><tbody>
            @for (a of v.arms; track a.v) { <tr><td><b>v{{ a.v }}</b>{{ a.v === v.published ? ' (live)' : ' (draft)' }}</td><td>{{ a.calls }}</td><td>{{ pct(a.answered_pct) }}</td><td>{{ pct(a.success_pct) }}</td><td><b [class]="tone(a.qa)">{{ a.qa ?? '—' }}</b></td><td class="s-muted">{{ a.enough ? '' : 'Fewer than 30 calls: too early to call it' }}</td></tr> }
          </tbody></table></div>
        } @else { <p class="s-empty">Loading versions…</p> }
      }
    </div>
  `,
})
export class AgentQualityComponent {
  readonly source = input.required<QualitySource>();
  readonly agent = input.required<string>();
  protected readonly TABS: [string, string][] = [['qa', 'Quality checks'], ['test', 'Test'], ['versions', 'Versions']];
  protected readonly tab = signal('qa');
  protected readonly qa = signal<QaCard | null>(null); protected readonly qaDraft = signal<QaCard['config']>({ sample_pct: 40, min_seconds: 15, checks: [], custom: [] });
  protected readonly tv = signal<TestsView | null>(null); protected readonly picked = signal<string[]>([]); protected readonly testVersion = signal(0);
  protected readonly vv = signal<VersionsView | null>(null); protected readonly draftPrompt = signal(''); protected readonly draftNote = signal(''); protected readonly editOpen = signal(false); protected readonly splitPct = signal(20);
  protected readonly busy = signal(false); protected readonly msg = signal(''); protected readonly bad = signal(false);
  protected readonly qaDirty = computed(() => JSON.stringify(this.qaDraft()) !== JSON.stringify(this.qa()?.config));
  constructor() { effect(() => { this.agent(); this.source(); untracked(() => { this.qa.set(null); this.tv.set(null); this.vv.set(null); this.go(this.tab()); }); }); }
  private say(m: string, bad = false): void { this.msg.set(m); this.bad.set(bad); }
  private async attempt<T>(fn: () => Promise<T>, again = true): Promise<T | null> { try { return await fn(); } catch (e) { if (again) { await new Promise((r) => setTimeout(r, 1200)); return this.attempt(fn, false); } this.say(errText(e, 'Could not load this.'), true); return null; } }
  protected async go(t: string): Promise<void> {
    this.tab.set(t); this.msg.set(''); const a = this.agent(); const s = this.source();
    if (t === 'qa' && !this.qa()) { const c = await this.attempt(() => s.quality(a)); if (c) { this.qa.set(c); this.qaDraft.set(structuredClone(c.config)); } }
    if (t === 'test' && !this.tv()) { const v = await this.attempt(() => s.tests(a)); if (v) { this.tv.set(v); this.picked.set(v.scenarios.map((x) => x.id)); if (!this.testVersion()) this.testVersion.set(v.versions.find((x) => x.status === 'published')?.v ?? v.versions[0]?.v ?? 0); } }
    if (t === 'versions' && !this.vv()) { const v = await this.attempt(() => s.versions(a)); if (v) this.setVersions(v); }
  }
  protected tone(n: number | null): string { return n == null ? '' : n >= 85 ? 'q-good' : n >= 70 ? 'q-mid' : 'q-bad'; }
  protected pct(n: number | null): string { return n == null ? '—' : n + '%'; }
  protected when(iso: string | null): string { return iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'; }
  // Quality checks
  protected setQa(part: Partial<QaCard['config']>): void { this.qaDraft.set({ ...this.qaDraft(), ...part }); }
  protected checkOn(k: string): boolean { return this.qaDraft().checks.find((c) => c.key === k)?.on !== false; }
  protected toggleCheck(k: string, on: boolean): void { this.setQa({ checks: this.qaDraft().checks.map((c) => (c.key === k ? { ...c, on } : c)) }); }
  protected setCustom(i: number, part: Partial<{ text: string; on: boolean }>): void { this.setQa({ custom: this.qaDraft().custom.map((c, j) => (j === i ? { ...c, ...part } : c)) }); }
  protected addCustom(): void { this.setQa({ custom: [...this.qaDraft().custom, { id: 'n' + Date.now(), text: '', on: true }] }); }
  protected removeCustom(i: number): void { this.setQa({ custom: this.qaDraft().custom.filter((_, j) => j !== i) }); }
  protected async saveQa(): Promise<void> { this.busy.set(true); try { const c = await this.source().saveQuality(this.agent(), this.qaDraft()); this.qa.set(c); this.qaDraft.set(structuredClone(c.config)); this.say('Saved. The calls were graded again.'); } catch { this.say('Could not save.', true); } finally { this.busy.set(false); } }
  // Tests
  protected pick(id: string, on: boolean): void { this.picked.set(on ? [...this.picked(), id] : this.picked().filter((x) => x !== id)); }
  protected async run(): Promise<void> {
    this.busy.set(true);
    try { const r = await this.source().runTests(this.agent(), this.picked(), this.testVersion()); const t = await this.source().tests(this.agent()); this.tv.set({ ...t, last: r }); this.say(`${r.passed} of ${r.total} passed on v${r.version}.`, r.passed < r.total); }
    catch { this.say('Could not run the tests.', true); } finally { this.busy.set(false); }
  }
  protected async fromCalls(): Promise<void> {
    this.busy.set(true);
    try { const t = await this.source().testsFromCalls(this.agent()); this.tv.set({ ...t, last: this.tv()?.last ?? t.last }); this.picked.set(t.scenarios.map((x) => x.id)); this.say(t.added ? `Added ${t.added} scenario${t.added === 1 ? '' : 's'} from calls that failed a check.` : 'No new failing calls to turn into tests.'); }
    catch { this.say('Could not add scenarios.', true); } finally { this.busy.set(false); }
  }
  // Versions
  private setVersions(v: VersionsView): void { this.vv.set(v); const d = this.draftOf(v); this.draftPrompt.set(d?.prompt ?? ''); this.draftNote.set(d?.note ?? ''); this.splitPct.set(v.split.b_pct); this.tv.set(null); }
  protected draftOf(v: VersionsView) { return v.list.find((x) => x.status === 'draft') ?? null; }
  protected async saveDraft(): Promise<void> { this.busy.set(true); try { this.setVersions(await this.source().saveDraft(this.agent(), { prompt: this.draftPrompt(), note: this.draftNote() })); this.qa.set(null); this.say('Draft saved.'); } catch { this.say('Could not save the draft.', true); } finally { this.busy.set(false); } }
  protected async newDraft(): Promise<void> { this.busy.set(true); try { this.setVersions(await this.source().saveDraft(this.agent(), {})); this.editOpen.set(true); this.say('Draft started from the live version.'); } catch { this.say('Could not start a draft.', true); } finally { this.busy.set(false); } }
  protected async publish(n: number): Promise<void> {
    if (!confirm(`Publish v${n}? New calls use it at once; calls already running finish on the old version.`)) return;
    this.busy.set(true); try { this.setVersions(await this.source().publish(this.agent())); this.qa.set(null); this.say(`v${n} is live.`); } catch (e) { this.say(errText(e, 'Could not publish.'), true); } finally { this.busy.set(false); }
  }
  protected async setSplit(on: boolean, pct: number): Promise<void> {
    this.busy.set(true); try { this.setVersions(await this.source().split(this.agent(), { on, b_pct: pct })); this.say(on ? `${pct}% of new calls go to the draft.` : 'All calls use the live version.'); } catch (e) { this.say(errText(e, 'Could not save the split.'), true); } finally { this.busy.set(false); }
  }
}

// ── Live calls: watch a call as it happens, listen in, take over, or hand it to a person with a brief ──
export interface LiveCall { id: string; po: string; caller: string; phone: string; campaign: string; agent: string; started_at: string; elapsed: number; state: 'ai' | 'human' | 'transferred' | 'ended';
  mood: string; flag: string | null; transcript: { who: string; text: string; at: number }[]; transfer: { to: string; phone: string; brief: string; at: string } | null; listening: string | null }
export interface LiveSource { list(): Promise<{ calls: LiveCall[]; buyers: { key: string; name: string; phone: string }[] }>; act(id: string, action: string, body?: Record<string, string>): Promise<{ ok: string; calls: LiveCall[] }>; openCall?(id: string): void }
@Component({
  selector: 'app-live-calls',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [CSS + `
    .lv { border: 1px solid var(--s-line); border-radius: 12px; background: var(--s-bg); }
    .lv-bar { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; padding: 10px 14px; font-size: 13.5px; }
    .lv-dot { width: 9px; height: 9px; border-radius: 50%; background: #dc2626; box-shadow: 0 0 0 0 rgba(220, 38, 38, .5); animation: lv-pulse 1.6s infinite; }
    @keyframes lv-pulse { 70% { box-shadow: 0 0 0 7px rgba(220, 38, 38, 0); } 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0); } }
    @media (prefers-reduced-motion: reduce) { .lv-dot { animation: none; } }
    .lv-chip { border: 1px solid var(--s-line); background: var(--s-bg); color: var(--s-text); border-radius: 999px; padding: 4px 10px; font: inherit; font-size: 12.5px; cursor: pointer; }
    .lv-chip.on { border-color: var(--s-accent); color: var(--s-accent); font-weight: 600; }
    .lv-chip.warn { border-color: #f59e0b; }
    .lv-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; padding: 0 14px 14px; }
    .lv-tr { display: grid; gap: 6px; max-height: 260px; overflow: auto; background: var(--s-soft); border-radius: 10px; padding: 10px 12px; font-size: 13px; }
    .lv-tr p { margin: 0; } .lv-tr .Agent b { color: var(--s-accent); } .lv-tr .You b { color: #b45309; }
    .lv-typing { color: var(--s-muted); font-style: italic; }
    .lv-flag { border-left: 3px solid #f59e0b; background: color-mix(in srgb, #f59e0b 10%, var(--s-bg)); padding: 6px 10px; border-radius: 0 8px 8px 0; font-size: 13px; }
    .lv-acts { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .lv-tf { display: grid; gap: 6px; border: 1px solid var(--s-line); border-radius: 10px; padding: 10px 12px; font-size: 13px; }
    .lv-tf select, .lv-tf textarea { border: 1px solid var(--s-line); border-radius: 6px; padding: 6px 8px; font: inherit; font-size: 13px; background: var(--s-bg); color: var(--s-text); }
    .lv-ok { color: var(--s-good); font-size: 13px; } .lv-err { color: #b91c1c; font-size: 13px; }
  `],
  template: `
    @if (calls().length) {
      <section class="lv" aria-label="Live calls">
        <div class="lv-bar"><i class="lv-dot" aria-hidden="true"></i><b>Live now: {{ running().length }} call{{ running().length === 1 ? '' : 's' }}</b>
          @for (c of calls(); track c.id) { <button type="button" class="lv-chip" [class.on]="sel() === c.id" [class.warn]="!!c.flag" (click)="pick(c.id)" [attr.aria-pressed]="sel() === c.id">{{ c.caller }} · {{ mmss(c.elapsed) }}{{ c.state === 'human' ? ' · you' : c.state === 'transferred' ? ' · transferred' : c.state === 'ended' ? ' · ended' : '' }}</button> }
          <span class="s-grow"></span>@if (sel()) { <button type="button" class="s-btn" (click)="sel.set('')">Close</button> }</div>
        @if (current(); as c) {
          <div class="lv-body">
            <span class="s-muted">{{ c.agent }} · {{ c.campaign }} · {{ c.phone }} · PO {{ c.po }}</span>
            @if (c.flag) { <div class="lv-flag"><b>Needs a person?</b> {{ c.flag }}</div> }
            <div class="lv-tr" aria-live="polite">
              @for (l of c.transcript; track $index) { <p [class]="l.who"><b>{{ l.who }}:</b> {{ l.text }}</p> }
              @if (c.state === 'ai') { <p class="lv-typing">{{ c.transcript.length % 2 ? 'Supplier is speaking…' : 'Agent is speaking…' }}</p> }
              @if (c.transfer; as tf) { <p class="lv-typing">Transferred to {{ tf.to }} ({{ tf.phone }}). Brief they heard: "{{ tf.brief }}"</p> }
            </div>
            @if (c.state === 'ai' || c.state === 'human') {
              <div class="lv-acts">
                <button type="button" class="s-btn" [class.s-primary]="!c.listening" (click)="act('listen')" [disabled]="!!c.listening">{{ c.listening ? 'Listening' : 'Listen' }}</button>
                @if (c.state === 'ai') { <button type="button" class="s-btn" (click)="act('takeover')">Take over</button> }
                <button type="button" class="s-btn" (click)="tfOpen.set(!tfOpen())" [attr.aria-expanded]="tfOpen()">Transfer…</button>
                <button type="button" class="s-btn" (click)="act('dnc')" title="End the call and add the number to the do-not-call list">Don't call again</button>
                <button type="button" class="s-btn s-danger" (click)="act('end')">End call</button>
              </div>
              @if (tfOpen()) {
                <div class="lv-tf"><b>Warm transfer</b><span class="s-muted">The person hears this brief before the supplier joins, so nobody has to repeat themselves.</span>
                  <label>To <select (change)="tfTo.set($any($event.target).value)">@for (b of buyers(); track b.key) { <option [value]="b.key" [selected]="b.key === tfTo()">{{ b.name }} · {{ b.phone }}</option> }</select></label>
                  <textarea rows="3" [value]="brief(c)" (input)="tfBrief.set($any($event.target).value)" aria-label="Brief"></textarea>
                  <div class="lv-acts"><span class="s-grow"></span><button type="button" class="s-btn" (click)="tfOpen.set(false)">Cancel</button><button type="button" class="s-btn s-primary" (click)="transfer(c)">Transfer now</button></div></div>
              }
            } @else if (source().openCall) { <div><button type="button" class="s-btn" (click)="source().openCall!(c.id)">Open the call</button></div> }
            @if (msg()) { <span [class.lv-ok]="!bad()" [class.lv-err]="bad()" role="status">{{ msg() }}</span> }
          </div>
        }
      </section>
    }
  `,
})
export class LiveCallsComponent implements OnDestroy {
  readonly source = input.required<LiveSource>();
  protected readonly calls = signal<LiveCall[]>([]); protected readonly buyers = signal<{ key: string; name: string; phone: string }[]>([]);
  protected readonly sel = signal(''); protected readonly tfOpen = signal(false); protected readonly tfTo = signal('buyer1'); protected readonly tfBrief = signal('');
  protected readonly msg = signal(''); protected readonly bad = signal(false);
  protected readonly running = computed(() => this.calls().filter((c) => c.state !== 'ended'));
  protected readonly current = computed(() => this.calls().find((c) => c.id === this.sel()) ?? null);
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor() { effect(() => { const s = this.source(); untracked(() => this.load(s)); }); this.timer = setInterval(() => { if (!document.hidden) this.load(this.source(), false); }, 3000); }
  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); }
  private async load(s: LiveSource, again = true): Promise<void> {
    try { const r = await s.list(); this.calls.set(r.calls); this.buyers.set(r.buyers); }
    catch { if (again) setTimeout(() => this.load(s, false), 1200); }
  }
  protected pick(id: string): void { this.sel.set(this.sel() === id ? '' : id); this.tfOpen.set(false); this.tfBrief.set(''); this.msg.set(''); }
  protected mmss(s: number): string { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
  protected brief(c: LiveCall): string { return this.tfBrief() || `${c.caller}, PO ${c.po}: ${c.flag ? c.flag.replace(/\.$/, '') : 'needs a person'}.`; }
  protected async act(action: string, body?: Record<string, string>): Promise<void> {
    const id = this.sel(); if (!id) return;
    try { const r = await this.source().act(id, action, body); this.calls.set(r.calls); this.msg.set(r.ok); this.bad.set(false); this.tfOpen.set(false); }
    catch (e) { this.msg.set(errText(e, 'That did not work.')); this.bad.set(true); }
  }
  protected transfer(c: LiveCall): void { this.act('transfer', { to: this.tfTo(), brief: this.brief(c) }); }
}

// ── Telephony hub: carriers, caller IDs, and concurrency slots per campaign ──
export interface TelephonyView {
  carriers: { key: string; name: string; status: string; channels: number; numbers: string[]; since: string }[];
  catalog: { key: string; name: string; region: string; fields: { key: string; label: string; type: string }[] }[];
  rotate: boolean; total: number; assigned: number; free: number; numbers: { number: string; carrier: string }[];
  running: { campaign_id: string; campaign: string; agent: string; slots: number; in_use: number; queued: number; minutes_left: number }[];
}
export interface TelephonySource { load(): Promise<TelephonyView>; test(b: { carrier: string; fields: Record<string, string> }): Promise<{ ok: boolean; steps: { label: string; ok: boolean; detail: string }[] }>;
  connect(b: { carrier: string; fields: Record<string, string> }): Promise<TelephonyView>; disconnect(key: string): Promise<TelephonyView>; saveSlots(b: { rotate: boolean; slots: Record<string, number> }): Promise<TelephonyView> }
@Component({
  selector: 'app-telephony-hub',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [CSS + `
    .th { display: grid; gap: 14px; }
    .th input, .th select { border: 1px solid var(--s-line); border-radius: 6px; padding: 6px 8px; font: inherit; font-size: 13px; background: var(--s-bg); color: var(--s-text); min-width: 0; }
    .th-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
    .th-card { border: 1px solid var(--s-line); border-radius: 12px; padding: 12px 14px; display: grid; gap: 4px; font-size: 13px; }
    .th-card b { font-size: 15px; } .th-ok { color: var(--s-good); font-weight: 600; }
    .th-tiles { display: flex; flex-wrap: wrap; gap: 8px; }
    .th-tile { border: 1px solid var(--s-line); background: var(--s-bg); color: var(--s-text); border-radius: 10px; padding: 8px 12px; font: inherit; font-size: 13px; cursor: pointer; text-align: left; }
    .th-tile small { display: block; color: var(--s-muted); font-size: 12px; }
    .th-tile.on { border: 2px solid var(--s-accent); padding: 7px 11px; }
    .th-form { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
    .th-form label { display: grid; gap: 4px; font-size: 12px; color: var(--s-muted); }
    .th-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: 13px; }
    .th-steps li.bad { color: #b91c1c; }
    .th-meter { height: 10px; border-radius: 5px; background: var(--s-soft); overflow: hidden; display: flex; } .th-meter i { background: var(--s-accent); } .th-meter u { background: color-mix(in srgb, var(--s-accent) 35%, transparent); }
    .th-tbl { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
    .th-tbl th { text-align: left; font-weight: 500; font-size: 12px; color: var(--s-muted); padding: 6px 8px; border-bottom: 1px solid var(--s-line); }
    .th-tbl td { padding: 6px 8px; border-bottom: 1px solid var(--s-line); }
    .th-tbl input { width: 70px; }
    .th-scroll { overflow-x: auto; }
    .th-msg { font-size: 13px; color: var(--s-good); } .th-msg.bad { color: #b91c1c; }
  `],
  template: `
    <div class="th">
      <div><h2 class="s-title" role="heading" [attr.aria-level]="page() ? 1 : 2">Telephony</h2>
        <p class="s-muted">The carriers your calls go out on, the numbers suppliers see, and how many calls each campaign may run at once.</p></div>
      @if (v(); as view) {
        <b>Connected carriers</b>
        <div class="th-cards">@for (c of view.carriers; track c.key) {
          <div class="th-card"><b>{{ c.name }}</b><span class="th-ok">● Connected</span><span>{{ c.channels }} calls at once · {{ c.numbers.length }} number{{ c.numbers.length === 1 ? '' : 's' }}</span><span class="s-muted">since {{ when(c.since) }}</span>
            <div><button type="button" class="s-btn" (click)="disconnect(c.key)">Disconnect</button></div></div>
        } @empty { <p class="s-note">No carrier connected: calls cannot go out.</p> }</div>
        <details class="th-add" [open]="addOpen()" (toggle)="addOpen.set($any($event.target).open)"><summary><b>+ Connect a carrier</b> <span class="s-muted">bring your own Ozonetel, Exotel, Tata Tele, Plivo, Twilio or SIP trunk</span></summary>
          <div class="th-tiles">@for (c of view.catalog; track c.key) { <button type="button" class="th-tile" [class.on]="pickC() === c.key" (click)="pickC.set(c.key); fields.set({}); test.set(null)">{{ c.name }}<small>{{ c.region }}</small></button> }</div>
          @if (carrier(); as c) {
            <div class="th-form">@for (f of c.fields; track f.key) { <label>{{ f.label }}<input [type]="f.type === 'secret' ? 'password' : 'text'" autocomplete="off" (input)="setF(f.key, $any($event.target).value)"></label> }
              <button type="button" class="s-btn" (click)="runTest()" [disabled]="busy()">Test</button>
              <button type="button" class="s-btn s-primary" (click)="connect()" [disabled]="busy() || !test()?.ok">Connect</button></div>
            @if (test(); as t) { <ul class="th-steps">@for (s of t.steps; track s.label) { <li [class.bad]="!s.ok">{{ s.ok ? '✓' : '✕' }} <b>{{ s.label }}</b> · {{ s.detail }}</li> }</ul> }
          }
        </details>
        <b>Numbers suppliers see</b>
        <div class="th-tiles">@for (n of view.numbers; track n.number) { <span class="th-tile">{{ n.number }}<small>{{ n.carrier }}</small></span> }</div>
        <label class="th-form" style="align-items: center"><input type="checkbox" style="width: 20px; height: 20px" [checked]="rotate()" (change)="rotate.set($any($event.target).checked)"> Rotate numbers across calls, so no single number gets flagged as spam</label>
        <b>Slots: calls at the same time</b>
        <div class="th-meter" role="img" [attr.aria-label]="view.assigned + ' of ' + view.total + ' slots given to campaigns'"><i [style.width.%]="share(view.assigned, view.total)"></i></div>
        <span class="s-muted">{{ view.total }} slots from your carriers · {{ view.assigned }} given to running campaigns · {{ view.free }} free. A campaign never takes more than its slots, so one big sheet cannot hold up the others.</span>
        <div class="th-scroll"><table class="th-tbl"><thead><tr><th>Running campaign</th><th>Slots</th><th>In use</th><th>Waiting</th><th>Done in about</th></tr></thead><tbody>
          @for (r of view.running; track r.campaign_id) { <tr><td>{{ r.campaign }}<br><span class="s-muted">{{ r.agent }}</span></td>
            <td><input type="number" min="1" max="200" [value]="slotOf(r)" (change)="setSlot(r.campaign_id, +$any($event.target).value)" [attr.aria-label]="'Slots for ' + r.campaign"></td>
            <td>{{ r.in_use }}</td><td>{{ r.queued }}</td><td>{{ mins(r.queued, slotOf(r)) }}</td></tr> }
          @empty { <tr><td colspan="5" class="s-muted">No campaign is running.</td></tr> }
        </tbody></table></div>
        <div class="th-form"><span class="s-grow"></span>@if (msg()) { <span class="th-msg" [class.bad]="bad()" role="status">{{ msg() }}</span> }<button type="button" class="s-btn s-primary" (click)="save()" [disabled]="busy()">Save numbers and slots</button></div>
      } @else { <p class="s-empty">{{ msg() || 'Loading telephony…' }}</p> }
    </div>
  `,
})
export class TelephonyHubComponent {
  readonly source = input.required<TelephonySource>();
  readonly page = input(false);
  protected readonly v = signal<TelephonyView | null>(null);
  protected readonly addOpen = signal(false); protected readonly pickC = signal(''); protected readonly fields = signal<Record<string, string>>({});
  protected readonly test = signal<{ ok: boolean; steps: { label: string; ok: boolean; detail: string }[] } | null>(null);
  protected readonly rotate = signal(true); protected readonly slots = signal<Record<string, number>>({});
  protected readonly busy = signal(false); protected readonly msg = signal(''); protected readonly bad = signal(false);
  protected readonly carrier = computed(() => this.v()?.catalog.find((c) => c.key === this.pickC()) ?? null);
  constructor() { effect(() => { const s = this.source(); untracked(() => this.load(s)); }); }
  private set(v: TelephonyView): void { this.v.set(v); this.rotate.set(v.rotate); this.slots.set({}); }
  private async load(s = this.source(), again = true): Promise<void> { try { this.set(await s.load()); } catch { if (again) setTimeout(() => this.load(s, false), 1200); else { this.msg.set('Could not load telephony.'); this.bad.set(true); } } }
  private say(m: string, bad = false): void { this.msg.set(m); this.bad.set(bad); }
  protected setF(k: string, v: string): void { this.fields.set({ ...this.fields(), [k]: v }); this.test.set(null); }
  protected async runTest(): Promise<void> { this.busy.set(true); try { this.test.set(await this.source().test({ carrier: this.pickC(), fields: this.fields() })); } finally { this.busy.set(false); } }
  protected async connect(): Promise<void> { this.busy.set(true); try { this.set(await this.source().connect({ carrier: this.pickC(), fields: this.fields() })); this.say(`${this.carrier()?.name} connected.`); this.addOpen.set(false); this.pickC.set(''); this.test.set(null); } catch (e) { this.say(errText(e, 'Could not connect.'), true); } finally { this.busy.set(false); } }
  protected async disconnect(key: string): Promise<void> { if (!confirm('Disconnect this carrier? Calls stop going out on it.')) return; try { this.set(await this.source().disconnect(key)); this.say('Disconnected.'); } catch (e) { this.say(errText(e, 'Could not disconnect.'), true); } }
  protected slotOf(r: { campaign_id: string; slots: number }): number { return this.slots()[r.campaign_id] ?? r.slots; }
  protected setSlot(id: string, n: number): void { this.slots.set({ ...this.slots(), [id]: n }); }
  protected mins(queued: number, slots: number): string { const m = Math.ceil((queued * 2.5) / Math.max(1, slots)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; }
  protected share(n: number, of: number): number { return of ? Math.min(100, (100 * n) / of) : 0; }
  protected async save(): Promise<void> { this.busy.set(true); try { this.set(await this.source().saveSlots({ rotate: this.rotate(), slots: this.slots() })); this.say('Saved.'); } catch { this.say('Could not save.', true); } finally { this.busy.set(false); } }
  protected when(iso: string): string { return new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }); }
}

// ── Supplier 360: one page per supplier, across every campaign and agent ──
export interface SupplierView {
  phone: string; name: string; email: string; agents: string[]; dnc: { reason: string } | null;
  stats: { calls: number; answered: number; success: number; campaigns: number; last_call: string | null };
  open_actions: ActionRow[]; pos: { po: string; campaigns: string[]; last: string | null; result: string }[];
  promises: { what: string; value: string; at: string | null; campaign: string; id: string }[]; memory: string[];
  calls: { id: string; at: string | null; campaign: string; agent: string; status: string; reason: string; summary: string }[];
}
export interface SupplierSource { load(phone: string): Promise<SupplierView>; openCall(id: string): void; openActions?(): void; back(): void }
@Component({
  selector: 'app-supplier-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [CSS + `
    .sp-nums { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; }
    .sp-nums div { background: var(--s-soft); border-radius: 10px; padding: 10px 12px; display: grid; } .sp-nums span { font-size: 12px; color: var(--s-muted); } .sp-nums b { font-size: 22px; }
    .sp-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 12px; align-items: start; }
    .sp-sec { display: grid; gap: 8px; padding: 12px 14px; } .sp-sec h2 { margin: 0; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--s-muted); }
    .sp-item { display: grid; gap: 2px; border-top: 1px solid var(--s-line); padding-top: 8px; font-size: 13px; } .sp-item:first-of-type { border-top: 0; padding-top: 0; }
    .sp-item small { color: var(--s-muted); }
    .sp-link { border: 0; background: none; padding: 0; color: var(--s-accent); text-decoration: underline; font: inherit; cursor: pointer; text-align: left; }
    .sp-warn { border: 1px solid #fca5a5; background: color-mix(in srgb, #dc2626 8%, var(--s-bg)); border-radius: 10px; padding: 8px 12px; font-size: 13px; }
    .sp-mem { margin: 0; padding-left: 18px; display: grid; gap: 4px; font-size: 13px; }
    @media (max-width: 900px) { .sp-grid { grid-template-columns: minmax(0, 1fr); } }
  `],
  template: `
    <div class="s">
      <div class="s-head"><button type="button" class="s-btn" (click)="source().back()">← Back</button></div>
      @if (v(); as s) {
        <div class="s-head"><div><h1 class="s-title">{{ s.name }}</h1><p class="s-sub">{{ s.phone }}{{ s.email ? ' · ' + s.email : '' }} · called by {{ s.agents.join(', ') }}</p></div></div>
        @if (s.dnc) { <div class="sp-warn" role="alert">On the do-not-call list: {{ s.dnc.reason }}. No agent calls this number.</div> }
        <div class="sp-nums"><div><span>Calls</span><b>{{ s.stats.calls }}</b></div><div><span>Answered</span><b>{{ s.stats.answered }}</b></div><div><span>Successful</span><b>{{ s.stats.success }}</b></div>
          <div><span>Campaigns</span><b>{{ s.stats.campaigns }}</b></div><div><span>Last call</span><b style="font-size: 15px">{{ when(s.stats.last_call) }}</b></div></div>
        <div class="sp-grid">
          <div class="s" style="gap: 12px">
            <div class="s-card sp-sec"><h2>Open actions ({{ s.open_actions.length }})</h2>
              @for (a of s.open_actions; track a.id) { <div class="sp-item"><b>{{ a.title }}</b><small>{{ a.lane === 'agent' ? 'With the agent: ' + (a.state || '') + (a.next_at ? ' · ' + when(a.next_at) : '') : 'For ' + (a.assignee || 'nobody yet') }} · {{ a.campaign }}</small></div> }
              @empty { <p class="s-muted">Nothing open for this supplier.</p> }
              @if (s.open_actions.length && source().openActions) { <div><button type="button" class="s-btn" (click)="source().openActions!()">Open Action needed</button></div> }
            </div>
            <div class="s-card sp-sec"><h2>Calls ({{ s.calls.length }})</h2>
              @for (c of s.calls; track c.id) { <div class="sp-item"><button type="button" class="sp-link" (click)="source().openCall(c.id)">{{ when(c.at) }} · {{ c.reason }}</button><small>{{ c.campaign }} · {{ c.agent }}</small>@if (c.summary) { <span>{{ c.summary }}</span> }</div> }
            </div>
          </div>
          <div class="s" style="gap: 12px">
            <div class="s-card sp-sec"><h2>What the agent knows</h2><ul class="sp-mem">@for (l of s.memory; track $index) { <li>{{ l }}</li> }</ul></div>
            <div class="s-card sp-sec"><h2>Promises</h2>
              @for (p of s.promises; track $index) { <div class="sp-item"><b>{{ p.what }}: {{ p.value }}</b><small>said {{ when(p.at) }} · {{ p.campaign }}</small></div> } @empty { <p class="s-muted">No dates promised yet.</p> }</div>
            <div class="s-card sp-sec"><h2>POs ({{ s.pos.length }})</h2>
              @for (p of s.pos; track p.po) { <div class="sp-item"><b>{{ p.po }}</b><small>{{ p.result }} · {{ when(p.last) }} · {{ p.campaigns.join(', ') }}</small></div> } @empty { <p class="s-muted">No PO numbers in the rows.</p> }</div>
          </div>
        </div>
      } @else { <p class="s-empty">{{ err() || 'Loading the supplier…' }}</p> }
    </div>
  `,
})
export class SupplierPageComponent {
  readonly source = input.required<SupplierSource>();
  private readonly route = inject(ActivatedRoute);
  protected readonly v = signal<SupplierView | null>(null);
  protected readonly err = signal('');
  protected readonly when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
  constructor() { this.route.paramMap.subscribe((m) => { const p = m.get('phone'); if (p) this.load(p); }); }
  private async load(p: string, again = true): Promise<void> {
    this.v.set(null); this.err.set('');
    try { this.v.set(await this.source().load(p)); } catch (e) { if (again) setTimeout(() => this.load(p, false), 1200); else this.err.set(errText(e, 'Could not load this supplier.')); }
  }
}

// ── Security center: sign-in, provisioning, data protection and deletion ──
export interface SecurityView {
  sso: { on: boolean; protocol: 'saml' | 'oidc'; provider: string; metadata_url: string; client_id: string; domain: string; enforce: boolean; tested: { ok: boolean; at: string } | null };
  scim: { on: boolean; base_url: string; token_hint: string }; mfa_required: boolean; session_hours: number; ip_allowlist: string;
  residency: { region: string; backups: string; note: string }; retention: { recordings_days: number; transcripts_days: number; contacts_days: number };
  pii_redaction: boolean; mask_numbers_for_viewers: boolean; recording_link_hours: number;
}
export interface SecuritySource {
  load(): Promise<SecurityView>; save(s: Partial<SecurityView>): Promise<SecurityView>; testSso(s: Partial<SecurityView>): Promise<{ ok: boolean; steps: { label: string; ok: boolean; detail: string }[] }>;
  scimToken(): Promise<SecurityView & { token: string }>; deleteContact(b: { phone: string; confirm?: boolean; reason?: string }): Promise<{ preview: { phone: string; calls: number; recordings: number; campaigns: number; on_dnc: boolean }; deleted?: boolean; note?: string }>;
}
@Component({
  selector: 'app-security-center',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [CSS + `
    .sc { display: grid; gap: 14px; }
    .sc input, .sc select { border: 1px solid var(--s-line); border-radius: 6px; padding: 6px 8px; font: inherit; font-size: 13px; background: var(--s-bg); color: var(--s-text); min-width: 0; }
    .sc-sec { border: 1px solid var(--s-line); border-radius: 12px; padding: 12px 14px; display: grid; gap: 10px; }
    .sc-sec h3 { margin: 0; font-size: 15px; display: flex; gap: 10px; align-items: center; } .sc-sec h3 .s-muted { font-weight: 400; font-size: 12.5px; }
    .sc-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; font-size: 13px; } .sc-row label { display: grid; gap: 4px; font-size: 12px; color: var(--s-muted); }
    .sc-tog { display: inline-flex !important; grid: none; gap: 8px; align-items: center; color: var(--s-text) !important; font-size: 13px !important; cursor: pointer; } .sc-tog input { width: 20px; height: 20px; accent-color: var(--s-accent); }
    .sc-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: 13px; } .sc-steps .bad { color: #b91c1c; }
    .sc-token { font-family: ui-monospace, Consolas, monospace; background: var(--s-soft); padding: 6px 8px; border-radius: 6px; font-size: 12.5px; overflow-wrap: anywhere; }
    .sc-ok { color: var(--s-good); font-size: 13px; } .sc-bad { color: #b91c1c; font-size: 13px; } .sc-chip { font-size: 12px; border-radius: 999px; padding: 1px 8px; border: 1px solid var(--s-line); }
    .sc-chip.on { color: var(--s-good); border-color: color-mix(in srgb, var(--s-good) 40%, transparent); }
  `],
  template: `
    <div class="sc">
      <div><h2 class="s-title" role="heading" [attr.aria-level]="page() ? 1 : 2">Security</h2><p class="s-muted">Who can sign in and how, where data lives, how long it is kept, and deleting a contact on request.</p></div>
      @if (d(); as s) {
        <section class="sc-sec"><h3>Single sign-on <span class="sc-chip" [class.on]="s.sso.enforce">{{ s.sso.enforce ? 'Required' : s.sso.on ? 'On, not required' : 'Off' }}</span></h3>
          <div class="sc-row">
            <label class="sc-tog"><input type="checkbox" [checked]="s.sso.on" (change)="sso({ on: $any($event.target).checked })"> Sign in with your identity provider</label>
            <label>Protocol<select (change)="sso({ protocol: $any($event.target).value })"><option value="saml" [selected]="s.sso.protocol === 'saml'">SAML 2.0</option><option value="oidc" [selected]="s.sso.protocol === 'oidc'">OpenID Connect</option></select></label>
            <label>Provider<select (change)="sso({ provider: $any($event.target).value })">@for (p of PROVIDERS; track p[0]) { <option [value]="p[0]" [selected]="p[0] === s.sso.provider">{{ p[1] }}</option> }</select></label>
            <label>Email domain<input [value]="s.sso.domain" (input)="sso({ domain: $any($event.target).value })"></label>
          </div>
          <div class="sc-row">@if (s.sso.protocol === 'saml') { <label style="flex: 1 1 320px">Metadata URL<input [value]="s.sso.metadata_url" (input)="sso({ metadata_url: $any($event.target).value })" placeholder="https://idp.example.com/app/metadata"></label> }
            @else { <label style="flex: 1 1 260px">Client ID<input [value]="s.sso.client_id" (input)="sso({ client_id: $any($event.target).value })"></label> }
            <button type="button" class="s-btn" (click)="test()" [disabled]="busy()">Test sign-in</button></div>
          @if (ssoTest(); as t) { <ul class="sc-steps">@for (x of t.steps; track x.label) { <li [class.bad]="!x.ok">{{ x.ok ? '✓' : '✕' }} <b>{{ x.label }}</b> · {{ x.detail }}</li> }</ul> }
          <label class="sc-tog"><input type="checkbox" [checked]="s.sso.enforce" [disabled]="!s.sso.tested?.ok && !ssoTest()?.ok" (change)="sso({ enforce: $any($event.target).checked })"> Require single sign-on for everyone {{ '@' }}{{ s.sso.domain }} (passwords stop working)</label>
          <span class="s-muted">Requiring it is only possible after a test passes, so nobody is locked out.</span>
        </section>
        <section class="sc-sec"><h3>User provisioning (SCIM) <span class="sc-chip" [class.on]="s.scim.on">{{ s.scim.on ? 'On' : 'Off' }}</span></h3>
          <span class="s-muted">Your identity provider adds, updates and removes Echo users and their roles automatically.</span>
          <div class="sc-row"><label style="flex: 1 1 280px">SCIM base URL<input [value]="s.scim.base_url" readonly></label><label>Token<input [value]="s.scim.token_hint || 'none yet'" readonly></label>
            <button type="button" class="s-btn" (click)="token()" [disabled]="busy()">{{ s.scim.token_hint ? 'Replace token' : 'Generate token' }}</button></div>
          @if (newToken()) { <div class="sc-token">{{ newToken() }}</div><span class="s-muted">Copy it now: it is shown once.</span> }
        </section>
        <section class="sc-sec"><h3>Sign-in rules</h3>
          <div class="sc-row"><label class="sc-tog"><input type="checkbox" [checked]="s.mfa_required" (change)="set({ mfa_required: $any($event.target).checked })"> Two-step sign-in for everyone</label>
            <label>Sign out after (hours)<input type="number" min="1" max="72" style="width: 80px" [value]="s.session_hours" (change)="set({ session_hours: +$any($event.target).value })"></label>
            <label style="flex: 1 1 260px">Allowed IP ranges (optional)<input [value]="s.ip_allowlist" (input)="set({ ip_allowlist: $any($event.target).value })" placeholder="e.g. 103.21.0.0/16, 49.36.12.4"></label></div>
        </section>
        <section class="sc-sec"><h3>Where data lives</h3>
          <div class="sc-row"><span><b>Region:</b> {{ s.residency.region }}</span><span><b>Backups:</b> {{ s.residency.backups }}</span></div><span class="s-muted">{{ s.residency.note }} Other regions and a private cloud are arranged with your account team.</span>
        </section>
        <section class="sc-sec"><h3>Keep data for</h3>
          <div class="sc-row"><label>Recordings (days)<input type="number" min="7" max="3650" style="width: 90px" [value]="s.retention.recordings_days" (change)="ret({ recordings_days: +$any($event.target).value })"></label>
            <label>Transcripts and answers (days)<input type="number" min="7" max="3650" style="width: 90px" [value]="s.retention.transcripts_days" (change)="ret({ transcripts_days: +$any($event.target).value })"></label>
            <label>Contact details (days)<input type="number" min="30" max="3650" style="width: 90px" [value]="s.retention.contacts_days" (change)="ret({ contacts_days: +$any($event.target).value })"></label></div>
          <div class="sc-row"><label class="sc-tog"><input type="checkbox" [checked]="s.pii_redaction" (change)="set({ pii_redaction: $any($event.target).checked })"> Hide bank, card and ID numbers in transcripts</label>
            <label class="sc-tog"><input type="checkbox" [checked]="s.mask_numbers_for_viewers" (change)="set({ mask_numbers_for_viewers: $any($event.target).checked })"> Mask phone numbers for viewers</label>
            <label>Recording links expire after (hours)<input type="number" min="1" max="168" style="width: 80px" [value]="s.recording_link_hours" (change)="set({ recording_link_hours: +$any($event.target).value })"></label></div>
        </section>
        <div class="sc-row"><span class="s-grow"></span>@if (msg()) { <span [class.sc-ok]="!bad()" [class.sc-bad]="bad()" role="status">{{ msg() }}</span> }
          <button type="button" class="s-btn" (click)="undo()" [disabled]="!dirty()">Undo changes</button><button type="button" class="s-btn s-primary" (click)="save()" [disabled]="!dirty() || busy()">Save security settings</button></div>
        <section class="sc-sec"><h3>Delete a contact's data <span class="s-muted">for a privacy request (DPDP, GDPR)</span></h3>
          <div class="sc-row"><label>Number<input [value]="delPhone()" (input)="delPhone.set($any($event.target).value); delPreview.set(null)" inputmode="tel" placeholder="10-digit mobile"></label>
            <button type="button" class="s-btn" (click)="preview()" [disabled]="!delPhone().trim()">See what would be deleted</button></div>
          @if (delPreview(); as p) {
            <span>{{ p.calls }} call{{ p.calls === 1 ? '' : 's' }} in {{ p.campaigns }} campaign{{ p.campaigns === 1 ? '' : 's' }}, {{ p.recordings }} recording{{ p.recordings === 1 ? '' : 's' }}, transcripts and answers.{{ p.on_dnc ? ' The number stays on the do-not-call list.' : '' }}</span>
            <div class="sc-row"><label style="flex: 1 1 260px">Why (request reference)<input [value]="delReason()" (input)="delReason.set($any($event.target).value)"></label>
              <button type="button" class="s-btn s-danger" (click)="del()" [disabled]="!delReason().trim() || busy()">Delete permanently</button></div>
          }
          @if (delNote()) { <span class="sc-ok" role="status">{{ delNote() }}</span> }
        </section>
      } @else { <p class="s-empty">{{ msg() || 'Loading security settings…' }}</p> }
    </div>
  `,
})
export class SecurityCenterComponent {
  readonly source = input.required<SecuritySource>();
  readonly page = input(false);
  protected readonly PROVIDERS: [string, string][] = [['okta', 'Okta'], ['azure', 'Microsoft Entra ID (Azure AD)'], ['google', 'Google Workspace'], ['onelogin', 'OneLogin'], ['other', 'Other']];
  protected readonly v = signal<SecurityView | null>(null); protected readonly d = signal<SecurityView | null>(null);
  protected readonly ssoTest = signal<{ ok: boolean; steps: { label: string; ok: boolean; detail: string }[] } | null>(null);
  protected readonly newToken = signal(''); protected readonly busy = signal(false); protected readonly msg = signal(''); protected readonly bad = signal(false);
  protected readonly delPhone = signal(''); protected readonly delReason = signal(''); protected readonly delNote = signal('');
  protected readonly delPreview = signal<{ phone: string; calls: number; recordings: number; campaigns: number; on_dnc: boolean } | null>(null);
  protected readonly dirty = computed(() => JSON.stringify(this.d()) !== JSON.stringify(this.v()));
  constructor() { effect(() => { const s = this.source(); untracked(() => this.load(s)); }); }
  private async load(s = this.source(), again = true): Promise<void> { try { const v = await s.load(); this.v.set(v); this.d.set(structuredClone(v)); } catch { if (again) setTimeout(() => this.load(s, false), 1200); else this.say('Could not load security settings.', true); } }
  private say(m: string, bad = false): void { this.msg.set(m); this.bad.set(bad); }
  protected set(part: Partial<SecurityView>): void { const d = this.d(); if (d) this.d.set({ ...d, ...part }); this.msg.set(''); }
  protected sso(part: Partial<SecurityView['sso']>): void { const d = this.d(); if (d) this.set({ sso: { ...d.sso, ...part } }); if (!('enforce' in part)) this.ssoTest.set(null); }
  protected ret(part: Partial<SecurityView['retention']>): void { const d = this.d(); if (d) this.set({ retention: { ...d.retention, ...part } }); }
  protected undo(): void { this.d.set(structuredClone(this.v())); }
  protected async test(): Promise<void> { this.busy.set(true); try { this.ssoTest.set(await this.source().testSso({ sso: this.d()!.sso })); } catch { this.say('Could not run the test.', true); } finally { this.busy.set(false); } }
  protected async save(): Promise<void> { this.busy.set(true); try { const v = await this.source().save(this.d()!); this.v.set(v); this.d.set(structuredClone(v)); this.say('Saved. The change is in the audit log.'); } catch { this.say('Could not save.', true); } finally { this.busy.set(false); } }
  protected async token(): Promise<void> { this.busy.set(true); try { const r = await this.source().scimToken(); this.newToken.set(r.token); const { token, ...v } = r; this.v.set(v); this.d.set({ ...structuredClone(v) }); } finally { this.busy.set(false); } }
  protected async preview(): Promise<void> { this.delNote.set(''); try { this.delPreview.set((await this.source().deleteContact({ phone: this.delPhone() })).preview); } catch (e) { this.say(errText(e, 'Could not look that up.'), true); } }
  protected async del(): Promise<void> {
    if (!confirm('Delete every call, recording, transcript and answer for this number? This cannot be undone.')) return;
    this.busy.set(true); try { const r = await this.source().deleteContact({ phone: this.delPhone(), confirm: true, reason: this.delReason() }); this.delNote.set(r.note || 'Deleted.'); this.delPreview.set(null); this.delPhone.set(''); this.delReason.set(''); }
    catch (e) { this.say(errText(e, 'Could not delete.'), true); } finally { this.busy.set(false); }
  }
}

// ── Audit log: every change and export, who did it and when; cannot be edited ──
export interface AuditEntry { at: string; who: string; area: string; action: string; target: string }
export interface AuditQuery { q: string; who: string; area: string; days: string }
export interface AuditSource { load(p: AuditQuery): Promise<{ rows: AuditEntry[]; total: number; people: string[]; areas: string[] }>; exportXlsx(p: AuditQuery): Promise<Blob> }
@Component({
  selector: 'app-audit-log',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [CSS + `
    .al { display: grid; gap: 12px; }
    .al-f { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .al-f select, .al-f input { border: 1px solid var(--s-line); border-radius: 8px; padding: 6px 10px; font: inherit; font-size: 13px; background: var(--s-bg); color: var(--s-text); min-width: 0; }
    .al-f input { flex: 1 1 220px; }
    .al-t { width: 100%; border-collapse: collapse; font-size: 13px; }
    .al-t th { text-align: left; font-weight: 500; font-size: 12px; color: var(--s-muted); padding: 6px 8px; border-bottom: 1px solid var(--s-line); }
    .al-t td { padding: 7px 8px; border-bottom: 1px solid var(--s-line); vertical-align: top; }
    .al-t td.w { white-space: nowrap; color: var(--s-muted); } .al-area { font-size: 11.5px; border: 1px solid var(--s-line); border-radius: 999px; padding: 1px 8px; white-space: nowrap; }
    .al-scroll { overflow-x: auto; }
  `],
  template: `
    <div class="al">
      <div class="s-head"><div><h2 class="s-title" role="heading" [attr.aria-level]="page() ? 1 : 2">Audit log</h2><p class="s-muted">Every change and every export in this workspace, with who did it. Entries cannot be edited or deleted.</p></div>
        <span class="s-grow"></span><button type="button" class="s-btn" (click)="exportList()">Export</button></div>
      <div class="al-f">
        <select (change)="days.set($any($event.target).value)" aria-label="Period">@for (p of PERIODS; track p[0]) { <option [value]="p[0]" [selected]="p[0] === days()">{{ p[1] }}</option> }</select>
        <select (change)="who.set($any($event.target).value)" aria-label="Who"><option value="all">Everyone</option>@for (p of people(); track p) { <option [value]="p">{{ p }}</option> }</select>
        <select (change)="area.set($any($event.target).value)" aria-label="Area"><option value="all">All areas</option>@for (a of areas(); track a) { <option [value]="a">{{ a }}</option> }</select>
        <input type="search" [value]="q()" (input)="setQ($any($event.target).value)" placeholder="Search what changed" aria-label="Search">
        <span class="s-muted">{{ total() }} entr{{ total() === 1 ? 'y' : 'ies' }}</span>
      </div>
      <div class="s-card al-scroll"><table class="al-t"><thead><tr><th>When</th><th>Who</th><th>Area</th><th>What</th><th>On</th></tr></thead><tbody>
        @for (e of rows(); track $index) { <tr><td class="w">{{ when(e.at) }}</td><td>{{ e.who }}</td><td><span class="al-area">{{ e.area }}</span></td><td>{{ e.action }}</td><td class="s-muted">{{ e.target }}</td></tr> }
        @empty { <tr><td colspan="5" class="s-muted">Nothing matches.</td></tr> }
      </tbody></table></div>
    </div>
  `,
})
export class AuditLogComponent {
  readonly source = input.required<AuditSource>();
  readonly page = input(false);
  protected readonly PERIODS: [string, string][] = [['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['0', 'All time']];
  protected readonly q = signal(''); protected readonly who = signal('all'); protected readonly area = signal('all'); protected readonly days = signal('30');
  protected readonly rows = signal<AuditEntry[]>([]); protected readonly total = signal(0); protected readonly people = signal<string[]>([]); protected readonly areas = signal<string[]>([]);
  private t: ReturnType<typeof setTimeout> | null = null;
  constructor() { effect(() => { this.who(); this.area(); this.days(); this.source(); untracked(() => this.load()); }); }
  private query(): AuditQuery { return { q: this.q().trim(), who: this.who(), area: this.area(), days: this.days() }; }
  private async load(again = true): Promise<void> {
    try { const r = await this.source().load(this.query()); this.rows.set(r.rows); this.total.set(r.total); this.people.set(r.people); this.areas.set(r.areas); }
    catch { if (again) setTimeout(() => this.load(false), 1200); }
  }
  protected setQ(v: string): void { this.q.set(v); if (this.t) clearTimeout(this.t); this.t = setTimeout(() => this.load(), 200); }
  protected when(iso: string): string { return new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
  protected async exportList(): Promise<void> { save(await this.source().exportXlsx(this.query()), 'audit-log.xlsx'); }
}
