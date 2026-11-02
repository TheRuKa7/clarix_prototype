import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { LucideAngularModule } from 'lucide-angular';
import {
  DOW,
  REPEAT_MODES,
  RepeatMode,
  ScheduleState,
  ScheduleValue,
  buildScheduleValue,
  buildSummary,
  defaultScheduleState,
  parseSchedule,
} from '../../utils/schedule';

/** The "Schedule" card: pick a repeat mode + its options + time, emits a cron/runAt schedule value. */
@Component({
  selector: 'app-schedule-picker',
  imports: [CommonModule, LucideAngularModule],
  templateUrl: './schedule-picker.component.html',
  styleUrl: './schedule-picker.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SchedulePickerComponent implements OnInit {
  /** Optional existing schedule to hydrate from (edit mode). */
  readonly initial = input<{ scheduleType?: string; cron?: string; runAt?: string } | null>(null);
  readonly valueChange = output<ScheduleValue>();

  protected readonly state = signal<ScheduleState>(defaultScheduleState());
  protected readonly summary = computed(() => buildSummary(this.state()));

  protected readonly REPEAT_MODES = REPEAT_MODES;
  protected readonly DOW = DOW;
  protected readonly hourOptions = Array.from({ length: 12 }, (_, i) => i + 1);
  protected readonly minuteOptions = Array.from({ length: 12 }, (_, i) => i * 5);
  protected readonly domOptions = Array.from({ length: 31 }, (_, i) => i + 1);

  ngOnInit(): void {
    const init = this.initial();
    if (init && (init.cron || init.runAt)) {
      this.state.set(parseSchedule(init.scheduleType ?? 'RECURRING', init.cron, init.runAt));
    }
    this.emit();
  }

  ordinal(n: number): string {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  setMode(mode: RepeatMode): void {
    this.patch({ mode });
  }

  setHour(hour: number): void {
    this.patch({ hour });
  }

  setMinute(minute: number): void {
    this.patch({ minute });
  }

  setAmpm(ampm: 'AM' | 'PM'): void {
    this.patch({ ampm });
  }

  toggleDay(key: string): void {
    this.state.update((s) => {
      const set = new Set(s.specificDays);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      return { ...s, specificDays: Array.from(set) };
    });
    this.emit();
  }

  isDaySelected(key: string): boolean {
    return this.state().specificDays.includes(key);
  }

  setWeeklyDay(key: string): void {
    this.patch({ weeklyDay: key });
  }

  setDayOfMonth(dayOfMonth: number): void {
    this.patch({ dayOfMonth });
  }

  changeInterval(delta: number): void {
    this.patch({ intervalHours: Math.max(1, this.state().intervalHours + delta) });
  }

  setOnceDate(onceDate: string): void {
    this.patch({ onceDate });
  }

  private patch(partial: Partial<ScheduleState>): void {
    this.state.update((s) => ({ ...s, ...partial }));
    this.emit();
  }

  private emit(): void {
    this.valueChange.emit(buildScheduleValue(this.state()));
  }
}
