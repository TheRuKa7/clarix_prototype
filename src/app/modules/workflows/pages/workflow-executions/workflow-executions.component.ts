import { callStatusView } from '../../utils/call-status';
import { CommonModule, Location } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { Subject, timeout } from 'rxjs';
import { finalize, takeUntil } from 'rxjs/operators';
import { environment } from '../../../../../environments/environment';
import { WorkflowDashboardComponent } from '../../components/workflow-dashboard/workflow-dashboard.component';
import {
  SUPPORTED_CHANNELS,
  WorkflowExecution,
  WorkflowTemplate,
} from '../../models/workflow-template.model';
import { WorkflowExecutionService } from '../../services/workflow-execution.service';
import { WorkflowTemplateService } from '../../services/workflow-template.service';
import { ConfirmDialogService } from '../../../../shared/ui/confirm-dialog/confirm-dialog.service';
import { ScheduleExecutionModalComponent } from './schedule-execution-modal/schedule-execution-modal.component';
import { dispatchState, dispatchTraceRef, dispatchTooltip } from '../../utils/dispatch-state';

@Component({
  selector: 'app-workflow-executions',
  imports: [
    CommonModule,
    FormsModule,
    LucideAngularModule,
    WorkflowDashboardComponent,
    ScheduleExecutionModalComponent,
  ],
  templateUrl: './workflow-executions.component.html',
  styleUrl: './workflow-executions.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowExecutionsComponent implements OnInit, OnDestroy {
  protected readonly view = callStatusView;
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly executionService = inject(WorkflowExecutionService);
  private readonly templateService = inject(WorkflowTemplateService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly destroy$ = new Subject<void>();


  protected readonly loading = signal(false);
  protected readonly downloading = signal(false);
  protected readonly templateLoading = signal(false);
  protected readonly executions = signal<WorkflowExecution[]>([]);
  protected readonly totalElements = signal(0);
  protected readonly template = signal<WorkflowTemplate | null>(null);
  protected readonly page = signal(0);
  protected readonly pageSize = signal(20);
  protected readonly pageSizeOptions = [10, 20, 50, 100] as const;

  // Live clock driving the countdown on UPCOMING rows; only ticks while such rows are visible.
  protected readonly now = signal(Date.now());
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private readonly hasUpcoming = computed(() =>
    this.executions().some((e) => e.status === 'UPCOMING')
  );

  // Execution whose schedule modal is open (null = closed).
  protected readonly scheduleTarget = signal<WorkflowExecution | null>(null);

  // Execution whose call is currently being stopped, so only its own row shows a spinner.
  protected readonly stoppingId = signal<string | null>(null);

  constructor() {
    effect(() => {
      if (this.hasUpcoming()) this.startClock();
      else this.stopClock();
    });
  }

  private startClock(): void {
    if (this.clockTimer) return;
    this.clockTimer = setInterval(() => this.now.set(Date.now()), 1000);
  }

  private stopClock(): void {
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  // Filters
  protected readonly statusFilter = signal<string>('');
  protected readonly channelFilter = signal<string>('');
  protected readonly phoneFilter = signal<string>('');
  protected readonly fromDate = signal<string>('');
  protected readonly toDate = signal<string>('');
  protected readonly activeQuickRange = signal<number | null>(null);
  /** When set (via ?batchId= from an uploaded sheet), narrows to that upload's executions. */
  protected readonly batchId = signal<string>('');
  private phoneDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly statusOptions = [
    'UPCOMING',
    'ACTIVE',
    'IN_PROGRESS',
    'WAITING',
    'COMPLETED',
    'FAILED',
    'PAUSED',
    'CANCELLED',
    'STOPPED',
    'DRAFT',
  ];
  /** Only live channels are offered; a ?channel= for anything else no longer applies. */
  protected readonly channelOptions: string[] = [...SUPPORTED_CHANNELS];

  protected readonly hasActiveFilters = computed(() =>
    !!this.statusFilter() ||
    !!this.channelFilter() ||
    !!this.phoneFilter() ||
    !!this.fromDate() ||
    !!this.toDate()
  );

  protected readonly dashboardFromIso = computed(() => this.toIsoStart(this.fromDate()));
  protected readonly dashboardToIso = computed(() => this.toIsoEnd(this.toDate()));

  protected templateId = '';

  protected readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.totalElements() / this.pageSize()))
  );

  protected readonly pageStart = computed(() =>
    this.totalElements() === 0 ? 0 : this.page() * this.pageSize() + 1
  );

  protected readonly pageEnd = computed(() =>
    Math.min(this.totalElements(), (this.page() + 1) * this.pageSize())
  );

  ngOnInit(): void {
    this.templateId = this.route.snapshot.paramMap.get('templateId') ?? '';
    if (!this.templateId) {
      this.router.navigate(['/workflows/templates']);
      return;
    }
    this.hydrateFromUrl();
    this.applyDefaultRangeIfEmpty();
    this.loadTemplate();
    this.loadExecutions();
  }

  private applyDefaultRangeIfEmpty(): void {
    // A batch view shows all of that upload's executions — don't impose the default date range.
    if (this.batchId()) return;
    if (this.fromDate() || this.toDate() || this.activeQuickRange() !== null) return;
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 2);
    this.fromDate.set(this.toDateInput(start));
    this.toDate.set(this.toDateInput(end));
    this.activeQuickRange.set(3);
    this.syncUrl();
  }

  private hydrateFromUrl(): void {
    const q = this.route.snapshot.queryParamMap;
    const status = q.get('status') ?? '';
    const channel = q.get('channel') ?? '';
    const phone = q.get('phone') ?? '';
    const from = q.get('from') ?? '';
    const to = q.get('to') ?? '';
    const quick = q.get('range');
    const pageParam = Number(q.get('page'));
    const sizeParam = Number(q.get('size'));

    const batch = q.get('batchId') ?? '';
    if (batch) this.batchId.set(batch);
    if (status && this.statusOptions.includes(status)) this.statusFilter.set(status);
    if (channel && this.channelOptions.includes(channel)) this.channelFilter.set(channel);
    if (phone) this.phoneFilter.set(phone);
    if (this.isValidDateInput(from)) this.fromDate.set(from);
    if (this.isValidDateInput(to)) this.toDate.set(to);
    if (quick && [1, 3, 7].includes(Number(quick))) this.activeQuickRange.set(Number(quick));
    if (Number.isFinite(sizeParam) && (this.pageSizeOptions as readonly number[]).includes(sizeParam)) {
      this.pageSize.set(sizeParam);
    }
    if (Number.isFinite(pageParam) && pageParam >= 0) this.page.set(pageParam);
  }

  private isValidDateInput(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
  }

  private syncUrl(): void {
    const params = new URLSearchParams();
    if (this.statusFilter()) params.set('status', this.statusFilter());
    if (this.channelFilter()) params.set('channel', this.channelFilter());
    if (this.phoneFilter()) params.set('phone', this.phoneFilter());
    if (this.fromDate()) params.set('from', this.fromDate());
    if (this.toDate()) params.set('to', this.toDate());
    if (this.activeQuickRange() !== null) params.set('range', String(this.activeQuickRange()));
    if (this.pageSize() !== 20) params.set('size', String(this.pageSize()));
    if (this.page() > 0) params.set('page', String(this.page()));
    if (this.batchId()) params.set('batchId', this.batchId());

    const path = this.location.path().split('?')[0];
    const query = params.toString();
    this.location.replaceState(path, query);
  }

  ngOnDestroy(): void {
    if (this.phoneDebounceTimer) clearTimeout(this.phoneDebounceTimer);
    this.stopClock();
    this.destroy$.next();
    this.destroy$.complete();
  }

  loadTemplate(): void {
    this.templateLoading.set(true);
    this.templateService
      .getById(this.templateId)
      .pipe(
        takeUntil(this.destroy$),
        timeout(10000),
        finalize(() => this.templateLoading.set(false))
      )
      .subscribe({
        next: (t) => this.template.set(t),
        error: (err) => console.error('Failed to load template:', err),
      });
  }

  loadExecutions(): void {
    this.loading.set(true);
    this.executionService
      .listByTemplate(this.templateId, {
        page: this.page(),
        size: this.pageSize(),
        status: this.statusFilter() || undefined,
        channelType: this.channelFilter() || undefined,
        phone: this.phoneFilter().trim() || undefined,
        from: this.toIsoStart(this.fromDate()),
        to: this.toIsoEnd(this.toDate()),
        batchId: this.batchId() || undefined,
      })
      .pipe(
        takeUntil(this.destroy$),
        timeout(15000),
        finalize(() => this.loading.set(false))
      )
      .subscribe({
        next: ({ items, total }) => {
          this.executions.set(items);
          this.totalElements.set(total);
        },
        error: (err) => {
          console.error('Failed to load executions:', err);
          this.executions.set([]);
          this.totalElements.set(0);
        },
      });
  }

  goToPage(page: number): void {
    if (page < 0 || page >= this.totalPages() || page === this.page()) return;
    this.page.set(page);
    this.syncUrl();
    this.loadExecutions();
  }

  setPageSize(size: number): void {
    if (!Number.isFinite(size) || size === this.pageSize()) return;
    this.pageSize.set(size);
    this.page.set(0); // rows-per-page changed; go back to the first page
    this.syncUrl();
    this.loadExecutions();
  }

  prevPage(): void {
    this.goToPage(this.page() - 1);
  }

  nextPage(): void {
    this.goToPage(this.page() + 1);
  }

  back(): void {
    this.router.navigate(['/workflows/templates']);
  }

  refresh(): void {
    this.loadExecutions();
  }

  clearBatchFilter(): void {
    this.batchId.set('');
    this.page.set(0);
    this.applyDefaultRangeIfEmpty(); // back to the normal default-range view
    this.syncUrl();
    this.loadExecutions();
  }

  downloadCsv(): void {
    if (this.downloading()) return;
    this.downloading.set(true);
    this.executionService
      .exportReport(this.templateId, {
        status: this.statusFilter() || undefined,
        channelType: this.channelFilter() || undefined,
        phone: this.phoneFilter().trim() || undefined,
        from: this.toIsoStart(this.fromDate()),
        to: this.toIsoEnd(this.toDate()),
        batchId: this.batchId() || undefined,
      })
      .pipe(
        takeUntil(this.destroy$),
        timeout(60000),
        finalize(() => this.downloading.set(false))
      )
      .subscribe({
        next: (blob) => this.triggerBlobDownload(blob),
        error: (err) => console.error('Failed to download executions report:', err),
      });
  }

  private triggerBlobDownload(blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const templateKey = this.template()?.templateKey ?? 'executions';
    anchor.href = url;
    anchor.download = `executions-${templateKey}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  /** In-app URL of an execution's detail page — used for anchor-style new-tab opens. */
  executionUrl(execution: WorkflowExecution): string {
    const tree = this.router.createUrlTree([
      '/workflows/templates',
      this.templateId,
      'executions',
      execution.id,
    ]);
    return this.location.prepareExternalUrl(this.router.serializeUrl(tree));
  }

  /**
   * Opens an execution. Ctrl/Cmd-click opens it in a new tab (like an anchor); a plain
   * click navigates in place. Keyboard activation calls this without an event.
   */
  openExecution(execution: WorkflowExecution, event?: MouseEvent): void {
    if (event && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      window.open(this.executionUrl(execution), '_blank');
      return;
    }
    this.router.navigate([
      '/workflows/templates',
      this.templateId,
      'executions',
      execution.id,
    ]);
  }

  /** Middle-click (auxclick, button 1) opens the execution in a new tab, like an anchor. */
  openExecutionAux(execution: WorkflowExecution, event: MouseEvent): void {
    if (event.button === 1) {
      event.preventDefault();
      window.open(this.executionUrl(execution), '_blank');
    }
  }

  /** Countdown label for an UPCOMING execution, recomputed each second via the now() signal. */
  countdownFor(execution: WorkflowExecution): string {
    if (!execution.scheduledAt) return '—';
    return this.formatCountdown(new Date(execution.scheduledAt).getTime() - this.now());
  }

  /** True once an UPCOMING execution's scheduled time has passed — it's firing and can no longer be rescheduled. */
  hasStarted(execution: WorkflowExecution): boolean {
    if (!execution.scheduledAt) return false;
    return new Date(execution.scheduledAt).getTime() - this.now() <= 0;
  }

  /** Formats a millisecond gap as "Xd Xh Xm Xs", capped at days; <= 0 shows "starting…". */
  formatCountdown(ms: number): string {
    if (ms <= 0) return 'starting…';
    let totalSec = Math.floor(ms / 1000);
    const days = Math.floor(totalSec / 86400);
    totalSec %= 86400;
    const hours = Math.floor(totalSec / 3600);
    totalSec %= 3600;
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    if (days > 0) return `${days}d ${hours}h ${mins}m ${secs}s`;
    if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }

  openSchedule(execution: WorkflowExecution, event: Event): void {
    event.stopPropagation();
    if (this.hasStarted(execution)) return;
    this.scheduleTarget.set(execution);
  }

  closeSchedule(): void {
    this.scheduleTarget.set(null);
  }

  onScheduleChanged(): void {
    this.loadExecutions();
  }

  /**
   * Stops an IN_PROGRESS execution's live call. Guards the row click (which would open the detail
   * page), confirms with the user, then reloads so the row reflects its new STOPPED status.
   */
  async stopCall(execution: WorkflowExecution, event: Event): Promise<void> {
    event.stopPropagation();
    if (execution.status !== 'IN_PROGRESS' || this.stoppingId()) return;
    const who = execution.resolvedContact?.name || execution.resolvedContact?.phone || 'this call';
    const ok = await this.confirm.ask({
      title: 'Stop call',
      message: `Stop the ongoing call to ${who}?`,
      confirmText: 'Stop call',
      tone: 'danger',
      icon: 'phone-off',
    });
    if (!ok) return;

    this.stoppingId.set(execution.id);
    this.executionService
      .stopCall(execution.id)
      .pipe(
        takeUntil(this.destroy$),
        timeout(15000),
        finalize(() => this.stoppingId.set(null))
      )
      .subscribe({
        next: () => this.loadExecutions(),
        error: (err) => {
          console.error('Failed to stop call:', err);
          alert(typeof err === 'string' ? err : 'Failed to stop the call');
        },
      });
  }

  formatDateTime(value?: string): string {
    if (!value) return '—';
    const d = new Date(value);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /**
   * Formats the actual call/conversation length, matching the execution detail page and CSV report.
   * Returns '—' for executions without a call duration (e.g. non-call channels).
   */
  callDuration(seconds?: number | null): string {
    if (seconds == null) return '—';
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  channelIcon(channel?: string): string {
    const map: Record<string, string> = {
      WHATSAPP: 'message-circle',
      EMAIL: 'mail',
      CALL: 'phone',
      CHAT: 'message-square',
    };
    return channel ? map[channel] ?? 'zap' : 'zap';
  }

  triggerMethodLabel(method?: string): string {
    const map: Record<string, string> = {
      KAFKA_EVENT: 'Kafka event',
      API_CALL: 'API call',
      CSV_UPLOAD: 'CSV upload',
    };
    return method ? map[method] ?? method : '—';
  }

  onStatusFilterChange(value: string): void {
    this.statusFilter.set(value);
    this.page.set(0);
    this.syncUrl();
    this.loadExecutions();
  }

  onChannelFilterChange(value: string): void {
    this.channelFilter.set(value);
    this.page.set(0);
    this.syncUrl();
    this.loadExecutions();
  }

  onPhoneFilterChange(value: string): void {
    this.phoneFilter.set(value ?? '');
    if (this.phoneDebounceTimer) clearTimeout(this.phoneDebounceTimer);
    this.phoneDebounceTimer = setTimeout(() => {
      this.page.set(0);
      this.syncUrl();
      this.loadExecutions();
    }, 350);
  }

  onFromDateChange(value: string): void {
    this.fromDate.set(value);
    this.activeQuickRange.set(null);
    this.page.set(0);
    this.syncUrl();
    this.loadExecutions();
  }

  onToDateChange(value: string): void {
    this.toDate.set(value);
    this.activeQuickRange.set(null);
    this.page.set(0);
    this.syncUrl();
    this.loadExecutions();
  }

  applyQuickRange(days: number): void {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - (days - 1));
    this.fromDate.set(this.toDateInput(start));
    this.toDate.set(this.toDateInput(end));
    this.activeQuickRange.set(days);
    this.page.set(0);
    this.syncUrl();
    this.loadExecutions();
  }

  clearFilters(): void {
    this.statusFilter.set('');
    this.channelFilter.set('');
    this.phoneFilter.set('');
    this.fromDate.set('');
    this.toDate.set('');
    this.activeQuickRange.set(null);
    if (this.phoneDebounceTimer) {
      clearTimeout(this.phoneDebounceTimer);
      this.phoneDebounceTimer = null;
    }
    this.page.set(0);
    this.syncUrl();
    this.loadExecutions();
  }

  private toDateInput(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private toIsoStart(value: string): string | undefined {
    if (!value) return undefined;
    const d = new Date(`${value}T00:00:00`);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  }

  private toIsoEnd(value: string): string | undefined {
    if (!value) return undefined;
    const d = new Date(`${value}T23:59:59.999`);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  }

  protected readonly dispatchState = dispatchState;
  protected readonly dispatchTraceRef = dispatchTraceRef;

  dispatchTooltip(execution: WorkflowExecution): string {
    return dispatchTooltip(execution, (v) => this.formatDateTime(v));
  }

  statusClass(status: string): string {
    const map: Record<string, string> = {
      COMPLETED: 'status-completed',
      ACTIVE: 'status-active',
      IN_PROGRESS: 'status-in-progress',
      WAITING: 'status-waiting',
      FAILED: 'status-failed',
      CANCELLED: 'status-cancelled',
      STOPPED: 'status-stopped',
      PAUSED: 'status-paused',
      DRAFT: 'status-draft',
      UPCOMING: 'status-upcoming',
    };
    return map[status] ?? 'status-default';
  }
}
