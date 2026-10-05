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
import { ActivatedRoute, Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { forkJoin, of } from 'rxjs';
import { catchError, finalize, map, shareReplay } from 'rxjs/operators';
import { ReportColumnSelectorComponent } from '../../components/report-column-selector/report-column-selector.component';
import { ReportFiltersComponent } from '../../components/report-filters/report-filters.component';
import { ExecutionReportService } from '../../services/execution-report.service';
import { WorkflowTemplateService } from '../../services/workflow-template.service';
import {
  DEFAULT_REPORT_DATE_FORMAT,
  ExecutionReportRequest,
  REPORT_DATE_FORMAT_OPTIONS,
  ReportFilter,
} from '../../models/execution-report.model';
import { ReportColumnSelection } from '../../models/workflow-template.model';
import { ReportColumnMeta, deriveReportColumns } from '../../utils/report-columns';
import { EmailScheduleModalComponent } from '../../components/email-schedule-modal/email-schedule-modal.component';
import { EmailScheduleService } from '../../services/email-schedule.service';
import { ConfirmDialogService } from '../../../../shared/ui/confirm-dialog/confirm-dialog.service';
import {
  DATA_WINDOW_PRESETS,
  EmailSchedule,
  ReportDataWindow,
  UpcomingSend,
} from '../../models/email-schedule.model';
import { DataFunctionService } from '../../../data-functions/services/data-function.service';
import { DataFunction } from '../../../data-functions/models/data-function.model';

@Component({
  selector: 'app-execution-report-form',
  imports: [
    CommonModule,
    LucideAngularModule,
    ReportColumnSelectorComponent,
    ReportFiltersComponent,
    EmailScheduleModalComponent,
  ],
  templateUrl: './execution-report-form.component.html',
  styleUrl: './execution-report-form.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExecutionReportFormComponent implements OnInit, OnDestroy {
  private readonly reportService = inject(ExecutionReportService);
  private readonly templateService = inject(WorkflowTemplateService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly scheduleService = inject(EmailScheduleService);
  private readonly dataFunctionService = inject(DataFunctionService);
  private readonly confirm = inject(ConfirmDialogService);

  /**
   * Data Functions, fetched once and replayed. They carry the declared types of the enrichment
   * input columns; without them those columns fall back to STRING, so a failed fetch degrades
   * the filter editor rather than breaking it.
   */
  private readonly dataFunctions$ = this.dataFunctionService.list({ size: 200 }).pipe(
    map((res) => res.items),
    catchError(() => of([] as DataFunction[])),
    shareReplay({ bufferSize: 1, refCount: false })
  );

  protected readonly reportId = signal<string | null>(null);
  protected readonly templates = signal<{ id: string; name: string }[]>([]);
  protected readonly selectedTemplateId = signal<string>('');
  protected readonly columns = signal<ReportColumnMeta[]>([]);
  protected readonly filterableColumns = computed(() => this.columns().filter((c) => c.filterable));

  protected readonly title = signal('');
  protected readonly description = signal('');
  /** Applies to every date cell in this report's CSV. */
  protected readonly dateFormat = signal<string>(DEFAULT_REPORT_DATE_FORMAT);
  protected readonly dateFormatOptions = REPORT_DATE_FORMAT_OPTIONS;
  protected readonly reportColumns = signal<ReportColumnSelection | undefined>(undefined);
  protected readonly filters = signal<ReportFilter[]>([]);
  protected readonly initialSelection = signal<ReportColumnSelection | undefined>(undefined);
  protected readonly initialFilters = signal<ReportFilter[]>([]);

  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly isEdit = computed(() => this.reportId() !== null);
  protected readonly activeTab = signal<'details' | 'data' | 'schedules'>('details');

  // Mail schedules (edit mode only)
  protected readonly schedules = signal<EmailSchedule[]>([]);
  protected readonly upcoming = signal<UpcomingSend[]>([]);
  protected readonly showScheduleModal = signal(false);
  protected readonly editingSchedule = signal<EmailSchedule | null>(null);

  /** Ticks once a second so the countdown to the next send stays live. */
  private readonly now = signal(Date.now());
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  /** The send we've already refreshed for, so a fired schedule reloads exactly once. */
  private refreshedFor: string | null = null;

  /** The soonest send still in the future. Null once every schedule is paused or done. */
  protected readonly nextSend = computed<UpcomingSend | null>(() => {
    const now = this.now();
    const future = this.upcoming()
      .filter((u) => Date.parse(u.at) > now)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return future[0] ?? null;
  });

  /** The schedule behind the next send, for its subject and recipients. */
  protected readonly nextSchedule = computed<EmailSchedule | null>(() => {
    const next = this.nextSend();
    if (!next) return null;
    return this.schedules().find((s) => s.id === next.scheduleId) ?? null;
  });

  /** "4h 2min 23sec" — coarse units drop off once they're zero. */
  protected readonly countdown = computed<string>(() => {
    const next = this.nextSend();
    if (!next) return '';
    const remainingMs = Date.parse(next.at) - this.now();
    if (remainingMs <= 0) return 'any moment now';

    const total = Math.floor(remainingMs / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (days > 0 || hours > 0) parts.push(`${hours}h`);
    if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}min`);
    // Seconds are noise a day out, but they're the whole point in the last minute.
    if (days === 0) parts.push(`${seconds}sec`);
    return parts.join(' ');
  });

  ngOnInit(): void {
    this.templateService.list({ size: 200 }).subscribe({
      next: (res) => this.templates.set(res.items.map((t) => ({ id: t.id, name: t.name }))),
      error: (e) => this.error.set(e.message ?? 'Failed to load templates'),
    });

    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.reportId.set(id);
      this.loadReport(id);
    }

    this.tickHandle = setInterval(() => this.tick(), 1000);
  }

  ngOnDestroy(): void {
    if (this.tickHandle !== null) clearInterval(this.tickHandle);
  }

  /** Advances the countdown, and reloads once a send's moment has passed so its result lands. */
  private tick(): void {
    if (this.activeTab() !== 'schedules') return;
    this.now.set(Date.now());

    const soonest = this.upcoming()
      .map((u) => u.at)
      .sort()[0];
    if (!soonest || Date.parse(soonest) > Date.now()) return;
    if (this.refreshedFor === soonest) return;

    // Give the scheduler a moment to actually send before asking for the outcome.
    this.refreshedFor = soonest;
    setTimeout(() => this.reloadSchedules(), 4000);
  }

  /** First letter of a recipient's address, for the avatar chip. */
  initial(email: string): string {
    return (email?.trim()[0] ?? '?').toUpperCase();
  }

  /** "Last 20 days", "Previous week", "All time" — how much data a send carries. */
  dataWindowLabel(window?: ReportDataWindow): string {
    if (!window) return 'All time';
    const preset = DATA_WINDOW_PRESETS.find((p) => p.type === window.type);
    if (!preset) return 'All time';
    if (!preset.rolling) return preset.label;
    // Units are stored plural; "Last 1 days" reads badly.
    const unit = window.value === 1 ? preset.unit!.replace(/s$/, '') : preset.unit;
    return `Last ${window.value} ${unit}`;
  }

  onTitle(value: string): void {
    this.title.set(value);
  }

  onDescription(value: string): void {
    this.description.set(value);
  }

  onDateFormat(value: string): void {
    this.dateFormat.set(value);
  }

  onTemplateChange(templateId: string): void {
    this.selectedTemplateId.set(templateId);
    // Switching template invalidates the previous selection/filters.
    this.initialSelection.set(undefined);
    this.reportColumns.set(undefined);
    this.initialFilters.set([]);
    this.filters.set([]);
    this.loadTemplateColumns(templateId);
  }

  onColumnsChange(selection: ReportColumnSelection): void {
    this.reportColumns.set(selection);
  }

  onFiltersChange(filters: ReportFilter[]): void {
    this.filters.set(filters);
  }

  save(): void {
    if (!this.selectedTemplateId()) {
      this.error.set('Please select a workflow template.');
      return;
    }
    if (!this.title().trim()) {
      this.error.set('Please enter a report title.');
      return;
    }
    this.error.set(null);
    const request: ExecutionReportRequest = {
      templateId: this.selectedTemplateId(),
      title: this.title().trim(),
      description: this.description().trim() || undefined,
      reportColumns: this.reportColumns(),
      filters: this.filters(),
      preferredDateFormat: this.dateFormat(),
    };
    this.saving.set(true);
    const op = this.isEdit()
      ? this.reportService.update(this.reportId()!, request)
      : this.reportService.create(request);
    op.pipe(finalize(() => this.saving.set(false))).subscribe({
      next: () => this.router.navigate(['/workflows/reports']),
      error: (e) => this.error.set(e.message ?? 'Failed to save report'),
    });
  }

  cancel(): void {
    this.router.navigate(['/workflows/reports']);
  }

  private loadReport(id: string): void {
    this.loading.set(true);
    this.reportService
      .getById(id)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (report) => {
          this.title.set(report.title);
          this.description.set(report.description ?? '');
          // Reports saved before this setting existed render in the default format.
          this.dateFormat.set(report.preferredDateFormat ?? DEFAULT_REPORT_DATE_FORMAT);
          this.selectedTemplateId.set(report.templateId);
          this.initialSelection.set(report.reportColumns);
          this.reportColumns.set(report.reportColumns);
          this.initialFilters.set(report.filters ?? []);
          this.filters.set(report.filters ?? []);
          this.schedules.set(report.emailSchedules ?? []);
          this.loadUpcoming();
          this.loadTemplateColumns(report.templateId);
        },
        error: (e) => this.error.set(e.message ?? 'Failed to load report'),
      });
  }

  // ─── Mail schedules ───

  openAddSchedule(): void {
    this.editingSchedule.set(null);
    this.showScheduleModal.set(true);
  }

  openEditSchedule(schedule: EmailSchedule): void {
    this.editingSchedule.set(schedule);
    this.showScheduleModal.set(true);
  }

  closeScheduleModal(): void {
    this.showScheduleModal.set(false);
    this.editingSchedule.set(null);
  }

  onScheduleSaved(): void {
    this.closeScheduleModal();
    this.reloadSchedules();
  }

  toggleSchedule(schedule: EmailSchedule): void {
    const id = this.reportId();
    if (!id) return;
    this.scheduleService.setEnabled(id, schedule.id, !schedule.enabled).subscribe({
      next: () => this.reloadSchedules(),
      error: (e) => this.error.set(e.message ?? 'Failed to update schedule'),
    });
  }

  runScheduleNow(schedule: EmailSchedule): void {
    const id = this.reportId();
    if (!id) return;
    this.scheduleService.runNow(id, schedule.id).subscribe({
      next: () => this.reloadSchedules(),
      error: (e) => this.error.set(e.message ?? 'Failed to send'),
    });
  }

  async deleteSchedule(schedule: EmailSchedule): Promise<void> {
    const id = this.reportId();
    if (!id) return;
    const ok = await this.confirm.ask({
      title: 'Delete schedule',
      message: 'Delete this schedule?',
      confirmText: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    this.scheduleService.delete(id, schedule.id).subscribe({
      next: () => this.reloadSchedules(),
      error: (e) => this.error.set(e.message ?? 'Failed to delete schedule'),
    });
  }

  private reloadSchedules(): void {
    const id = this.reportId();
    if (!id) return;
    this.reportService.getById(id).subscribe({
      next: (report) => {
        this.schedules.set(report.emailSchedules ?? []);
        this.loadUpcoming();
      },
      error: () => {},
    });
  }

  private loadUpcoming(): void {
    const id = this.reportId();
    if (!id) return;
    this.scheduleService.upcoming(id, 8).subscribe({
      next: (u) => this.upcoming.set(u),
      error: () => this.upcoming.set([]),
    });
  }

  private loadTemplateColumns(templateId: string): void {
    if (!templateId) {
      this.columns.set([]);
      return;
    }
    this.loading.set(true);
    forkJoin([this.templateService.getById(templateId), this.dataFunctions$])
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: ([template, dataFunctions]) => this.columns.set(deriveReportColumns(template, dataFunctions)),
        error: (e) => this.error.set(e.message ?? 'Failed to load template'),
      });
  }
}
