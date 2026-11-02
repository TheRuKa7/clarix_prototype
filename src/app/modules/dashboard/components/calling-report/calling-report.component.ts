import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal, untracked } from '@angular/core';

/**
 * The calling report (Calling-Report-Logic.md v1): headline cards, the four funnel boxes, by agent and the success
 * field, with the filters that scope all of it. Every number opens the calls behind it. Echo and Clarix use this same
 * file; each passes its own CallingReportSource. Keep the two copies identical.
 */

export interface ReportScope { days: number; agents: string[]; includeTests: boolean; }
export interface ReportLineView { key: string; label: string; count: number; share: number; strong?: boolean; sub?: boolean; good?: boolean; }
export interface ReportBox { key: string; step: number; label: string; total: number; lines: ReportLineView[]; }
export interface ByAgentRow { agent: string; agent_key: string; planned: number; picked_up: number; answered: number; success: number; success_rate: number; avg_talk_seconds: number; }
export interface CallingReport {
  generated_at: string; time_zone: string; definitions_version: string; workspace: string; from: string | null; to: string | null; tests_included: boolean;
  headline: { uploaded: number; campaigns: number; planned: number; picked_up: number; answered: number; success: number; planned_share: number; picked_up_share: number; answered_share: number; success_rate: number };
  stats: { dials: number; avg_talk_seconds: number; total_talk_seconds: number; in_progress: number };
  funnel: ReportBox[]; by_agent: ByAgentRow[]; success_field: { yes: number; no: number; na: number };
  sum_check: { ok: boolean; gaps: { box: string; expected: number; got: number }[] }; agents: { key: string; label: string }[];
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
}

const PERIODS = [{ days: 1, label: 'Today' }, { days: 7, label: '7 days' }, { days: 30, label: '30 days' }];
const PAGE = 10;

@Component({
  selector: 'app-calling-report',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
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
          @for (p of PERIODS; track p.days) { <button type="button" [class.on]="days() === p.days" (click)="setDays(p.days)">{{ p.label }}</button> }
        </div>
        <div class="cr-drop">
          <button type="button" class="cr-btn" [class.on]="agents().length" (click)="agentsOpen.set(!agentsOpen())" [attr.aria-expanded]="agentsOpen()">{{ agents().length ? agents().length + ' agent' + (agents().length > 1 ? 's' : '') : 'All agents' }} ▾</button>
          @if (agentsOpen()) {
            <div class="cr-menu" role="listbox" aria-label="Agents">
              <label class="cr-opt"><input type="checkbox" [checked]="!agents().length" (change)="setAgents([])"> All agents</label>
              @for (a of r()?.agents ?? []; track a.key) {
                <label class="cr-opt"><input type="checkbox" [checked]="agents().includes(a.key)" (change)="toggleAgent(a.key)"> {{ a.label }}</label>
              }
            </div>
          }
        </div>
        <label class="cr-check" title="Internal test calls are left out of every number unless this is on."><input type="checkbox" [checked]="includeTests()" (change)="setTests(!includeTests())"> Include test calls</label>
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

      @if (error()) { <p class="cr-note bad" role="alert">{{ error() }} <button type="button" class="cr-link" (click)="load()">Try again</button></p> }

      @if (r(); as rep) {
        <div class="cr-cards">
          <button type="button" class="cr-card" (click)="open('uploaded', 'Uploaded')"><span>Uploaded</span><b>{{ num(rep.headline.uploaded) }}</b><small>{{ rep.headline.campaigns }} campaign{{ rep.headline.campaigns === 1 ? '' : 's' }}</small></button>
          <button type="button" class="cr-card" (click)="open('planned', 'Planned')"><span>Planned</span><b>{{ num(rep.headline.planned) }}</b><small>{{ pct(rep.headline.planned_share) }} of uploaded</small></button>
          <button type="button" class="cr-card" (click)="open('picked_up', 'Picked up')"><span>Picked up</span><b>{{ num(rep.headline.picked_up) }}</b><small>{{ pct(rep.headline.picked_up_share) }} of planned</small></button>
          <button type="button" class="cr-card" (click)="open('answered', 'Answered')"><span>Answered</span><b>{{ num(rep.headline.answered) }}</b><small>{{ pct(rep.headline.answered_share) }} of picked up</small></button>
          <button type="button" class="cr-card good" (click)="open('success', 'Success')"><span>Success</span><b>{{ num(rep.headline.success) }}</b><small>Success rate {{ pct(rep.headline.success_rate) }}</small></button>
        </div>
        <div class="cr-stats">
          <div><span>Dials</span><b>{{ num(rep.stats.dials) }}</b></div>
          <div><span>Avg talk time</span><b>{{ mmss(rep.stats.avg_talk_seconds) }}</b></div>
          <div><span>Total talk time</span><b>{{ hms(rep.stats.total_talk_seconds) }}</b></div>
          <button type="button" (click)="open('in_progress', 'In progress')" [disabled]="!rep.stats.in_progress"><span>In progress</span><b>{{ num(rep.stats.in_progress) }}</b></button>
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
        <div class="cr-drill" role="region" [attr.aria-label]="bx.label + ' calls'">
          <div class="cr-drill-head">
            <b>{{ bx.label }}</b><span>{{ drillTotal() }} call{{ drillTotal() === 1 ? '' : 's' }}</span><span class="cr-grow"></span>
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
        </div>
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
    .cr-calls .cr-tr { grid-template-columns: 1.2fr 1.2fr 1.2fr 1.5fr 1fr 1.6fr .7fr; text-align: left; }
    .cr-calls .cr-tr > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cr-chips { display: flex; gap: 10px; flex-wrap: wrap; }
    .cr-chips button { border: 1px solid var(--cr-line); border-radius: 999px; background: var(--cr-bg); padding: 6px 16px; font: inherit; font-size: 14px; color: var(--cr-muted); cursor: pointer; }
    .cr-chips b { color: var(--cr-text); margin-left: 4px; }
    .cr-drill { border: 1px solid var(--cr-accent); border-radius: 12px; padding: 12px; display: grid; gap: 10px; background: var(--cr-bg); }
    .cr-drill-head { display: flex; gap: 10px; align-items: center; }
    .cr-drill-head span { color: var(--cr-muted); font-size: 13px; }
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
  readonly initialDays = input(30);
  /** Tells the page around the report when the period or agents change, so its other sections follow. */
  readonly scopeChange = output<ReportScope>();

  protected readonly PERIODS = PERIODS;
  protected readonly PAGE = PAGE;
  protected readonly days = signal(30);
  protected readonly agents = signal<string[]>([]);
  protected readonly includeTests = signal(false);
  protected readonly r = signal<CallingReport | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly agentsOpen = signal(false);
  protected readonly shareOpen = signal(false);
  protected readonly box = signal<{ key: string; label: string } | null>(null);
  protected readonly drillRows = signal<ReportCallRow[]>([]);
  protected readonly drillTotal = signal(0);
  protected readonly drillPage = signal(0);
  private seq = 0;

  protected readonly scope = computed<ReportScope>(() => ({ days: this.days(), agents: this.agents(), includeTests: this.includeTests() }));
  protected readonly periodLabel = computed(() => {
    const d = this.days(); const to = new Date(); const from = new Date(to.getTime() - (d === 1 ? 0 : d) * 86400000);
    const f = (x: Date, y = true) => x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(y ? { year: 'numeric' } : {}) });
    return d === 1 ? `${f(to)} (today)` : `${f(from, from.getFullYear() !== to.getFullYear())}–${f(to)} (last ${d} days)`;
  });
  protected readonly agentLabel = computed(() => {
    const a = this.agents(); if (!a.length) return 'All agents';
    const names = a.map((k) => this.r()?.agents.find((x) => x.key === k)?.label ?? k); return names.length > 2 ? `${names.length} agents` : names.join(', ');
  });
  protected readonly tzLabel = computed(() => {
    const tz = this.r()?.time_zone || 'Asia/Kolkata';
    const off = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value?.replace('GMT', 'UTC') || '';
    return `${tz === 'Asia/Kolkata' ? 'IST' : tz} (${off.includes(':') || off === 'UTC' ? off : off + ':00'})`;
  });

  constructor() {
    effect(() => { const d = this.initialDays(); untracked(() => this.days.set(d)); });
    effect(() => { this.scope(); untracked(() => this.load()); });
  }

  async load(): Promise<void> {
    const my = ++this.seq; const sc = this.scope();
    this.loading.set(true); this.error.set('');
    try {
      const rep = await this.source().report(sc);
      if (my !== this.seq) return;
      this.r.set(rep);
      if (this.box()) await this.fetchBox();
    } catch (e) {
      if (my === this.seq) this.error.set('Could not load the calling report.');
    } finally { if (my === this.seq) this.loading.set(false); }
  }

  protected setDays(d: number): void { this.days.set(d); this.emit(); }
  protected setAgents(a: string[]): void { this.agents.set(a); this.agentsOpen.set(false); this.emit(); }
  protected toggleAgent(k: string): void { const a = this.agents(); this.agents.set(a.includes(k) ? a.filter((x) => x !== k) : [...a, k]); this.emit(); }
  protected setTests(on: boolean): void { this.includeTests.set(on); this.emit(); }
  private emit(): void { this.drillPage.set(0); this.scopeChange.emit(this.scope()); }

  protected open(key: string, label: string): void { this.box.set({ key, label }); this.drillPage.set(0); this.fetchBox(); }
  protected close(): void { this.box.set(null); this.drillRows.set([]); }
  protected page(step: number): void { this.drillPage.set(Math.max(0, this.drillPage() + step)); this.fetchBox(); }
  private async fetchBox(): Promise<void> {
    const b = this.box(); if (!b) return;
    try { const res = await this.source().calls(this.scope(), b.key, this.drillPage() * PAGE, PAGE); this.drillRows.set(res.rows); this.drillTotal.set(res.total); }
    catch { this.drillRows.set([]); this.drillTotal.set(0); this.error.set('Could not load these calls.'); }
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
  private fileName(): string { const slug = this.agents().length ? this.agentLabel().toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'all-agents'; return `calling-report-${slug}-${this.days() === 1 ? 'today' : this.days() + 'd'}-${new Date().toISOString().slice(0, 10)}`; }

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
      ['Picked up', h.picked_up, `${this.pct(h.picked_up_share)} of planned`, false], ['Answered', h.answered, `${this.pct(h.answered_share)} of picked up`, false], ['Success', h.success, `Success rate ${this.pct(h.success_rate)}`, true]];
    const cw = (W - 2 * M - 4 * 12) / 5;
    cards.forEach(([l, v, s, good], i) => { const x = M + i * (cw + 12); rect(x, y, cw, 100, good ? greenBg : '#fff', good ? greenLine : line); text(l, x + 16, y + 26, 13, mute); text(this.num(v), x + 16, y + 64, 34, good ? green : ink, 700); text(s, x + 16, y + 86, 12.5, good ? green : mute, good ? 600 : 400); });
    y += 112; const sw = (W - 2 * M - 3 * 12) / 4;
    [['Dials', this.num(rep.stats.dials)], ['Avg talk time', this.mmss(rep.stats.avg_talk_seconds)], ['Total talk time', this.hms(rep.stats.total_talk_seconds)], ['In progress', this.num(rep.stats.in_progress)]]
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
