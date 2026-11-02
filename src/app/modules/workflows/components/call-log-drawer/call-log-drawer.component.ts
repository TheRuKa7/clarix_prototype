import { callStatusView } from '../../utils/call-status';
import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { ConversationDetail, TranscriptMessage } from '../../models/conversation.model';
import { WorkflowExecution } from '../../models/workflow-template.model';
import { ConversationService } from '../../services/conversation.service';
import { WorkflowExecutionService } from '../../services/workflow-execution.service';
import { formatFieldValue, humanizeFieldKey, parseTranscript } from '../../utils/transcript-parser';
import { dispatchState, dispatchTraceRef, dispatchTooltip } from '../../utils/dispatch-state';

/**
 * Slide-in call detail panel for Call Logs and Campaign Detail. A lighter-weight sibling to the
 * full execution detail page (kept alive at its own route for deep links) — this covers the
 * common case of "what happened on this call" without leaving the list.
 */
@Component({
  selector: 'app-call-log-drawer',
  imports: [CommonModule, LucideAngularModule, RouterLink],
  templateUrl: './call-log-drawer.component.html',
  styleUrl: './call-log-drawer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallLogDrawerComponent implements OnChanges, OnDestroy {
  protected readonly view = callStatusView;
  private readonly executionService = inject(WorkflowExecutionService);
  private readonly conversationService = inject(ConversationService);

  readonly executionId = input.required<string>();
  readonly closed = output<void>();

  protected readonly loading = signal(false);
  protected readonly execution = signal<WorkflowExecution | null>(null);
  protected readonly conversation = signal<ConversationDetail | null>(null);
  protected readonly transcript = signal<TranscriptMessage[]>([]);
  protected readonly audioUrl = signal<string | null>(null);
  protected readonly audioLoading = signal(false);

  private currentAudioObjectUrl: string | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['executionId']) {
      this.load(this.executionId());
    }
  }

  ngOnDestroy(): void {
    this.revokeAudioUrl();
  }

  close(): void {
    this.closed.emit();
  }

  protected readonly dispatchState = dispatchState;
  protected readonly dispatchTraceRef = dispatchTraceRef;

  dispatchTooltip(execution: WorkflowExecution): string {
    return dispatchTooltip(execution, (v) => this.formatDateTime(v));
  }

  private formatDateTime(value?: string): string {
    if (!value) return '—';
    return new Date(value).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  extractedFieldEntries(): Array<{ key: string; label: string; value: string }> {
    const fields = this.execution()?.extractedFields ?? {};
    return Object.entries(fields).map(([key, value]) => ({
      key,
      label: humanizeFieldKey(key),
      value: formatFieldValue(value),
    }));
  }

  playAudio(): void {
    const conv = this.conversation();
    if (!conv || this.audioUrl() || this.audioLoading()) return;
    this.audioLoading.set(true);
    this.conversationService.fetchAudioBlob(conv.id).subscribe({
      next: (blob) => {
        this.revokeAudioUrl();
        this.currentAudioObjectUrl = URL.createObjectURL(blob);
        this.audioUrl.set(this.currentAudioObjectUrl);
        this.audioLoading.set(false);
      },
      error: () => this.audioLoading.set(false),
    });
  }

  private load(executionId: string): void {
    this.loading.set(true);
    this.execution.set(null);
    this.conversation.set(null);
    this.transcript.set([]);
    this.revokeAudioUrl();
    this.audioUrl.set(null);

    this.executionService.getById(executionId).subscribe({
      next: (exec) => {
        this.execution.set(exec);
        this.loading.set(false);
        if (exec.activeConversationId) {
          this.loadConversation(exec.activeConversationId);
        }
      },
      error: () => this.loading.set(false),
    });
  }

  private loadConversation(conversationId: string): void {
    this.conversationService.getById(conversationId).subscribe({
      next: (conv) => {
        this.conversation.set(conv);
        if (conv.transcriptUrl) {
          this.conversationService
            .fetchTranscript(conversationId)
            .subscribe((text) => this.transcript.set(parseTranscript(text)));
        } else if (conv.transcriptText) {
          // Inline transcript (Exchange) — already in hand, no fetch needed.
          this.transcript.set(parseTranscript(conv.transcriptText));
        }
      },
    });
  }

  private revokeAudioUrl(): void {
    if (this.currentAudioObjectUrl) {
      URL.revokeObjectURL(this.currentAudioObjectUrl);
      this.currentAudioObjectUrl = null;
    }
  }
}
