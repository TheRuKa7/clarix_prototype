import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { Subject, timeout } from 'rxjs';
import { debounceTime, distinctUntilChanged, finalize, takeUntil } from 'rxjs/operators';
import { HasPermissionDirective } from "../../../core/permissions/directives/has-permission.directive";
import { ConfirmDialogService } from '../../../shared/ui/confirm-dialog/confirm-dialog.service';
import {
  WorkflowStatus,
  WorkflowTemplate,
  WorkflowTemplateStats,
} from '../models/workflow-template.model';
import { WorkflowTemplateService } from '../services/workflow-template.service';
import { WorkflowTemplateFormComponent } from './workflow-template-form.component';

@Component({
  selector: 'app-workflow-templates',
  imports: [CommonModule, FormsModule, LucideAngularModule, WorkflowTemplateFormComponent, HasPermissionDirective],
  templateUrl: './workflow-templates.component.html',
  styleUrl: './workflow-templates.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowTemplatesComponent implements OnInit, OnDestroy {
  private readonly templateService = inject(WorkflowTemplateService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly destroy$ = new Subject<void>();

  /** When set (via ?templateId= from Execution Reports), the list is narrowed to this one template. */
  protected readonly templateIdFilter = signal<string | null>(null);
  private readonly searchInput$ = new Subject<string>();

  protected readonly loading = signal(false);
  protected readonly statsLoading = signal(false);
  protected readonly actionLoading = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly templates = signal<WorkflowTemplate[]>([]);
  protected readonly totalElements = signal(0);
  protected readonly stats = signal<WorkflowTemplateStats>({
    total: 0,
    active: 0,
    draft: 0,
    totalSteps: 0,
  });

  protected readonly page = signal(0);
  protected readonly pageSize = signal(12);
  searchTerm = '';
  /** Default landing tab — All/Draft are one click away via the filter tabs. */
  statusFilter = 'ACTIVE';

  /** Pill-style filter tabs above the grid — mirrors the counts already shown in the stats strip. */
  setStatusFilter(status: string): void {
    if (this.statusFilter === status) return;
    this.statusFilter = status;
    this.onStatusFilterChange();
  }

  showForm = false;
  editingTemplate: WorkflowTemplate | null = null;

  readonly WorkflowStatus = WorkflowStatus;

  protected readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.totalElements() / this.pageSize()))
  );

  protected readonly pageStart = computed(() =>
    this.totalElements() === 0 ? 0 : this.page() * this.pageSize() + 1
  );

  protected readonly pageEnd = computed(() =>
    Math.min(this.totalElements(), (this.page() + 1) * this.pageSize())
  );

  protected readonly activePct = computed(() => {
    const s = this.stats();
    return s.total === 0 ? 0 : Math.round((s.active / s.total) * 100);
  });

  /** Templates to render — narrowed to a single template when templateIdFilter is pinned. */
  protected readonly visibleTemplates = computed(() => {
    const filter = this.templateIdFilter();
    const all = this.templates();
    return filter ? all.filter((t) => t.id === filter) : all;
  });

  /** Name of the pinned template (for the filter banner), when loaded. */
  protected readonly filteredTemplateName = computed(() => {
    const filter = this.templateIdFilter();
    return filter ? (this.templates().find((t) => t.id === filter)?.name ?? filter) : null;
  });

  ngOnInit(): void {
    this.searchInput$
      .pipe(takeUntil(this.destroy$), debounceTime(300), distinctUntilChanged())
      .subscribe(() => {
        this.page.set(0);
        this.loadTemplates();
      });

    // Pinned from Execution Reports: show only this template, regardless of status, on one page.
    const pinnedTemplateId = this.route.snapshot.queryParamMap.get('templateId');
    if (pinnedTemplateId) {
      this.templateIdFilter.set(pinnedTemplateId);
      this.statusFilter = '';
      this.pageSize.set(100);
    }

    this.loadStats();
    this.loadTemplates();
  }

  clearTemplateFilter(): void {
    this.templateIdFilter.set(null);
    this.statusFilter = 'ACTIVE';
    this.pageSize.set(12);
    this.page.set(0);
    this.router.navigate([], { relativeTo: this.route, queryParams: {} });
    this.loadTemplates();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  loadTemplates(): void {
    this.loading.set(true);
    this.templateService
      .list({
        page: this.page(),
        size: this.pageSize(),
        search: this.searchTerm,
        status: this.statusFilter || undefined,
      })
      .pipe(
        takeUntil(this.destroy$),
        timeout(10000),
        finalize(() => this.loading.set(false))
      )
      .subscribe({
        next: ({ items, total }) => {
          this.templates.set(items);
          this.totalElements.set(total);
        },
        error: (err) => {
          console.error('Failed to load templates:', err);
          this.templates.set([]);
          this.totalElements.set(0);
        },
      });
  }

  loadStats(): void {
    this.statsLoading.set(true);
    this.templateService
      .getStats()
      .pipe(
        takeUntil(this.destroy$),
        timeout(10000),
        finalize(() => this.statsLoading.set(false))
      )
      .subscribe({
        next: (s) => this.stats.set(s),
        error: (err) => console.error('Failed to load stats:', err),
      });
  }

  refresh(): void {
    this.loadStats();
    this.loadTemplates();
  }

  onSearchChange(): void {
    this.searchInput$.next(this.searchTerm);
  }

  onStatusFilterChange(): void {
    this.page.set(0);
    this.loadTemplates();
  }

  onPageSizeChange(size: number): void {
    this.pageSize.set(size);
    this.page.set(0);
    this.loadTemplates();
  }

  goToPage(page: number): void {
    if (page < 0 || page >= this.totalPages() || page === this.page()) return;
    this.page.set(page);
    this.loadTemplates();
  }

  nextPage(): void {
    this.goToPage(this.page() + 1);
  }

  prevPage(): void {
    this.goToPage(this.page() - 1);
  }

  openCreate(): void {
    this.editingTemplate = null;
    this.showForm = true;
  }

  openEdit(template: WorkflowTemplate): void {
    this.editingTemplate = template;
    this.showForm = true;
  }

  onFormSaved(): void {
    this.showForm = false;
    this.editingTemplate = null;
    this.refresh();
  }

  onFormCancelled(): void {
    this.showForm = false;
    this.editingTemplate = null;
  }

  activate(template: WorkflowTemplate): void {
    this.actionLoading.set(template.id);
    this.templateService
      .activate(template.id)
      .pipe(takeUntil(this.destroy$), timeout(10000), finalize(() => this.actionLoading.set(null)))
      .subscribe({
        next: () => this.refresh(),
        error: (err) => console.error('Failed to activate template:', err),
      });
  }

  deactivate(template: WorkflowTemplate): void {
    this.actionLoading.set(template.id);
    this.templateService
      .deactivate(template.id)
      .pipe(takeUntil(this.destroy$), timeout(10000), finalize(() => this.actionLoading.set(null)))
      .subscribe({
        next: () => this.refresh(),
        error: (err) => console.error('Failed to deactivate template:', err),
      });
  }

  /** Only DRAFT templates with no execution history can be deleted — the backend enforces this. */
  async delete(template: WorkflowTemplate): Promise<void> {
    this.actionError.set(null);
    const ok = await this.confirm.ask({
      title: 'Delete template',
      message: `Delete "${template.name}"? This can't be undone.`,
      confirmText: 'Delete',
      tone: 'danger',
      icon: 'trash-2',
    });
    if (!ok) return;

    this.actionLoading.set(template.id);
    this.templateService
      .delete(template.id)
      .pipe(takeUntil(this.destroy$), timeout(10000), finalize(() => this.actionLoading.set(null)))
      .subscribe({
        next: () => this.refresh(),
        error: (err: string) => this.actionError.set(err ?? 'Failed to delete template'),
      });
  }

  formatDate(dateStr?: string): string {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }


  formatLastRunTooltip(dateStr?: string): string | null {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  /** Executions that reached a terminal state. In-flight runs are excluded. */
  private finishedCount(template: WorkflowTemplate): number {
    return (
      (template.completedCount ?? 0) + (template.failedCount ?? 0) + (template.cancelledCount ?? 0)
    );
  }

  /**
   * Share of finished executions that completed, or null when none have finished yet — a template
   * that just spawned 100 calls has resolved none of them and would otherwise read 0%.
   */
  successRate(template: WorkflowTemplate): number | null {
    const finished = this.finishedCount(template);
    if (finished === 0) return null;
    return Math.round(((template.completedCount ?? 0) / finished) * 100);
  }

  successRateLabel(template: WorkflowTemplate): string {
    const rate = this.successRate(template);
    return rate === null ? '—' : `${rate}%`;
  }

  successRateTooltip(template: WorkflowTemplate): string {
    const finished = this.finishedCount(template);
    if (finished === 0) return 'No executions have finished yet';
    return `${template.completedCount ?? 0} of ${finished} finished execution${
      finished !== 1 ? 's' : ''
    } completed`;
  }

  createdByLabel(template: WorkflowTemplate): string {
    return template.createdBy?.trim() || 'Unknown';
  }

  /** Created date on the card; the tooltip carries the last-updated timestamp. */
  createdTooltip(template: WorkflowTemplate): string | null {
    if (!template.updatedAt) return null;
    const updated = this.formatLastRunTooltip(template.updatedAt);
    return updated ? `Last updated ${updated}` : null;
  }

  formatLastRun(dateStr?: string): string {
    if (!dateStr) return 'Never';
    const ts = new Date(dateStr).getTime();
    if (isNaN(ts)) return 'Never';
    const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diffSec < 45) return 'Just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return `${diffDay}d ago`;
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  channelIcon(channel: string): string {
    const map: Record<string, string> = {
      WHATSAPP: 'message-circle',
      EMAIL: 'mail',
      CALL: 'phone',
      CHAT: 'message-square',
    };
    return map[channel] ?? 'zap';
  }
}
