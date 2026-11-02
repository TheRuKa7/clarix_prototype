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
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { WorkflowExecution } from '../../../models/workflow-template.model';
import { WorkflowExecutionService } from '../../../services/workflow-execution.service';

/**
 * Modal to reschedule, run-now, or cancel an UPCOMING workflow execution.
 * Self-contained: performs the service calls and emits {@link changed} on success
 * so the parent can refresh, and {@link closed} to dismiss.
 */
@Component({
  selector: 'app-schedule-execution-modal',
  imports: [FormsModule, LucideAngularModule],
  templateUrl: './schedule-execution-modal.component.html',
  styleUrl: './schedule-execution-modal.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'close()',
  },
})
export class ScheduleExecutionModalComponent implements OnInit {
  private readonly executionService = inject(WorkflowExecutionService);

  readonly execution = input.required<WorkflowExecution>();
  readonly changed = output<void>();
  readonly closed = output<void>();

  protected readonly busy = signal(false);
  protected readonly error = signal<string>('');
  protected readonly confirmingCancel = signal(false);
  /** Value bound to the datetime-local input, in local "yyyy-MM-ddTHH:mm" form. */
  protected readonly picked = signal<string>('');

  /** Lower bound for the picker — one minute from now (no past scheduling). */
  protected readonly minDateTime = computed(() => this.toLocalInput(new Date(Date.now() + 60_000)));

  ngOnInit(): void {
    const scheduledAt = this.execution().scheduledAt;
    const base = scheduledAt ? new Date(scheduledAt) : new Date(Date.now() + 15 * 60_000);
    this.picked.set(this.toLocalInput(base));
  }

  save(): void {
    const value = this.picked();
    if (!value) {
      this.error.set('Please pick a date and time.');
      return;
    }
    const when = new Date(value);
    if (isNaN(when.getTime())) {
      this.error.set('Invalid date and time.');
      return;
    }
    if (when.getTime() <= Date.now()) {
      this.error.set('Scheduled time must be in the future.');
      return;
    }
    this.run(this.executionService.reschedule(this.execution().id, when.toISOString()));
  }

  executeNow(): void {
    this.run(this.executionService.executeNow(this.execution().id));
  }

  confirmCancel(): void {
    this.run(this.executionService.cancelExecution(this.execution().id));
  }

  private run(obs: Observable<WorkflowExecution>): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    obs.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: () => {
        this.changed.emit();
        this.closed.emit();
      },
      error: (err: string) => this.error.set(err ?? 'Something went wrong.'),
    });
  }

  close(): void {
    if (this.busy()) return;
    this.closed.emit();
  }

  /** Converts a Date to the local "yyyy-MM-ddTHH:mm" string a datetime-local input expects. */
  private toLocalInput(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  }
}
