import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { finalize } from 'rxjs/operators';
import { ExecutionSheet } from '../../models/execution-sheet.model';
import { WorkflowExecution } from '../../models/workflow-template.model';
import { ExecutionSheetService } from '../../services/execution-sheet.service';
import { WorkflowExecutionService } from '../../services/workflow-execution.service';
import { ConfirmDialogService } from '../../../../shared/ui/confirm-dialog/confirm-dialog.service';
import { CampaignProgress, buildCampaignProgress, campaignState } from '../../utils/campaign-progress';
import { callStatusView, mss } from '../../utils/call-status';
import { downloadBlob } from '../../utils/csv-download';
import { InfoHintComponent } from '../../components/info-hint/info-hint.component';
import { GROUPS, campaignRule, outcomeWord, statusHover, telephonyLine, runTime } from '../../utils/outcome';
import { CallStatusReferenceComponent } from '../../components/call-status-reference/call-status-reference.component';
import { CallDownloadsService } from '../../utils/call-downloads';

/**
 * Run > Campaigns drill-in: one uploaded sheet's calls with Echo's status and
 * result for each, plus Stop and the report. Refreshes itself while calls are open.
 */
@Component({
  selector: 'app-campaign-detail',
  imports: [CommonModule, LucideAngularModule, CallStatusReferenceComponent, InfoHintComponent],
  templateUrl: './campaign-detail.component.html',
  styleUrl: './campaign-detail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CampaignDetailComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly sheetService = inject(ExecutionSheetService);
  private readonly executionService = inject(WorkflowExecutionService);
  private readonly confirm = inject(ConfirmDialogService);

  protected readonly loading = signal(false);
  protected readonly campaign = signal<ExecutionSheet | null>(null);
  protected readonly calls = signal<WorkflowExecution[]>([]);
  protected readonly callsLoading = signal(false);
  protected readonly downloadingOutput = signal(false);
  protected readonly stopping = signal(false);
  protected readonly filter = signal('');
  protected readonly view = callStatusView;
  protected readonly mss = mss;
  protected readonly dials = computed(() => this.calls().reduce((n, c) => n + (c.attemptNumber || 0), 0));
  protected readonly talkSeconds = computed(() => this.calls().reduce((n, c) => n + (c.callStatus === 'COMPLETED' ? c.callDurationSeconds || 0 : 0), 0));
  private timer: ReturnType<typeof setInterval> | null = null;

  protected readonly progress = computed<CampaignProgress | null>(() => {
    const c = this.campaign();
    return c ? buildCampaignProgress(c) : null;
  });
  protected readonly state = computed(() => campaignState(this.progress() ?? undefined));

  protected readonly downloads = inject(CallDownloadsService);
  protected readonly runTime = runTime;
  protected readonly q = signal('');
  protected readonly group = signal('');
  protected readonly outcomeFilter = signal('');
  protected readonly filtersOn = computed(() => !!(this.q().trim() || this.group() || this.outcomeFilter()));

  /** Echo's outcome for a call, or the older status words for runs from before outcomes existed. */
  protected word(c: WorkflowExecution): { key: string; label: string; group: string; tone: string; help: string; detail: string } {
    const w = outcomeWord(c.outcome);
    const v = callStatusView(c);
    if (!w) return { key: v.label, label: v.label, group: c.status === 'IN_PROGRESS' ? 'in_progress' : c.status === 'COMPLETED' ? 'reached' : 'not_reached', tone: v.tone, help: '', detail: v.detail };
    // Talk time has its own column, so it is not repeated here.
    const detail = w.key === 'no_answer' && c.ringSeconds != null ? `rang ${mss(c.ringSeconds)}` : '';
    const dials = (c.attemptNumber || 0) > 1 ? `${c.attemptNumber} dials` : '';
    return { ...w, detail: [detail, dials].filter(Boolean).join(' · ') };
  }
  /** Status info icon: meaning, what happened, what the telephony service sent, and the rule. */
  protected why(c: WorkflowExecution, o: { help: string; detail: string; key: string }): string {
    const w = outcomeWord(c.outcome);
    return [o.help, o.detail, this.oz(c), w?.rule ? `How: ${w.rule}` : ''].filter(Boolean).join('\n');
  }
  protected readonly hover = statusHover;
  protected readonly rule = campaignRule;
  protected oz(c: WorkflowExecution): string { return telephonyLine(c.providerStatus); }
  protected hasTalk(c: WorkflowExecution): boolean { return !!c.activeConversationId && c.callStatus === 'COMPLETED' && !!c.callDurationSeconds; }
  protected readonly groupCounts = computed(() => GROUPS.map((g) => ({ ...g, count: this.calls().filter((c) => this.word(c).group === g.key).length })));
  protected readonly doneCount = computed(() => this.calls().filter((c) => this.word(c).group !== 'in_progress').length);
  protected readonly barLabel = computed(() => this.groupCounts().filter((g) => g.count).map((g) => `${g.label} ${g.count}`).join(', '));
  protected readonly outcomeCounts = computed(() => {
    const m = new Map<string, { key: string; label: string; group: string; count: number }>();
    for (const c of this.calls()) {
      const w = this.word(c);
      const cur = m.get(w.key) ?? { key: w.key, label: w.label, group: w.group, count: 0 };
      cur.count += 1;
      m.set(w.key, cur);
    }
    const order = GROUPS.map((g) => g.key as string);
    return [...m.values()].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || b.count - a.count);
  });
  protected readonly shownCalls = computed(() => {
    const t = this.q().trim().toLowerCase();
    return this.calls().filter((c) => {
      const w = this.word(c);
      if (t && ![c.resolvedContact?.name, c.resolvedContact?.phone, c.id].some((v) => String(v || '').toLowerCase().includes(t))) return false;
      if (this.group() && w.group !== this.group()) return false;
      if (this.outcomeFilter() && w.key !== this.outcomeFilter()) return false;
      return true;
    });
  });
  clearFilters(): void { this.q.set(''); this.group.set(''); this.outcomeFilter.set(''); }

  ngOnInit(): void {
    const batchId = this.route.snapshot.paramMap.get('batchId');
    if (!batchId) {
      this.router.navigate(['/workflows/campaigns']);
      return;
    }
    this.load(batchId, true);
    this.timer = setInterval(() => {
      if (this.state().cls === 'live') this.load(batchId, false);
    }, 5000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private load(batchId: string, first: boolean): void {
    if (first) this.loading.set(true);
    this.sheetService
      .getById(batchId)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (sheet) => {
          this.campaign.set(sheet);
          this.loadCalls(sheet, first);
        },
        error: (err) => console.error('Failed to load campaign:', err),
      });
  }

  private loadCalls(sheet: ExecutionSheet, first: boolean): void {
    if (!sheet.templateId) return;
    if (first) this.callsLoading.set(true);
    this.executionService
      .listByTemplate(sheet.templateId, { batchId: sheet.id, size: 500 })
      .pipe(finalize(() => this.callsLoading.set(false)))
      .subscribe({
        next: (r) => this.calls.set(r.items),
        error: (err) => console.error('Failed to load calls:', err),
      });
  }

  back(): void {
    this.router.navigate(['/workflows/campaigns']);
  }

  openAgent(): void {
    const c = this.campaign();
    if (c?.templateId) this.router.navigate(['/workflows/build/agents'], { queryParams: { templateId: c.templateId } });
  }

  openCall(execution: WorkflowExecution): void {
    this.router.navigate(['/workflows/templates', execution.templateId, 'executions', execution.id]);
  }

  async stop(): Promise<void> {
    const c = this.campaign();
    const open = this.progress()?.inProgress ?? 0;
    if (!c || !open) return;
    const ok = await this.confirm.ask({
      title: 'Stop this campaign?',
      message: `The ${open} call${open === 1 ? '' : 's'} still open will be stopped. Finished calls keep their results.`,
      confirmText: 'Stop campaign',
      tone: 'danger',
    });
    if (!ok) return;
    this.stopping.set(true);
    this.sheetService
      .stopBatch(c.id)
      .pipe(finalize(() => this.stopping.set(false)))
      .subscribe({ next: () => this.load(c.id, false), error: (err) => console.error('Stop failed:', err) });
  }

  downloadInput(): void {
    const c = this.campaign();
    if (c?.fileUrl) window.open(c.fileUrl, '_blank');
  }

  downloadOutput(): void {
    const c = this.campaign();
    if (!c?.templateId || this.downloadingOutput()) return;
    this.downloadingOutput.set(true);
    this.executionService
      .exportReport(c.templateId, { batchId: c.id })
      .pipe(finalize(() => this.downloadingOutput.set(false)))
      .subscribe({
        next: (blob) => {
          const base = (c.originalFilename || c.templateName || 'campaign').replace(/\.csv$/i, '');
          downloadBlob(`${base.replace(/[^A-Za-z0-9_-]/g, '_')}_report.xlsx`, blob);
        },
        error: (err) => console.error('Failed to download output:', err),
      });
  }
}
