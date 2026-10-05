import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { finalize } from 'rxjs/operators';
import { WorkflowTemplate } from '../../models/workflow-template.model';
import { EMPTY_ORG_SUMMARY, WorkflowOrgSummary } from '../../models/workflow-org-summary.model';
import { WorkflowTemplateService } from '../../services/workflow-template.service';
import { WorkflowExecutionService } from '../../services/workflow-execution.service';
import { downloadSampleCsv } from '../../utils/csv-download';
import { CsvBulkUploadComponent } from '../csv-bulk-upload/csv-bulk-upload.component';

/**
 * Run > Agents — the operator's home. Pick a live agent, get its sheet, upload one back.
 * No configuration surfaces here on purpose; that's Build > Agents.
 */
@Component({
  selector: 'app-run-agents',
  imports: [CommonModule, LucideAngularModule, CsvBulkUploadComponent],
  templateUrl: './run-agents.component.html',
  styleUrl: './run-agents.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RunAgentsComponent implements OnInit {
  private readonly templateService = inject(WorkflowTemplateService);
  private readonly executionService = inject(WorkflowExecutionService);
  private readonly router = inject(Router);

  protected readonly loading = signal(false);
  protected readonly agents = signal<WorkflowTemplate[]>([]);
  protected readonly summary = signal<WorkflowOrgSummary>(EMPTY_ORG_SUMMARY);
  protected readonly csvUploadTemplate = signal<WorkflowTemplate | null>(null);
  protected readonly uploadWithoutTemplate = signal(false);

  ngOnInit(): void {
    this.loadAgents();
    this.loadSummary();
  }

  private loadAgents(): void {
    this.loading.set(true);
    this.templateService
      .list({ page: 0, size: 100, status: 'ACTIVE' })
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: ({ items }) => this.agents.set(items),
        error: (err) => {
          console.error('Failed to load agents:', err);
          this.agents.set([]);
        },
      });
  }

  private loadSummary(): void {
    this.executionService.getOrgSummary().subscribe((summary) => this.summary.set(summary));
  }

  /** Executions that reached a terminal state — same shape as the Build > Agents success rate. */
  private finishedCount(template: WorkflowTemplate): number {
    return (
      (template.completedCount ?? 0) + (template.failedCount ?? 0) + (template.cancelledCount ?? 0)
    );
  }

  /** Calls not yet final: every run minus the finished ones. */
  openCount(template: WorkflowTemplate): number {
    return Math.max(0, (template.executionCount ?? 0) - this.finishedCount(template));
  }

  successRateLabel(template: WorkflowTemplate): string {
    const finished = this.finishedCount(template);
    if (finished === 0) return '—';
    return `${Math.round(((template.completedCount ?? 0) / finished) * 100)}%`;
  }

  getSheet(template: WorkflowTemplate): void {
    downloadSampleCsv(template);
  }

  uploadAndRun(template: WorkflowTemplate): void {
    this.csvUploadTemplate.set(template);
  }

  /** Card click — analytics/execution-history now lives under Run, not Build. */
  openExecutions(template: WorkflowTemplate): void {
    this.router.navigate(['/workflows/templates', template.id, 'executions']);
  }

  openReports(template: WorkflowTemplate, event: Event): void {
    event.stopPropagation();
    this.router.navigate(['/workflows/reports'], { queryParams: { templateId: template.id } });
  }

  newCampaignWithoutAgent(): void {
    this.uploadWithoutTemplate.set(true);
  }

  closeCsvUpload(): void {
    this.csvUploadTemplate.set(null);
    this.uploadWithoutTemplate.set(false);
  }

  onCsvUploadCompleted(): void {
    this.closeCsvUpload();
    this.router.navigate(['/workflows/campaigns']);
  }
}
