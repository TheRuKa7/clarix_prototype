import { ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

/**
 * One call page: every call list in Echo and Clarix opens this, by report row id. Header with the call status and outcome,
 * summary, answers, next step, recording, transcript, dials, inputs and (where kept) the timeline; Previous and Next step
 * through the call's campaign; a person can change the outcome of an answered call. Rows with no conversation show their
 * dials and reason instead. Echo and Clarix use this same file with their own CallPageSource. Keep the two copies identical.
 */

export interface CallDetail {
  id: string; call_id: string | null; campaign_id: string; agent: string; campaign: string; uploaded_by: string; caller_name: string; phone: string; email: string;
  call_date: string | null; duration_seconds: number | null; retries: number; dials_count: number; call_status: string; status_reason: string; goal_reached: string;
  callback_at: string | null; summary: string; outcome_source?: 'review' | 'person'; changed_by?: string; changed_at?: string | null; change_note?: string; review_status_reason?: string;
  answers: { key: string; label: string; value: string }[]; inputs: { key: string; value: string }[]; transcript: { who: string; text: string; at: string | null }[];
  has_audio: boolean; audio_path: string | null; dials: { n: number; at: string; ring_seconds: number | null; talk_seconds: number | null; result: string; provider: string }[];
  timeline: { at: string; type: string; status: string; detail: string }[]; prev_id: string | null; next_id: string | null; position: number; of: number; outcome_options: string[];
}
export interface CallPageSource {
  detail(id: string): Promise<CallDetail>;
  audio(path: string): Promise<Blob>;
  changeOutcome(id: string, statusReason: string, note: string): Promise<CallDetail>;
  /** Where Back goes when the page was opened directly (no list to go back to). */
  home: string;
  /** The route the page lives at, for Previous and Next, e.g. "/calls". */
  base: string;
}

const COLORS: Record<string, string> = { success: '#16a34a', not_successful: '#dc2626', no_conversation: '#7c3aed', not_picked_up: '#d97706', in_progress: '#a8a29e', not_planned: '#d6d3d1' };

@Component({
  selector: 'app-call-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cp" [class.cp-busy]="loading()">
      <div class="cp-bar">
        <button type="button" class="cp-btn" (click)="back()">← Back</button>
        @if (d(); as c) {
          @if (c.of > 1) {
            <button type="button" class="cp-btn" [disabled]="!c.prev_id" (click)="go(c.prev_id)">‹ Previous</button>
            <span class="cp-muted">{{ c.position }} of {{ c.of }} in this campaign</span>
            <button type="button" class="cp-btn" [disabled]="!c.next_id" (click)="go(c.next_id)">Next ›</button>
          }
          <span class="cp-grow"></span>
          @if (audioUrl()) { <a class="cp-btn" [href]="audioUrl()" [download]="'recording-' + c.id + '.wav'">Download audio</a> }
          <button type="button" class="cp-btn" (click)="exportJson()">Export JSON</button>
        }
      </div>

      @if (error()) { <p class="cp-note bad" role="alert">{{ error() }}</p> }

      @if (d(); as c) {
        <header class="cp-head">
          <div>
            <h1 class="cp-title">{{ c.caller_name || c.phone || 'Unknown caller' }}</h1>
            <p class="cp-sub">{{ c.phone }}@if (c.email) { · {{ c.email }} }</p>
            <p class="cp-sub">{{ c.agent }} · {{ c.campaign }}@if (c.call_date) { · {{ when(c.call_date) }} } · talk {{ mmss(c.duration_seconds) }} · {{ c.dials_count }} dial{{ c.dials_count === 1 ? '' : 's' }}</p>
          </div>
          <div class="cp-chips">
            <span class="cp-chip"><i [style.background]="color()"></i>{{ c.call_status }}</span>
            <span class="cp-chip" [title]="c.status_reason">{{ c.status_reason }}</span>
            <span class="cp-chip" [class.good]="c.goal_reached === 'Yes'">Goal: {{ c.goal_reached }}</span>
          </div>
        </header>

        @if (c.outcome_source === 'person') {
          <p class="cp-note">Outcome changed by {{ c.changed_by }}@if (c.changed_at) { on {{ when(c.changed_at) }} }: "{{ c.review_status_reason }}" → "{{ c.status_reason }}"@if (c.change_note) { · {{ c.change_note }} }</p>
        }
        @if (answered()) {
          @if (editing()) {
            <div class="cp-card cp-edit">
              <b>Change outcome</b>
              <select [value]="pick()" (change)="pick.set($any($event.target).value)" aria-label="Outcome">
                @for (o of c.outcome_options; track o) { <option [value]="o" [selected]="o === pick()">{{ o }}</option> }
              </select>
              <input type="text" placeholder="Why (shown on the call)" [value]="note()" (input)="note.set($any($event.target).value)" aria-label="Note">
              <button type="button" class="cp-btn" (click)="editing.set(false)">Cancel</button>
              <button type="button" class="cp-btn cp-primary" (click)="saveOutcome()">Save</button>
            </div>
          } @else { <button type="button" class="cp-link" (click)="startEdit()">Change outcome</button> }
        }

        <div class="cp-grid">
          <div class="cp-col">
            <section class="cp-card">
              <h2>Summary</h2>
              <p>{{ c.summary || reasonText() }}</p>
            </section>
            @if (c.transcript.length) {
              <section class="cp-card">
                <div class="cp-card-head"><h2>Transcript</h2><span class="cp-muted">{{ c.transcript.length }} turns</span><span class="cp-grow"></span>
                  <button type="button" class="cp-link" (click)="copyTranscript()">{{ copied() ? 'Copied' : 'Copy' }}</button><button type="button" class="cp-link" (click)="downloadTranscript()">.txt</button></div>
                <div class="cp-turns">
                  @for (t of c.transcript; track $index) { <div class="cp-turn" [class.agent]="t.who === 'Agent'"><b>{{ t.who }}</b><span>{{ t.text }}</span></div> }
                </div>
              </section>
            } @else {
              <section class="cp-card"><h2>No conversation</h2><p class="cp-muted">{{ reasonText() }}. The dials below show what the line returned.</p></section>
            }
            @if (c.timeline.length) {
              <section class="cp-card">
                <h2>Timeline</h2>
                <div class="cp-rows">@for (e of c.timeline; track $index) { <div class="cp-row"><span class="cp-muted">{{ when(e.at) }}</span><span>{{ e.type }}</span><span class="cp-muted">{{ e.status }}{{ e.detail ? ' · ' + e.detail : '' }}</span></div> }</div>
              </section>
            }
          </div>
          <div class="cp-col">
            @if (c.has_audio) {
              <section class="cp-card"><h2>Recording</h2>
                @if (audioUrl()) { <audio controls [src]="audioUrl()" preload="metadata"></audio> } @else { <p class="cp-muted">Loading the recording…</p> }
              </section>
            }
            <section class="cp-card">
              <h2>Answers</h2>
              @if (c.answers.length) { <div class="cp-kv">@for (a of c.answers; track a.key) { <span>{{ a.label }}</span><b>{{ a.value }}</b> }</div> }
              @else { <p class="cp-muted">No answers were saved on this call.</p> }
            </section>
            @if (c.callback_at || c.status_reason.includes('Follow-up') || c.status_reason.includes('Callback')) {
              <section class="cp-card"><h2>Next step</h2>
                <div class="cp-kv">
                  @if (c.callback_at) { <span>Call back</span><b>{{ c.callback_at }}</b> }
                  <span>What to do</span><b>{{ c.status_reason.includes('Callback') ? 'Call the supplier back at the agreed time' : c.status_reason.includes('Follow-up') ? 'The team acts on the answer' : '—' }}</b>
                </div>
              </section>
            }
            <section class="cp-card">
              <h2>Dials</h2>
              @if (c.dials.length) {
                <div class="cp-rows">@for (x of c.dials; track x.n) { <div class="cp-row"><span>#{{ x.n }} · {{ when(x.at) }}</span><span>{{ x.result || '—' }}</span><span class="cp-muted">ring {{ x.ring_seconds ?? '—' }}s · talk {{ x.talk_seconds ?? '—' }}s{{ x.provider ? ' · ' + x.provider : '' }}</span></div> }</div>
              } @else { <p class="cp-muted">Never dialled.</p> }
            </section>
            @if (c.inputs.length) {
              <section class="cp-card"><h2>Inputs</h2><div class="cp-kv">@for (i of c.inputs; track i.key) { <span>{{ i.key.replaceAll('_', ' ') }}</span><b>{{ i.value }}</b> }</div></section>
            }
          </div>
        </div>
      } @else if (!error()) { <p class="cp-muted">Loading the call…</p> }
    </div>
  `,
  styles: [`
    :host { display: block; --cp-text: var(--ds-text, var(--text, #0c0a09)); --cp-muted: var(--ds-text-muted, var(--muted, #5c5752)); --cp-line: var(--ds-border, var(--line, #e7e5e2));
      --cp-bg: var(--ds-surface, var(--card, #fff)); --cp-soft: var(--ds-surface-sunken, var(--bg-2, #f5f5f4)); --cp-good: var(--ds-success-fg, #146c34); --cp-accent: var(--ds-accent, var(--accent, #4c4184)); }
    .cp { display: grid; gap: 12px; color: var(--cp-text); }
    .cp-busy { opacity: .7; }
    .cp-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .cp-grow { flex: 1; }
    .cp-muted { color: var(--cp-muted); font-size: 12.5px; }
    .cp-btn { border: 1px solid var(--cp-line); background: var(--cp-bg); color: var(--cp-text); border-radius: 8px; padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer; text-decoration: none; }
    .cp-btn:disabled { opacity: .45; cursor: default; }
    .cp-primary { background: var(--cp-text); color: var(--cp-bg); border-color: var(--cp-text); }
    .cp-link { border: 0; background: none; text-decoration: underline; color: var(--cp-muted); cursor: pointer; font: inherit; font-size: 13px; padding: 0 4px; justify-self: start; }
    .cp-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
    .cp-title { margin: 0; font-size: 22px; font-weight: 700; }
    .cp-sub { margin: 3px 0 0; color: var(--cp-muted); font-size: 13px; }
    .cp-chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .cp-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--cp-line); border-radius: 999px; padding: 4px 10px; font-size: 12.5px; background: var(--cp-bg); }
    .cp-chip i { width: 8px; height: 8px; border-radius: 50%; }
    .cp-chip.good { color: var(--cp-good); border-color: currentColor; }
    .cp-note { margin: 0; padding: 8px 12px; border-radius: 8px; background: var(--cp-soft); font-size: 13px; }
    .cp-note.bad { color: var(--ds-danger-fg, #b91c1c); }
    .cp-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 12px; align-items: start; }
    .cp-col { display: grid; gap: 12px; }
    .cp-card { border: 1px solid var(--cp-line); border-radius: 12px; background: var(--cp-bg); padding: 12px 14px; display: grid; gap: 8px; }
    .cp-card h2 { margin: 0; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--cp-muted); font-weight: 600; }
    .cp-card p { margin: 0; font-size: 13.5px; line-height: 1.5; }
    .cp-card-head { display: flex; align-items: center; gap: 8px; }
    .cp-edit { grid-template-columns: auto 1fr 1.4fr auto auto; align-items: center; }
    .cp-edit select, .cp-edit input { border: 1px solid var(--cp-line); border-radius: 8px; padding: 6px 8px; font: inherit; font-size: 13px; background: var(--cp-bg); color: var(--cp-text); }
    .cp-turns { display: grid; gap: 8px; max-height: 520px; overflow: auto; }
    .cp-turn { display: grid; gap: 2px; padding: 8px 10px; border-radius: 10px; background: var(--cp-soft); font-size: 13.5px; max-width: 92%; }
    .cp-turn.agent { background: var(--ds-info-bg, #f2f1fd); justify-self: end; }
    .cp-turn b { font-size: 11.5px; color: var(--cp-muted); font-weight: 600; }
    .cp-kv { display: grid; grid-template-columns: minmax(110px, auto) 1fr; gap: 6px 12px; font-size: 13px; }
    .cp-kv span { color: var(--cp-muted); text-transform: capitalize; }
    .cp-kv b { font-weight: 500; word-break: break-word; }
    .cp-rows { display: grid; gap: 6px; font-size: 12.5px; }
    .cp-row { display: grid; grid-template-columns: 1.2fr 1fr 1.6fr; gap: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--cp-line); }
    .cp-row:last-child { border-bottom: 0; }
    audio { width: 100%; }
    @media (max-width: 900px) { .cp-grid { grid-template-columns: 1fr; } .cp-edit { grid-template-columns: 1fr; } .cp-row { grid-template-columns: 1fr; } }
  `],
})
export class CallPageComponent implements OnDestroy {
  readonly source = input.required<CallPageSource>();
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly id = signal('');
  protected readonly d = signal<CallDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly audioUrl = signal<string | null>(null);
  protected readonly editing = signal(false);
  protected readonly pick = signal('');
  protected readonly note = signal('');
  protected readonly copied = signal(false);
  private seq = 0;

  protected readonly answered = computed(() => { const c = this.d(); return !!c && c.call_status === 'Answered'; });
  protected readonly color = computed(() => {
    const c = this.d(); if (!c) return COLORS['not_planned']; const s = c.call_status;
    if (s === 'Answered') return c.status_reason.startsWith('Success') ? COLORS['success'] : COLORS['not_successful'];
    if (s === 'No reply' || s === 'System issue') return COLORS['no_conversation'];
    if (s === 'Not picked' || s === 'DND' || s === 'Voicemail') return COLORS['not_picked_up'];
    return s === 'In progress' ? COLORS['in_progress'] : COLORS['not_planned'];
  });
  protected readonly reasonText = computed(() => { const c = this.d(); return c ? `${c.call_status}: ${c.status_reason}` : ''; });

  constructor() {
    this.route.paramMap.subscribe((p) => this.id.set(p.get('id') || ''));
    effect(() => { const id = this.id(); if (id) untracked(() => this.load(id)); });
  }
  ngOnDestroy(): void { this.revoke(); }

  private async load(id: string): Promise<void> {
    const my = ++this.seq; this.loading.set(true); this.error.set(''); this.editing.set(false); this.revoke();
    try {
      const c = await this.source().detail(id); if (my !== this.seq) return; this.d.set(c);
      if (c.has_audio && c.audio_path) this.source().audio(c.audio_path).then((b) => { if (my === this.seq) this.audioUrl.set(URL.createObjectURL(b)); }).catch(() => {});
    } catch { if (my === this.seq) this.error.set('Could not load this call.'); }
    finally { if (my === this.seq) this.loading.set(false); }
  }
  private revoke(): void { const u = this.audioUrl(); if (u) URL.revokeObjectURL(u); this.audioUrl.set(null); }

  /** Back to the list the call was opened from (its filters are in its address); straight in, back to the dashboard. */
  protected back(): void {
    // A signal on newer Angular (Clarix), a plain value on older (Echo).
    const n: any = (this.router as any).lastSuccessfulNavigation; const nav = typeof n === 'function' ? n() : n;
    if (nav?.previousNavigation) history.back(); else this.router.navigate([this.source().home]);
  }
  /** Previous and Next replace this page in history, so Back still returns to the list. */
  protected go(id: string | null): void { if (id) this.router.navigate([this.source().base, id], { replaceUrl: true }); }

  protected startEdit(): void { const c = this.d(); if (!c) return; this.pick.set(c.status_reason); this.note.set(''); this.editing.set(true); }
  protected async saveOutcome(): Promise<void> {
    const c = this.d(); if (!c) return;
    try { this.d.set(await this.source().changeOutcome(c.id, this.pick(), this.note())); this.editing.set(false); } catch { this.error.set('Could not change the outcome.'); }
  }

  protected copyTranscript(): void { navigator.clipboard?.writeText(this.transcriptText()); this.copied.set(true); setTimeout(() => this.copied.set(false), 1500); }
  protected downloadTranscript(): void { this.save(new Blob([this.transcriptText()], { type: 'text/plain;charset=utf-8' }), `transcript-${this.d()?.id}.txt`); }
  protected exportJson(): void { const c = this.d(); if (c) this.save(new Blob([JSON.stringify(c, null, 2)], { type: 'application/json' }), `call-${c.id}.json`); }
  private transcriptText(): string { return (this.d()?.transcript ?? []).map((t) => `${t.who}: ${t.text}`).join('\n'); }
  private save(blob: Blob, name: string): void { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }

  protected mmss(s: number | null | undefined): string { if (s == null) return '—'; const t = Math.round(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; }
  protected when(iso: string | null): string { return iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'; }
}
