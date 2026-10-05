import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { LucideAngularModule } from 'lucide-angular';
import { ReportColumnSelection } from '../../models/workflow-template.model';
import { ReportColumnMeta, isAlwaysIncluded } from '../../utils/report-columns';

function splitId(id: string): [string, string] {
  const i = id.indexOf(':');
  return i < 0 ? [id, ''] : [id.slice(0, i), id.slice(i + 1)];
}

/**
 * Reusable "Customize Report" column selector: choose which columns appear, reorder them, and
 * rename their CSV headers. Driven by a flat {@link ReportColumnMeta} list (derived from a template)
 * and emits a {@link ReportColumnSelection}. Report-field columns are always included (matching the
 * backend) and cannot be toggled off.
 */
@Component({
  selector: 'app-report-column-selector',
  imports: [CommonModule, DragDropModule, LucideAngularModule],
  templateUrl: './report-column-selector.component.html',
  styleUrl: './report-column-selector.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportColumnSelectorComponent {
  readonly columns = input<ReportColumnMeta[]>([]);
  readonly initialSelection = input<ReportColumnSelection | undefined>(undefined);
  readonly selectionChange = output<ReportColumnSelection>();

  private readonly selectedIds = signal<Set<string>>(new Set());
  private readonly order = signal<string[]>([]);
  private readonly headers = signal<Map<string, string>>(new Map());

  constructor() {
    // Re-hydrate whenever the source columns or the saved selection change (e.g. template picked).
    effect(() => this.hydrate(this.columns(), this.initialSelection()));
  }

  protected readonly sections = computed(() => {
    const groups = new Map<string, ReportColumnMeta[]>();
    for (const c of this.columns()) {
      const list = groups.get(c.section) ?? [];
      list.push(c);
      groups.set(c.section, list);
    }
    return Array.from(groups.entries()).map(([section, cols]) => ({ section, cols }));
  });

  protected readonly enabledColumns = computed<ReportColumnMeta[]>(() => {
    const sel = this.selectedIds();
    return this.columns().filter((c) => isAlwaysIncluded(c.id) || sel.has(c.id));
  });

  protected readonly orderedColumns = computed<ReportColumnMeta[]>(() => {
    const enabled = this.enabledColumns();
    const ord = this.order();
    if (!ord.length) return enabled;
    const byId = new Map(enabled.map((c) => [c.id, c]));
    const result: ReportColumnMeta[] = [];
    for (const id of ord) {
      const c = byId.get(id);
      if (c) {
        result.push(c);
        byId.delete(id);
      }
    }
    for (const c of byId.values()) result.push(c);
    return result;
  });

  isSelected(id: string): boolean {
    return isAlwaysIncluded(id) || this.selectedIds().has(id);
  }

  isLocked(id: string): boolean {
    return isAlwaysIncluded(id);
  }

  toggle(id: string, checked: boolean): void {
    if (isAlwaysIncluded(id)) return;
    this.selectedIds.update((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
    this.emit();
  }

  drop(event: CdkDragDrop<ReportColumnMeta[]>): void {
    const ids = this.orderedColumns().map((c) => c.id);
    moveItemInArray(ids, event.previousIndex, event.currentIndex);
    this.order.set(ids);
    this.emit();
  }

  effectiveHeader(col: ReportColumnMeta): string {
    return this.headers().get(col.id) ?? col.label;
  }

  setHeader(id: string, defaultLabel: string, value: string): void {
    const trimmed = value.trim();
    this.headers.update((prev) => {
      const next = new Map(prev);
      if (!trimmed || trimmed === defaultLabel) next.delete(id);
      else next.set(id, trimmed);
      return next;
    });
    this.emit();
  }

  private hydrate(cols: ReportColumnMeta[], sel: ReportColumnSelection | undefined): void {
    const ids = new Set<string>();
    for (const c of cols) {
      if (!sel || this.isInSelection(c, sel)) ids.add(c.id);
    }
    this.selectedIds.set(ids);
    this.order.set(sel?.columnOrder?.length ? [...sel.columnOrder] : []);
    this.headers.set(sel?.headerOverrides ? new Map(Object.entries(sel.headerOverrides)) : new Map());
  }

  /** A missing section list in the saved selection means "include everything in that section". */
  private isInSelection(col: ReportColumnMeta, sel: ReportColumnSelection): boolean {
    const [ns, key] = splitId(col.id);
    switch (ns) {
      case 'contact':
        return sel.contact ? sel.contact.includes(key) : true;
      case 'detail':
        return sel.executionDetails ? sel.executionDetails.includes(key) : true;
      case 'context':
        return sel.contextParams ? sel.contextParams.includes(key) : true;
      case 'dfInput':
        return sel.enrichmentInputs ? sel.enrichmentInputs.includes(key) : true;
      case 'outcome':
        return sel.executionOutcome ? sel.executionOutcome.includes(key) : true;
      default:
        return true; // reportField and unknown -> always included
    }
  }

  private emit(): void {
    const sel = this.selectedIds();
    const contact: string[] = [];
    const details: string[] = [];
    const context: string[] = [];
    const enrich: string[] = [];
    const outcome: string[] = [];
    for (const c of this.columns()) {
      if (isAlwaysIncluded(c.id) || !sel.has(c.id)) continue;
      const [ns, key] = splitId(c.id);
      if (ns === 'contact') contact.push(key);
      else if (ns === 'detail') details.push(key);
      else if (ns === 'context') context.push(key);
      else if (ns === 'dfInput') enrich.push(key);
      else if (ns === 'outcome') outcome.push(key);
    }
    const payload: ReportColumnSelection = {
      contact,
      executionDetails: details,
      contextParams: context,
      enrichmentInputs: enrich,
      executionOutcome: outcome,
      columnOrder: this.orderedColumns().map((c) => c.id),
    };
    const headers = this.headers();
    if (headers.size) {
      const enabledIds = new Set(this.enabledColumns().map((c) => c.id));
      const obj: Record<string, string> = {};
      for (const [id, header] of headers) {
        if (enabledIds.has(id)) obj[id] = header;
      }
      if (Object.keys(obj).length) payload.headerOverrides = obj;
    }
    this.selectionChange.emit(payload);
  }
}
