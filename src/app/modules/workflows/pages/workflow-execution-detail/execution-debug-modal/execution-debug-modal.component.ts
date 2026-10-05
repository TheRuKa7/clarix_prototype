import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { LucideAngularModule } from 'lucide-angular';
import { Subject, timeout } from 'rxjs';
import { finalize, takeUntil } from 'rxjs/operators';
import { WorkflowExecutionService } from '../../../services/workflow-execution.service';
import { WorkflowEventModel } from '../../../models/workflow-event.model';
import { HasPermissionDirective } from '../../../../../core/permissions/directives/has-permission.directive';

type PayloadKind = 'request' | 'response' | 'error';

interface TimelineNode {
  event: WorkflowEventModel;
  icon: string;
  label: string;
  tone: string; // maps to a status-dot colour class
  time: string;
  relative: string;
  hasRequest: boolean;
  hasResponse: boolean;
  hasError: boolean;
  isLatest: boolean;
}

@Component({
  selector: 'app-execution-debug-modal',
  imports: [CommonModule, LucideAngularModule, HasPermissionDirective],
  templateUrl: './execution-debug-modal.component.html',
  styleUrl: './execution-debug-modal.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'close()',
  },
})
export class ExecutionDebugModalComponent implements OnInit {
  private readonly executionService = inject(WorkflowExecutionService);
  private readonly destroy$ = new Subject<void>();

  readonly executionId = input.required<string>();
  readonly closed = output<void>();
  /** Emitted after a manual sync so the parent can refresh the execution/conversation. */
  readonly synced = output<void>();

  protected readonly loading = signal(false);
  protected readonly syncing = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly events = signal<WorkflowEventModel[]>([]);

  /** id of the event whose payload viewer is open, plus which payload. */
  protected readonly openPayload = signal<{ id: string; kind: PayloadKind } | null>(null);
  protected readonly copied = signal(false);

  // Newest event first — the reversed order matches "most recent on top".
  protected readonly nodes = computed<TimelineNode[]>(() =>
    this.events()
      .map((event) => {
        const { icon, label } = this.describe(event);
        return {
          event,
          icon,
          label,
          tone: this.toneFor(event.status),
          time: this.formatDateTime(event.createdAt),
          relative: this.relativeTime(event.createdAt),
          hasRequest: this.hasPayload(event.requestPayload),
          hasResponse: this.hasPayload(event.responsePayload),
          hasError: !!event.errorMessage,
          isLatest: false,
        };
      })
      .reverse()
      // After reversing, index 0 is the most recent event — flag it so its icon pulses.
      .map((node, i) => ({ ...node, isLatest: i === 0 }))
  );

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.executionService
      .getEvents(this.executionId())
      .pipe(takeUntil(this.destroy$), timeout(15000), finalize(() => this.loading.set(false)))
      .subscribe({
        next: (events) => {
          this.events.set(events);
          this.autoOpenNewest(events);
        },
        error: (err) => {
          console.error('Failed to load events:', err);
          this.error.set('Failed to load the timeline.');
        },
      });
  }

  /** Auto-expand the newest event's response (or error), so the latest result is visible up-front. */
  private autoOpenNewest(events: WorkflowEventModel[]): void {
    const newest = events[events.length - 1];
    if (!newest) {
      this.openPayload.set(null);
      return;
    }
    if (this.hasPayload(newest.responsePayload)) {
      this.openPayload.set({ id: newest.id, kind: 'response' });
    } else if (newest.errorMessage) {
      this.openPayload.set({ id: newest.id, kind: 'error' });
    } else {
      this.openPayload.set(null);
    }
  }

  syncNow(): void {
    if (this.syncing()) return;
    this.syncing.set(true);
    this.executionService
      .syncStatus(this.executionId())
      .pipe(takeUntil(this.destroy$), timeout(20000), finalize(() => this.syncing.set(false)))
      .subscribe({
        next: () => {
          this.synced.emit();
          this.load(); // pick up the new STATUS_SYNC event (and any follow-on webhook processing)
        },
        error: (err) => {
          console.error('Sync failed:', err);
          this.error.set(typeof err === 'string' ? err : 'Failed to sync call status.');
        },
      });
  }

  close(): void {
    this.destroy$.next();
    this.closed.emit();
  }

  togglePayload(eventId: string, kind: PayloadKind): void {
    const cur = this.openPayload();
    if (cur && cur.id === eventId && cur.kind === kind) {
      this.openPayload.set(null);
    } else {
      this.copied.set(false);
      this.openPayload.set({ id: eventId, kind });
    }
  }

  isPayloadOpen(eventId: string, kind: PayloadKind): boolean {
    const cur = this.openPayload();
    return !!cur && cur.id === eventId && cur.kind === kind;
  }

  /** Pretty-printed JSON of the currently open payload, or the raw error text for the 'error' kind. */
  payloadJson(event: WorkflowEventModel, kind: PayloadKind): string {
    if (kind === 'error') return event.errorMessage ?? '';
    const data = kind === 'request' ? event.requestPayload : event.responsePayload;
    if (!data) return '';
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return 'Unable to render payload.';
    }
  }

  copyPayload(json: string): void {
    if (!json || !navigator?.clipboard) return;
    navigator.clipboard
      .writeText(json)
      .then(() => {
        this.copied.set(true);
        setTimeout(() => this.copied.set(false), 2000);
      })
      .catch((e) => console.error(e));
  }

  private hasPayload(p: Record<string, unknown> | null | undefined): boolean {
    return !!p && Object.keys(p).length > 0;
  }

  private toneFor(status: string): string {
    switch ((status ?? '').toUpperCase()) {
      case 'SUCCESS':
        return 'tone-success';
      case 'FAILED':
        return 'tone-failed';
      case 'RETRYING':
        return 'tone-retrying';
      default:
        return 'tone-pending';
    }
  }

  formatDateTime(value?: string | null): string {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  private relativeTime(value?: string | null): string {
    if (!value) return '';
    const d = new Date(value).getTime();
    if (isNaN(d)) return '';
    const diff = Date.now() - d;
    const sec = Math.round(diff / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    return `${day}d ago`;
  }

  /**
   * Turns a raw event into a plain-language timeline step. Reads like a story:
   * started → placing the call → waiting for webhook → (webhook received | auto-sync) → completed/failed.
   * CALL_INITIATED is disambiguated by status (pending = placing, success = waiting), and STATUS_SYNC
   * by its source (manual vs. the automatic missing-webhook fallback).
   */
  private describe(event: WorkflowEventModel): { icon: string; label: string } {
    const status = (event.status ?? '').toUpperCase();
    const source = (event.requestPayload?.['source'] as string | undefined)?.toLowerCase();
    switch (event.eventType) {
      case 'WORKFLOW_TRIGGERED':
        return { icon: 'play', label: 'Workflow execution started' };
      case 'CALL_INITIATED':
        if (status === 'SUCCESS') return { icon: 'phone-call', label: 'Call placed' };
        if (status === 'FAILED') return { icon: 'phone-off', label: 'Call failed' };
        return { icon: 'phone-outgoing', label: 'Placing the call' };
      case 'WAITING_FOR_WEBHOOK':
        return { icon: 'clock', label: 'Waiting for webhook' };
      case 'CALL_ANSWERED':
        return { icon: 'phone-call', label: 'Call answered' };
      case 'CALL_COMPLETED':
        return { icon: 'phone', label: 'Call completed' };
      case 'CALL_FAILED':
        return { icon: 'phone-off', label: 'Call failed' };
      case 'CALL_NO_ANSWER':
        return { icon: 'phone-missed', label: 'No answer' };
      case 'CALL_STOPPED':
        return { icon: 'phone-off', label: 'Call stopped' };
      case 'RETRY_SCHEDULED':
        return { icon: 'rotate-ccw', label: 'Trying to place the call again' };
      case 'STATUS_SYNC':
        return source === 'manual'
          ? { icon: 'refresh-cw', label: 'Manual status sync' }
          : { icon: 'refresh-cw', label: 'Webhook not received, syncing automatically' };
      case 'WEBHOOK_RECEIVED':
        return { icon: 'webhook', label: 'Webhook received' };
      case 'FIELD_EXTRACTED':
        return { icon: 'list-checks', label: 'Fields extracted' };
      case 'ESCALATION_TRIGGERED':
        return { icon: 'triangle-alert', label: 'Escalation triggered' };
      case 'WORKFLOW_COMPLETED':
        return { icon: 'circle-check', label: 'Completed' };
      case 'WORKFLOW_FAILED':
        return { icon: 'circle-x', label: 'Failed' };
      case 'WHATSAPP_SENT':
      case 'WHATSAPP_DELIVERED':
      case 'WHATSAPP_READ':
      case 'WHATSAPP_REPLIED':
        return { icon: 'message-circle', label: this.humanize(event.eventType) };
      default:
        return { icon: 'circle', label: this.humanize(event.eventType) };
    }
  }

  private humanize(key: string): string {
    return key
      .toLowerCase()
      .replace(/[_-]/g, ' ')
      .replace(/^./, (c) => c.toUpperCase());
  }
}
