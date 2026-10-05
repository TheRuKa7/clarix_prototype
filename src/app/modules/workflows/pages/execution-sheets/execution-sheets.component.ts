import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { Subject, debounceTime } from 'rxjs';
import { finalize, takeUntil } from 'rxjs/operators';
import { ExecutionSheetService } from '../../services/execution-sheet.service';
import { WorkflowExecutionService } from '../../services/workflow-execution.service';
import { ConfirmDialogService } from '../../../../shared/ui/confirm-dialog/confirm-dialog.service';
import { ExecutionSheet } from '../../models/execution-sheet.model';
import { WorkflowTemplate } from '../../models/workflow-template.model';
import { TemplatePickerComponent } from '../../components/template-picker/template-picker.component';
import { CsvBulkUploadComponent } from '../csv-bulk-upload/csv-bulk-upload.component';
import { downloadBlob } from '../../utils/csv-download';
import { CampaignProgress, buildCampaignProgress, campaignState } from '../../utils/campaign-progress';
import { GROUPS, campaignRule, runTime } from '../../utils/outcome';

const PAGE_SIZE = 20;

@Component({
  selector: 'app-execution-sheets',
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    LucideAngularModule,
    TemplatePickerComponent,
    CsvBulkUploadComponent,
  ],
  templateUrl: './execution-sheets.component.html',
  styleUrl: './execution-sheets.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExecutionSheetsComponent implements OnInit, OnDestroy {
  private readonly sheetService = inject(ExecutionSheetService);
  private readonly executionService = inject(WorkflowExecutionService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly destroy$ = new Subject<void>();
  private readonly router = inject(Router);

  /** Open a campaign's page: every call, its result, Stop and the report. */
  protected open(sheet: ExecutionSheet): void {
    this.router.navigate(['/workflows/campaigns', sheet.id]);
  }

  protected state(sheet: ExecutionSheet) {
    return campaignState(this.campaigns().get(sheet.id));
  }

  protected readonly sheets = signal<ExecutionSheet[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(0);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  // ── Filters ──
  protected readonly templateId = signal('');
  protected readonly uploadedBy = signal('');
  /** yyyy-MM-dd from the date inputs; widened to whole days when queried. */
  protected readonly fromDate = signal('');
  protected readonly toDate = signal('');

  /** A keystroke per request would hammer the endpoint; the email box waits for a pause. */
  private readonly uploadedByInput = new Subject<string>();

  protected readonly showUpload = signal(false);
  /** Batch currently being exported, so only its own button shows a spinner. */
  protected readonly downloadingId = signal<string | null>(null);
  /** Batch currently being stopped, so only its own button shows a spinner. */
  protected readonly stoppingId = signal<string | null>(null);

  /** Campaign summary per sheet id, recomputed whenever the sheet list changes. */
  protected readonly campaigns = computed<Map<string, CampaignProgress>>(() => {
    const map = new Map<string, CampaignProgress>();
    for (const s of this.sheets()) map.set(s.id, buildCampaignProgress(s));
    return map;
  });

  protected readonly pageSize = PAGE_SIZE;
  protected readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / PAGE_SIZE)));
  protected readonly firstRow = computed(() => (this.total() === 0 ? 0 : this.page() * PAGE_SIZE + 1));
  protected readonly lastRow = computed(() => Math.min(this.total(), (this.page() + 1) * PAGE_SIZE));
  protected readonly runTime = runTime;
  protected readonly rule = campaignRule;
  protected readonly RANGES = [
    { key: 'all', label: 'Any time' }, { key: 'today', label: 'Today' }, { key: '7d', label: '7 days' }, { key: '30d', label: '30 days' }, { key: 'custom', label: 'Pick dates' },
  ];
  protected readonly STATES = [{ key: 'all', label: 'All' }, { key: 'live', label: 'Running' }, { key: 'done', label: 'Finished' }];
  protected readonly range = signal('all');
  protected readonly stateFilter = signal('all');
  /** Search is applied to the loaded page: file name, agent and uploader. */
  protected readonly q = signal('');
  protected readonly shown = computed(() => {
    const t = this.q().trim().toLowerCase();
    const st = this.stateFilter();
    return this.sheets().filter((s) => {
      if (t && ![s.originalFilename, s.templateName, s.uploadedBy].some((v) => String(v || '').toLowerCase().includes(t))) return false;
      if (st === 'live' && this.state(s).cls !== 'live') return false;
      if (st === 'done' && this.state(s).cls === 'live') return false;
      return true;
    });
  });
  protected readonly hasFilters = computed(
    () => !!this.templateId() || !!this.q().trim() || this.range() !== 'all' || this.stateFilter() !== 'all' || !!this.fromDate() || !!this.toDate()
  );

  /** Progress by Echo's outcome groups; falls back to run status for older sheets. */
  protected progress(sheet: ExecutionSheet) {
    const g = sheet.outcomeGroups ?? {};
    const total = Object.values(g).reduce((n, x) => n + x, 0) || this.campaigns().get(sheet.id)?.total || 0;
    const parts = GROUPS.filter((x) => g[x.key]).map((x) => ({ key: x.key, pct: ((g[x.key] || 0) / (total || 1)) * 100, n: g[x.key] || 0, label: x.label }));
    return {
      total, parts, reached: g['reached'] || 0, done: total - (g['in_progress'] || 0),
      title: parts.map((x) => `${x.label}: ${x.n}`).join(' · '),
    };
  }

  setRange(key: string): void {
    this.range.set(key);
    if (key === 'custom') return;
    const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
    this.fromDate.set(key === 'today' ? day(0) : key === '7d' ? day(6) : key === '30d' ? day(29) : '');
    this.toDate.set('');
    this.reload();
  }

  ngOnInit(): void {
    this.uploadedByInput
      .pipe(debounceTime(350), takeUntil(this.destroy$))
      .subscribe((value) => {
        this.uploadedBy.set(value);
        this.reload();
      });
    this.load();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  onTemplateFilter(template: WorkflowTemplate | null): void {
    this.templateId.set(template?.id ?? '');
    this.reload();
  }

  onUploadedByInput(value: string): void {
    this.uploadedByInput.next(value);
  }

  onFromDate(value: string): void {
    this.fromDate.set(value);
    this.reload();
  }

  onToDate(value: string): void {
    this.toDate.set(value);
    this.reload();
  }

  clearFilters(): void {
    this.q.set('');
    this.range.set('all');
    this.stateFilter.set('all');
    this.templateId.set('');
    this.uploadedBy.set('');
    this.fromDate.set('');
    this.toDate.set('');
    this.reload();
  }

  /** Any filter change invalidates the current page — page 3 of the old result set means nothing. */
  private reload(): void {
    this.page.set(0);
    this.load();
  }

  prevPage(): void {
    if (this.page() === 0) return;
    this.page.update((p) => p - 1);
    this.load();
  }

  nextPage(): void {
    if (this.page() + 1 >= this.pageCount()) return;
    this.page.update((p) => p + 1);
    this.load();
  }

  openUpload(): void {
    this.showUpload.set(true);
  }

  closeUpload(): void {
    this.showUpload.set(false);
  }

  onUploadCompleted(): void {
    // The new sheet belongs at the top of an unfiltered, first-page list.
    this.reload();
  }

  /** The executions report for one uploaded sheet, filtered to the batch that sheet triggered. */
  downloadBatchReport(sheet: ExecutionSheet): void {
    if (!sheet.templateId || this.downloadingId()) return;
    this.downloadingId.set(sheet.id);
    this.executionService
      .exportReport(sheet.templateId, { batchId: sheet.id })
      .pipe(finalize(() => this.downloadingId.set(null)))
      .subscribe({
        next: (blob: Blob) => downloadBlob(this.reportFilename(sheet), blob),
        error: (e: { message?: string }) =>
          this.error.set(e.message ?? 'Failed to download the report'),
      });
  }

  /** Stops all in-progress calls in one sheet, after confirmation, then reloads to refresh counts. */
  async stopBatch(sheet: ExecutionSheet): Promise<void> {
    const live = sheet.inProgressCount ?? 0;
    if (live <= 0 || this.stoppingId()) return;
    const ok = await this.confirm.ask({
      title: 'Stop calls',
      message: `Stop ${live} ongoing call${live === 1 ? '' : 's'} in this sheet?`,
      confirmText: `Stop ${live} call${live === 1 ? '' : 's'}`,
      tone: 'danger',
      icon: 'phone-off',
    });
    if (!ok) return;

    this.stoppingId.set(sheet.id);
    this.sheetService
      .stopBatch(sheet.id)
      .pipe(finalize(() => this.stoppingId.set(null)))
      .subscribe({
        next: () => this.load(),
        error: (e: { message?: string }) => this.error.set(e.message ?? 'Failed to stop the calls'),
      });
  }

  private reportFilename(sheet: ExecutionSheet): string {
    const base = (sheet.originalFilename || sheet.templateName || 'executions').replace(/\.csv$/i, '');
    return `${base.replace(/[^A-Za-z0-9_-]/g, '_')}_report.csv`;
  }

  private load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.sheetService
      .list({
        page: this.page(),
        size: PAGE_SIZE,
        templateId: this.templateId() || undefined,
        uploadedBy: this.uploadedBy() || undefined,
        from: startOfDayIso(this.fromDate()),
        to: endOfDayIso(this.toDate()),
      })
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (r) => {
          this.sheets.set(r.items);
          this.total.set(r.total);
        },
        error: (e) => this.error.set(e.message ?? 'Failed to load sheets'),
      });
  }
}

/** A picked day starts at local midnight; the backend compares instants. */
function startOfDayIso(day: string): string | undefined {
  if (!day) return undefined;
  const date = new Date(`${day}T00:00:00`);
  return isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** The "to" day is inclusive, so it runs to the last millisecond of that local day. */
function endOfDayIso(day: string): string | undefined {
  if (!day) return undefined;
  const date = new Date(`${day}T23:59:59.999`);
  return isNaN(date.getTime()) ? undefined : date.toISOString();
}
