import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { ConfirmDialogService } from '../../../../shared/ui/confirm-dialog/confirm-dialog.service';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { finalize } from 'rxjs/operators';
import { forkJoin } from 'rxjs';
import { ExecutionReportService } from '../../services/execution-report.service';
import { WorkflowTemplateService } from '../../services/workflow-template.service';
import { ExecutionReport } from '../../models/execution-report.model';

@Component({
  selector: 'app-execution-reports',
  imports: [CommonModule, RouterLink, LucideAngularModule],
  templateUrl: './execution-reports.component.html',
  styleUrl: './execution-reports.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExecutionReportsComponent implements OnInit {
  private readonly reportService = inject(ExecutionReportService);
  private readonly templateService = inject(WorkflowTemplateService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly confirm = inject(ConfirmDialogService);

  protected readonly reports = signal<ExecutionReport[]>([]);
  protected readonly templateNames = signal<Map<string, string>>(new Map());
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly downloadingId = signal<string | null>(null);

  /** When set (via ?templateId= from a template card), the list is narrowed to one template. */
  protected readonly templateIdFilter = signal<string | null>(null);

  protected readonly filteredTemplateName = computed(() => {
    const id = this.templateIdFilter();
    return id ? (this.templateNames().get(id) ?? id) : null;
  });

  ngOnInit(): void {
    this.templateIdFilter.set(this.route.snapshot.queryParamMap.get('templateId'));
    this.load();
  }

  clearFilter(): void {
    this.templateIdFilter.set(null);
    this.router.navigate([], { relativeTo: this.route, queryParams: {} });
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.error.set(null);
    forkJoin({
      reports: this.reportService.list({ size: 100, templateId: this.templateIdFilter() ?? undefined }),
      templates: this.templateService.list({ size: 200 }),
    })
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: ({ reports, templates }) => {
          this.reports.set(reports.items);
          this.templateNames.set(new Map(templates.items.map((t) => [t.id, t.name])));
        },
        error: (e) => this.error.set(e.message ?? 'Failed to load reports'),
      });
  }

  templateName(templateId: string): string {
    return this.templateNames().get(templateId) ?? templateId;
  }

  newReport(): void {
    this.router.navigate(['/workflows/reports/new']);
  }

  edit(report: ExecutionReport): void {
    this.router.navigate(['/workflows/reports', report.id, 'edit']);
  }

  async remove(report: ExecutionReport): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Delete report',
      message: `Delete report "${report.title}"?`,
      confirmText: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    this.reportService.delete(report.id).subscribe({
      next: () => this.reports.update((r) => r.filter((x) => x.id !== report.id)),
      error: (e) => this.error.set(e.message ?? 'Failed to delete report'),
    });
  }

  download(report: ExecutionReport): void {
    if (this.downloadingId()) return;
    this.downloadingId.set(report.id);
    this.reportService
      .download(report.id)
      .pipe(finalize(() => this.downloadingId.set(null)))
      .subscribe({
        next: (blob) => this.saveBlob(blob, this.slug(report.title) + '.csv'),
        error: (e) => this.error.set(e.message ?? 'Failed to download report'),
      });
  }

  private saveBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  private slug(title: string): string {
    const s = (title ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    return s || 'report';
  }
}
