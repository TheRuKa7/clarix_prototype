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

export type PeriodKey = 'today' | 'yesterday' | '7d' | '30d' | 'custom';
/** from and to are ISO instants; days is the span, for pages that still think in days. */
export interface ReportScope { period: PeriodKey; from: string; to: string; days: number; agents: string[]; includeTests: boolean; }
export interface ReportLineView { key: string; label: string; count: number; share: number; strong?: boolean; sub?: boolean; good?: boolean; }
export interface ReportBox { key: string; step: number; label: string; total: number; lines: ReportLineView[]; }
export interface ByAgentRow { agent: string; agent_key: string; planned: number; picked_up: number; answered: number; success: number; success_rate: number; avg_talk_seconds: number; }
export interface CallingReport {
  generated_at: string; time_zone: string; definitions_version: string; workspace: string; from: string | null; to: string | null; tests_included: boolean;
  headline: { uploaded: number; campaigns: number; planned: number; picked_up: number; answered: number; success: number; planned_share: number; picked_up_share: number; answered_share: number; success_rate: number; finished: number; not_finished: number };
  stats: { dials: number; avg_talk_seconds: number; total_talk_seconds: number; in_progress: number };
  funnel: ReportBox[]; by_agent: ByAgentRow[]; success_field: { yes: number; no: number; na: number };
  sum_check: { ok: boolean; gaps: { box: string; expected: number; got: number }[] };
  /** Agents with planned calls in the period (any agent filter ignored), with that count. */
  agents: { key: string; label: string; count: number }[];
}
export interface ReportCallRow {
  id: string; call_id: string | null; campaign_id: string; primary_id?: string; call_date: string | null; agent: string; campaign: string; caller_name: string; phone: string;
  call_status: string; status_reason: string; goal_reached: string; duration_seconds: number | null; callback_at: string | null; uploaded_by: string;
}
export interface CallingReportSource {
  report(scope: ReportScope): Promise<CallingReport>;
  calls(scope: ReportScope, box: string, skip: number, limit: number): Promise<{ rows: ReportCallRow[]; total: number }>;
  exportXlsx(scope: ReportScope, box: string): Promise<Blob>;
  /** Opens the call page for a row (phase 2 makes this the one call page everywhere). */
  openCall(row: ReportCallRow): void;
  /** Opens the full Call logs page, where the product has one. */
  openCallLogs?(scope: ReportScope, box: string): void;
  /** The workspace's internal test numbers: calls to them count only as Internal test calls. */
  testNumbers?(): Promise<string[]>;
  saveTestNumbers?(numbers: string[]): Promise<string[]>;
}

const PERIODS: { key: PeriodKey; label: string }[] = [{ key: 'today', label: 'Today' }, { key: 'yesterday', label: 'Yesterday' }, { key: '7d', label: 'Last 7 days' }, { key: '30d', label: 'Last 30 days' }, { key: 'custom', label: 'Custom' }];
/** Names for boxes that are not a funnel line, so an open list can be restored from the address. */
const BOX_LABELS: Record<string, string> = { uploaded: 'Uploaded', planned: 'Planned', picked_up: 'Picked up', answered: 'Answered', success: 'Success', in_progress: 'Not finished',
  goal_yes: 'Goal reached: Yes', goal_no: 'Goal reached: No', goal_na: 'Goal reached: N/A' };
const PAGE = 10;

@Component({
  selector: 'app-calling-report',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:click)': 'onDocClick($event)', '(document:keydown.escape)': 'onEscape()' },
  template: `
    <section class="cr" [class.cr-busy]="loading()">
      <header class="cr-head">
        <div>
          <h2 class="cr-title">Calling report</h2>
          <p class="cr-sub"><b>{{ r()?.workspace || workspace() }}</b> · {{ agentLabel() }} · {{ periodLabel() }}</p>
        </div>
        <div class="cr-meta">
          @if (r()) { <span>Generated {{ when(r()!.generated_at) }}</span><span>Times in {{ tzLabel() }}</span> }
        </div>
      </header>

      <div class="cr-filters" role="toolbar" aria-label="Report filters">
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
        <div class="cr-drop">
          <button type="button" class="cr-btn" [class.on]="agents().length" (click)="agentsOpen.set(!agentsOpen())" [attr.aria-expanded]="agentsOpen()">{{ agents().length ? agents().length + ' agent' + (agents().length > 1 ? 's' : '') : 'All agents' }} ▾</button>
          @if (agentsOpen()) {
            <div class="cr-menu" role="listbox" aria-label="Agents">
              <label class="cr-opt"><input type="checkbox" [checked]="!agents().length" (change)="setAgents([])"> All agents</label>
              @for (a of r()?.agents ?? []; track a.key) {
                <label class="cr-opt"><input type="checkbox" [checked]="agents().includes(a.key)" (change)="toggleAgent(a.key)"> <span class="cr-opt-l">{{ a.label }}</span><small>{{ num(a.count) }}</small></label>
              } @empty { <p class="cr-empty cr-pad">No agent had calls planned in this period.</p> }
            </div>
          }
        </div>
        <label class="cr-check" title="Internal test calls are left out of every number unless this is on."><input type="checkbox" [checked]="includeTests()" (change)="setTests(!includeTests())"> Include test calls</label>
        @if (source().testNumbers) {
          <div class="cr-drop">
            <button type="button" class="cr-btn cr-small" (click)="openTests()" [attr.aria-expanded]="testsOpen()" title="Phone numbers your team uses for testing">Test numbers ({{ testNumbers().length }})</button>
            @if (testsOpen()) {
              <div class="cr-menu cr-tests" role="dialog" aria-label="Test numbers">
                <b>Internal test numbers</b>
                <p>Calls to these numbers count only on the "Internal test calls" line. One per line; the last 10 digits are kept.</p>
                <textarea rows="5" [value]="testDraft()" (input)="testDraft.set($any($event.target).value)" aria-label="Test numbers, one per line"></textarea>
                <div class="cr-tests-foot"><span class="cr-grow"></span><button type="button" class="cr-btn" (click)="testsOpen.set(false)">Cancel</button><button type="button" class="cr-btn cr-primary" (click)="saveTests()">Save</button></div>
              </div>
            }
          </div>
        }
        <span class="cr-grow"></span>
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

      @if (chips().length) {
        <div class="cr-active" aria-label="Active filters">
          @for (c of chips(); track c.key) { <span class="cr-fchip">{{ c.label }}<button type="button" (click)="removeChip(c.key)" [attr.aria-label]="'Remove ' + c.label">✕</button></span> }
          <button type="button" class="cr-link" (click)="clearAll()">Clear all</button>
        </div>
      }

      @if (error()) { <p class="cr-note bad" role="alert">{{ error() }} <button type="button" class="cr-link" (click)="load()">Try again</button></p> }

      @if (r(); as rep) {
        <div class="cr-cards">
          <button type="button" class="cr-card" (click)="open('uploaded', 'Uploaded')"><span>Uploaded</span><b>{{ num(rep.headline.uploaded) }}</b><small>{{ rep.headline.campaigns }} campaign{{ rep.headline.campaigns === 1 ? '' : 's' }}</small></button>
          <button type="button" class="cr-card" (click)="open('planned', 'Planned')"><span>Planned</span><b>{{ num(rep.headline.planned) }}</b><small>{{ pct(rep.headline.planned_share) }} of uploaded</small></button>
          <button type="button" class="cr-card" (click)="open('picked_up', 'Picked up')"><span>Picked up</span><b>{{ num(rep.headline.picked_up) }}</b><small>{{ pct(rep.headline.picked_up_share) }} of {{ rep.headline.not_finished ? num(rep.headline.finished) + ' finished' : 'planned' }}</small></button>
          <button type="button" class="cr-card" (click)="open('answered', 'Answered')"><span>Answered</span><b>{{ num(rep.headline.answered) }}</b><small>{{ pct(rep.headline.answered_share) }} of picked up</small></button>
          <button type="button" class="cr-card good" (click)="open('success', 'Success')"><span>Success</span><b>{{ num(rep.headline.success) }}</b><small>Success rate {{ pct(rep.headline.success_rate) }}</small></button>
        </div>
        <div class="cr-stats">
          <div><span>Dials</span><b>{{ num(rep.stats.dials) }}</b></div>
          <div><span>Avg talk time</span><b>{{ mmss(rep.stats.avg_talk_seconds) }}</b></div>
          <div><span>Total talk time</span><b>{{ hms(rep.stats.total_talk_seconds) }}</b></div>
          <button type="button" (click)="open('in_progress', 'Not finished')" [disabled]="!rep.stats.in_progress" title="Still being dialled or waiting for a retry: no result yet, so not in any rate"><span>Not finished</span><b>{{ num(rep.stats.in_progress) }}</b></button>
        </div>

        <h3 class="cr-section">Funnel</h3>
        <div class="cr-funnel">
          @for (b of rep.funnel; track b.key) {
            <div class="cr-box" [class.good]="b.key === 'answered'">
              <div class="cr-box-head"><i>{{ b.step }}</i><span>{{ b.label }}</span><b>{{ num(b.total) }}</b></div>
              @for (l of b.lines; track l.key) {
                <button type="button" class="cr-line" [class.strong]="l.strong" [class.sub]="l.sub" [class.good]="l.good" (click)="open(l.key, l.label)" [title]="'Show the ' + l.count + ' calls: ' + l.label">
                  <span>@if (l.sub) { <em>–</em> }{{ l.label }}</span><b>{{ num(l.count) }}</b><small>{{ pct(l.share) }}</small>
                </button>
              }
            </div>
          }
        </div>
        <p class="cr-sum" [class.bad]="!rep.sum_check.ok">
          @if (rep.sum_check.ok) { Every box adds up to the one above it. }
          @else { Counts do not match: @for (g of rep.sum_check.gaps; track g.box) { {{ g.box }} is {{ g.expected }}, its parts add to {{ g.got }}. } }
          <span class="cr-ver">Definitions {{ rep.definitions_version }}</span>
        </p>

        <h3 class="cr-section">By agent</h3>
        @if (rep.by_agent.length) {
          <div class="cr-table" role="table" aria-label="By agent">
            <div class="cr-tr cr-th" role="row"><span role="columnheader">Agent</span><span role="columnheader">Planned</span><span role="columnheader">Picked up</span><span role="columnheader">Answered</span><span role="columnheader">Success</span><span role="columnheader">Success rate</span><span role="columnheader">Avg talk time</span></div>
            @for (a of rep.by_agent; track a.agent_key) {
              <button type="button" class="cr-tr" role="row" (click)="setAgents([a.agent_key])" title="Show this agent only">
                <span role="cell">{{ a.agent }}</span><span role="cell">{{ num(a.planned) }}</span><span role="cell">{{ num(a.picked_up) }}</span><span role="cell">{{ num(a.answered) }}</span><span role="cell">{{ num(a.success) }}</span>
                <span role="cell" class="good">{{ pct(a.success_rate) }}</span><span role="cell">{{ mmss(a.avg_talk_seconds) }}</span>
              </button>
            }
          </div>
        } @else { <p class="cr-empty">No calls were planned in this period.</p> }

        <h3 class="cr-section">Success field</h3>
        <div class="cr-chips">
          <button type="button" (click)="open('goal_yes', 'Goal reached: Yes')">Yes <b>{{ num(rep.success_field.yes) }}</b></button>
          <button type="button" (click)="open('goal_no', 'Goal reached: No')">No <b>{{ num(rep.success_field.no) }}</b></button>
          <button type="button" (click)="open('goal_na', 'Goal reached: N/A')">N/A <b>{{ num(rep.success_field.na) }}</b></button>
        </div>
      } @else if (!error()) { <p class="cr-empty">Loading the report…</p> }

      @if (box(); as bx) {
        <div class="cr-scrim" (click)="close()" aria-hidden="true"></div>
        <aside class="cr-drill" role="dialog" aria-modal="true" [attr.aria-label]="bx.label + ' calls'" tabindex="-1">
          <div class="cr-drill-head">
            <div><b>{{ bx.label }}</b><span>{{ drillTotal() }} call{{ drillTotal() === 1 ? '' : 's' }} · {{ agentLabel() }} · {{ periodLabel() }}</span></div><span class="cr-grow"></span>
            @if (source().openCallLogs) { <button type="button" class="cr-btn" (click)="source().openCallLogs!(scope(), bx.key)">Open in Call logs</button> }
            <button type="button" class="cr-btn" (click)="exportBox()">Export</button>
            <button type="button" class="cr-btn" (click)="close()" aria-label="Close the list">✕</button>
          </div>
          @if (drillRows().length) {
            <div class="cr-table cr-calls" role="table">
              <div class="cr-tr cr-th" role="row"><span role="columnheader">Call date</span><span role="columnheader">Caller</span><span role="columnheader">Agent</span><span role="columnheader">Campaign</span><span role="columnheader">Call status</span><span role="columnheader">Status reason</span><span role="columnheader">Duration</span></div>
              @for (c of drillRows(); track c.id) {
                <button type="button" class="cr-tr" role="row" (click)="source().openCall(c)" [title]="'Open the call with ' + (c.caller_name || c.phone)">
                  <span role="cell">{{ c.call_date ? when(c.call_date) : '—' }}</span><span role="cell">{{ c.caller_name || c.phone || '—' }}</span><span role="cell">{{ c.agent }}</span>
                  <span role="cell" [title]="c.campaign">{{ c.campaign }}</span><span role="cell">{{ c.call_status }}</span><span role="cell" [title]="c.status_reason">{{ c.status_reason }}</span>
                  <span role="cell">{{ c.duration_seconds == null ? '—' : mmss(c.duration_seconds) }}</span>
                </button>
              }
            </div>
            <div class="cr-pager">
              <button type="button" class="cr-btn" [disabled]="drillPage() === 0" (click)="page(-1)">Newer</button>
              <span>{{ drillPage() * PAGE + 1 }}–{{ drillPage() * PAGE + drillRows().length }} of {{ drillTotal() }}</span>
              <button type="button" class="cr-btn" [disabled]="(drillPage() + 1) * PAGE >= drillTotal()" (click)="page(1)">Older</button>
            </div>
          } @else { <p class="cr-empty">No calls in this box.</p> }
        </aside>
      }
    </section>
  `,
  styles: [`
    :host { display: block; --cr-text: var(--ds-text, var(--text, #0c0a09)); --cr-muted: var(--ds-text-muted, var(--muted, #5c5752)); --cr-line: var(--ds-border, var(--line, #e7e5e2));
      --cr-bg: var(--ds-surface, var(--card, #fff)); --cr-soft: var(--ds-surface-sunken, var(--bg-2, #f5f5f4)); --cr-good: var(--ds-success-fg, #146c34); --cr-good-bg: var(--ds-success-bg, #ecfdf3);
      --cr-good-line: var(--ds-success-border, #a7f3d0); --cr-bad: var(--ds-danger-fg, #b91c1c); --cr-accent: var(--ds-accent, var(--accent, #4c4184)); }
    .cr { display: grid; gap: 14px; color: var(--cr-text); }
    .cr-busy { opacity: .7; transition: opacity .2s; }
    .cr-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-end; border-bottom: 1px solid var(--cr-line); padding-bottom: 12px; }
    .cr-title { margin: 0; font-size: 22px; font-weight: 700; }
    .cr-sub { margin: 4px 0 0; color: var(--cr-muted); font-size: 13px; }
    .cr-sub b { color: var(--cr-text); font-weight: 600; }
    .cr-meta { display: grid; text-align: right; color: var(--cr-muted); font-size: 12px; }
    .cr-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .cr-grow { flex: 1; }
    .cr-seg { display: inline-flex; border: 1px solid var(--cr-line); border-radius: 8px; overflow: hidden; }
    .cr-seg button { border: 0; background: var(--cr-bg); color: var(--cr-text); padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer; }
    .cr-seg button.on { background: var(--cr-text); color: var(--cr-bg); }
    .cr-btn { border: 1px solid var(--cr-line); background: var(--cr-bg); color: var(--cr-text); border-radius: 8px; padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer; }
    .cr-btn.on { border-color: var(--cr-accent); color: var(--cr-accent); }
    .cr-btn:disabled { opacity: .5; cursor: default; }
    .cr-check { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; color: var(--cr-muted); cursor: pointer; }
    .cr-drop { position: relative; }
    .cr-menu { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; min-width: 220px; background: var(--cr-bg); border: 1px solid var(--cr-line); border-radius: 10px; padding: 6px; display: grid; box-shadow: 0 8px 24px -12px rgba(0,0,0,.25); }
    .cr-menu.cr-right { left: auto; right: 0; }
    .cr-menu button, .cr-opt { border: 0; background: none; text-align: left; padding: 7px 8px; border-radius: 6px; font: inherit; font-size: 13px; color: var(--cr-text); cursor: pointer; display: flex; gap: 8px; align-items: center; }
    .cr-menu button:hover, .cr-opt:hover { background: var(--cr-soft); }
    .cr-cards { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
    .cr-card { text-align: left; border: 1px solid var(--cr-line); border-radius: 12px; background: var(--cr-bg); padding: 14px 16px; display: grid; gap: 2px; cursor: pointer; font: inherit; color: inherit; }
    .cr-card:hover, .cr-line:hover, .cr-tr:not(.cr-th):hover, .cr-chips button:hover { background: var(--cr-soft); }
    .cr-card span { color: var(--cr-muted); font-size: 13px; }
    .cr-card b { font-size: 32px; line-height: 1.15; font-weight: 700; font-variant-numeric: tabular-nums; }
    .cr-card small { color: var(--cr-muted); font-size: 12.5px; }
    .cr-card.good { background: var(--cr-good-bg); border-color: var(--cr-good-line); }
    .cr-card.good b, .cr-card.good small { color: var(--cr-good); }
    .cr-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .cr-stats > * { display: flex; justify-content: space-between; align-items: center; background: var(--cr-soft); border: 0; border-radius: 10px; padding: 9px 14px; font: inherit; font-size: 13px; color: var(--cr-muted); }
    .cr-stats button { cursor: pointer; }
    .cr-stats b { color: var(--cr-text); font-variant-numeric: tabular-nums; }
    .cr-section { margin: 8px 0 0; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--cr-muted); font-weight: 600; }
    .cr-funnel { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .cr-box { border: 1px solid var(--cr-line); border-radius: 12px; background: var(--cr-bg); padding: 12px 14px; display: grid; align-content: start; }
    .cr-box.good { border-color: var(--cr-good-line); }
    .cr-box-head { display: flex; align-items: center; gap: 10px; padding-bottom: 10px; margin-bottom: 4px; border-bottom: 1px solid var(--cr-line); font-weight: 600; }
    .cr-box-head i { font-style: normal; width: 22px; height: 22px; border: 1px solid var(--cr-line); border-radius: 50%; display: grid; place-items: center; font-size: 12px; color: var(--cr-muted); }
    .cr-box-head span { flex: 1; }
    .cr-box-head b { font-size: 22px; font-variant-numeric: tabular-nums; }
    .cr-line { display: grid; grid-template-columns: 1fr 64px 48px; gap: 8px; align-items: center; border: 0; background: none; padding: 6px 4px; border-radius: 6px; font: inherit; font-size: 13.5px; color: var(--cr-text); cursor: pointer; text-align: left; }
    .cr-line b, .cr-line small { text-align: right; font-variant-numeric: tabular-nums; }
    .cr-line b { font-weight: 500; }
    .cr-line small { color: var(--cr-muted); }
    .cr-line.strong span { font-weight: 600; }
    .cr-line.sub span { padding-left: 16px; }
    .cr-line em { font-style: normal; color: var(--cr-muted); margin-right: 8px; }
    .cr-line.good span, .cr-line.good b { color: var(--cr-good); }
    .cr-sum { margin: 0; font-size: 12px; color: var(--cr-muted); display: flex; gap: 12px; }
    .cr-sum.bad { color: var(--cr-bad); font-weight: 600; }
    .cr-ver { margin-left: auto; }
    .cr-table { border: 1px solid var(--cr-line); border-radius: 12px; overflow: hidden; background: var(--cr-bg); }
    .cr-tr { display: grid; grid-template-columns: 2fr repeat(6, 1fr); gap: 8px; padding: 10px 14px; border: 0; border-top: 1px solid var(--cr-line); width: 100%; background: none; font: inherit; font-size: 13.5px; color: var(--cr-text); text-align: right; cursor: pointer; }
    .cr-tr > :first-child { text-align: left; }
    .cr-th { border-top: 0; background: var(--cr-soft); color: var(--cr-muted); font-size: 12.5px; cursor: default; }
    .cr-tr .good { color: var(--cr-good); font-weight: 600; }
    .cr-calls .cr-tr { grid-template-columns: 1.3fr 1.2fr 1.1fr 1.3fr .9fr 1.5fr .6fr; text-align: left; font-size: 12.5px; }
    .cr-calls .cr-tr > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cr-chips { display: flex; gap: 10px; flex-wrap: wrap; }
    .cr-chips button { border: 1px solid var(--cr-line); border-radius: 999px; background: var(--cr-bg); padding: 6px 16px; font: inherit; font-size: 14px; color: var(--cr-muted); cursor: pointer; }
    .cr-chips b { color: var(--cr-text); margin-left: 4px; }
    .cr-opt-l { flex: 1; }
    .cr-opt small { color: var(--cr-muted); font-variant-numeric: tabular-nums; }
    .cr-pad { padding: 6px 8px; }
    .cr-small { padding: 4px 10px; font-size: 12.5px; color: var(--cr-muted); }
    .cr-primary { background: var(--cr-text); color: var(--cr-bg); border-color: var(--cr-text); }
    .cr-tests { width: 300px; gap: 8px; padding: 12px; }
    .cr-tests b { font-size: 13.5px; }
    .cr-tests p { margin: 0; font-size: 12px; color: var(--cr-muted); }
    .cr-tests textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--cr-line); border-radius: 8px; padding: 8px; font: 13px var(--ds-mono, ui-monospace, monospace); background: var(--cr-bg); color: var(--cr-text); resize: vertical; }
    .cr-tests-foot { display: flex; gap: 8px; }
    .cr-tests-foot .cr-btn { padding: 5px 12px; }
    .cr-active { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: -4px; }
    .cr-fchip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 4px 3px 10px; border-radius: 999px; background: var(--cr-soft); border: 1px solid var(--cr-line); font-size: 12.5px; }
    .cr-fchip button { border: 0; background: none; color: var(--cr-muted); cursor: pointer; width: 20px; height: 20px; border-radius: 50%; font-size: 11px; }
    .cr-fchip button:hover { background: var(--cr-line); color: var(--cr-text); }
    .cr-range { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; color: var(--cr-muted); }
    .cr-range input { border: 1px solid var(--cr-line); border-radius: 8px; padding: 5px 8px; font: inherit; font-size: 13px; background: var(--cr-bg); color: var(--cr-text); }
    .cr-scrim { position: fixed; inset: 0; background: rgba(12, 10, 9, .32); z-index: 1000; }
    .cr-drill { position: fixed; top: 0; right: 0; bottom: 0; width: min(760px, 100vw); z-index: 1001; overflow: auto; padding: 18px; display: flex; flex-direction: column; gap: 12px;
      background: var(--cr-bg); color: var(--cr-text); border-left: 1px solid var(--cr-line); box-shadow: -12px 0 40px -20px rgba(0, 0, 0, .4); outline: none; }
    .cr-drill-head { display: flex; gap: 10px; align-items: flex-start; }
    .cr-drill-head > div { display: grid; gap: 2px; }
    .cr-drill-head b { font-size: 16px; }
    .cr-drill-head span { color: var(--cr-muted); font-size: 12.5px; }
    .cr-pager { display: flex; gap: 10px; align-items: center; justify-content: flex-end; font-size: 13px; color: var(--cr-muted); }
    .cr-note { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--cr-soft); font-size: 13px; }
    .cr-note.bad { color: var(--cr-bad); }
    .cr-link { border: 0; background: none; text-decoration: underline; color: inherit; cursor: pointer; font: inherit; }
    .cr-empty { margin: 0; color: var(--cr-muted); font-size: 13px; }
    @media (max-width: 900px) { .cr-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } .cr-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } .cr-funnel { grid-template-columns: 1fr; }
      .cr-tr { grid-template-columns: 1.6fr repeat(6, minmax(44px, 1fr)); font-size: 12.5px; } .cr-calls .cr-tr { grid-template-columns: 1fr 1fr 1fr; } .cr-calls .cr-tr > :nth-child(n+4) { display: none; } }
  `],
})
export class CallingReportComponent {
  readonly source = input.required<CallingReportSource>();
  /** Workspace name shown until the first report loads. */
  readonly workspace = input('');
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
  private seq = 0;

  /** The workspace time zone: days start at midnight there. */
  private readonly tz = computed(() => this.r()?.time_zone || 'Asia/Kolkata');
  protected readonly today = computed(() => this.ymd(Date.now()));
  /** [from, to] in ms for the chosen period: calendar days in the workspace time zone, up to now. */
  private readonly range = computed<[number, number]>(() => {
    const p = this.period(); const today = this.today(); const now = Date.now();
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
    return { period: this.period(), from: new Date(a).toISOString(), to: new Date(b).toISOString(), days: this.days(), agents: this.agents(), includeTests: this.includeTests() };
  });
  protected readonly periodLabel = computed(() => {
    const [a, b] = this.range(); const from = this.ymd(a), to = this.ymd(b);
    const f = (ymd: string, year = true) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) }); };
    const span = from === to ? f(to) : `${f(from, from.slice(0, 4) !== to.slice(0, 4))}–${f(to)}`;
    const word: Record<PeriodKey, string> = { today: 'today', yesterday: 'yesterday', '7d': 'last 7 days', '30d': 'last 30 days', custom: 'custom range' };
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

  constructor() {
    this.readUrl();
    effect(() => { this.scope(); untracked(() => this.load()); });
    effect(() => { const src = this.source(); untracked(() => src.testNumbers?.().then((n) => this.testNumbers.set(n)).catch(() => {})); });
  }

  // ── Address: period, from, to, agents, tests, box, page ────────────────────
  private readUrl(): void {
    const q = this.route.snapshot.queryParamMap;
    const p = q.get('period') as PeriodKey | null;
    if (p && PERIODS.some((x) => x.key === p)) this.period.set(p);
    if (p === 'custom') { this.customFrom.set(q.get('from') || ''); this.customTo.set(q.get('to') || ''); }
    this.agents.set((q.get('agents') || '').split(',').filter(Boolean));
    this.includeTests.set(q.get('tests') === '1');
    const box = q.get('box'); if (box) { this.box.set({ key: box, label: BOX_LABELS[box] || box }); this.drillPage.set(Math.max(0, Number(q.get('page') || 0))); }
  }
  private writeUrl(): void {
    const b = this.box(); const custom = this.period() === 'custom';
    this.router.navigate([], { relativeTo: this.route, replaceUrl: true, queryParamsHandling: 'merge', queryParams: {
      period: this.period() === '30d' ? null : this.period(), from: custom ? this.customFrom() || null : null, to: custom ? this.customTo() || null : null,
      agents: this.agents().join(',') || null, tests: this.includeTests() ? '1' : null, box: b?.key ?? null, page: b && this.drillPage() ? this.drillPage() : null } });
  }

  async load(): Promise<void> {
    const my = ++this.seq; const sc = this.scope();
    this.loading.set(true); this.error.set('');
    try {
      const rep = await this.source().report(sc);
      if (my !== this.seq) return;
      this.r.set(rep);
      // A list restored from the address gets its proper name once the report is in.
      const b = this.box(); if (b) { const l = rep.funnel.flatMap((x) => x.lines).find((x) => x.key === b.key); if (l && l.label !== b.label) this.box.set({ key: b.key, label: l.label }); await this.fetchBox(); }
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

  protected open(key: string, label: string): void {
    this.box.set({ key, label }); this.drillPage.set(0); this.drillRows.set([]); this.writeUrl(); this.fetchBox();
    setTimeout(() => (this.host.nativeElement.querySelector('.cr-drill') as HTMLElement | null)?.focus(), 0);
  }
  protected close(): void { this.box.set(null); this.drillRows.set([]); this.writeUrl(); }
  protected page(step: number): void { this.drillPage.set(Math.max(0, this.drillPage() + step)); this.writeUrl(); this.fetchBox(); }
  private async fetchBox(): Promise<void> {
    const b = this.box(); if (!b) return;
    try { const res = await this.source().calls(this.scope(), b.key, this.drillPage() * PAGE, PAGE); this.drillRows.set(res.rows); this.drillTotal.set(res.total); }
    catch { this.drillRows.set([]); this.drillTotal.set(0); this.error.set('Could not load these calls.'); }
  }

  /** Menus close on a click anywhere else; Escape closes a menu, then the list. */
  protected onDocClick(ev: Event): void {
    const t = ev.target as HTMLElement | null; if (t?.closest('.cr-drop')) return;
    this.agentsOpen.set(false); this.shareOpen.set(false); this.testsOpen.set(false);
  }
  protected onEscape(): void {
    if (this.agentsOpen() || this.shareOpen() || this.testsOpen()) { this.agentsOpen.set(false); this.shareOpen.set(false); this.testsOpen.set(false); } else if (this.box()) this.close();
  }

  protected async exportBox(): Promise<void> { const b = this.box(); if (b) this.save(await this.source().exportXlsx(this.scope(), b.key), `${this.fileName()}-${b.key}.xlsx`); }
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
    rep.by_agent.forEach((a) => { y += 38; [a.agent, this.num(a.planned), this.num(a.picked_up), this.num(a.answered), this.num(a.success), this.pct(a.success_rate), this.mmss(a.avg_talk_seconds)]
      .forEach((t, i) => text(t, cx[i], y - 13, 13.5, i === 5 ? green : ink, i === 5 ? 600 : 400, i ? 'right' : 'left')); g.fillStyle = line; g.fillRect(M, y, W - 2 * M, 1); });
    y += 44; text('SUCCESS FIELD', M, y, 12, mute, 600); y += 14; let x = M;
    for (const [l, v] of [['Yes', rep.success_field.yes], ['No', rep.success_field.no], ['N/A', rep.success_field.na]] as [string, number][]) {
      g.font = `600 14px ${F}`; const w = g.measureText(`${l}  ${this.num(v)}`).width + 32; rect(x, y, w, 34, '#fff', line, 17); text(l, x + 16, y + 22, 14, mute); text(this.num(v), x + w - 16, y + 22, 14, ink, 600, 'right'); x += w + 10;
    }
    return c;
  }

  protected num(n: number): string { return (n ?? 0).toLocaleString('en-IN'); }
  protected pct(x: number): string { return `${Math.round((x || 0) * 100)}%`; }
  protected mmss(s: number): string { const t = Math.round(s || 0); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; }
  protected hms(s: number): string { const t = Math.round(s || 0), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60; return h ? `${h}h ${m}m` : `${m}m ${sec}s`; }
  protected when(iso: string): string {
    return new Date(iso).toLocaleString('en-GB', { timeZone: this.r()?.time_zone || 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  }
}
