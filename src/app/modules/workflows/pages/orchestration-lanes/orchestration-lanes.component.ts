import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { ConditionOperator, StepCondition, WorkflowTemplate } from '../../models/workflow-template.model';
import { Lane, OrchestrationDefinition, OrchestrationPreview, SampleColumn, SampleDetail, SampleFile, UnmatchedRule } from '../../models/orchestration.model';
import { OrchestrationService } from '../../services/orchestration.service';
import { TemplatePickerComponent } from '../../components/template-picker/template-picker.component';

/** Rule words a person would say; the stored value stays the backend's operator. */
const OPERATORS: { value: ConditionOperator; label: string; needsValue: boolean; many?: boolean }[] = [
  { value: ConditionOperator.EQUALS, label: 'is', needsValue: true },
  { value: ConditionOperator.NOT_EQUALS, label: 'is not', needsValue: true },
  { value: ConditionOperator.IN, label: 'is one of', needsValue: true, many: true },
  { value: ConditionOperator.NOT_IN, label: 'is none of', needsValue: true, many: true },
  { value: ConditionOperator.CONTAINS, label: 'contains', needsValue: true },
  { value: ConditionOperator.NOT_CONTAINS, label: 'does not contain', needsValue: true },
  { value: ConditionOperator.IS_NULL, label: 'is empty', needsValue: false },
  { value: ConditionOperator.IS_NOT_NULL, label: 'is filled', needsValue: false },
];

/**
 * Build > Orchestration. One upload, split by rules into routes; each route sends its rows to one agent,
 * and a row goes to the first route it matches. Rules are built from a real file's columns and values, and
 * the result is shown as you edit: rows per route, rows left over, and what each agent is missing.
 * Clarix decides only which agent gets which rows. How rows become calls is the agent's plan in Echo.
 */
@Component({
  selector: 'app-orchestration-lanes',
  imports: [LucideAngularModule, TemplatePickerComponent],
  templateUrl: './orchestration-lanes.component.html',
  styleUrl: './orchestration-lanes.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrchestrationLanesComponent {
  private readonly api = inject(OrchestrationService);
  protected readonly operators = OPERATORS;

  protected readonly definitions = signal<OrchestrationDefinition[]>([]);
  protected readonly activeId = signal<string | null>(null);
  protected readonly name = signal('');
  protected readonly lanes = signal<Lane[]>([]);
  protected readonly unmatched = signal<UnmatchedRule>({ action: 'leave' });
  protected readonly dirty = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly removing = signal(false);

  protected readonly samples = signal<SampleFile[]>([]);
  protected readonly sample = signal<SampleDetail | null>(null);
  protected readonly preview = signal<OrchestrationPreview | null>(null);
  protected readonly columns = computed<SampleColumn[]>(() => this.sample()?.columns ?? []);
  private previewTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.load();
    // The result follows every edit, a moment after typing stops.
    effect(() => {
      const s = this.sample(); const def = { name: this.name(), lanes: this.lanes(), unmatched: this.unmatched() };
      clearTimeout(this.previewTimer); if (!s) { this.preview.set(null); return; }
      this.previewTimer = setTimeout(async () => { try { this.preview.set(await firstValueFrom(this.api.preview(s.id, def))); } catch { this.preview.set(null); } }, 250);
    });
  }

  private async load(): Promise<void> {
    try {
      const [defs, samples] = await Promise.all([firstValueFrom(this.api.list()), firstValueFrom(this.api.samples())]);
      this.definitions.set(defs); this.samples.set(samples);
      if (defs.length) this.select(defs[0].id); else this.startNew();
      if (samples.length) this.pickSample(samples[0].id);
    } catch { this.error.set('Could not load. Try again.'); }
  }
  protected select(id: string): void {
    const d = this.definitions().find((x) => x.id === id); if (!d) return;
    this.activeId.set(d.id); this.name.set(d.name); this.lanes.set(structuredClone(d.lanes)); this.unmatched.set(d.unmatched ?? { action: 'leave' }); this.dirty.set(false); this.error.set(''); this.removing.set(false);
  }
  protected onSelect(ev: Event): void { const v = (ev.target as HTMLSelectElement).value; if (v) this.select(v); else this.startNew(); }
  protected startNew(): void { this.activeId.set(null); this.name.set(''); this.lanes.set([{ name: '', order: 0, filterRules: [{ field: '', operator: ConditionOperator.EQUALS, value: '' }] }]); this.unmatched.set({ action: 'leave' }); this.dirty.set(false); this.removing.set(false); }
  protected async pickSample(id: string): Promise<void> { try { this.sample.set(await firstValueFrom(this.api.sample(id))); } catch { this.error.set('Could not read that file.'); } }
  protected onSample(ev: Event): void { this.pickSample((ev.target as HTMLSelectElement).value); }
  protected async onFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement; const file = input.files?.[0]; input.value = ''; if (!file) return;
    try { const s = await firstValueFrom(this.api.uploadSample(file)); this.samples.update((l) => [{ id: s.id, name: s.name, rows: s.rows, uploaded: true }, ...l]); this.sample.set(s); this.error.set(''); }
    catch { this.error.set('Could not read that file. Use .xlsx or .csv with a header row.'); }
  }

  private edit(fn: (lanes: Lane[]) => Lane[]): void { this.lanes.update(fn); this.dirty.set(true); }
  protected val(ev: Event): string { return (ev.target as HTMLInputElement).value; }
  protected setName(ev: Event): void { this.name.set(this.val(ev)); this.dirty.set(true); }
  protected addLane(): void { this.edit((l) => [...l, { name: '', order: l.length, filterRules: [{ field: '', operator: ConditionOperator.EQUALS, value: '' }] }]); }
  protected removeLane(i: number): void { this.edit((l) => l.filter((_, x) => x !== i)); }
  protected move(i: number, by: number): void { this.edit((l) => { const n = [...l]; const j = i + by; if (j < 0 || j >= n.length) return l; [n[i], n[j]] = [n[j], n[i]]; return n; }); }
  protected patchLane(i: number, p: Partial<Lane>): void { this.edit((l) => l.map((x, n) => (n === i ? { ...x, ...p } : x))); }
  protected pickAgent(i: number, t: WorkflowTemplate | null): void { this.patchLane(i, { targetTemplateId: t?.id }); }
  protected addRule(i: number): void { this.edit((l) => l.map((x, n) => (n === i ? { ...x, filterRules: [...x.filterRules, { field: '', operator: ConditionOperator.EQUALS, value: '' }] } : x))); }
  protected removeRule(i: number, r: number): void { this.edit((l) => l.map((x, n) => (n === i ? { ...x, filterRules: x.filterRules.filter((_, k) => k !== r) } : x))); }
  protected patchRule(i: number, r: number, p: Partial<StepCondition>): void { this.edit((l) => l.map((x, n) => (n === i ? { ...x, filterRules: x.filterRules.map((y, k) => (k === r ? { ...y, ...p } : y)) } : x))); }
  protected setField(i: number, r: number, ev: Event): void { this.patchRule(i, r, { field: this.val(ev), value: '' }); }
  protected setOp(i: number, r: number, ev: Event): void { this.patchRule(i, r, { operator: this.val(ev) as ConditionOperator }); }
  protected setUnmatched(action: 'leave' | 'route'): void { this.unmatched.update((u) => ({ ...u, action })); this.dirty.set(true); }
  protected pickRestAgent(t: WorkflowTemplate | null): void { this.unmatched.update((u) => ({ ...u, targetTemplateId: t?.id })); this.dirty.set(true); }

  protected op(rule: StepCondition) { return OPERATORS.find((o) => o.value === rule.operator) ?? OPERATORS[0]; }
  /** Values to pick from, when the column repeats in the file; otherwise the value is typed. */
  protected valuesFor(field: string) { return this.columns().find((c) => c.name === field)?.values ?? []; }
  protected hasColumn(field: string): boolean { return this.columns().some((c) => c.name === field); }
  protected chosen(rule: StepCondition): string[] { return String(rule.value ?? '').split(',').map((v) => v.trim()).filter(Boolean); }
  protected toggleValue(i: number, r: number, rule: StepCondition, v: string): void { const cur = this.chosen(rule); this.patchRule(i, r, { value: (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]).join(', ') }); }
  protected routeResult(i: number) { return this.preview()?.routes.find((x) => x.index === i) ?? null; }
  protected laneTitle(lane: Lane, i: number): string { return lane.name || `Route ${i + 1}`; }
  protected share(rows: number): number { const t = this.preview()?.total ?? 0; return t ? Math.round((rows / t) * 100) : 0; }

  protected readonly problems = computed(() => {
    const out: string[] = []; if (!this.name().trim()) out.push('Give it a name');
    this.lanes().forEach((l, i) => { if (!l.targetTemplateId) out.push(`${this.laneTitle(l, i)}: pick an agent`); if (l.filterRules.some((r) => !r.field)) out.push(`${this.laneTitle(l, i)}: pick a column for each rule`); });
    if (this.unmatched().action === 'route' && !this.unmatched().targetTemplateId) out.push('Everything else: pick an agent');
    return out;
  });
  protected async save(): Promise<void> {
    if (this.saving() || this.problems().length) return; this.saving.set(true);
    const body = { name: this.name().trim(), lanes: this.lanes().map((l, i) => ({ ...l, order: i })), unmatched: this.unmatched() };
    try {
      const id = this.activeId(); const saved = await firstValueFrom(id ? this.api.update(id, body) : this.api.create(body));
      this.definitions.set(await firstValueFrom(this.api.list())); this.select(saved.id);
    } catch { this.error.set('Could not save. Try again.'); }
    this.saving.set(false);
  }
  protected async remove(): Promise<void> {
    const id = this.activeId(); if (!id) return;
    await firstValueFrom(this.api.delete(id)); this.definitions.set(await firstValueFrom(this.api.list()));
    if (this.definitions().length) this.select(this.definitions()[0].id); else this.startNew();
  }
}
