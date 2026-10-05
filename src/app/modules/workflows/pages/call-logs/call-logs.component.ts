import { callStatusView, durationText } from '../../utils/call-status';
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { Subject, debounceTime, takeUntil } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { WorkflowExecution } from '../../models/workflow-template.model';
import { WorkflowExecutionService } from '../../services/workflow-execution.service';
import { Router } from '@angular/router';
import { CallDownloadsService } from '../../utils/call-downloads';
import { outcomeWord } from '../../utils/outcome';

const PAGE_SIZE = 20;
const STATUS_OPTIONS = [
  'COMPLETED',
  'FAILED',
  'IN_PROGRESS',
  'UPCOMING',
  'WAITING',
  'CANCELLED',
  'STOPPED',
];

/** Run > Call Logs & Confirmations — every call placed, org-wide, its outcome and its recording. */
@Component({
  selector: 'app-call-logs',
  imports: [CommonModule, FormsModule, LucideAngularModule],
  templateUrl: './call-logs.component.html',
  styleUrl: './call-logs.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallLogsComponent implements OnInit, OnDestroy {
  protected readonly view = callStatusView;
  protected readonly dur = durationText;
  protected readonly word = outcomeWord;
  protected readonly downloads = inject(CallDownloadsService);
  private readonly router = inject(Router);
  protected hasTalk(e: WorkflowExecution): boolean { return !!e.activeConversationId && e.status === 'COMPLETED' && !!e.callDurationSeconds; }
  /** Every call opens on its own page, with back navigation to this list. */
  openCall(e: WorkflowExecution): void { this.router.navigate(['/workflows/templates', e.templateId, 'executions', e.id], { queryParams: { from: 'calls' } }); }
  protected statusWord(s: string): string { return callStatusView({ status: s } as any).label; }
  private readonly executionService = inject(WorkflowExecutionService);
  private readonly destroy$ = new Subject<void>();
  private readonly searchInput$ = new Subject<string>();

  protected readonly statusOptions = STATUS_OPTIONS;
  protected readonly loading = signal(false);
  protected readonly executions = signal<WorkflowExecution[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(0);
  protected readonly pageSize = PAGE_SIZE;

  searchTerm = '';
  statusFilter = '';


  ngOnInit(): void {
    this.searchInput$.pipe(takeUntil(this.destroy$), debounceTime(350)).subscribe(() => {
      this.page.set(0);
      this.load();
    });
    this.load();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  onSearchChange(): void {
    this.searchInput$.next(this.searchTerm);
  }

  onStatusFilterChange(): void {
    this.page.set(0);
    this.load();
  }

  prevPage(): void {
    if (this.page() === 0) return;
    this.page.update((p) => p - 1);
    this.load();
  }

  nextPage(): void {
    if ((this.page() + 1) * PAGE_SIZE >= this.total()) return;
    this.page.update((p) => p + 1);
    this.load();
  }



  private load(): void {
    this.loading.set(true);
    this.executionService
      .listAll({
        page: this.page(),
        size: PAGE_SIZE,
        status: this.statusFilter || undefined,
        search: this.searchTerm || undefined,
      })
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (r) => {
          this.executions.set(r.items);
          this.total.set(r.total);
        },
        error: (err) => console.error('Failed to load call logs:', err),
      });
  }
}
