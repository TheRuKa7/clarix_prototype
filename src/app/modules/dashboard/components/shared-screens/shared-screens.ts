import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { CallingReportComponent, CallingReportSource, CampaignColumns, ReportCallRow } from '../calling-report/calling-report.component';

/**
 * The screens Echo and Clarix share (plan phase 3): Campaigns, Campaign, New campaign and Follow ups. The Call logs page is
 * the calling report in log mode. Both apps use this same file, each with its own sources. Keep the two copies identical.
 */

export interface CampaignLine {
  campaign_id: string; campaign: string; agent: string; agent_key: string; uploaded_by: string; created_at: string | null; uploaded: number; planned: number; picked_up: number;
  answered: number; success: number; success_rate: number | null; not_finished: number; bad_data: number; status: 'Running' | 'Completed' | 'Stopped' | 'Failed';
  /** The agent's custom stats for this campaign: total in the sheet, covered on answered calls, accepted. */
  stats?: { field: string; label: string; total: number; covered: number; accepted: number }[];
  /** One campaign only: its sheet's columns and the agent's answers, for its table. */
  columns?: CampaignColumns;
}
export interface CampaignsSource {
  list(p: { from: string | null; to: string | null; state: string; q: string; skip: number; limit: number }): Promise<{ rows: CampaignLine[]; total: number; running: number }>;
  get(id: string): Promise<CampaignLine>;
  stop(id: string): Promise<{ stopped: number }>;
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
/** How a row that was not reached is called again: the gaps grow linearly, stay the same or double. */
export interface RetryRule { schedule: 'linear' | 'increasing' | 'doubling'; base_minutes: number; retries: number; from: string; to: string; skip_sunday: boolean; avoid_lunch: boolean }
export const RETRY_SCHEDULES: { key: RetryRule['schedule']; label: string; hint: string }[] = [
  { key: 'linear', label: 'Linear', hint: 'the same gap every time' }, { key: 'increasing', label: 'Linear increasing', hint: 'each gap one step longer' }, { key: 'doubling', label: 'Doubling', hint: 'each gap twice the last' }];
/** Minutes between retries, as the mock and the product work them out. */
export function retryGaps(r: RetryRule): number[] {
  const b = Math.max(1, Number(r.base_minutes) || 30); const n = Math.min(10, Math.max(0, Number(r.retries) || 0));
  return Array.from({ length: n }, (_, i) => (r.schedule === 'linear' ? b : r.schedule === 'doubling' ? b * 2 ** i : b * (i + 1)));
}
/** Retry times after a missed call at `start`, moved into calling hours (IST), skipping lunch and Sundays when set. */
export function retryTimes(r: RetryRule, start: number): number[] {
  const IST = 330 * 60000; const hm = (x: string) => { const [h, m] = x.split(':').map(Number); return h * 60 + (m || 0); }; const open = hm(r.from || '10:00'), close = hm(r.to || '18:00');
  const fit = (ms: number) => {
    for (let g = 0; g < 14; g += 1) {
      const l = new Date(ms + IST); const mins = l.getUTCHours() * 60 + l.getUTCMinutes(); const day = ms - mins * 60000 - l.getUTCSeconds() * 1000 - l.getUTCMilliseconds();
      if (r.skip_sunday && l.getUTCDay() === 0) ms = day + 86400000 + open * 60000; else if (mins < open) ms = day + open * 60000; else if (mins >= close) ms = day + 86400000 + open * 60000;
      else if (r.avoid_lunch && mins >= 780 && mins < 840) ms = day + 840 * 60000; else return ms;
    }
    return ms;
  };
  let t = start; return retryGaps(r).map((g) => (t = fit(t + g * 60000)));
}
export interface NewCampaignSource {
  agents(): Promise<{ key: string; label: string; inputs: string[] }[]>;
  template(agent: string): Promise<Blob>;
  check(agent: string, file: File): Promise<{ file: string; rows: number; will_dial: number; calls: number; bad: { row: number; reason: string }[]; tests: number; matched: string[]; missing: string[];
    fixed?: { row: number; notes: string[] }[]; warnings?: { row: number; notes: string[] }[]; note?: UploadNote }>;
  /** Tips for the agent's template, shown when it is picked. */
  tips?(agent: string): Promise<UploadNote>;
  /** Each agent's retry rule, and saving one. */
  retryRules?(): Promise<{ agents: { agent: string; label: string; rule: RetryRule }[] }>;
  saveRetryRule?(agent: string, rule: RetryRule): Promise<unknown>;
  start(agent: string, file: File): Promise<{ campaign_id: string; dialled: number }>;
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
  .s { display: grid; gap: 12px; }
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
  .s-check { width: 16px; height: 16px; cursor: pointer; }
  tr.done td { color: var(--s-muted); }
  tr.done .s-task { text-decoration: line-through; }
  .s-task { font-weight: 500; white-space: normal; min-width: 220px; }
  td.s-wrap { white-space: normal; min-width: 260px; max-width: 420px; color: var(--s-muted); font-size: 12.5px; }
  .s-actions .s-btn { padding: 4px 10px; font-size: 12.5px; }
`;
const STATUS_COLOR: Record<string, string> = { Running: '#d97706', Completed: '#16a34a', Stopped: '#a8a29e', Failed: '#dc2626' };
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
          <table>
            <thead><tr><th>Campaign</th><th>Agent</th><th>Status</th><th class="num">Uploaded</th><th class="num">Planned</th><th class="num">Picked up</th><th class="num">Answered</th><th class="num">Success rate</th><th>Coverage</th><th></th></tr></thead>
            <tbody>
              @for (c of rows(); track c.campaign_id) {
                <tr class="click" (click)="source().open(c)" tabindex="0" (keydown.enter)="source().open(c)">
                  <td class="cut" [title]="c.campaign">{{ c.campaign }}<small>{{ c.uploaded_by || '—' }} · {{ when(c.created_at) }}</small></td>
                  <td class="cut" [title]="c.agent">{{ c.agent }}</td>
                  <td><span class="s-chip" [style.--c]="color(c.status)"><i></i>{{ c.status }}</span></td>
                  <td class="num">{{ c.uploaded }}</td><td class="num">{{ c.planned }}</td><td class="num">{{ c.picked_up }}</td><td class="num">{{ c.answered }}</td><td class="num">{{ pct(c.success_rate) }}</td>
                  <td>@for (st of c.stats ?? []; track st.field) { <div class="s-cov" [title]="st.label + ': ' + st.covered + ' of ' + st.total + ' on answered calls, ' + st.accepted + ' accepted'">{{ st.label }} <b>{{ st.covered }}/{{ st.total }}</b> <small>{{ st.accepted }} accepted</small></div> } @empty { <span class="s-muted">—</span> }</td>
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
    .nc-note { border: 1px solid color-mix(in srgb, var(--s-accent) 35%, var(--s-line)); background: color-mix(in srgb, var(--s-accent) 5%, var(--s-bg)); border-radius: 10px; padding: 10px 14px; display: grid; gap: 6px; font-size: 13px; }
    .nc-note ul { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
    .nc-note small { color: var(--s-muted); }
    .nc-note-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .nc-ai { font-size: 11px; font-weight: 600; letter-spacing: .04em; color: var(--s-accent); border: 1px solid currentColor; border-radius: 999px; padding: 0 7px; }
    .nc-fixed { max-height: 160px; overflow: auto; font-size: 12.5px; display: grid; gap: 4px; color: var(--s-good); }
    .nc-warn { max-height: 120px; overflow: auto; font-size: 12.5px; display: grid; gap: 4px; color: #a16207; }
    .nc-retry { border: 1px solid var(--s-line); border-radius: 10px; padding: 12px 14px; display: grid; gap: 10px; font-size: 13px; }
    .nc-retry-row { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
    .nc-retry input[type=number] { width: 72px; } .nc-retry input[type=number], .nc-retry input[type=time] { border: 1px solid var(--s-line); border-radius: 6px; padding: 4px 6px; font: inherit; background: var(--s-bg); color: var(--s-text); }
    .nc-retry label { display: inline-flex; gap: 6px; align-items: center; }
    .nc-times { display: flex; flex-wrap: wrap; gap: 6px; }
    .nc-times span { background: var(--s-soft); border-radius: 6px; padding: 3px 8px; font-size: 12.5px; }
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
            @if (k.missing.length) { <p class="s-note">Columns not found in the file: {{ k.missing.join(', ') }}. Rows that need them will fail the check.</p> }
            @if (k.fixed?.length) { <b class="s-muted">Fixed for you ({{ k.fixed!.length }} row{{ k.fixed!.length === 1 ? '' : 's' }}): these will be called</b><div class="nc-fixed">@for (f of k.fixed!; track f.row) { <span>Row {{ f.row }}: {{ f.notes.join('; ') }}</span> }</div> }
            @if (k.warnings?.length) { <b class="s-muted">Check these ({{ k.warnings!.length }}): they will still be called</b><div class="nc-warn">@for (w of k.warnings!; track w.row) { <span>Row {{ w.row }}: {{ w.notes.join('; ') }}</span> }</div> }
            @if (k.bad.length) { <b class="s-muted">Not called ({{ k.bad.length }})</b><div class="nc-bad">@for (b of k.bad; track b.row) { <span>Row {{ b.row }}: {{ b.reason }}</span> }</div> }
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
            <button type="button" class="s-btn s-primary" [disabled]="!check()?.will_dial" (click)="step.set(3)">Next</button>
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
                <label><input type="checkbox" [checked]="ru.avoid_lunch" (change)="setRule({ avoid_lunch: $any($event.target).checked })"> Not 1–2 pm</label>
              </div>
              <span class="s-muted">Gaps: {{ gapsText() }} minutes. Missed at 10:00 today, it is called again at:</span>
              <div class="nc-times">@for (t of example(); track $index) { <span>{{ t }}</span> } @empty { <span>No retries</span> }</div>
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
  protected readonly noteSent = signal(false);
  protected readonly SCHEDULES = RETRY_SCHEDULES;
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
      this.tips.set(null); this.pickRule(); if (!a) return;
      this.source().tips?.(a).then((t) => { if (this.agent() === a) this.tips.set(t); }).catch(() => {});
      // The rules may not have loaded with the page (first visit after an update): ask again.
      if (!this.rules.length) this.source().retryRules?.().then((r) => { this.rules = r.agents; this.pickRule(); }).catch(() => {});
    }); });
  }
  private pickRule(): void { const a = this.agent(); const r = this.rules.find((x) => x.agent === a)?.rule; this.rule.set(a && r ? { ...r } : null); }
  protected setRule(part: Partial<RetryRule>): void { const r = this.rule(); if (r) this.rule.set({ ...r, ...part }); }
  protected async template(): Promise<void> { save(await this.source().template(this.agent()), `${this.agentLabel().replace(/[^A-Za-z0-9]+/g, '_')}_template.xlsx`); }
  protected async pick(f: File | undefined): Promise<void> {
    this.file.set(f ?? null); this.check.set(null); this.error.set(''); this.noteSent.set(false); if (!f) return;
    try { this.check.set(await this.source().check(this.agent(), f)); } catch (e) { this.error.set(e instanceof Error ? e.message : 'Could not read that file.'); }
  }
  protected async start(): Promise<void> {
    const f = this.file(); if (!f) return; this.busy.set(true);
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
          <table>
            <thead><tr><th></th><th>Action task</th><th>Summary</th><th>Owner</th><th>Caller</th><th>Last call</th></tr></thead>
            <tbody>
              @for (r of rows(); track r.id) {
                <tr class="click" [class.done]="r.follow.state === 'done'" (click)="source().openCall(r)" [title]="'Open the call with ' + (r.caller_name || r.phone)">
                  <td (click)="$event.stopPropagation()"><input type="checkbox" class="s-check" [checked]="r.follow.state === 'done'" (change)="toggle(r)" [attr.aria-label]="'Done: ' + r.task"></td>
                  <td class="s-task">{{ r.task }}<small>{{ r.kind }}@if (r.follow.state === 'done' && r.follow.by) { · done by {{ r.follow.by }} }</small></td>
                  <td class="s-wrap">{{ r.summary || r.status_reason }}</td>
                  <td>{{ r.owner }}</td>
                  <td>{{ r.caller_name || '—' }}<small>{{ r.phone }}{{ r.email ? ' · ' + r.email : '' }}</small><small>{{ r.agent }} · {{ r.campaign }}</small></td>
                  <td>{{ when(r.call_date) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (!rows().length) { <p class="s-empty">{{ show() === 'open' ? 'Nothing to do here.' : 'Nothing done yet.' }}</p> }
      </div>
    </div>
  `,
})
export class FollowUpsListComponent {
  readonly source = input.required<FollowUpsSource>();
  protected readonly kind = signal('all');
  protected readonly show = signal('open');
  protected readonly rows = signal<FollowRow[]>([]);
  protected readonly counts = signal({ open: 0, callback: 0, follow_up: 0, done: 0 });
  protected readonly when = when;
  constructor() { effect(() => { this.kind(); this.show(); untracked(() => this.load()); }); }
  private async load(): Promise<void> { const r = await this.source().list(this.show(), this.kind()); this.rows.set(r.rows); this.counts.set(r.counts); }
  protected async toggle(r: FollowRow): Promise<void> { await this.source().act(r.id, r.follow.state === 'done' ? 'open' : 'done'); this.load(); }
  protected async exportList(): Promise<void> { save(await this.source().exportXlsx(this.show(), this.kind()), `follow-ups-${this.kind()}-${this.show()}.xlsx`); }
}
