import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

/**
 * The calling report (Calling-Report-Logic.md v1): headline cards, the four funnel boxes, by agent and the success
 * field, with the filters that scope all of it. Every number opens the calls behind it. Echo and Clarix use this same
 * file; each passes its own CallingReportSource. Keep the two copies identical.
 *
 * Periods are calendar days in the workspace time zone. The filters and the open list live in the address, so Back,
 * reload and a shared link all show the same report.
 */

export type PeriodKey = 'all' | 'today' | 'yesterday' | '7d' | '30d' | 'custom';
/** from and to are ISO instants; days is the span, for pages that still think in days. */
export interface ReportScope { period: PeriodKey; from: string; to: string; days: number; agents: string[]; includeTests: boolean; campaign?: string; unit?: string; }
export interface ReportLineView { key: string; label: string; count: number; share: number | null; strong?: boolean; sub?: boolean; good?: boolean; }
export interface ReportBox { key: string; step: number; label: string; total: number; lines: ReportLineView[]; }
export interface ByAgentRow { agent: string; agent_key: string; planned: number; picked_up: number; answered: number; success: number; success_rate: number | null; avg_talk_seconds: number | null; }
export interface TrendBucket { key: string; label: string; partial: boolean; planned: number; picked_up: number; answered: number; success: number; picked_up_share: number | null; answered_share: number | null; success_rate: number | null; }
type Rate = number | null;
export interface CallingReport {
  generated_at: string; time_zone: string; definitions_version: string; workspace: string; from: string | null; to: string | null; tests_included: boolean;
  headline: { uploaded: number; campaigns: number; planned: number; picked_up: number; answered: number; success: number; planned_share: Rate; picked_up_share: Rate; answered_share: Rate; success_rate: Rate; finished: number; not_finished: number };
  stats: { dials: number; avg_talk_seconds: number; total_talk_seconds: number; in_progress: number };
  funnel: ReportBox[]; by_agent: ByAgentRow[]; success_field: { yes: number; no: number; na: number };
  sum_check: { ok: boolean; gaps: { box: string; expected: number; got: number }[] };
  /** Agents with planned calls in the period (any agent filter ignored), with that count. */
  agents: { key: string; label: string; count: number }[];
  /** The per-agent stat the funnel is counted in ('' = calls), and the stats on offer. */
  unit?: string; units_available?: { field: string; label: string }[];
  /** Weekly (or daily, for two weeks or less) success, logic doc section 7. */
  trend: { unit: 'week' | 'day'; buckets: TrendBucket[] };
  /** The period just before this one, the same length: for the change shown on each rate. */
  previous?: { from: string; to: string; planned: number; picked_up: number; answered: number; success: number; picked_up_share: Rate; answered_share: Rate; success_rate: Rate };
}
export interface ReportCallRow {
  id: string; call_id: string | null; campaign_id: string; primary_id?: string; call_date: string | null; agent: string; campaign: string; caller_name: string; phone: string;
  call_status: string; status_reason: string; goal_reached: string; duration_seconds: number | null; callback_at: string | null; uploaded_by: string; summary?: string; retries?: number;
}
/** The call log's search box and per-column "contains" filters; the export uses the same. */
export interface LogFilters { q: string; cols: Record<string, string | string[]> }
export interface CallingReportSource {
  report(scope: ReportScope): Promise<CallingReport>;
  calls(scope: ReportScope, box: string, skip: number, limit: number, filters?: LogFilters): Promise<{ rows: ReportCallRow[]; total: number }>;
  exportXlsx(scope: ReportScope, box: string, filters?: LogFilters): Promise<Blob>;
  /** Opens the call page for a row (phase 2 makes this the one call page everywhere). */
  openCall(row: ReportCallRow): void;
  /** Opens the full Call logs page, where the product has one. */
  openCallLogs?(scope: ReportScope, box: string): void;
  /** The workspace's internal test numbers: calls to them count only as Internal test calls. */
  testNumbers?(): Promise<string[]>;
  /** Distinct values of one call log column, for the multi-select filter. */
  values?(scope: ReportScope, box: string, filters: LogFilters, column: string): Promise<{ value: string; count: number }[]>;
  /** Open follow ups and work still running, for the small box on the dashboard. */
  tasks?(scope: ReportScope): Promise<{ follow_ups: number; callbacks: number; follow_up_required: number; running_campaigns: number; not_finished: number }>;
  openCampaigns?(): void;
  /** Each agent's custom stats (POs, items…): what to count the funnel and campaigns in. */
  agentStats?(): Promise<{ agent: string; label: string; fields: { field: string; label: string }[]; stats: { field: string; label: string }[] }[]>;
  saveAgentStats?(agent: string, stats: { field: string; label: string }[]): Promise<unknown>;
  /** Opens the Follow ups page, where the product has one. */
  openFollowUps?(): void;
  saveTestNumbers?(numbers: string[]): Promise<string[]>;
}

const PERIODS: { key: PeriodKey; label: string }[] = [{ key: 'all', label: 'All time' }, { key: 'today', label: 'Today' }, { key: 'yesterday', label: 'Yesterday' }, { key: '7d', label: 'Last 7 days' }, { key: '30d', label: 'Last 30 days' }, { key: 'custom', label: 'Custom' }];
/** Names for boxes that are not a funnel line, so an open list can be restored from the address. */
const BOX_LABELS: Record<string, string> = { uploaded: 'Uploaded', planned: 'Planned', picked_up: 'Picked up', answered: 'Answered', success: 'Success', in_progress: 'Not finished',
  goal_yes: 'Goal reached: Yes', goal_no: 'Goal reached: No', goal_na: 'Goal reached: N/A' };
const PAGE = 10;
/** The call log's columns, in order: key, header. */
/** Columns filtered by picking values (several at once); the rest by typing. */
const PICK_COLUMNS = new Set(['agent', 'campaign', 'call_status', 'status_reason', 'goal_reached', 'retries']);
const LOG_COLUMNS: [string, string][] = [['call_date', 'Call date'], ['agent', 'Agent'], ['campaign', 'Campaign'], ['caller_name', 'Caller'], ['phone', 'Phone'], ['summary', 'Call summary'],
  ['call_status', 'Call status'], ['status_reason', 'Status reason'], ['callback_at', 'Call back'], ['duration_seconds', 'Duration'], ['retries', 'Retries'], ['goal_reached', 'Goal']];
const COLORS = { success: '#16a34a', not_successful: '#dc2626', no_conversation: '#7c3aed', not_picked_up: '#d97706', in_progress: '#a8a29e', not_planned: '#d6d3d1' };

@Component({
  selector: 'app-calling-report',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:click)': 'onDocClick($event)', '(document:keydown.escape)': 'onEscape()' },
  template: `
    <section class="cr" [class.cr-busy]="loading()">
      <div class="cr-top">
        <div class="cr-seg" role="group" aria-label="Period">
          @for (p of PERIODS; track p.key) { <button type="button" [class.on]="period() === p.key" (click)="setPeriod(p.key)">{{ p.label }}</button> }
        </div>
        @if (period() === 'custom') {
          <span class="cr-range">
            <input type="date" aria-label="From" [value]="customFrom()" [max]="customTo()" (change)="setCustom($any($event.target).value, customTo())">
            <span>to</span>
            <input type="date" aria-label="To" [value]="customTo()" [min]="customFrom()" [max]="today()" (change)="setCustom(customFrom(), $any($event.target).value)">
          </span>
        }
        @if (agents().length || period() !== '30d') { <button type="button" class="cr-link" (click)="clearAll()">Reset period</button> }
        @if (mode() === 'dashboard' && (r()?.units_available?.length || 0) > 0) {
          <div class="cr-seg" role="group" aria-label="Count by">
            <button type="button" [class.on]="!unit()" (click)="setUnit('')">Calls</button>
            @for (u of r()?.units_available ?? []; track u.field) { <button type="button" [class.on]="unit() === u.field" (click)="setUnit(u.field)">{{ u.label }}</button> }
          </div>
        }
        @if (mode() === 'dashboard' && source().agentStats) {
          <div class="cr-drop">
            <button type="button" class="cr-link" (click)="openStats()">Custom stats</button>
            @if (statsOpen()) {
              <div class="cr-menu cr-stats-menu" role="dialog" aria-label="Custom stats per agent">
                <b>Custom stats per agent</b>
                <p class="cr-muted">Count the funnel and campaigns in what each agent's upload carries, as well as calls.</p>
                @for (a of statsDraft(); track a.agent) {
                  <div class="cr-stat-agent"><span>{{ a.label }}</span>
                    @for (f of a.fields; track f.field) { <label class="cr-opt"><input type="checkbox" [checked]="isStat(a, f.field)" (change)="toggleStat(a, f)"> {{ f.label }} <small>{{ f.field }}</small></label> }
                    @empty { <small class="cr-muted">No number columns in this agent's upload.</small> }
                  </div>
                }
                <div class="cr-tests-foot"><span class="cr-grow"></span><button type="button" class="cr-btn" (click)="statsOpen.set(false)">Cancel</button><button type="button" class="cr-btn cr-primary" (click)="saveStats()">Save</button></div>
              </div>
            }
          </div>
        }
        <span class="cr-grow"></span>
        <span class="cr-meta">{{ periodLabel() }} · {{ tzLabel() }}</span>
        <div class="cr-drop">
          <button type="button" class="cr-btn" (click)="shareOpen.set(!shareOpen())" [disabled]="!r()" [attr.aria-expanded]="shareOpen()">Share ▾</button>
          @if (shareOpen()) {
            <div class="cr-menu cr-right" role="menu">
              <button type="button" role="menuitem" (click)="sharePicture()">Picture (.png)</button>
              <button type="button" role="menuitem" (click)="sharePdf()">PDF</button>
              <button type="button" role="menuitem" (click)="shareSheet()">Excel (every call)</button>
            </div>
          }
        </div>
      </div>

      @if (error()) { <p class="cr-note bad" role="alert">{{ error() }} <button type="button" class="cr-link" (click)="load()">Try again</button></p> }

      @if (r(); as rep) {
        @if (mode() === 'dashboard' && tasks(); as t) {
          <div class="cr-tasks" role="list" aria-label="Follow ups and active tasks">
            <button type="button" role="listitem" (click)="source().openFollowUps?.()"><b>{{ num(t.follow_ups) }}</b> follow ups open <small>{{ t.callbacks }} callbacks · {{ t.follow_up_required }} follow-up required</small></button>
            <button type="button" role="listitem" (click)="source().openCampaigns?.()"><b>{{ num(t.running_campaigns) }}</b> campaign{{ t.running_campaigns === 1 ? '' : 's' }} running</button>
            <button type="button" role="listitem" (click)="open('in_progress', 'Not finished')"><b>{{ num(t.not_finished) }}</b> calls not finished</button>
          </div>
        }
        @if (mode() === 'dashboard') {
        <!-- The funnel, one row: each step's count and its share of the step before. Click a step to see its calls below. -->
        <div class="cr-card">
          <div class="cr-funnel" role="list" aria-label="Funnel">
            @for (s of steps(); track s.key; let last = $last) {
              <button type="button" role="listitem" class="cr-step" [class.on]="box()?.key === s.key" [class.good]="s.key === 'success'" (click)="open(s.key, s.label)">
                <span>{{ s.label }}</span><b>{{ num(s.count) }}</b><small>{{ s.note }}</small>
              </button>
              @if (!last) { <i class="cr-arrow" aria-hidden="true">›</i> }
            }
          </div>

          <!-- Call status: every planned row by how its call ended. Click a status to see its calls below. -->
          <div class="cr-status-head"><span>Call status{{ unitName() ? ' · counted in ' + unitName() : '' }}</span><span class="cr-muted">{{ num(rep.headline.planned) }} {{ unitName() ? unitName() + ' planned' : 'planned' }} · {{ num(rep.stats.dials) }} dials · avg talk {{ mmss(rep.stats.avg_talk_seconds) }}</span></div>
          <div class="cr-bar" role="img" [attr.aria-label]="'Call status of ' + rep.headline.planned + ' planned calls'">
            @for (g of groups(); track g.key) { @if (g.count) { <span [style.width.%]="g.width" [style.background]="g.color" [title]="g.label + ': ' + g.count + ' (' + pct(g.width / 100) + ' of planned)'"></span> } }
          </div>
          <div class="cr-groups">
            @for (g of groups(); track g.key) {
              @if (g.count || g.always) {
                <div class="cr-group">
                  <button type="button" class="cr-ghead" [class.on]="box()?.key === g.key" (click)="open(g.key, g.label)"><i [style.background]="g.color"></i>{{ g.label }} <b>{{ num(g.count) }}</b><small>{{ pct(g.share) }}</small></button>
                  @for (l of g.lines; track l.key) {
                    <button type="button" class="cr-chip" [class.on]="box()?.key === l.key" [class.zero]="!l.count" (click)="open(l.key, l.label)">{{ l.label }} <b>{{ num(l.count) }}</b><small>{{ pct(l.share) }}</small></button>
                  }
                </div>
              }
            }
          </div>
          @if (!rep.sum_check.ok) { <p class="cr-note bad">Counts do not match: @for (g of rep.sum_check.gaps; track g.box) { {{ g.box }} is {{ g.expected }}, its parts add to {{ g.got }}. } </p> }
        </div>
        }

        <!-- The call log: every row, newest first, or only the step or status picked above. A row opens its call. -->
        <div class="cr-card cr-log">
          <div class="cr-log-head">
            <b>Calls</b>
            @if (box(); as bx) { <span class="cr-fchip">{{ bx.label }}<button type="button" (click)="close()" aria-label="Show every call">✕</button></span> }
            <span class="cr-muted">{{ num(drillTotal()) }} call{{ drillTotal() === 1 ? '' : 's' }}</span>
            <input class="cr-search" type="search" placeholder="Search every column" [value]="search()" (input)="setSearch($any($event.target).value)" aria-label="Search calls">
            @if (logFiltered()) { <button type="button" class="cr-link" (click)="clearLogFilters()">Clear column filters</button> }
            <span class="cr-grow"></span>
            @if (source().openCallLogs && mode() === 'dashboard') { <button type="button" class="cr-link" (click)="source().openCallLogs!(scope(), box()?.key ?? 'uploaded')">Open in Call logs</button> }
            <button type="button" class="cr-btn" (click)="exportBox()" [title]="'Export the ' + drillTotal() + ' calls shown, with these filters'">Export</button>
          </div>
          <div class="cr-scroll">
            <table class="cr-table">
              <thead>
                <tr>@for (col of LOG_COLUMNS; track col[0]) { <th>{{ col[1] }}</th> }</tr>
                <tr class="cr-frow">@for (col of LOG_COLUMNS; track col[0]) {
                  <th>@if (PICK_COLUMNS.has(col[0])) {
                    <div class="cr-drop">
                      <button type="button" class="cr-pick" [class.on]="picked(col[0]).length" (click)="openPick(col[0])">{{ picked(col[0]).length ? picked(col[0]).length + ' selected' : 'All' }} ▾</button>
                      @if (pickOpen() === col[0]) {
                        <div class="cr-menu cr-pick-menu" role="listbox" [attr.aria-label]="'Filter ' + col[1]">
                          <label class="cr-opt"><input type="checkbox" [checked]="!picked(col[0]).length" (change)="setPicked(col[0], [])"> All</label>
                          @for (v of pickValues(); track v.value) { <label class="cr-opt"><input type="checkbox" [checked]="picked(col[0]).includes(v.value)" (change)="togglePicked(col[0], v.value)"> <span class="cr-opt-l">{{ v.value || '(blank)' }}</span><small>{{ v.count }}</small></label> }
                        </div>
                      }
                    </div>
                  } @else { <input type="text" [value]="textFilter(col[0])" (input)="setCol(col[0], $any($event.target).value)" [attr.aria-label]="'Filter ' + col[1]" placeholder="Filter"> }</th>
                }</tr>
              </thead>
              @if (drillRows().length) {
                <tbody>
                  @for (c of drillRows(); track c.id) {
                    <tr tabindex="0" (click)="source().openCall(c)" (keydown.enter)="source().openCall(c)" [title]="'Open the call with ' + (c.caller_name || c.phone)">
                      <td class="nw">{{ c.call_date ? when(c.call_date) : '—' }}</td><td class="cut" [title]="c.agent">{{ c.agent }}</td><td class="cut" [title]="c.campaign">{{ c.campaign }}</td><td>{{ c.caller_name || '—' }}</td><td class="nw">{{ c.phone || '—' }}</td>
                      <td class="cut wide" [title]="c.summary || ''">{{ c.summary || '—' }}</td><td><span class="cr-st" [style.--c]="colorOf(c)">{{ c.call_status }}</span></td><td class="cut" [title]="c.status_reason">{{ c.status_reason }}</td>
                      <td class="nw">{{ c.callback_at || '—' }}</td><td class="nw">{{ mmss(c.duration_seconds) }}</td><td>{{ c.retries ?? 0 }}</td><td>{{ c.goal_reached }}</td>
                    </tr>
                  }
                </tbody>
              }
            </table>
          </div>
          @if (drillRows().length) {
            <div class="cr-pager">
              <button type="button" class="cr-btn" [disabled]="drillPage() === 0" (click)="page(-1)">Newer</button>
              <span>{{ drillPage() * PAGE + 1 }}–{{ drillPage() * PAGE + drillRows().length }} of {{ num(drillTotal()) }}</span>
              <button type="button" class="cr-btn" [disabled]="(drillPage() + 1) * PAGE >= drillTotal()" (click)="page(1)">Older</button>
            </div>
          } @else { <p class="cr-empty cr-pad">{{ logFiltered() ? 'No calls match these filters.' : 'No calls here in this period.' }}</p> }
        </div>
      } @else if (!error()) { <p class="cr-empty">Loading…</p> }
    </section>
  `,
  styles: [`
    :host { display: block; --cr-text: var(--ds-text, var(--text, #0c0a09)); --cr-muted: var(--ds-text-muted, var(--muted, #5c5752)); --cr-line: var(--ds-border, var(--line, #e7e5e2));
      --cr-bg: var(--ds-surface, var(--card, #fff)); --cr-soft: var(--ds-surface-sunken, var(--bg-2, #f5f5f4)); --cr-good: var(--ds-success-fg, #146c34); --cr-good-bg: var(--ds-success-bg, #ecfdf3);
      --cr-bad: var(--ds-danger-fg, #b91c1c); --cr-accent: var(--ds-accent, var(--accent, #4c4184)); }
    .cr { display: grid; gap: 12px; color: var(--cr-text); }
    .cr-busy { opacity: .7; transition: opacity .2s; }
    .cr-top { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .cr-grow { flex: 1; }
    .cr-meta, .cr-muted { color: var(--cr-muted); font-size: 12.5px; }
    .cr-seg { display: inline-flex; border: 1px solid var(--cr-line); border-radius: 8px; overflow: hidden; }
    .cr-seg button { border: 0; background: var(--cr-bg); color: var(--cr-text); padding: 6px 11px; font: inherit; font-size: 13px; cursor: pointer; }
    .cr-seg button.on { background: var(--cr-text); color: var(--cr-bg); }
    .cr-btn { border: 1px solid var(--cr-line); background: var(--cr-bg); color: var(--cr-text); border-radius: 8px; padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer; }
    .cr-btn.on { border-color: var(--cr-accent); color: var(--cr-accent); }
    .cr-btn:disabled { opacity: .5; cursor: default; }
    .cr-link { border: 0; background: none; text-decoration: underline; color: var(--cr-muted); cursor: pointer; font: inherit; font-size: 13px; padding: 0; }
    .cr-range { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; color: var(--cr-muted); }
    .cr-range input { border: 1px solid var(--cr-line); border-radius: 8px; padding: 5px 8px; font: inherit; font-size: 13px; background: var(--cr-bg); color: var(--cr-text); }
    .cr-drop { position: relative; }
    .cr-menu { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; min-width: 240px; background: var(--cr-bg); border: 1px solid var(--cr-line); border-radius: 10px; padding: 6px; display: grid; box-shadow: 0 8px 24px -12px rgba(0,0,0,.25); }
    .cr-menu.cr-right { left: auto; right: 0; }
    .cr-menu button, .cr-opt { border: 0; background: none; text-align: left; padding: 7px 8px; border-radius: 6px; font: inherit; font-size: 13px; color: var(--cr-text); cursor: pointer; display: flex; gap: 8px; align-items: center; }
    .cr-menu button:hover, .cr-opt:hover { background: var(--cr-soft); }
    .cr-opt-l { flex: 1; }
    .cr-opt small { color: var(--cr-muted); }
    .cr-pad { padding: 8px; }
    .cr-card { border: 1px solid var(--cr-line); border-radius: 12px; background: var(--cr-bg); padding: 14px 16px; display: grid; gap: 10px; }
    .cr-funnel { display: flex; align-items: stretch; gap: 4px; }
    .cr-step { flex: 1; text-align: left; border: 1px solid transparent; border-radius: 10px; background: none; padding: 6px 10px; display: grid; gap: 1px; cursor: pointer; font: inherit; color: inherit; }
    .cr-step:hover { background: var(--cr-soft); }
    .cr-step.on { border-color: var(--cr-accent); }
    .cr-step span { font-size: 12.5px; color: var(--cr-muted); }
    .cr-step b { font-size: 26px; line-height: 1.15; font-variant-numeric: tabular-nums; }
    .cr-step small { font-size: 12px; color: var(--cr-muted); }
    .cr-step.good { background: var(--cr-good-bg); }
    .cr-step.good b, .cr-step.good small { color: var(--cr-good); }
    .cr-arrow { align-self: center; font-style: normal; color: var(--cr-muted); font-size: 20px; }
    .cr-status-head { display: flex; justify-content: space-between; align-items: baseline; border-top: 1px solid var(--cr-line); padding-top: 10px; }
    .cr-status-head > span:first-child { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--cr-muted); font-weight: 600; }
    .cr-bar { display: flex; height: 12px; border-radius: 999px; overflow: hidden; background: var(--cr-soft); }
    .cr-bar span { height: 100%; }
    .cr-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 6px 14px; }
    .cr-group { display: flex; flex-direction: column; gap: 2px; }
    .cr-ghead, .cr-chip { display: flex; align-items: center; gap: 6px; border: 1px solid transparent; background: none; border-radius: 6px; padding: 3px 6px; font: inherit; font-size: 13px; color: var(--cr-text); cursor: pointer; text-align: left; }
    .cr-ghead { font-weight: 600; }
    .cr-ghead i { width: 9px; height: 9px; border-radius: 2px; flex: none; }
    .cr-chip { padding-left: 21px; }
    .cr-ghead b, .cr-chip b { margin-left: auto; font-variant-numeric: tabular-nums; }
    .cr-ghead small, .cr-chip small { color: var(--cr-muted); font-weight: 400; width: 36px; text-align: right; font-size: 12px; }
    .cr-ghead:hover, .cr-chip:hover { background: var(--cr-soft); }
    .cr-ghead.on, .cr-chip.on { border-color: var(--cr-accent); }
    .cr-chip.zero { color: var(--cr-muted); }
    .cr-log { padding: 12px 0 8px; gap: 8px; }
    .cr-log-head { display: flex; align-items: center; gap: 10px; padding: 0 16px; }
    .cr-fchip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 10px; border-radius: 999px; background: var(--cr-soft); border: 1px solid var(--cr-line); font-size: 12.5px; }
    .cr-fchip button { border: 0; background: none; color: var(--cr-muted); cursor: pointer; width: 20px; height: 20px; border-radius: 50%; font-size: 11px; }
    .cr-scroll { overflow-x: auto; }
    .cr-search { border: 1px solid var(--cr-line); border-radius: 8px; padding: 5px 10px; font: inherit; font-size: 13px; background: var(--cr-bg); color: var(--cr-text); width: 220px; }
    .cr-frow th { background: var(--cr-bg); padding: 4px 6px; }
    .cr-pick { width: 100%; min-width: 72px; text-align: left; border: 1px solid var(--cr-line); border-radius: 6px; padding: 3px 6px; font: inherit; font-size: 12px; background: var(--cr-bg); color: var(--cr-muted); cursor: pointer; white-space: nowrap; }
    .cr-pick.on { border-color: var(--cr-accent); color: var(--cr-accent); }
    .cr-pick-menu { max-height: 280px; overflow: auto; font-weight: 400; }
    .cr-stats-menu { width: 340px; gap: 8px; padding: 12px; max-height: 420px; overflow: auto; }
    .cr-stat-agent { display: grid; gap: 2px; border-top: 1px solid var(--cr-line); padding-top: 6px; }
    .cr-stat-agent > span { font-weight: 600; font-size: 13px; }
    .cr-tests-foot { display: flex; gap: 8px; }
    .cr-primary { background: var(--cr-text); color: var(--cr-bg); border-color: var(--cr-text); }
    .cr-tasks { display: flex; gap: 8px; flex-wrap: wrap; }
    .cr-tasks button { display: flex; align-items: baseline; gap: 6px; border: 1px solid var(--cr-line); border-radius: 10px; background: var(--cr-bg); padding: 7px 12px; font: inherit; font-size: 13px; color: var(--cr-text); cursor: pointer; }
    .cr-tasks button:hover { background: var(--cr-soft); }
    .cr-tasks b { font-size: 16px; }
    .cr-tasks small { color: var(--cr-muted); font-size: 12px; }
    .cr-frow input { width: 100%; min-width: 64px; box-sizing: border-box; border: 1px solid var(--cr-line); border-radius: 6px; padding: 3px 6px; font: inherit; font-size: 12px; background: var(--cr-bg); color: var(--cr-text); }
    .cr-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    .cr-table th { text-align: left; font-weight: 500; color: var(--cr-muted); background: var(--cr-soft); padding: 7px 10px; white-space: nowrap; }
    .cr-table td { padding: 7px 10px; border-top: 1px solid var(--cr-line); white-space: nowrap; }
    .cr-table tbody tr { cursor: pointer; }
    .cr-table tbody tr:hover { background: var(--cr-soft); }
    .cr-table .nw { white-space: nowrap; }
    .cr-table .cut { max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cr-table .cut.wide { max-width: 260px; }
    .cr-st { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    .cr-st::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--c, #a8a29e); }
    .cr-pager { display: flex; gap: 10px; align-items: center; justify-content: flex-end; font-size: 13px; color: var(--cr-muted); padding: 0 16px; }
    .cr-note { margin: 0; padding: 8px 12px; border-radius: 8px; background: var(--cr-soft); font-size: 13px; }
    .cr-note.bad { color: var(--cr-bad); }
    .cr-empty { margin: 0; color: var(--cr-muted); font-size: 13px; }
    @media (max-width: 900px) { .cr-funnel { flex-wrap: wrap; } .cr-step { flex: 1 0 40%; } .cr-arrow { display: none; } .cr-meta { width: 100%; } }
  `],
})
export class CallingReportComponent {
  readonly source = input.required<CallingReportSource>();
  /** Workspace name shown until the first report loads. */
  readonly workspace = input('');
  /** dashboard: funnel, call status and the call log. log: the call log alone (the Call logs page). */
  readonly mode = input<'dashboard' | 'log'>('dashboard');
  /** Only this campaign's rows (the campaign page); the period starts at All time. */
  readonly campaign = input('');
  /** Tells the page around the report when the period or agents change. */
  readonly scopeChange = output<ReportScope>();

  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly host = inject(ElementRef<HTMLElement>);

  protected readonly PERIODS = PERIODS;
  protected readonly PAGE = PAGE;
  protected readonly period = signal<PeriodKey>('30d');
  protected readonly customFrom = signal('');
  protected readonly customTo = signal('');
  protected readonly agents = signal<string[]>([]);
  protected readonly includeTests = signal(false);
  protected readonly r = signal<CallingReport | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly agentsOpen = signal(false);
  protected readonly shareOpen = signal(false);
  protected readonly testsOpen = signal(false);
  protected readonly testNumbers = signal<string[]>([]);
  protected readonly testDraft = signal('');
  protected readonly box = signal<{ key: string; label: string } | null>(null);
  protected readonly drillRows = signal<ReportCallRow[]>([]);
  protected readonly drillTotal = signal(0);
  protected readonly drillPage = signal(0);
  protected readonly LOG_COLUMNS = LOG_COLUMNS;
  protected readonly search = signal('');
  protected readonly colFilters = signal<Record<string, string | string[]>>({});
  protected readonly PICK_COLUMNS = PICK_COLUMNS;
  protected readonly pickOpen = signal('');
  protected readonly pickValues = signal<{ value: string; count: number }[]>([]);
  protected readonly unit = signal('');
  protected readonly unitName = computed(() => this.r()?.units_available?.find((u) => u.field === this.unit())?.label ?? '');
  protected readonly tasks = signal<{ follow_ups: number; callbacks: number; follow_up_required: number; running_campaigns: number; not_finished: number } | null>(null);
  protected readonly statsOpen = signal(false);
  protected readonly statsDraft = signal<{ agent: string; label: string; fields: { field: string; label: string }[]; stats: { field: string; label: string }[] }[]>([]);
  protected readonly logFiltered = computed(() => !!this.search().trim() || Object.values(this.colFilters()).some((v) => (Array.isArray(v) ? v.length : v.trim())));
  private typing: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  /** The workspace time zone: days start at midnight there. */
  private readonly tz = computed(() => this.r()?.time_zone || 'Asia/Kolkata');
  protected readonly today = computed(() => this.ymd(Date.now()));
  /** [from, to] in ms for the chosen period: calendar days in the workspace time zone, up to now. */
  private readonly range = computed<[number, number]>(() => {
    const p = this.period(); const today = this.today(); const now = Date.now();
    if (p === 'all') return [0, now];
    if (p === 'today') return [this.dayStart(today), now];
    if (p === 'yesterday') return [this.dayStart(this.addDays(today, -1)), this.dayStart(today) - 1];
    if (p === '7d') return [this.dayStart(this.addDays(today, -7)), now];
    if (p === '30d') return [this.dayStart(this.addDays(today, -30)), now];
    const from = this.customFrom() || this.addDays(today, -6); const to = this.customTo() || today;
    return [this.dayStart(from), Math.min(now, this.dayStart(this.addDays(to, 1)) - 1)];
  });
  protected readonly days = computed(() => { const [a, b] = this.range(); return Math.max(1, Math.round((b - a) / 86400000)); });
  protected readonly scope = computed<ReportScope>(() => {
    const [a, b] = this.range();
    return { period: this.period(), from: new Date(a).toISOString(), to: new Date(b).toISOString(), days: this.days(), agents: this.agents(), includeTests: this.includeTests(), campaign: this.campaign() || undefined, unit: this.unit() || undefined };
  });
  protected readonly periodLabel = computed(() => {
    const [a, b] = this.range(); const from = this.ymd(a), to = this.ymd(b);
    const f = (ymd: string, year = true) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) }); };
    const span = from === to ? f(to) : `${f(from, from.slice(0, 4) !== to.slice(0, 4))}–${f(to)}`;
    if (this.period() === 'all') return 'All time';
    const word: Record<PeriodKey, string> = { all: 'all time', today: 'today', yesterday: 'yesterday', '7d': 'last 7 days', '30d': 'last 30 days', custom: 'custom range' };
    return `${span} (${word[this.period()]})`;
  });
  protected readonly agentLabel = computed(() => {
    const a = this.agents(); if (!a.length) return 'All agents';
    const names = a.map((k) => this.r()?.agents.find((x) => x.key === k)?.label ?? k); return names.length > 2 ? `${names.length} agents` : names.join(', ');
  });
  protected readonly tzLabel = computed(() => {
    const tz = this.tz(); const m = this.offsetMinutes(Date.now()); const sign = m < 0 ? '-' : '+'; const abs = Math.abs(m);
    return `${tz === 'Asia/Kolkata' ? 'IST' : tz} (UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')})`;
  });

  /** The filters in force, each with its own remove button (the default, Last 30 days for all agents without tests, shows none). */
  protected readonly chips = computed(() => {
    const out: { key: string; label: string }[] = [];
    if (this.period() !== '30d') out.push({ key: 'period', label: this.period() === 'custom' ? `Dates: ${this.periodLabel().replace(/ \(custom range\)$/, '')}` : `Period: ${PERIODS.find((x) => x.key === this.period())?.label}` });
    for (const k of this.agents()) out.push({ key: `agent:${k}`, label: `Agent: ${this.r()?.agents.find((a) => a.key === k)?.label ?? k}` });
    if (this.includeTests()) out.push({ key: 'tests', label: 'Test calls included' });
    return out;
  });

  /** "previous 7 days" and the like, for the change shown on each rate. */
  private readonly prevLabel = computed(() => ({ all: 'before', today: 'yesterday', yesterday: 'the day before', '7d': 'the previous 7 days', '30d': 'the previous 30 days', custom: `the previous ${this.days()} days` })[this.period()]);
  private line(key: string) { return this.r()?.funnel.flatMap((b) => b.lines).find((l) => l.key === key) ?? { key, label: key, count: 0, share: null }; }
  /** The funnel in one row: each step's count and its share of the step before. */
  protected readonly steps = computed(() => {
    const rep = this.r(); if (!rep) return [];
    const h = rep.headline; const d = (k: 'picked_up_share' | 'answered_share' | 'success_rate') => { const x = this.delta(k); return x && x.v ? ` · ${x.text}` : ''; };
    return [
      { key: 'uploaded', label: 'Uploaded', count: h.uploaded, note: `${h.campaigns} campaign${h.campaigns === 1 ? '' : 's'}` },
      { key: 'planned', label: 'Planned', count: h.planned, note: `${this.pct(h.planned_share)} of uploaded` },
      { key: 'picked_up', label: 'Picked up', count: h.picked_up, note: `${this.pct(h.picked_up_share)} of ${h.not_finished ? 'finished' : 'planned'}${d('picked_up_share')}` },
      { key: 'answered', label: 'Answered', count: h.answered, note: `${this.pct(h.answered_share)} of picked up${d('answered_share')}` },
      { key: 'success', label: 'Success', count: h.success, note: `${this.pct(h.success_rate)} success rate${d('success_rate')}` },
    ];
  });
  /** How every planned call ended, in the order of the funnel. The bar covers planned calls; "Not planned" sits outside it. */
  protected readonly groups = computed(() => {
    const rep = this.r(); if (!rep) return [];
    const h = rep.headline; const L = (k: string) => this.line(k); const share = (a: number, b: number) => (b ? a / b : null);
    const width = (n: number) => (h.planned ? (n / h.planned) * 100 : 0);
    const silent = L('silent').count + L('system_issue').count; const notPlanned = L('bad_data').count + L('test').count + (L('stopped').count || 0);
    return [
      { key: 'success', label: 'Success', color: COLORS.success, count: h.success, share: h.success_rate, width: width(h.success), always: true, lines: ['accepted', 'partial', 'follow_up', 'callback'].map(L) },
      { key: 'not_successful', label: 'Not successful', color: COLORS.not_successful, count: L('not_successful').count, share: L('not_successful').share, width: width(L('not_successful').count), always: true, lines: ['not_given_time', 'left', 'wrong_number'].map(L) },
      { key: 'no_conversation', label: 'Picked up, no conversation', color: COLORS.no_conversation, count: silent, share: share(silent, h.picked_up), width: width(silent), always: false, lines: ['silent', 'system_issue'].map(L) },
      { key: 'not_picked_up', label: 'Not picked up', color: COLORS.not_picked_up, count: L('not_picked_up').count, share: L('not_picked_up').share, width: width(L('not_picked_up').count), always: true, lines: ['no_answer', 'dnd', 'voicemail'].map(L) },
      { key: 'in_progress', label: 'Not finished', color: COLORS.in_progress, count: h.not_finished, share: share(h.not_finished, h.planned), width: width(h.not_finished), always: false, lines: [] },
      { key: 'not_planned', label: 'Not planned', color: COLORS.not_planned, count: notPlanned, share: share(notPlanned, h.uploaded), width: 0, always: false, lines: ['bad_data', 'test'].map(L) },
    ];
  });
  /** The dot colour of a row's status in the call log: the colour of its group in the bar. */
  protected colorOf(c: ReportCallRow): string {
    const s = c.call_status, r = c.status_reason || '';
    if (s === 'Answered') return r.startsWith('Success') ? COLORS.success : COLORS.not_successful;
    if (s === 'No reply' || s === 'System issue') return COLORS.no_conversation;
    if (s === 'Not picked' || s === 'DND' || s === 'Voicemail') return COLORS.not_picked_up;
    if (s === 'In progress') return COLORS.in_progress;
    return COLORS.not_planned;
  }

  /** The largest reason answered calls ended without a result. */
  protected readonly loss = computed(() => {
    const rep = this.r(); if (!rep?.headline.answered) return null;
    const box = rep.funnel.find((b) => b.key === 'answered'); const lines = (box?.lines ?? []).filter((l) => ['not_given_time', 'left', 'wrong_number'].includes(l.key));
    const top = [...lines].sort((a, b) => b.count - a.count)[0];
    return top?.count ? { key: top.key, label: top.label, count: top.count, share: top.count / rep.headline.answered } : null;
  });

  private urlPeriod = false;
  constructor() {
    this.readUrl();
    // A campaign page starts at All time unless the address says otherwise.
    effect(() => { if (this.campaign() && !this.urlPeriod) untracked(() => this.period.set('all')); });
    effect(() => { this.scope(); untracked(() => this.load()); });
    effect(() => { const src = this.source(); untracked(() => src.testNumbers?.().then((n) => this.testNumbers.set(n)).catch(() => {})); });
  }

  // ── Address: period, from, to, agents, tests, box, page ────────────────────
  private readUrl(): void {
    const q = this.route.snapshot.queryParamMap;
    const p = q.get('period') as PeriodKey | null;
    if (p && PERIODS.some((x) => x.key === p)) { this.period.set(p); this.urlPeriod = true; }
    if (p === 'custom') { this.customFrom.set(q.get('from') || ''); this.customTo.set(q.get('to') || ''); }
    this.agents.set((q.get('agents') || '').split(',').filter(Boolean));
    this.includeTests.set(q.get('tests') === '1');
    this.unit.set(q.get('unit') || '');
    this.search.set(q.get('q') || ''); try { this.colFilters.set(JSON.parse(q.get('f') || '{}')); } catch { /* ignore bad filters */ }
    const box = q.get('box'); if (box) { this.box.set({ key: box, label: BOX_LABELS[box] || box }); this.drillPage.set(Math.max(0, Number(q.get('page') || 0))); }
  }
  private writeUrl(): void {
    const b = this.box(); const custom = this.period() === 'custom';
    this.router.navigate([], { relativeTo: this.route, replaceUrl: true, queryParamsHandling: 'merge', queryParams: {
      period: this.period() === '30d' ? null : this.period(), from: custom ? this.customFrom() || null : null, to: custom ? this.customTo() || null : null,
      agents: this.agents().join(',') || null, tests: this.includeTests() ? '1' : null, unit: this.unit() || null, box: b?.key ?? null, page: this.drillPage() || null, q: this.search().trim() || null, f: this.logFilters().cols && Object.keys(this.logFilters().cols).length ? JSON.stringify(this.logFilters().cols) : null } });
  }

  async load(): Promise<void> {
    const my = ++this.seq; const sc = this.scope();
    this.loading.set(true); this.error.set('');
    try {
      const rep = await this.source().report(sc);
      if (my !== this.seq) return;
      this.r.set(rep);
      // A list restored from the address gets its proper name once the report is in.
      const b = this.box(); if (b) { const l = rep.funnel.flatMap((x) => x.lines).find((x) => x.key === b.key); if (l && l.label !== b.label) this.box.set({ key: b.key, label: l.label }); }
      await this.fetchBox();
      if (this.mode() === 'dashboard') this.source().tasks?.(sc).then((t) => { if (my === this.seq) this.tasks.set(t); }).catch(() => {});
    } catch {
      if (my === this.seq) this.error.set('Could not load the calling report.');
    } finally { if (my === this.seq) this.loading.set(false); }
  }

  protected setPeriod(p: PeriodKey): void {
    if (p === 'custom' && !this.customFrom()) { this.customFrom.set(this.addDays(this.today(), -6)); this.customTo.set(this.today()); }
    this.period.set(p); this.emit();
  }
  protected setCustom(from: string, to: string): void { if (!from || !to) return; if (from > to) [from, to] = [to, from]; this.customFrom.set(from); this.customTo.set(to); this.emit(); }
  protected setAgents(a: string[]): void { this.agents.set(a); this.agentsOpen.set(false); this.emit(); }
  protected toggleAgent(k: string): void { const a = this.agents(); this.agents.set(a.includes(k) ? a.filter((x) => x !== k) : [...a, k]); this.emit(); }
  protected setTests(on: boolean): void { this.includeTests.set(on); this.emit(); }
  protected removeChip(key: string): void {
    if (key === 'period') { this.period.set('30d'); this.emit(); }
    else if (key === 'tests') this.setTests(false);
    else if (key.startsWith('agent:')) this.setAgents(this.agents().filter((a) => a !== key.slice(6)));
  }
  protected clearAll(): void { this.period.set('30d'); this.agents.set([]); this.includeTests.set(false); this.emit(); }

  protected openTests(): void { this.testDraft.set(this.testNumbers().join('\n')); this.testsOpen.set(!this.testsOpen()); this.agentsOpen.set(false); this.shareOpen.set(false); }
  protected async saveTests(): Promise<void> {
    const save = this.source().saveTestNumbers; if (!save) return;
    try { this.testNumbers.set(await save(this.testDraft().split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean))); this.testsOpen.set(false); await this.load(); }
    catch { this.error.set('Could not save the test numbers.'); }
  }
  private emit(): void { this.drillPage.set(0); this.writeUrl(); this.scopeChange.emit(this.scope()); }

  /** Picks a step or status for the call log below; picking it again shows every call. */
  protected open(key: string, label: string): void {
    if (this.box()?.key === key) return this.close();
    this.box.set({ key, label }); this.drillPage.set(0); this.writeUrl(); this.fetchBox();
  }
  protected close(): void { this.box.set(null); this.drillPage.set(0); this.writeUrl(); this.fetchBox(); }
  protected page(step: number): void { this.drillPage.set(Math.max(0, this.drillPage() + step)); this.writeUrl(); this.fetchBox(); }
  private async fetchBox(): Promise<void> {
    try { const res = await this.source().calls(this.scope(), this.box()?.key ?? 'uploaded', this.drillPage() * PAGE, PAGE, this.logFilters()); this.drillRows.set(res.rows); this.drillTotal.set(res.total); }
    catch { this.drillRows.set([]); this.drillTotal.set(0); this.error.set('Could not load these calls.'); }
  }

  /** Menus close on a click anywhere else; Escape closes a menu, then the list. */
  protected onDocClick(ev: Event): void {
    const t = ev.target as HTMLElement | null; if (t?.closest('.cr-drop')) return;
    this.agentsOpen.set(false); this.shareOpen.set(false); this.testsOpen.set(false); this.pickOpen.set(''); this.statsOpen.set(false);
  }
  protected onEscape(): void {
    if (this.agentsOpen() || this.shareOpen() || this.testsOpen()) { this.agentsOpen.set(false); this.shareOpen.set(false); this.testsOpen.set(false); } else if (this.box()) this.close();
  }

  protected async exportBox(): Promise<void> { const k = this.box()?.key ?? 'uploaded'; this.save(await this.source().exportXlsx(this.scope(), k, this.logFilters()), `${this.fileName()}-${k}${this.logFiltered() ? '-filtered' : ''}.xlsx`); }
  /** Non-empty column filters and the search box, as sent to the call log and the export. */
  private logFilters(): LogFilters { return { q: this.search().trim(), cols: Object.fromEntries(Object.entries(this.colFilters()).filter(([, v]) => (Array.isArray(v) ? v.length : v.trim()))) }; }
  protected textFilter(k: string): string { const v = this.colFilters()[k]; return typeof v === 'string' ? v : ''; }
  protected picked(k: string): string[] { const v = this.colFilters()[k]; return Array.isArray(v) ? v : []; }
  /** Opens a column's value list, counted with the other filters on. */
  protected async openPick(k: string): Promise<void> {
    if (this.pickOpen() === k) { this.pickOpen.set(''); return; }
    this.pickOpen.set(k); this.pickValues.set([]);
    const f = this.logFilters(); delete f.cols[k];
    try { this.pickValues.set((await this.source().values?.(this.scope(), this.box()?.key ?? 'uploaded', f, k)) ?? []); } catch { /* the list stays empty */ }
  }
  protected setPicked(k: string, vals: string[]): void { this.colFilters.set({ ...this.colFilters(), [k]: vals }); this.refilter(); }
  protected togglePicked(k: string, v: string): void { const cur = this.picked(k); this.setPicked(k, cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]); }
  protected setUnit(u: string): void { this.unit.set(u); this.emit(); }
  protected async openStats(): Promise<void> {
    if (this.statsOpen()) { this.statsOpen.set(false); return; }
    try { this.statsDraft.set(await this.source().agentStats!()); this.statsOpen.set(true); } catch { this.error.set('Could not load the custom stats.'); }
  }
  protected isStat(a: { stats: { field: string }[] }, field: string): boolean { return a.stats.some((s) => s.field === field); }
  protected toggleStat(a: { agent: string; stats: { field: string; label: string }[] }, f: { field: string; label: string }): void {
    this.statsDraft.set(this.statsDraft().map((x) => (x.agent !== a.agent ? x : { ...x, stats: this.isStat(x, f.field) ? x.stats.filter((s) => s.field !== f.field) : [...x.stats, f] })));
  }
  protected async saveStats(): Promise<void> {
    try { for (const a of this.statsDraft()) await this.source().saveAgentStats!(a.agent, a.stats); this.statsOpen.set(false); await this.load(); }
    catch { this.error.set('Could not save the custom stats.'); }
  }
  protected setSearch(v: string): void { this.search.set(v); this.refilter(); }
  protected setCol(k: string, v: string): void { this.colFilters.set({ ...this.colFilters(), [k]: v }); this.refilter(); }
  protected clearLogFilters(): void { this.search.set(''); this.colFilters.set({}); this.drillPage.set(0); this.writeUrl(); this.fetchBox(); }
  /** Typing waits a moment before the log reloads. */
  private refilter(): void { if (this.typing) clearTimeout(this.typing); this.typing = setTimeout(() => { this.drillPage.set(0); this.writeUrl(); this.fetchBox(); }, 300); }
  protected async shareSheet(): Promise<void> { this.shareOpen.set(false); this.save(await this.source().exportXlsx(this.scope(), 'uploaded'), `${this.fileName()}.xlsx`); }
  protected async sharePicture(): Promise<void> { this.shareOpen.set(false); const c = this.draw(); if (c) c.toBlob((b) => b && this.save(b, `${this.fileName()}.png`), 'image/png'); }
  protected sharePdf(): void {
    this.shareOpen.set(false); const c = this.draw(); if (!c) return;
    const w = window.open('', '_blank'); if (!w) return;
    w.document.write(`<!doctype html><title>${this.fileName()}</title><style>@page{size:A4;margin:10mm}body{margin:0}img{width:100%}</style><img src="${c.toDataURL('image/png')}">`);
    w.document.close(); w.onload = () => { w.focus(); w.print(); };
  }
  private save(blob: Blob, name: string): void {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  private fileName(): string {
    const slug = this.agents().length ? this.agentLabel().toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'all-agents'; const [a, b] = this.range();
    return `calling-report-${slug}-${this.ymd(a)}-to-${this.ymd(b)}`;
  }

  // ── Calendar days in the workspace time zone ────────────────────────────────
  private ymd(ms: number): string { return new Intl.DateTimeFormat('en-CA', { timeZone: this.tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
  private addDays(ymd: string, n: number): string { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
  /** Minutes the workspace time zone is ahead of UTC at a moment. */
  private offsetMinutes(ms: number): number {
    const v = new Intl.DateTimeFormat('en-US', { timeZone: this.tz(), timeZoneName: 'shortOffset' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value || 'GMT';
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(v); return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
  }
  /** Midnight at the start of a calendar day in the workspace time zone, as ms. */
  private dayStart(ymd: string): number { const [y, m, d] = ymd.split('-').map(Number); const utc = Date.UTC(y, m - 1, d); return utc - this.offsetMinutes(utc) * 60000; }

  /** The shared picture: the same report as on screen, laid out like the agreed image (cards, funnel, by agent, success field). */
  private draw(): HTMLCanvasElement | null {
    const rep = this.r(); if (!rep) return null;
    const W = 1040, M = 40, scale = 2; const agentsH = 46 + rep.by_agent.length * 38;
    const boxH = (b: ReportBox) => 58 + b.lines.length * 32; const row1 = Math.max(boxH(rep.funnel[0]), boxH(rep.funnel[1])); const row2 = Math.max(boxH(rep.funnel[2]), boxH(rep.funnel[3]));
    const H = 120 + 120 + 56 + 40 + row1 + 14 + row2 + 50 + agentsH + 60 + 60;
    const c = document.createElement('canvas'); c.width = W * scale; c.height = H * scale; const g = c.getContext('2d'); if (!g) return null; g.scale(scale, scale);
    const F = '"Geist", "Inter", system-ui, -apple-system, "Segoe UI", sans-serif'; const ink = '#0c0a09', mute = '#6b6560', line = '#e7e5e2', soft = '#f6f5f3', green = '#0f7b4b', greenBg = '#ecfdf5', greenLine = '#a7f3d0';
    const text = (s: string, x: number, y: number, size: number, color = ink, weight = 400, align: CanvasTextAlign = 'left') => { g.font = `${weight} ${size}px ${F}`; g.fillStyle = color; g.textAlign = align; g.textBaseline = 'alphabetic'; g.fillText(s, x, y); };
    const rect = (x: number, y: number, w: number, h: number, fill: string, stroke = line, r = 12) => { g.beginPath(); g.roundRect(x, y, w, h, r); g.fillStyle = fill; g.fill(); if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); } };
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    let y = M + 30; text('Calling report', M, y, 30, ink, 700); text(`Generated ${this.when(rep.generated_at)}`, W - M, y - 8, 12.5, mute, 400, 'right');
    y += 26; text(`${rep.workspace} · ${this.agentLabel()} · ${this.periodLabel()}`, M, y, 14.5, mute); text(`Times in ${this.tzLabel()}`, W - M, y - 10, 12.5, mute, 400, 'right');
    y += 18; g.fillStyle = line; g.fillRect(M, y, W - 2 * M, 1); y += 22;
    const h = rep.headline; const cards: [string, number, string, boolean][] = [['Uploaded', h.uploaded, `${h.campaigns} campaigns`, false], ['Planned', h.planned, `${this.pct(h.planned_share)} of uploaded`, false],
      ['Picked up', h.picked_up, `${this.pct(h.picked_up_share)} of ${h.not_finished ? this.num(h.finished) + ' finished' : 'planned'}`, false], ['Answered', h.answered, `${this.pct(h.answered_share)} of picked up`, false], ['Success', h.success, `Success rate ${this.pct(h.success_rate)}`, true]];
    const cw = (W - 2 * M - 4 * 12) / 5;
    cards.forEach(([l, v, s, good], i) => { const x = M + i * (cw + 12); rect(x, y, cw, 100, good ? greenBg : '#fff', good ? greenLine : line); text(l, x + 16, y + 26, 13, mute); text(this.num(v), x + 16, y + 64, 34, good ? green : ink, 700); text(s, x + 16, y + 86, 12.5, good ? green : mute, good ? 600 : 400); });
    y += 112; const sw = (W - 2 * M - 3 * 12) / 4;
    [['Dials', this.num(rep.stats.dials)], ['Avg talk time', this.mmss(rep.stats.avg_talk_seconds)], ['Total talk time', this.hms(rep.stats.total_talk_seconds)], ['Not finished', this.num(rep.stats.in_progress)]]
      .forEach(([l, v], i) => { const x = M + i * (sw + 12); rect(x, y, sw, 38, soft, '', 10); text(l, x + 14, y + 24, 13, mute); text(v, x + sw - 14, y + 24, 13.5, ink, 600, 'right'); });
    y += 64; text('FUNNEL', M, y, 12, mute, 600); y += 14;
    const bw = (W - 2 * M - 12) / 2;
    rep.funnel.forEach((b, i) => {
      const x = M + (i % 2) * (bw + 12); const top = y + (i < 2 ? 0 : row1 + 14); const good = b.key === 'answered';
      rect(x, top, bw, i < 2 ? row1 : row2, '#fff', good ? greenLine : line);
      g.beginPath(); g.arc(x + 26, top + 28, 11, 0, Math.PI * 2); g.strokeStyle = line; g.stroke(); text(String(b.step), x + 26, top + 32, 11.5, mute, 500, 'center');
      text(b.label, x + 46, top + 33, 15, ink, 600); text(this.num(b.total), x + bw - 16, top + 35, 22, ink, 700, 'right');
      g.fillStyle = line; g.fillRect(x + 16, top + 48, bw - 32, 1);
      b.lines.forEach((l, j) => { const ly = top + 72 + j * 32; const col = l.good ? green : ink;
        text((l.sub ? '–   ' : '') + l.label, x + (l.sub ? 34 : 16), ly, 13.5, l.sub ? ink : col, l.strong ? 600 : 400); text(this.num(l.count), x + bw - 76, ly, 13.5, col, 400, 'right'); text(this.pct(l.share), x + bw - 16, ly, 12.5, mute, 400, 'right'); });
    });
    y += row1 + 14 + row2 + 36; text('BY AGENT', M, y, 12, mute, 600); y += 12;
    const cols = ['Agent', 'Planned', 'Picked up', 'Answered', 'Success', 'Success rate', 'Avg talk time']; const cx = [M + 14, 520, 610, 700, 790, 890, W - M - 14];
    rect(M, y, W - 2 * M, 34, soft, '', 8); cols.forEach((t, i) => text(t, cx[i], y + 22, 12.5, mute, 500, i ? 'right' : 'left')); y += 34;
    const fit = (t: string, w: number) => { g.font = `400 13.5px ${F}`; if (g.measureText(t).width <= w) return t; let x = t; while (x.length > 1 && g.measureText(x + '…').width > w) x = x.slice(0, -1); return x + '…'; };
    rep.by_agent.forEach((a) => { y += 38; [fit(a.agent, cx[1] - cx[0] - 70), this.num(a.planned), this.num(a.picked_up), this.num(a.answered), this.num(a.success), this.pct(a.success_rate), this.mmss(a.avg_talk_seconds)]
      .forEach((t, i) => text(t, cx[i], y - 13, 13.5, i === 5 ? green : ink, i === 5 ? 600 : 400, i ? 'right' : 'left')); g.fillStyle = line; g.fillRect(M, y, W - 2 * M, 1); });
    y += 44; text('SUCCESS FIELD', M, y, 12, mute, 600); y += 14; let x = M;
    for (const [l, v] of [['Yes', rep.success_field.yes], ['No', rep.success_field.no], ['N/A', rep.success_field.na]] as [string, number][]) {
      g.font = `600 14px ${F}`; const w = g.measureText(`${l}  ${this.num(v)}`).width + 32; rect(x, y, w, 34, '#fff', line, 17); text(l, x + 16, y + 22, 14, mute); text(this.num(v), x + w - 16, y + 22, 14, ink, 600, 'right'); x += w + 10;
    }
    return c;
  }

  protected lineCount(key: string): number { return this.r()?.funnel.flatMap((b) => b.lines).find((l) => l.key === key)?.count ?? 0; }
  /** Change in percentage points against the previous period; nothing when either side has nothing to divide by. */
  protected delta(k: 'picked_up_share' | 'answered_share' | 'success_rate'): { v: number; text: string; title: string } | null {
    const rep = this.r(); const cur = rep?.headline[k]; const prev = rep?.previous?.[k];
    if (cur == null || !rep?.previous) return null;
    if (prev == null) return { v: 0, text: `Nothing to compare`, title: `No calls to compare in ${this.prevLabel()}` };
    const v = Math.round(cur * 100) - Math.round(prev * 100);
    return { v, text: v > 0 ? `+${v} pts` : v < 0 ? `−${-v} pts` : 'No change', title: `Against ${this.prevLabel()}: ${this.pct(prev)}` };
  }
  protected num(n: number): string { return (n ?? 0).toLocaleString('en-IN'); }
  /** A rate as a whole percent; a dash when there was nothing to divide by. */
  protected pct(x: number | null | undefined): string { return x == null ? '—' : `${Math.round(x * 100)}%`; }
  protected mmss(s: number | null | undefined): string { if (s == null) return '—'; const t = Math.round(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; }
  protected hms(s: number): string { const t = Math.round(s || 0), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60; return h ? `${h}h ${m}m` : `${m}m ${sec}s`; }
  protected when(iso: string): string {
    return new Date(iso).toLocaleString('en-GB', { timeZone: this.r()?.time_zone || 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  }
}
