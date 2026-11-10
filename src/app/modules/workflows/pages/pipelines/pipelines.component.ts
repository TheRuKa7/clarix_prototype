import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { PipelineCall, PipelineRun, PipelineSpec, PipelineSummary } from '../../models/pipeline.model';
import { PipelineService } from '../../services/pipeline.service';

type Tab = 'lanes' | 'aside' | 'calls' | 'back' | 'spec';
const RESHAPE: Record<string, string> = { one: 'One row, one call', fan_out: 'One row, many calls', fan_in: 'Many rows, one call' };
const TYPE_WORD: Record<string, string> = { id: 'kept as text', date: 'YYYY-MM-DD', phone: '+91 phone', number: 'number', text: 'trimmed text' };

/**
 * Build > Pipelines. One spec takes any source to calls and back: read the sheets or the API, clean the values,
 * route rows to agents, look up what is missing, turn rows into calls, hand each agent its inputs, and write
 * every answer back to the rows it stands for. Everything here is a dry run on the pipeline's source: nothing is dialled.
 */
@Component({
  selector: 'app-pipelines',
  imports: [LucideAngularModule],
  templateUrl: './pipelines.component.html',
  styleUrl: './pipelines.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PipelinesComponent {
  private readonly api = inject(PipelineService);
  protected readonly RESHAPE = RESHAPE;

  protected readonly list = signal<PipelineSummary[]>([]);
  protected readonly spec = signal<PipelineSpec | null>(null);
  protected readonly run = signal<PipelineRun | null>(null);
  protected readonly tab = signal<Tab>('lanes');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly withResults = signal(false);
  protected readonly openCall = signal('');
  protected readonly laneFilter = signal('');
  protected readonly draft = signal('');
  protected readonly draftError = signal('');
  protected readonly saved = signal(true);

  protected readonly summary = computed(() => this.list().find((x) => x.id === this.spec()?.id) ?? null);
  protected readonly calls = computed<PipelineCall[]>(() => { const r = this.run(); const f = this.laneFilter(); return (r?.calls ?? []).filter((c) => !f || c.lane === f).slice(0, 60); });
  protected readonly shownOf = computed(() => { const r = this.run(); const f = this.laneFilter(); return f ? r?.lanes.find((l) => l.id === f)?.calls ?? 0 : r?.calls.length ?? 0; });
  protected readonly asideCols = computed(() => [...new Set((this.run()?.quarantine ?? []).flatMap((q) => Object.keys(q.row)))].slice(0, 6));
  protected readonly types = computed(() => Object.entries(this.spec()?.clean.types ?? {}).map(([col, t]) => ({ col, t: TYPE_WORD[t] ?? t })));
  protected readonly backCols = computed(() => { const s = this.run()?.results?.sample?.[0]; return s ? Object.keys(s).filter((k) => !['row_id', 'call_id', 'lane', 'key'].includes(k)) : []; });
  protected readonly maxFunnel = computed(() => Math.max(1, ...(this.run()?.funnel ?? []).map((f) => f.value)));

  constructor() { void this.load(); }

  private async load(): Promise<void> {
    try { const l = await firstValueFrom(this.api.list()); this.list.set(l); if (l[0]) await this.open(l[0].id); }
    catch { this.error.set('Pipelines could not be loaded.'); }
  }
  protected async open(id: string): Promise<void> {
    this.error.set(''); this.openCall.set(''); this.laneFilter.set(''); this.withResults.set(false);
    try { const s = await firstValueFrom(this.api.get(id)); this.spec.set(s); this.draft.set(JSON.stringify(s, null, 2)); this.saved.set(true); this.draftError.set(''); await this.go(); }
    catch { this.error.set('This pipeline could not be opened.'); }
  }
  /** Runs the saved spec, or the edited one when the spec tab has unsaved changes. */
  protected async go(spec: PipelineSpec | null = null): Promise<void> {
    const s = this.spec(); if (!s) return;
    this.busy.set(true); this.error.set('');
    try { this.run.set(await firstValueFrom(this.api.run(s.id, spec, this.withResults()))); }
    catch (e: unknown) { this.error.set(this.message(e, 'The pipeline could not run.')); }
    finally { this.busy.set(false); }
  }
  protected async simulate(): Promise<void> { this.withResults.set(true); this.tab.set('back'); await this.go(this.saved() ? null : this.parsed()); }
  protected async onFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement; const file = input.files?.[0]; input.value = ''; const s = this.spec(); if (!file || !s) return;
    try { const sum = await firstValueFrom(this.api.useFile(s.id, file)); this.list.update((l) => l.map((x) => (x.id === sum.id ? sum : x))); await this.go(); }
    catch (e: unknown) { this.error.set(this.message(e, 'That file could not be read.')); }
  }
  protected async useSample(): Promise<void> {
    const s = this.spec(); if (!s) return;
    const sum = await firstValueFrom(this.api.useSample(s.id)); this.list.update((l) => l.map((x) => (x.id === sum.id ? sum : x))); await this.go();
  }

  // Spec editor
  protected editDraft(v: string): void { this.draft.set(v); this.saved.set(false); this.draftError.set(this.parsed() ? '' : this.draftError()); }
  private parsed(): PipelineSpec | null {
    try { const j = JSON.parse(this.draft()); if (!j?.source || !j?.clean || !Array.isArray(j?.lanes)) { this.draftError.set('A pipeline needs source, clean and lanes.'); return null; } return j; }
    catch (e) { this.draftError.set(`Not valid JSON: ${(e as Error).message}`); return null; }
  }
  protected async tryDraft(): Promise<void> { const j = this.parsed(); if (j) { this.draftError.set(''); await this.go(j); } }
  protected async saveDraft(): Promise<void> {
    const j = this.parsed(); if (!j) return;
    try { const s = await firstValueFrom(this.api.save(j)); this.spec.set(s); this.draft.set(JSON.stringify(s, null, 2)); this.saved.set(true); this.draftError.set(''); await this.go(); }
    catch (e: unknown) { this.draftError.set(this.message(e, 'The pipeline could not be saved.')); }
  }
  protected resetDraft(): void { const s = this.spec(); if (s) { this.draft.set(JSON.stringify(s, null, 2)); this.saved.set(true); this.draftError.set(''); void this.go(); } }

  protected downloadAside(): void {
    const r = this.run(); if (!r) return; const cols = this.asideCols();
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [['Row', 'Stage', 'Lane', 'Reason', ...cols].map(esc).join(','), ...r.quarantine.map((q) => [q.row_id, q.stage, q.lane, q.reason, ...cols.map((c) => q.row[c])].map(esc).join(','))].join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `${r.id}-set-aside.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  protected isMulti(v: unknown): boolean { return String(v).includes('\n'); }
  protected keyText(k: Record<string, string>): string { return Object.entries(k).map(([a, b]) => `${a} ${b}`).join(' · '); }
  protected pct(n: number): number { return Math.max(4, Math.round((n / this.maxFunnel()) * 100)); }
  private message(e: unknown, fallback: string): string { const m = (e as { error?: { message?: string } })?.error?.message; return m || fallback; }
}
