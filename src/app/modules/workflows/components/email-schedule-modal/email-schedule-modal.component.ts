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
import { finalize } from 'rxjs/operators';
import { SchedulePickerComponent } from '../schedule-picker/schedule-picker.component';
import { EmailScheduleService } from '../../services/email-schedule.service';
import {
  DATA_WINDOW_PRESETS,
  DataWindowType,
  EmailSchedule,
  EmailScheduleRequest,
} from '../../models/email-schedule.model';
import { ScheduleValue } from '../../utils/schedule';

function parseEmails(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Reports carry execution data, so they may only be mailed inside the company. The backend rejects
 * anything else regardless; this is here to say so before the user hits save.
 *
 * Exact host match, so a lookalike like "example.com.attacker.net" and a subdomain like
 * "mail.example.com" are both rejected rather than waved through by a suffix check.
 */
const ALLOWED_RECIPIENT_DOMAIN = 'example.com';

function isInternalAddress(address: string): boolean {
  const parts = address.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  return parts[1].toLowerCase() === ALLOWED_RECIPIENT_DOMAIN;
}

/** The addresses that would be rejected, so the message can name them. */
function externalAddresses(addresses: string[]): string[] {
  return addresses.filter((a) => !isInternalAddress(a));
}

/** Popup form to create/edit a report email schedule. */
@Component({
  selector: 'app-email-schedule-modal',
  imports: [CommonModule, LucideAngularModule, SchedulePickerComponent],
  templateUrl: './email-schedule-modal.component.html',
  styleUrl: './email-schedule-modal.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmailScheduleModalComponent implements OnInit {
  readonly reportId = input.required<string>();
  readonly schedule = input<EmailSchedule | null>(null);
  readonly saved = output<void>();
  readonly cancelled = output<void>();

  private readonly scheduleService = inject(EmailScheduleService);

  protected readonly to = signal('');
  protected readonly cc = signal('');
  protected readonly subject = signal('');
  protected readonly body = signal('');
  protected readonly singleThread = signal(false);
  protected readonly windowType = signal<DataWindowType>('LAST_DAYS');
  protected readonly windowValue = signal(7);
  protected readonly scheduleValue = signal<ScheduleValue | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly initialSchedule = signal<{ scheduleType?: string; cron?: string; runAt?: string } | null>(null);

  protected readonly DATA_WINDOW_PRESETS = DATA_WINDOW_PRESETS;
  protected readonly isEdit = computed(() => !!this.schedule());

  ngOnInit(): void {
    const s = this.schedule();
    if (s) {
      this.to.set((s.recipientsTo ?? []).join(', '));
      this.cc.set((s.recipientsCc ?? []).join(', '));
      this.subject.set(s.subject ?? '');
      this.body.set(s.body ?? '');
      this.singleThread.set(!!s.singleThread);
      if (s.dataWindow) {
        this.windowType.set(s.dataWindow.type);
        this.windowValue.set(s.dataWindow.value || 1);
      }
      this.initialSchedule.set({ scheduleType: s.scheduleType, cron: s.cron, runAt: s.runAt });
    }
  }

  isRolling(type: DataWindowType): boolean {
    return !!DATA_WINDOW_PRESETS.find((p) => p.type === type)?.rolling;
  }

  rollingUnit(type: DataWindowType): string {
    return DATA_WINDOW_PRESETS.find((p) => p.type === type)?.unit ?? '';
  }

  onScheduleChange(value: ScheduleValue): void {
    this.scheduleValue.set(value);
  }

  save(): void {
    const sv = this.scheduleValue();
    const to = parseEmails(this.to());
    const cc = parseEmails(this.cc());
    if (!to.length) {
      this.error.set('At least one "to" recipient is required.');
      return;
    }
    const external = externalAddresses([...to, ...cc]);
    if (external.length) {
      this.error.set(
        `Recipients must be @${ALLOWED_RECIPIENT_DOMAIN} addresses. Remove: ${external.join(', ')}`
      );
      return;
    }
    if (!this.subject().trim()) {
      this.error.set('Subject is required.');
      return;
    }
    if (!sv || (sv.scheduleType === 'RECURRING' && !sv.cron) || (sv.scheduleType === 'ONCE' && !sv.runAt)) {
      this.error.set('Please complete the schedule (pick a date/time).');
      return;
    }
    this.error.set(null);

    const req: EmailScheduleRequest = {
      scheduleType: sv.scheduleType,
      cron: sv.cron,
      runAt: sv.runAt,
      summary: sv.summary,
      recipientsTo: to,
      recipientsCc: cc,
      subject: this.subject().trim(),
      body: this.body().trim() || undefined,
      singleThread: this.singleThread(),
      dataWindow: { type: this.windowType(), value: this.windowValue() },
    };

    this.saving.set(true);
    const existing = this.schedule();
    const op = existing
      ? this.scheduleService.update(this.reportId(), existing.id, req)
      : this.scheduleService.create(this.reportId(), req);
    op.pipe(finalize(() => this.saving.set(false))).subscribe({
      next: () => this.saved.emit(),
      error: (e) => this.error.set(e.message ?? 'Failed to save schedule'),
    });
  }

  cancel(): void {
    this.cancelled.emit();
  }
}
