import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  HostListener,
  signal,
  viewChild,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { Subject, timeout } from 'rxjs';
import { takeUntil, finalize } from 'rxjs/operators';
import { WorkflowExecutionService } from '../../services/workflow-execution.service';
import { ConversationService } from '../../services/conversation.service';
import { WorkflowTemplateService } from '../../services/workflow-template.service';
import {
  WorkflowExecution,
  WorkflowTemplate,
} from '../../models/workflow-template.model';
import {
  ConversationDetail,
  TranscriptMessage,
} from '../../models/conversation.model';
import { ExecutionDebugModalComponent } from './execution-debug-modal/execution-debug-modal.component';
import { hangupText, mss, reasonText, resultText, statusText } from '../../utils/call-status';
import { CallDownloadsService } from '../../utils/call-downloads';
import { outcomeWord, statusHover, telephonyLine } from '../../utils/outcome';
import { CallPlayerComponent } from '../../components/call-player/call-player.component';
import { InfoHintComponent } from '../../components/info-hint/info-hint.component';

type TimelineView = 'simple' | 'detailed';

interface KeyValue {
  key: string;
  value: string;
}

interface RequiredFieldOutcome {
  label: string;
  value: string | null;
  collected: boolean;
}

@Component({
  selector: 'app-workflow-execution-detail',
  imports: [CommonModule, LucideAngularModule, ExecutionDebugModalComponent, CallPlayerComponent, InfoHintComponent],
  templateUrl: './workflow-execution-detail.component.html',
  styleUrl: './workflow-execution-detail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'onEscape()',
  },
})
export class WorkflowExecutionDetailComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly executionService = inject(WorkflowExecutionService);
  private readonly conversationService = inject(ConversationService);
  private readonly templateService = inject(WorkflowTemplateService);
  protected readonly downloads = inject(CallDownloadsService);
  protected readonly outcomeWord = outcomeWord;
  protected readonly hover = statusHover;
  protected readonly ozLine = computed(() => telephonyLine(this.execution()?.providerStatus));
  /** Where the user came from, so Back returns there: the campaign, Call Logs, or the agent's runs. */

  // ── Call page layout: player and transcript on the left, tabs on the right ──
  private readonly player = viewChild<CallPlayerComponent>('player');
  protected readonly sumOpen = signal(false);
  protected readonly side = signal<'answers' | 'dials' | 'context' | 'metrics'>('answers');
  /** Side tabs that have something to show. */
  protected readonly sideTabs = computed(() => {
    const t: { key: 'answers' | 'dials' | 'context' | 'metrics'; label: string; n: number }[] = [
      { key: 'answers', label: 'Answers', n: this.requiredFieldOutcomes().length ? this.collectedFieldCount() : 0 },
    ];
    const dials = this.execution()?.attemptLog?.length ?? 0;
    if (dials) t.push({ key: 'dials', label: 'Dials', n: dials });
    if (this.callContextEntries().length) t.push({ key: 'context', label: 'Details', n: 0 });
    return t;
  });
  /** Status info icon: meaning, what the telephony service sent, and the exact rule. */
  protected readonly whyText = computed(() => {
    const o = outcomeWord(this.execution()?.outcome);
    if (!o) return '';
    return o.help;
  });
  /** Speaker changes in seconds, from transcript times, to colour the waveform. */
  protected readonly turnMarks = computed(() =>
    this.transcriptMessages().filter((m) => m.time).map((m) => ({ at: this.secs(m.time!), who: m.isUser ? 'caller' as const : 'agent' as const }))
  );
  /** Arrow keys move between the side tabs (WAI-ARIA tabs pattern). */
  protected moveTab(d: number): void {
    const t = this.sideTabs(); const i = t.findIndex((x) => x.key === this.side());
    this.side.set(t[(i + d + t.length) % t.length].key);
  }
  protected playFrom(time?: string): void { if (time) this.player()?.seek(this.secs(time)); }
  private secs(t: string): number { return t.split(':').map(Number).reduce((n, x) => n * 60 + (x || 0), 0); }
  /** A dial's info icon: what the telephony service sent, field by field. */
  protected dialRaw(a: { provider: Record<string, string | undefined>; anomalies?: string[] }): string {
    const lines = Object.entries(a.provider || {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
    return ['Telephony sent:', ...lines, ...(a.anomalies || []).map((x) => `Note: ${x.replaceAll('_', ' ').toLowerCase()}`)].join('\n');
  }

  protected readonly from = signal<'campaign' | 'calls' | 'runs'>('runs');
  /** The campaign's calls in list order, for previous and next without going back. */
  protected readonly siblings = signal<string[]>([]);
  private siblingsBatch = '';
  protected readonly position = computed(() => this.siblings().indexOf(this.executionId) + 1);
  protected readonly backLabel = computed(() => (this.from() === 'campaign' ? 'Campaign' : this.from() === 'calls' ? 'Call Logs' : 'All runs'));
  protected hasTalk(): boolean { const e = this.execution(); return !!e?.activeConversationId && e.status === 'COMPLETED' && !!e.callDurationSeconds; }
  go(step: number): void {
    const list = this.siblings();
    const i = list.indexOf(this.executionId) + step;
    if (i < 0 || i >= list.length) return;
    this.router.navigate(['/workflows/templates', this.execution()?.templateId || this.templateId, 'executions', list[i]], { queryParamsHandling: 'preserve' });
  }
  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
    if (e.key === 'j') this.go(1);
    if (e.key === 'k') this.go(-1);
  }
  private readonly destroy$ = new Subject<void>();

  protected readonly executionLoading = signal(false);
  protected readonly conversationLoading = signal(false);
  protected readonly transcriptLoading = signal(false);
  protected readonly transcriptError = signal<string | null>(null);
  protected readonly audioLoading = signal(false);
  protected readonly audioError = signal<string | null>(null);
  protected readonly audioObjectUrl = signal<string | null>(null);
  protected readonly execution = signal<WorkflowExecution | null>(null);
  protected readonly mss = mss;
  protected readonly hangupText = hangupText;
  protected readonly statusText = statusText;
  protected readonly resultText = resultText;
  protected readonly reasonText = reasonText;
  protected readonly template = signal<WorkflowTemplate | null>(null);
  protected readonly conversation = signal<ConversationDetail | null>(null);
  protected readonly transcriptText = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly timelineView = signal<TimelineView>('simple');
  protected readonly debugOpen = signal(false);

  protected templateId = '';
  protected executionId = '';

  protected readonly audioSrc = computed(() => this.audioObjectUrl());

  protected readonly headerId = computed(
    () =>
      this.conversation()?.providerSessionId ??
      this.conversation()?.id ??
      this.execution()?.activeConversationId ??
      ''
  );

  protected readonly transcriptMessages = computed<TranscriptMessage[]>(() => {
    const text = this.transcriptText();
    if (!text) return [];
    return this.parseTranscript(text);
  });

  protected readonly turns = computed(() => this.transcriptMessages().length);

  protected readonly satisfactionRating = computed(
    () => this.conversation()?.postCallIntelligence?.satisfaction_score?.rating ?? null
  );

  protected readonly satisfactionStars = computed(() => {
    const rating = this.satisfactionRating();
    if (rating == null) return null;
    return Array.from({ length: 5 }, (_, i) => i < rating);
  });

  protected readonly sentimentClass = computed(() => {
    const s = (this.conversation()?.postCallIntelligence?.sentiment ?? '').toLowerCase();
    if (s.includes('positive')) return 'sentiment-positive';
    if (s.includes('negative')) return 'sentiment-negative';
    if (s.includes('neutral')) return 'sentiment-neutral';
    return 'sentiment-default';
  });

  /** Normalises mom (which the AI may emit as a string or string[]) into a clean list. */
  protected readonly executiveSummaryItems = computed<string[]>(() => {
    const v = this.conversation()?.postCallIntelligence?.summary?.mom;
    const raw = Array.isArray(v) ? v : v != null ? [v] : [];
    return raw
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
  });

  protected readonly resolutionText = computed(
    () => this.conversation()?.postCallIntelligence?.summary?.resolution ?? null
  );

  /** Normalises pending_items (which the AI may emit as a string or string[]) into a clean list. */
  protected readonly pendingItems = computed<string[]>(() => {
    const v = this.conversation()?.postCallIntelligence?.summary?.pending_items;
    const raw = Array.isArray(v) ? v : v != null ? [v] : [];
    return raw
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
  });

  /**
   * Every context param the template maps from the trigger event, with the
   * value resolved onto this execution (or "—" when none was extracted).
   */
  protected readonly callContextEntries = computed<KeyValue[]>(() => {
    const mappings = this.template()?.contextMappings ?? [];
    if (mappings.length === 0) return [];
    const context = this.execution()?.context ?? {};
    return mappings.map((m) => {
      const raw = context[m.fieldName];
      const has = raw != null && String(raw).trim() !== '';
      return {
        key: this.humanize(m.fieldName),
        value: has ? this.formatFieldValue(raw) : '—',
      };
    });
  });

  protected readonly requiredDataEntries = computed<KeyValue[]>(() => {
    const data = this.conversation()?.postCallIntelligence?.REQUIRED_DATA;
    if (!data) return [];
    return Object.entries(data).map(([k, v]) => ({
      key: this.humanize(k),
      value: v == null || v === '' ? '—' : String(v),
    }));
  });

  /**
   * Outcome of each required field the template asked the AI to collect.
   * Values come from the conversation's extractedFields (call-specific),
   * falling back to the execution's merged extractedFields.
   */
  protected readonly requiredFieldOutcomes = computed<RequiredFieldOutcome[]>(() => {
    const fields = this.template()?.requiredFields ?? [];
    if (fields.length === 0) return [];
    const collected: Record<string, unknown> = {
      ...(this.execution()?.extractedFields ?? {}),
      ...(this.conversation()?.extractedFields ?? {}),
    };
    return fields.map((f) => {
      const raw = collected[f.fieldKey];
      const has = raw != null && String(raw).trim() !== '';
      return {
        label: f.fieldLabel || f.fieldKey,
        value: has ? this.formatFieldValue(raw) : null,
        collected: has,
      };
    });
  });

  protected readonly collectedFieldCount = computed(
    () => this.requiredFieldOutcomes().filter((o) => o.collected).length
  );

  protected readonly callMetricsEntries = computed<KeyValue[]>(() => {
    const c = this.conversation();
    if (!c) return [];
    const rows: KeyValue[] = [];
    if (c.providerSessionId) rows.push({ key: 'Session ID', value: c.providerSessionId });
    if (c.workflowExecutionId) rows.push({ key: 'Execution ID', value: c.workflowExecutionId });
    if (c.channelType) rows.push({ key: 'Channel', value: c.channelType });
    if (c.stepId) rows.push({ key: 'Step', value: c.stepId });
    if (c.durationSeconds != null)
      rows.push({ key: 'Duration', value: this.formatDurationFromSeconds(c.durationSeconds) });
    if (c.cost != null) rows.push({ key: 'Cost', value: `₹ ${c.cost.toFixed(2)}` });
    const intel = c.postCallIntelligence;
    if (intel?.intent) rows.push({ key: 'Intent', value: intel.intent });
    if (intel?.sentiment) rows.push({ key: 'Sentiment', value: intel.sentiment });
    if (intel?.tone_analysis?.classification)
      rows.push({ key: 'Tone', value: intel.tone_analysis.classification });
    if (intel?.tone_analysis?.trend)
      rows.push({ key: 'Trend', value: intel.tone_analysis.trend });
    if (c.startedAt) rows.push({ key: 'Started At', value: this.formatDateTime(c.startedAt) });
    if (c.endedAt) rows.push({ key: 'Ended At', value: this.formatDateTime(c.endedAt) });
    return rows;
  });

  protected readonly hangupEntries = computed<KeyValue[]>(() => {
    const w = this.conversation()?.providerWebhookPayload;
    if (!w) return [];
    const rows: KeyValue[] = [];
    const order = [
      'status',
      'referenceId',
      'requestId',
      'duration',
      'cost',
    ];
    for (const key of order) {
      const v = w[key];
      if (v == null || v === '') continue;
      const display =
        key === 'duration' && typeof v === 'number'
          ? this.formatDurationFromSeconds(v)
          : key === 'cost' && typeof v === 'number'
            ? `₹ ${v.toFixed(2)}`
            : String(v);
      rows.push({ key: this.humanize(key), value: display });
    }
    return rows;
  });

  ngOnInit(): void {
    if (this.route.snapshot.queryParamMap.get('from') === 'calls') this.from.set('calls');
    // Previous and next reuse this page, so follow the route instead of reading it once.
    this.route.paramMap.pipe(takeUntil(this.destroy$)).subscribe((pm) => {
      this.templateId = pm.get('templateId') ?? '';
      this.executionId = pm.get('executionId') ?? '';
      if (!this.executionId) {
        this.back();
        return;
      }
      this.revokeAudioUrl();
      this.loadExecution();
      if (this.templateId && this.template()?.id !== this.templateId) this.loadTemplate(this.templateId);
    });
  }

  private loadSiblings(templateId: string, batchId: string): void {
    if (this.siblingsBatch === batchId) return;
    this.siblingsBatch = batchId;
    this.executionService.listByTemplate(templateId, { batchId, size: 500 }).pipe(takeUntil(this.destroy$)).subscribe({
      next: (r) => this.siblings.set(r.items.map((x) => x.id)),
      error: () => this.siblings.set([]),
    });
  }

  loadTemplate(templateId: string): void {
    this.templateService
      .getById(templateId)
      .pipe(takeUntil(this.destroy$), timeout(15000))
      .subscribe({
        next: (t) => this.template.set(t),
        error: (err) => console.error('Failed to load template:', err),
      });
  }

  ngOnDestroy(): void {
    this.revokeAudioUrl();
    this.destroy$.next();
    this.destroy$.complete();
  }

  loadExecution(): void {
    this.executionLoading.set(true);
    this.error.set(null);
    this.executionService
      .getById(this.executionId)
      .pipe(
        takeUntil(this.destroy$),
        timeout(15000),
        finalize(() => this.executionLoading.set(false))
      )
      .subscribe({
        next: (exec) => {
          this.execution.set(exec);
          if (exec?.batchId) {
            if (this.from() !== 'calls') this.from.set('campaign');
            this.loadSiblings(exec.templateId, exec.batchId);
          }
          if (!this.templateId && exec?.templateId) {
            this.loadTemplate(exec.templateId);
          }
          if (exec?.activeConversationId) {
            this.loadConversation(exec.activeConversationId);
          }
        },
        error: (err) => {
          console.error('Failed to load execution:', err);
          this.error.set('Failed to load execution details.');
        },
      });
  }

  loadConversation(conversationId: string): void {
    this.conversationLoading.set(true);
    this.conversationService
      .getById(conversationId)
      .pipe(
        takeUntil(this.destroy$),
        timeout(15000),
        finalize(() => this.conversationLoading.set(false))
      )
      .subscribe({
        next: (c) => {
          this.conversation.set(c);
          if (c?.id && c?.transcriptUrl) {
            this.loadTranscript(c.id);
          } else if (c?.transcriptText) {
            // Inline transcript (Exchange) — already in hand, no fetch needed.
            this.transcriptText.set(c.transcriptText);
          }
          if (c?.id && c?.audioUrl) {
            this.loadAudio(c.id);
          }
        },
        error: (err) => {
          console.error('Failed to load conversation:', err);
          this.conversation.set(null);
        },
      });
  }

  loadAudio(conversationId: string): void {
    this.revokeAudioUrl();
    this.audioLoading.set(true);
    this.audioError.set(null);
    this.conversationService
      .fetchAudioBlob(conversationId)
      .pipe(
        takeUntil(this.destroy$),
        timeout(30000),
        finalize(() => this.audioLoading.set(false))
      )
      .subscribe({
        next: (blob) => {
          const url = URL.createObjectURL(blob);
          this.audioObjectUrl.set(url);
        },
        error: () => this.audioError.set('Could not load audio recording.'),
      });
  }

  /** Retries the audio fetch — some providers publish the recording to storage a little after
   *  the completion webhook fires, so the first load can 403 for a short window. */
  retryAudio(): void {
    const conversationId = this.conversation()?.id;
    if (conversationId) {
      this.loadAudio(conversationId);
    }
  }

  private revokeAudioUrl(): void {
    const url = this.audioObjectUrl();
    if (url) {
      URL.revokeObjectURL(url);
      this.audioObjectUrl.set(null);
    }
  }

  loadTranscript(conversationId: string): void {
    this.transcriptLoading.set(true);
    this.transcriptError.set(null);
    this.conversationService
      .fetchTranscript(conversationId)
      .pipe(
        takeUntil(this.destroy$),
        timeout(15000),
        finalize(() => this.transcriptLoading.set(false))
      )
      .subscribe({
        next: (text) => this.transcriptText.set(text),
        error: () => this.transcriptError.set('Could not fetch transcript inline.'),
      });
  }

  back(): void {
    const e = this.execution();
    if (this.from() === 'calls') { this.router.navigate(['/workflows/calls']); return; }
    if (this.from() === 'campaign' && e?.batchId) { this.router.navigate(['/workflows/campaigns', e.batchId]); return; }
    if (this.templateId) {
      this.router.navigate(['/workflows/templates', this.templateId, 'executions']);
    } else {
      this.router.navigate(['/workflows/templates']);
    }
  }

  refresh(): void {
    this.loadExecution();
  }

  setTimelineView(view: TimelineView): void {
    this.timelineView.set(view);
  }

  onEscape(): void {
    if (this.debugOpen()) this.closeDebug();
  }

  openDebug(): void {
    this.debugOpen.set(true);
  }

  closeDebug(): void {
    this.debugOpen.set(false);
  }

  /** After a manual sync in the debug modal, refresh execution + conversation panels. */
  onDebugSynced(): void {
    this.loadExecution();
  }

  copyTranscript(): void {
    const text = this.transcriptText();
    if (!text || !navigator?.clipboard) return;
    navigator.clipboard.writeText(text).catch((e) => console.error(e));
  }

  downloadTxt(): void {
    const text = this.transcriptText();
    if (!text) return;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript-${this.conversation()?.providerSessionId ?? this.executionId}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  formatDateTime(value?: string | null): string {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  formatTime(value?: string | null): string {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  formatDurationFromSeconds(seconds?: number | null): string {
    if (seconds == null) return '—';
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${this.pad(h)}:${this.pad(m)}:${this.pad(s)}`;
  }

  private parseTranscript(text: string): TranscriptMessage[] {
    const lines = text.split(/\r?\n/);
    const messages: TranscriptMessage[] = [];
    let current: TranscriptMessage | null = null;

    const speakerRegex = /^\s*(?:\[(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\]\s*)?([A-Za-z][A-Za-z _-]{0,30})\s*[:>-]\s*(.*)$/;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        if (current) {
          messages.push(current);
          current = null;
        }
        continue;
      }
      const match = speakerRegex.exec(line);
      if (match) {
        if (current) messages.push(current);
        const speaker = match[2].trim();
        current = {
          speaker,
          time: match[1],
          text: match[3] ?? '',
          isUser: this.isUserSpeaker(speaker),
        };
      } else if (current) {
        current.text = current.text ? `${current.text} ${line}` : line;
      } else {
        current = { speaker: 'Transcript', text: line, isUser: false };
      }
    }
    if (current) messages.push(current);
    return messages;
  }

  private isUserSpeaker(speaker: string): boolean {
    const s = speaker.toLowerCase();
    return (
      s === 'user' ||
      s === 'customer' ||
      s === 'human' ||
      s === 'caller' ||
      s.startsWith('user ')
    );
  }

  private formatFieldValue(value: unknown): string {
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (value !== null && typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  private humanize(key: string): string {
    return key
      .replace(/([A-Z])/g, ' $1')
      .replace(/[_-]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^./, (c) => c.toUpperCase())
      .trim();
  }

  private pad(n: number): string {
    return n.toString().padStart(2, '0');
  }
}
