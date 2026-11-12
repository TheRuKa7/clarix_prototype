import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal, untracked } from '@angular/core';

/**
 * New campaign, as one modal in two steps: 1 Upload sheet (agent, template, check) and 2 Schedule (now or a free slot), then a summary.
 * Echo and Clarix use this same file, each with its own source. Keep the two copies identical.
 */
export interface WizardAgent { key: string; label: string; description?: string; inputs: string[] }
export interface WizardBadRow { row: number; reason: string }
export interface WizardCheck {
  file: string; rows: number; will_dial: number; bad: WizardBadRow[]; tests: number; missing: string[];
  columns?: { key: string; label: string }[]; sheet_rows?: { row: number; is_dummy?: boolean; cells: Record<string, string> }[]; countries?: { code: string; name: string; rows: number }[];
}
export interface WizardCountry { code: string; name: string; tz_label: string; law?: string }
export interface WizardSlot { at: string; local: string; utc: string; utc_day: number; status: 'free' | 'taken'; by: string }
export interface WizardSlots { country: string; name: string; tz_label: string; law: string; date: string; today: string; line: string; hours: { from: string; to: string } | null; closed: string; slots: WizardSlot[] }
export interface WizardEstimate { calls: number; starts_at: string; ends_at: string; check_back_at: string; duration_min: number; spans_days: boolean; country: string; tz_label: string; offset_min: number }
export type WizardStarted = WizardEstimate & { campaign_id: string | null; scheduled: boolean };
export interface CampaignWizardSource {
  agents(): Promise<WizardAgent[]>;
  template(agent: string): Promise<Blob>;
  check(agent: string, file: File): Promise<WizardCheck>;
  countries(): Promise<WizardCountry[]>;
  slots(agent: string, country: string, date: string): Promise<WizardSlots>;
  estimate(b: { calls: number; when: string; country: string }): Promise<WizardEstimate>;
  badRows(columns: string[], rows: { row: number; reason: string; cells: Record<string, string> }[]): Promise<Blob>;
  start(agent: string, file: File, o: { when: string; country: string }): Promise<WizardStarted>;
  opened(campaignId: string): void;
}
interface BadLine { row: number; reason: string; cells: Record<string, string> }

const PAGE = 8;
function download(blob: Blob, name: string): void { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
/** A moment as "Fri 13 Nov, 09:30" in a fixed offset from UTC. */
function stamp(iso: string, offsetMin: number): string {
  return new Date(Date.parse(iso) + offsetMin * 60000).toLocaleString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
const shortTz = (label: string) => label.split(' (')[0];
const mins = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);

@Component({
  selector: 'app-new-campaign',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'cancel()' },
  styles: [`
    :host { --m-text: var(--ds-text, var(--text, #0c0a09)); --m-muted: var(--ds-text-muted, var(--muted, #5c5752)); --m-line: var(--ds-border, var(--line, #e7e5e2)); --m-bg: var(--ds-surface, var(--card, #fff));
      --m-soft: var(--ds-surface-sunken, var(--bg-2, #f5f5f4)); --m-accent: var(--ds-accent, var(--accent, #4c4184)); --m-on: var(--ds-on-accent, #fff); --m-good: var(--ds-success-fg, #146c34); --m-bad: var(--ds-danger-fg, #b91c1c);
      --m-warn: var(--ds-warning-fg, #a16207); --m-r: var(--ds-r-md, 8px); color: var(--m-text); font-size: 13px; }
    .nm-backdrop { position: fixed; inset: 0; z-index: 1000; background: rgba(12, 10, 9, .48); display: grid; place-items: center; padding: 12px; }
    .nm { width: min(720px, 100%); max-height: calc(100vh - 24px); display: flex; flex-direction: column; background: var(--m-bg); border: 1px solid var(--m-line); border-radius: 12px; box-shadow: 0 24px 60px rgba(0, 0, 0, .28); overflow: hidden; }
    .nm-head { display: flex; align-items: flex-start; gap: 12px; padding: 16px 20px 12px; border-bottom: 1px solid var(--m-line); }
    .nm-head h2 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -.02em; }
    .nm-steps { margin: 4px 0 0; display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--m-muted); font-size: 12px; }
    .nm-steps b { color: var(--m-text); }
    .nm-x { margin-left: auto; flex: none; width: 32px; height: 32px; border: 0; border-radius: 8px; background: none; color: var(--m-muted); font-size: 18px; line-height: 1; cursor: pointer; }
    .nm-x:hover { background: var(--m-soft); color: var(--m-text); }
    .nm-body { padding: 16px 20px; overflow-y: auto; overscroll-behavior: contain; display: grid; gap: 14px; align-content: start; min-width: 0; }
    .nm-body > * { min-width: 0; }
    .nm-foot { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; padding: 12px 20px; border-top: 1px solid var(--m-line); background: var(--m-bg); }
    .nm-field { display: grid; gap: 6px; }
    .nm-field > label, .nm-label { font-weight: 600; font-size: 13px; }
    .nm-desc { margin: 0; color: var(--m-muted); font-size: 13px; line-height: 1.45; }
    .nm-row { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
    .nm-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 0 14px; border: 1px solid var(--ds-border-strong, var(--m-line)); background: var(--m-bg); color: var(--m-text);
      border-radius: var(--m-r); font: inherit; font-size: 13px; font-weight: 550; cursor: pointer; white-space: nowrap; }
    .nm-btn:hover:not(:disabled) { background: var(--m-soft); }
    .nm-btn:disabled { opacity: .5; cursor: not-allowed; }
    .nm-btn.sm { min-height: 30px; padding: 0 10px; font-size: 12px; }
    .nm-btn.primary { background: var(--m-accent); border-color: var(--m-accent); color: var(--m-on); }
    .nm-btn.primary:hover:not(:disabled) { background: var(--ds-accent-hover, var(--m-accent)); filter: brightness(1.06); }
    .nm-btn:focus-visible, .nm-slot:focus-visible, .nm-seg button:focus-visible, .nm-x:focus-visible { outline: 2px solid var(--ds-focus, var(--m-accent)); outline-offset: 2px; }
    select, input[type=date] { min-height: 36px; padding: 0 10px; border: 1px solid var(--ds-border-input, var(--m-line)); border-radius: var(--m-r); background-color: var(--ds-input-bg, var(--m-bg)); color: var(--m-text); font: inherit; font-size: 13px; max-width: 100%; }
    select { width: 100%; }
    input[type=file] { font: inherit; font-size: 13px; color: var(--m-muted); max-width: 100%; }
    input[type=file]::file-selector-button { border: 1px solid var(--m-line); background: var(--m-bg); color: var(--m-text); border-radius: 8px; padding: 6px 12px; margin-right: 10px; font: inherit; font-size: 13px; cursor: pointer; }
    .nm-upload { border: 1px dashed var(--ds-border-strong, var(--m-line)); border-radius: 10px; padding: 12px; display: grid; gap: 8px; }
    .nm-nums { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
    .nm-nums div { background: var(--m-soft); border-radius: 8px; padding: 8px 12px; display: grid; gap: 2px; }
    .nm-nums span { font-size: 12px; color: var(--m-muted); }
    .nm-nums b { font-size: 22px; font-variant-numeric: tabular-nums; }
    .nm-nums .ok b { color: var(--m-good); } .nm-nums .no b { color: var(--m-bad); }
    .nm-note { margin: 0; padding: 10px 12px; border-radius: var(--m-r); border: 1px solid var(--m-line); background: var(--m-soft); line-height: 1.45; }
    .nm-note.good { border-color: color-mix(in srgb, var(--m-good) 40%, var(--m-line)); background: color-mix(in srgb, var(--m-good) 8%, var(--m-bg)); color: var(--m-good); }
    .nm-note.bad { border-color: color-mix(in srgb, var(--m-bad) 40%, var(--m-line)); background: color-mix(in srgb, var(--m-bad) 6%, var(--m-bg)); color: var(--m-bad); }
    .nm-table { border: 1px solid var(--m-line); border-radius: 10px; overflow: hidden; }
    .nm-table-head { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; padding: 8px 12px; background: var(--m-soft); border-bottom: 1px solid var(--m-line); }
    .nm-table-head b { margin-right: auto; }
    .nm-scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 12px; color: var(--m-muted); font-weight: 600; padding: 8px 12px; border-bottom: 1px solid var(--m-line); white-space: nowrap; }
    td { padding: 8px 12px; border-top: 1px solid var(--m-line); vertical-align: top; overflow-wrap: anywhere; }
    tbody tr:first-child td { border-top: 0; }
    td.n, th.n { width: 56px; font-variant-numeric: tabular-nums; }
    td small { display: block; color: var(--m-muted); font-size: 12px; }
    td.why { color: var(--m-bad); min-width: 200px; }
    .nm-pager { display: flex; justify-content: flex-end; align-items: center; gap: 10px; padding: 8px 12px; border-top: 1px solid var(--m-line); color: var(--m-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
    .nm-seg { display: inline-flex; padding: 2px; gap: 2px; border: 1px solid var(--m-line); border-radius: var(--m-r); background: var(--m-soft); }
    .nm-seg button { min-height: 32px; border: 0; background: transparent; color: var(--m-muted); border-radius: 6px; padding: 0 12px; font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }
    .nm-seg button.on { background: var(--m-bg); color: var(--m-text); font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, .1); }
    .nm-two { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .nm-slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 6px; }
    .nm-slot { min-height: 34px; padding: 0 6px; border: 1px solid var(--m-line); border-radius: 8px; background: var(--m-bg); color: var(--m-text); font: inherit; font-size: 13px; font-variant-numeric: tabular-nums; cursor: pointer; text-align: center; }
    .nm-slot:hover:not(:disabled) { border-color: var(--m-accent); }
    .nm-slot.on { background: var(--m-accent); border-color: var(--m-accent); color: var(--m-on); font-weight: 600; }
    .nm-slot:disabled { cursor: not-allowed; color: var(--m-muted); background: var(--m-soft); text-decoration: line-through; }
    .nm-legend { color: var(--m-muted); font-size: 12px; line-height: 1.45; }
    .nm-sum { border: 1px solid color-mix(in srgb, var(--m-accent) 35%, var(--m-line)); background: color-mix(in srgb, var(--m-accent) 5%, var(--m-bg)); border-radius: 10px; padding: 12px 14px; display: grid; gap: 8px; }
    .nm-sum dl { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px; }
    .nm-sum dt { color: var(--m-muted); } .nm-sum dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
    .nm-done { display: grid; gap: 6px; justify-items: start; }
    .nm-done h3 { margin: 0; font-size: 16px; }
    @media (max-width: 560px) { .nm-body, .nm-head, .nm-foot { padding-left: 14px; padding-right: 14px; } .nm-sum dl { grid-template-columns: minmax(0, 1fr); gap: 0; } .nm-sum dd { margin-bottom: 6px; } .nm-foot .nm-btn { flex: 1 1 100%; } }
  `],
  template: `
    <div class="nm-backdrop" (mousedown)="backdrop($event)">
      <div class="nm" role="dialog" aria-modal="true" aria-labelledby="nm-title">
        <div class="nm-head">
          <div>
            <h2 id="nm-title">{{ step() === 3 ? (result()?.scheduled ? 'Campaign scheduled' : 'Campaign started') : 'New campaign' }}</h2>
            @if (step() < 3) { <p class="nm-steps"><span [style.fontWeight]="step() === 1 ? 600 : 400">1 · Upload sheet</span><span [style.fontWeight]="step() === 2 ? 600 : 400">2 · Schedule</span></p> }
          </div>
          <button type="button" class="nm-x" (click)="cancel()" aria-label="Close">✕</button>
        </div>

        <div class="nm-body">
          @if (error()) { <p class="nm-note bad" role="alert">{{ error() }}</p> }

          @if (step() === 1) {
            <div class="nm-field">
              <label for="nm-agent">Agent</label>
              <select id="nm-agent" [value]="agent()" (change)="pickAgent($any($event.target).value)">
                <option value="">Choose an agent…</option>
                @for (a of agents(); track a.key) { <option [value]="a.key" [selected]="a.key === agent()">{{ a.label }}</option> }
              </select>
              @if (agentInfo(); as a) { <p class="nm-desc">{{ a.description }}</p> }
            </div>

            <div class="nm-upload">
              <div class="nm-row">
                <button type="button" class="nm-btn" [disabled]="!agent()" (click)="template()">Download template</button>
                <input type="file" accept=".xlsx,.xls,.csv" [disabled]="!agent() || checking()" (change)="pick($any($event.target).files?.[0])" aria-label="Filled template to upload (.xlsx or .csv)">
              </div>
              <span class="nm-desc" [attr.role]="checking() ? 'status' : null">{{ checking() ? 'Checking your sheet…' : 'Fill the template, then upload it here (.xlsx or .csv). It is checked as soon as it is chosen.' }}</span>
            </div>

            @if (check(); as k) {
              @if (k.missing.includes('contact_phone') || !k.rows) {
                <p class="nm-note bad" role="alert">{{ k.rows ? 'The phone column is missing. Every row needs a phone number: add the column and upload again.' : 'No rows found in this file.' }}</p>
              }
              <div class="nm-nums">
                <div><span>Rows in file</span><b>{{ k.rows }}</b></div>
                <div class="ok"><span>Calls that will be placed</span><b>{{ k.will_dial }}</b></div>
                <div [class.no]="k.bad.length"><span>Rows with bad data</span><b>{{ k.bad.length }}</b></div>
              </div>
              @if (k.bad.length) {
                <div class="nm-table">
                  <div class="nm-table-head">
                    <b>Rows with bad data: not called</b>
                    <button type="button" class="nm-btn sm" (click)="downloadBad()" [disabled]="exporting()">{{ exporting() ? 'Preparing…' : 'Download as Excel' }}</button>
                  </div>
                  <div class="nm-scroll">
                    <table>
                      <thead><tr><th class="n">Row</th><th>Contact</th><th>Why</th></tr></thead>
                      <tbody>
                        @for (b of badPage(); track b.row) {
                          <tr><td class="n">{{ b.row }}</td><td>{{ nameOf(b) }}<small>{{ phoneOf(b) }}</small></td><td class="why">{{ b.reason }}</td></tr>
                        }
                      </tbody>
                    </table>
                  </div>
                  @if (badLines().length > PAGE) {
                    <div class="nm-pager">
                      <button type="button" class="nm-btn sm" [disabled]="page() === 0" (click)="page.set(page() - 1)">Previous</button>
                      <span>{{ page() * PAGE + 1 }}–{{ page() * PAGE + badPage().length }} of {{ badLines().length }}</span>
                      <button type="button" class="nm-btn sm" [disabled]="(page() + 1) * PAGE >= badLines().length" (click)="page.set(page() + 1)">Next</button>
                    </div>
                  }
                </div>
              } @else if (k.will_dial) {
                <p class="nm-note good">All {{ k.will_dial }} rows are good.</p>
              }
              @if (k.tests) { <p class="nm-desc">{{ k.tests }} internal test number{{ k.tests === 1 ? ' is' : 's are' }} left out.</p> }
            }
          }

          @if (step() === 2) {
            <div class="nm-field">
              <span class="nm-label">When should it start?</span>
              <div class="nm-seg" role="group" aria-label="When to start">
                <button type="button" [class.on]="mode() === 'now'" [attr.aria-pressed]="mode() === 'now'" (click)="setMode('now')">Run now</button>
                <button type="button" [class.on]="mode() === 'later'" [attr.aria-pressed]="mode() === 'later'" (click)="setMode('later')">Pick a time</button>
              </div>
            </div>
            <div class="nm-two">
              <div class="nm-field">
                <label for="nm-country">Country the calls go to</label>
                <select id="nm-country" (change)="setCountry($any($event.target).value)">
                  @for (c of countries(); track c.code) { <option [value]="c.code" [selected]="c.code === country()">{{ c.name }}</option> }
                </select>
              </div>
              @if (mode() === 'later') {
                <div class="nm-field">
                  <label for="nm-date">Date</label>
                  <input id="nm-date" type="date" [min]="view()?.today || ''" [value]="date()" (change)="setDate($any($event.target).value)">
                </div>
              }
            </div>
            @if (countryInfo(); as ci) { <p class="nm-legend">{{ ci.law }}</p> }

            @if (mode() === 'later') {
              <div class="nm-field">
                <div class="nm-row">
                  <span class="nm-label">Free slots</span>
                  <div class="nm-seg" role="group" aria-label="Time zone">
                    <button type="button" [class.on]="tz() === 'local'" [attr.aria-pressed]="tz() === 'local'" (click)="tz.set('local')">{{ localTz() }}</button>
                    <button type="button" [class.on]="tz() === 'utc'" [attr.aria-pressed]="tz() === 'utc'" (click)="tz.set('utc')">UTC</button>
                  </div>
                </div>
                @if (loadingSlots()) { <span class="nm-desc" role="status">Loading slots…</span> }
                @else if (view(); as v) {
                  @if (v.closed) { <p class="nm-note">{{ v.closed }}</p> }
                  @else {
                    <div class="nm-slots" role="group" aria-label="Start time">
                      @for (s of v.slots; track s.at) {
                        <button type="button" class="nm-slot" [class.on]="slot() === s.at" [disabled]="s.status === 'taken'" [attr.aria-pressed]="slot() === s.at"
                          [title]="s.status === 'taken' ? 'In use on ' + v.line + (s.by ? ' by ' + s.by : '') : 'Start at ' + label(s)" (click)="slot.set(s.at)">{{ label(s) }}</button>
                      }
                    </div>
                    <p class="nm-legend">Open {{ v.hours?.from }}–{{ v.hours?.to }} {{ shortTz(v.tz_label) }}. Crossed-out slots are taken: another agent is calling from the same number ({{ v.line }}) then.</p>
                  }
                }
              </div>
            }

            @if (est(); as e) {
              <div class="nm-sum" aria-live="polite">
                <dl>
                  <dt>Calls to place</dt><dd>{{ e.calls }}</dd>
                  <dt>Starts</dt><dd>{{ startText(e) }}</dd>
                  <dt>Expected to finish</dt><dd>{{ stampIn(e.ends_at, e) }} (about {{ minutes(e.duration_min) }}{{ e.spans_days ? ', over more than one day' : '' }})</dd>
                  <dt>Check back after</dt><dd>{{ stampIn(e.check_back_at, e) }}</dd>
                </dl>
                <span class="nm-legend">Times in {{ tz() === 'utc' ? 'UTC' : localTz() }}. Calls only go out inside the country's calling hours.</span>
              </div>
            } @else if (mode() === 'later') { <p class="nm-desc">Pick a free slot to see when the campaign should be done.</p> }
          }

          @if (step() === 3) {
            @if (result(); as r) {
              <div class="nm-done">
                <h3>{{ r.calls }} call{{ r.calls === 1 ? '' : 's' }} {{ r.scheduled ? 'scheduled' : 'queued' }}</h3>
                <p class="nm-desc">It starts {{ stampIn(r.starts_at, r) }} and should be done around {{ stampIn(r.ends_at, r) }}.</p>
                <p class="nm-desc"><b>Come back after {{ stampIn(r.check_back_at, r) }}</b> to see how the calls went.{{ r.scheduled ? ' It shows in Campaigns when it starts.' : '' }}</p>
              </div>
            }
          }
        </div>

        <div class="nm-foot">
          @if (step() === 1) {
            <button type="button" class="nm-btn" (click)="cancel()">Cancel</button>
            @if (check(); as k) {
              <button type="button" class="nm-btn primary" [disabled]="!k.will_dial || k.missing.includes('contact_phone') || checking()" (click)="goSchedule()">{{ k.bad.length ? 'Continue with ' + k.will_dial + ' valid call' + (k.will_dial === 1 ? '' : 's') : 'Next' }}</button>
            } @else { <button type="button" class="nm-btn primary" disabled>Next</button> }
          }
          @if (step() === 2) {
            <button type="button" class="nm-btn" (click)="step.set(1)">Back</button>
            <button type="button" class="nm-btn primary" [disabled]="busy() || !est() || (mode() === 'later' && !slot())" (click)="start()">{{ busy() ? 'Starting…' : mode() === 'now' ? 'Start campaign' : 'Schedule campaign' }}</button>
          }
          @if (step() === 3) {
            @if (result()?.campaign_id) { <button type="button" class="nm-btn primary" (click)="openCampaign()">View campaign</button> }
            @else { <button type="button" class="nm-btn primary" (click)="finish()">Done</button> }
          }
        </div>
      </div>
    </div>
  `,
})
export class NewCampaignComponent {
  readonly source = input.required<CampaignWizardSource>();
  /** True when a campaign was started or scheduled, so the page behind can refresh. */
  readonly closed = output<boolean>();

  protected readonly PAGE = PAGE;
  protected readonly shortTz = shortTz;
  protected readonly minutes = mins;
  protected readonly step = signal(1);
  protected readonly agents = signal<WizardAgent[]>([]);
  protected readonly agent = signal('');
  protected readonly file = signal<File | null>(null);
  protected readonly check = signal<WizardCheck | null>(null);
  protected readonly checking = signal(false);
  protected readonly error = signal('');
  protected readonly page = signal(0);
  protected readonly exporting = signal(false);
  protected readonly countries = signal<WizardCountry[]>([]);
  protected readonly country = signal('IN');
  protected readonly mode = signal<'now' | 'later'>('now');
  protected readonly tz = signal<'local' | 'utc'>('local');
  protected readonly date = signal('');
  protected readonly slot = signal('');
  protected readonly view = signal<WizardSlots | null>(null);
  protected readonly loadingSlots = signal(false);
  protected readonly est = signal<WizardEstimate | null>(null);
  protected readonly busy = signal(false);
  protected readonly result = signal<WizardStarted | null>(null);
  private slotSeq = 0;
  private estSeq = 0;
  private started = false;

  protected readonly agentInfo = computed(() => this.agents().find((a) => a.key === this.agent()) ?? null);
  protected readonly countryInfo = computed(() => this.countries().find((c) => c.code === this.country()) ?? null);
  protected readonly localTz = computed(() => shortTz(this.countryInfo()?.tz_label || this.view()?.tz_label || 'Local'));
  /** Bad rows with the cells of the sheet they came from, so a reader can tell who they are. */
  protected readonly badLines = computed<BadLine[]>(() => {
    const k = this.check(); if (!k) return [];
    const cells = new Map((k.sheet_rows || []).filter((r) => !r.is_dummy).map((r) => [r.row, r.cells]));
    return k.bad.map((b) => ({ row: b.row, reason: b.reason, cells: cells.get(b.row) || {} }));
  });
  protected readonly badPage = computed(() => this.badLines().slice(this.page() * PAGE, (this.page() + 1) * PAGE));

  constructor() {
    effect(() => { const s = this.source(); untracked(() => {
      s.agents().then((a) => this.agents.set(a)).catch(() => this.error.set('Could not load the agents.'));
      s.countries().then((c) => this.countries.set(c)).catch(() => this.error.set('Could not load the countries.'));
    }); });
    // Free slots for the agent's line, in the picked country and on the picked date.
    effect(() => {
      const on = this.step() === 2 && this.mode() === 'later'; const agent = this.agent(); const country = this.country(); const date = this.date();
      untracked(() => { if (!on || !agent) return; const my = ++this.slotSeq; this.loadingSlots.set(true);
        this.source().slots(agent, country, date).then((v) => { if (my !== this.slotSeq) return; this.view.set(v); if (!date) this.date.set(v.date); if (!v.slots.some((s) => s.at === this.slot() && s.status === 'free')) this.slot.set(''); })
          .catch(() => { if (my === this.slotSeq) this.error.set('Could not load the slots.'); }).finally(() => { if (my === this.slotSeq) this.loadingSlots.set(false); }); });
    });
    // When the campaign should be done: from now, or from the picked slot.
    effect(() => {
      const on = this.step() === 2; const mode = this.mode(); const slot = this.slot(); const country = this.country(); const calls = this.check()?.will_dial ?? 0;
      untracked(() => { if (!on || !calls) return; if (mode === 'later' && !slot) { this.est.set(null); return; }
        const my = ++this.estSeq; this.source().estimate({ calls, when: mode === 'now' ? 'now' : slot, country }).then((e) => { if (my === this.estSeq) this.est.set(e); }).catch(() => { if (my === this.estSeq) this.est.set(null); }); });
    });
  }

  protected backdrop(e: MouseEvent): void { if (e.target === e.currentTarget) this.cancel(); }
  protected cancel(): void { this.closed.emit(this.started); }
  protected finish(): void { this.closed.emit(true); }
  protected openCampaign(): void { const id = this.result()?.campaign_id; if (id) { this.closed.emit(true); this.source().opened(id); } }

  protected pickAgent(key: string): void {
    this.agent.set(key); this.file.set(null); this.check.set(null); this.page.set(0); this.error.set('');
  }
  protected async template(): Promise<void> {
    try { download(await this.source().template(this.agent()), `${(this.agentInfo()?.label || 'agent').replace(/[^A-Za-z0-9]+/g, '_')}_template.xlsx`); } catch { this.error.set('Could not download the template.'); }
  }
  protected async pick(f: File | undefined): Promise<void> {
    this.file.set(f ?? null); this.check.set(null); this.page.set(0); this.error.set(''); if (!f) return;
    this.checking.set(true);
    try {
      const k = await this.source().check(this.agent(), f); this.check.set(k);
      const main = k.countries?.[0]?.code; if (main && this.countries().some((c) => c.code === main)) this.country.set(main);
    } catch (e) { this.error.set(e instanceof Error ? e.message : 'Could not read that file.'); } finally { this.checking.set(false); }
  }
  protected nameOf(b: BadLine): string { const k = Object.keys(b.cells).find((c) => /name/i.test(c)); return (k && b.cells[k]) || '—'; }
  protected phoneOf(b: BadLine): string { const k = Object.keys(b.cells).find((c) => /phone|mobile/i.test(c)); return (k && b.cells[k]) || ''; }
  protected async downloadBad(): Promise<void> {
    const k = this.check(); if (!k) return; this.exporting.set(true);
    try { download(await this.source().badRows((k.columns || []).map((c) => c.key), this.badLines()), 'rows_with_bad_data.xlsx'); } catch { this.error.set('Could not prepare the Excel file.'); } finally { this.exporting.set(false); }
  }

  protected goSchedule(): void { this.error.set(''); this.step.set(2); }
  protected setMode(m: 'now' | 'later'): void { this.mode.set(m); if (m === 'now') this.slot.set(''); }
  protected setCountry(c: string): void { this.country.set(c); this.slot.set(''); this.date.set(''); }
  protected setDate(d: string): void { this.date.set(d); this.slot.set(''); }
  protected label(s: WizardSlot): string { return this.tz() === 'utc' ? `${s.utc}${s.utc_day ? ` ${s.utc_day > 0 ? '+' : '−'}${Math.abs(s.utc_day)}d` : ''}` : s.local; }
  protected stampIn(iso: string, e: { offset_min: number }): string { return stamp(iso, this.tz() === 'utc' ? 0 : e.offset_min); }
  protected startText(e: WizardEstimate): string {
    const wait = Date.parse(e.starts_at) - Date.now();
    return this.mode() === 'now' && wait < 120000 ? 'Right away' : `${this.stampIn(e.starts_at, e)}${this.mode() === 'now' ? ' (when calling hours open)' : ''}`;
  }

  protected async start(): Promise<void> {
    const f = this.file(); if (!f || !this.agent()) return; this.busy.set(true); this.error.set('');
    try {
      const r = await this.source().start(this.agent(), f, { when: this.mode() === 'now' ? 'now' : this.slot(), country: this.country() });
      this.result.set(r); this.started = true; this.step.set(3);
    } catch (e) { this.error.set(e instanceof Error ? e.message : 'Could not start the campaign.'); } finally { this.busy.set(false); }
  }
}
