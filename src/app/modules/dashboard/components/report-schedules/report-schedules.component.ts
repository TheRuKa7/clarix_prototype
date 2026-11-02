import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { ReportColumn, ReportSchedule, ReportService } from '../../services/report.service';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FORMATS = [
  { key: 'image', label: 'Picture', icon: 'image', help: 'One picture in the email body, ready to forward to a chat group.' },
  { key: 'pdf', label: 'PDF', icon: 'file-text', help: 'A two page summary for reviews.' },
  { key: 'excel', label: 'Spreadsheet', icon: 'table', help: 'Five tabs: summary, comparison, day by day, follow ups and every contact.' },
];

/** Reports by email: the list of what is sent, and one short form to add or change one. A compact centred popup. */
@Component({
  selector: 'app-report-schedules',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule],
  templateUrl: './report-schedules.component.html',
  styleUrl: './report-schedules.component.scss',
  host: { '(document:keydown.escape)': 'onEsc()' },
})
export class ReportSchedulesComponent {
  private readonly reports = inject(ReportService);
  /** What the dashboard is showing now; a new report starts from it. */
  readonly by = input('agent');
  readonly columns = input<ReportColumn[]>([]);
  readonly startNew = input(false);
  readonly agent = input('');
  readonly agents = input<{ key: string; label: string }[]>([]);
  readonly closed = output<void>();

  protected readonly DAYS = DAYS;
  protected readonly FORMATS = FORMATS;
  protected readonly list = signal<ReportSchedule[]>([]);
  protected readonly form = signal<ReportSchedule | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly sent = signal('');
  protected readonly removing = signal<ReportSchedule | null>(null);
  protected readonly typing = signal('');
  protected readonly preview = computed(() => { const f = this.form(); return f ? `Goes out ${this.when(f).toLowerCase()}` : ''; });
  protected readonly values = computed(() => this.columns().find((c) => c.key === this.form()?.by)?.values ?? []);

  constructor() { this.load().then(() => { if (this.startNew()) this.add(); }); }

  private async load(): Promise<void> {
    try { this.list.set(await firstValueFrom(this.reports.schedules())); this.error.set(''); } catch { this.error.set('Could not load the reports. Try again.'); }
  }
  protected onEsc(): void { if (this.removing()) this.removing.set(null); else if (this.form()) this.form.set(null); else this.closed.emit(); }
  protected add(): void { this.error.set(''); this.typing.set(''); this.form.set({ name: '', every: 'day', weekdays: [1, 2, 3, 4, 5], time: '18:30', days: 1, by: this.by(), value: '', agent: this.agent(), recipients: [], formats: ['image', 'excel'], include_follow_ups: true, on: true }); }
  protected edit(s: ReportSchedule): void { this.error.set(''); this.typing.set(''); this.form.set({ ...s, weekdays: [...s.weekdays], recipients: [...s.recipients], formats: [...s.formats] }); }
  protected patch(p: Partial<ReportSchedule>): void { const f = this.form(); if (f) this.form.set({ ...f, ...p }); }
  protected setEvery(v: 'day' | 'week'): void { this.patch({ every: v, days: v === 'week' ? 7 : 1, weekdays: v === 'week' ? [1] : [1, 2, 3, 4, 5] }); }
  protected toggleDay(i: number): void { const f = this.form()!; this.patch({ weekdays: f.every === 'week' ? [i] : f.weekdays.includes(i) ? f.weekdays.filter((d) => d !== i) : [...f.weekdays, i].sort() }); }
  protected toggleFormat(k: string): void { const f = this.form()!; this.patch({ formats: f.formats.includes(k) ? f.formats.filter((x) => x !== k) : [...f.formats, k] }); }
  protected addRecipient(ev?: Event): void {
    ev?.preventDefault(); const f = this.form(); if (!f) return;
    const found = this.typing().split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (found.length) { this.patch({ recipients: [...new Set([...f.recipients, ...found])].slice(0, 25) }); this.typing.set(''); }
  }
  protected dropRecipient(e: string): void { this.patch({ recipients: this.form()!.recipients.filter((x) => x !== e) }); }
  protected val(ev: Event): string { return (ev.target as HTMLInputElement).value; }
  protected checked(ev: Event): boolean { return (ev.target as HTMLInputElement).checked; }

  protected async save(): Promise<void> {
    this.addRecipient(); const f = this.form()!;
    const err = !f.name.trim() ? 'Give the report a name' : !f.recipients.length ? 'Add at least one email address' : !f.formats.length ? 'Pick at least one format' : !f.weekdays.length ? 'Pick at least one day' : '';
    if (err) { this.error.set(err); return; }
    this.busy.set(true);
    try { await firstValueFrom(this.reports.saveSchedule(f)); this.form.set(null); await this.load(); } catch { this.error.set('Could not save. Try again.'); }
    this.busy.set(false);
  }
  protected async toggle(s: ReportSchedule): Promise<void> { await firstValueFrom(this.reports.saveSchedule({ id: s.id, on: !s.on })); await this.load(); }
  protected async sendNow(s: ReportSchedule): Promise<void> { await firstValueFrom(this.reports.sendNow(s.id!)); this.sent.set(s.id!); await this.load(); setTimeout(() => this.sent.set(''), 4000); }
  protected async remove(s: ReportSchedule): Promise<void> { await firstValueFrom(this.reports.deleteSchedule(s.id!)); this.removing.set(null); await this.load(); }

  protected when(s: ReportSchedule): string {
    const days = [...s.weekdays].sort();
    const which = s.every === 'week' ? `Every ${DAYS[days[0]] ?? 'Mon'}` : days.length === 7 ? 'Every day' : days.join() === '1,2,3,4,5' ? 'Weekdays' : days.map((d) => DAYS[d]).join(', ');
    return `${which} at ${s.time}`;
  }
  protected agentLabel(s: ReportSchedule): string { return s.agent ? this.agents().find((a) => a.key === s.agent)?.label ?? s.agent : 'All agents'; }
  protected setAgent(ev: Event): void { const k = this.val(ev); this.patch({ agent: k, ...(k && this.form()?.by === 'agent' ? { by: 'campaign' } : {}) }); }
  protected formatsLabel(s: ReportSchedule): string { return FORMATS.filter((f) => s.formats.includes(f.key)).map((f) => f.label.toLowerCase()).join(', '); }
  protected ago(iso: string): string { const m = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60000)); return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; }
}
