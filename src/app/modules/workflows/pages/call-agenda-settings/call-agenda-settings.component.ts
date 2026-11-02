import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  AgendaBand,
  AgendaOverflowPolicy,
  CallAgendaConfig,
  WorkflowTemplate,
  WorkflowTemplateRequest,
} from '../../models/workflow-template.model';
import { WorkflowTemplateService } from '../../services/workflow-template.service';
import { TemplatePickerComponent } from '../../components/template-picker/template-picker.component';

/** Fixed, PRD-governed vocabulary (PRD-VOX-12) — not admin-editable, shown for reference only. */
const OUTCOME_BUCKETS = [
  'ETA Available/ Shared',
  'Acknowledged for PO Acceptance',
  'Material Ready for Dispatch',
  'Technical Clarification Required',
  'Call Back required by Ops',
  'PO Copy/ Mail Not Received',
  'Payment Pendency Update Required',
  'Access/ Operational Issue in Supplier Central',
  'Issue in working with Moglix',
  'Not Aligned for Dialler Calling',
  'No Response',
];

const OVERFLOW_OPTIONS: { value: AgendaOverflowPolicy; label: string }[] = [
  { value: 'FOLLOW_UP_CALL_NEXT_BAND', label: 'Follow-up call, next priority band only' },
  { value: 'FOLLOW_UP_CALL_CONTINUE_ORDER', label: 'Follow-up call, continue in order' },
  { value: 'DEFER_NEXT_CAMPAIGN', label: 'Leave for the next campaign' },
];

function emptyConfig(): CallAgendaConfig {
  return {
    bands: [],
    groupByKey: 'supplier_code',
    maxLinesPerCall: 8,
    checkInAfterLine: 6,
    hardStopDuration: '10 minutes',
    overflowPolicy: 'FOLLOW_UP_CALL_NEXT_BAND',
    reAskOnMismatch: true,
    capCommitmentAtOpenQuantity: true,
  };
}

/**
 * Build > Orchestration > Call agenda — config-only settings for how one supplier's multiple open
 * lines become one or more calls. Inert until the (separately gated) grouping engine reads it.
 *
 * Saves by round-tripping the full template: load it, mutate only `callAgendaConfig`, send every
 * other field back untouched — a partial payload to `update()` would silently wipe the rest.
 */
@Component({
  selector: 'app-call-agenda-settings',
  imports: [CommonModule, FormsModule, TemplatePickerComponent],
  templateUrl: './call-agenda-settings.component.html',
  styleUrl: './call-agenda-settings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallAgendaSettingsComponent {
  private readonly templateService = inject(WorkflowTemplateService);

  protected readonly outcomeBuckets = OUTCOME_BUCKETS;
  protected readonly overflowOptions = OVERFLOW_OPTIONS;

  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly template = signal<WorkflowTemplate | null>(null);
  protected readonly config = signal<CallAgendaConfig>(emptyConfig());

  onTemplatePicked(template: WorkflowTemplate | null): void {
    this.saved.set(false);
    if (!template) {
      this.template.set(null);
      this.config.set(emptyConfig());
      return;
    }
    this.loading.set(true);
    this.templateService.getById(template.id).subscribe({
      next: (full) => {
        this.template.set(full);
        this.config.set(full.callAgendaConfig ? structuredClone(full.callAgendaConfig) : emptyConfig());
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  addBand(): void {
    this.config.update((c) => ({
      ...c,
      bands: [...c.bands, { name: 'New band', rule: '', matchRules: [] }],
    }));
  }

  removeBand(index: number): void {
    this.config.update((c) => ({ ...c, bands: c.bands.filter((_, i) => i !== index) }));
  }

  moveBand(index: number, delta: number): void {
    const bands = [...this.config().bands];
    const target = index + delta;
    if (target < 0 || target >= bands.length) return;
    [bands[index], bands[target]] = [bands[target], bands[index]];
    this.config.update((c) => ({ ...c, bands }));
  }

  updateBand(index: number, patch: Partial<AgendaBand>): void {
    const bands = this.config().bands.map((b, i) => (i === index ? { ...b, ...patch } : b));
    this.config.update((c) => ({ ...c, bands }));
  }

  updateConfig(patch: Partial<CallAgendaConfig>): void {
    this.config.update((c) => ({ ...c, ...patch }));
  }

  save(): void {
    const template = this.template();
    if (!template || this.saving()) return;

    const request: WorkflowTemplateRequest = {
      templateKey: template.templateKey,
      name: template.name,
      description: template.description,
      defaultChannelType: template.defaultChannelType,
      callProviderKey: template.callProviderKey,
      providerAgentId: template.providerAgentId,
      agentFieldBindings: template.agentFieldBindings,
      triggerEventTypes: template.triggerEventTypes,
      triggerFilters: template.triggerFilters,
      contactExtractionConfig: template.contactExtractionConfig,
      contextMappings: template.contextMappings,
      reportFields: template.reportFields,
      reportColumns: template.reportColumns,
      requiredFields: template.requiredFields,
      enrichments: template.enrichments,
      callAgendaConfig: this.config(),
      steps: template.steps,
      maxRetries: template.maxRetries,
      retryDelayMinutes: template.retryDelayMinutes,
    };

    this.saving.set(true);
    this.saved.set(false);
    this.templateService.update(template.id, request).subscribe({
      next: (updated) => {
        this.template.set(updated);
        this.saving.set(false);
        this.saved.set(true);
      },
      error: () => this.saving.set(false),
    });
  }
}
