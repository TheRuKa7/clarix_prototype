import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs/operators';
import { ConditionOperator, StepCondition, WorkflowTemplate } from '../../models/workflow-template.model';
import { Lane, LanePreviewResult, OrchestrationDefinition } from '../../models/orchestration.model';
import { OrchestrationService } from '../../services/orchestration.service';
import { TemplatePickerComponent } from '../../components/template-picker/template-picker.component';

const OPERATORS: ConditionOperator[] = [
  ConditionOperator.EQUALS,
  ConditionOperator.NOT_EQUALS,
  ConditionOperator.CONTAINS,
  ConditionOperator.NOT_CONTAINS,
  ConditionOperator.IS_NULL,
  ConditionOperator.IS_NOT_NULL,
  ConditionOperator.IN,
  ConditionOperator.NOT_IN,
];

function newLane(order: number): Lane {
  return { name: 'New lane', order, filterRules: [], sortField: '', groupByKey: '', targetTemplateId: undefined };
}

/**
 * Build > Orchestration > Lanes — one large upload split by rules into lanes, each feeding a
 * different agent. Config-only: not yet wired into CSV ingest (a separately gated phase).
 */
@Component({
  selector: 'app-orchestration-lanes',
  imports: [CommonModule, FormsModule, TemplatePickerComponent],
  templateUrl: './orchestration-lanes.component.html',
  styleUrl: './orchestration-lanes.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrchestrationLanesComponent implements OnInit {
  private readonly orchestrationService = inject(OrchestrationService);

  protected readonly operators = OPERATORS;
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly definitions = signal<OrchestrationDefinition[]>([]);
  protected readonly activeId = signal<string | null>(null);
  protected readonly name = signal('New orchestration');
  protected readonly lanes = signal<Lane[]>([]);

  protected readonly previewHeaders = signal('');
  protected readonly previewResults = signal<LanePreviewResult[] | null>(null);
  protected readonly previewing = signal(false);

  ngOnInit(): void {
    this.loadDefinitions();
  }

  private loadDefinitions(): void {
    this.loading.set(true);
    this.orchestrationService
      .list()
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe((defs) => {
        this.definitions.set(defs);
        if (defs.length > 0 && !this.activeId()) {
          this.selectDefinition(defs[0].id);
        }
      });
  }

  selectDefinition(id: string): void {
    const def = this.definitions().find((d) => d.id === id);
    if (!def) return;
    this.activeId.set(def.id);
    this.name.set(def.name);
    this.lanes.set(structuredClone(def.lanes));
    this.previewResults.set(null);
  }

  newDefinition(): void {
    this.activeId.set(null);
    this.name.set('New orchestration');
    this.lanes.set([]);
    this.previewResults.set(null);
  }

  addLane(): void {
    this.lanes.update((lanes) => [...lanes, newLane(lanes.length)]);
  }

  removeLane(index: number): void {
    this.lanes.update((lanes) => lanes.filter((_, i) => i !== index));
  }

  updateLane(index: number, patch: Partial<Lane>): void {
    this.lanes.update((lanes) => lanes.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  onLaneTargetPicked(index: number, template: WorkflowTemplate | null): void {
    this.updateLane(index, { targetTemplateId: template?.id });
  }

  addRule(laneIndex: number): void {
    this.lanes.update((lanes) =>
      lanes.map((l, i) =>
        i === laneIndex
          ? { ...l, filterRules: [...l.filterRules, { field: '', operator: ConditionOperator.EQUALS, value: '' }] }
          : l
      )
    );
  }

  removeRule(laneIndex: number, ruleIndex: number): void {
    this.lanes.update((lanes) =>
      lanes.map((l, i) => (i === laneIndex ? { ...l, filterRules: l.filterRules.filter((_, ri) => ri !== ruleIndex) } : l))
    );
  }

  updateRule(laneIndex: number, ruleIndex: number, patch: Partial<StepCondition>): void {
    this.lanes.update((lanes) =>
      lanes.map((l, i) =>
        i === laneIndex
          ? { ...l, filterRules: l.filterRules.map((r, ri) => (ri === ruleIndex ? { ...r, ...patch } : r)) }
          : l
      )
    );
  }

  save(): void {
    if (this.saving()) return;
    this.saving.set(true);
    this.saved.set(false);
    const request = { name: this.name(), lanes: this.lanes() };
    const id = this.activeId();
    const obs = id ? this.orchestrationService.update(id, request) : this.orchestrationService.create(request);
    obs.pipe(finalize(() => this.saving.set(false))).subscribe((def) => {
      this.saved.set(true);
      this.loadDefinitions();
      this.activeId.set(def.id);
    });
  }

  runPreview(): void {
    const id = this.activeId();
    const headers = this.previewHeaders()
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    if (!id || headers.length === 0) return;
    this.previewing.set(true);
    this.orchestrationService
      .preview(id, headers)
      .pipe(finalize(() => this.previewing.set(false)))
      .subscribe((results) => this.previewResults.set(results));
  }
}
