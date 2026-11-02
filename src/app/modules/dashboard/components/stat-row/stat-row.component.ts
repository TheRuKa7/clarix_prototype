import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { LucideAngularModule } from 'lucide-angular';
import { ReportResult, ReportService, ReportStats, StatRowItem } from '../../services/report.service';

interface Open { key: string; label: string; help: string; total?: number; rows?: StatRowItem[] }

/**
 * What is done and what waits on a person, from Echo's numbers: one result per row and five stats.
 * Every number opens the rows behind it. The same row sits on the Dashboard and on each campaign page.
 */
@Component({
  selector: 'app-stat-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, RouterLink],
  templateUrl: './stat-row.component.html',
})
export class StatRowComponent {
  private readonly reports = inject(ReportService);
  readonly stats = input<ReportStats | null | undefined>(null);
  readonly result = input<ReportResult | null | undefined>(null);
  /** Query that scopes the rows: days, agent, batchId. */
  readonly scope = input<Record<string, string | number>>({});
  protected readonly list = signal<Open | null>(null);

  protected readonly total = computed(() => { const r = this.result(); return r ? r.successful + r.needs_action + r.in_progress + r.closed : 0; });
  protected readonly segments = computed(() => {
    const r = this.result();
    return [
      { key: 'successful', label: 'Successful', count: r?.successful ?? 0, help: 'The call completed and its answers were saved.' },
      { key: 'needs_action', label: 'Needs action', count: r?.needs_action ?? 0, help: 'A person has to do something: correct a number, call by hand, fill in missing answers or fix a rejected row.' },
      { key: 'in_progress', label: 'In progress', count: r?.in_progress ?? 0, help: 'Waiting, calling, a retry is booked, or the contact asked to be called later.' },
      { key: 'closed', label: 'Closed', count: r?.closed ?? 0, help: 'Nothing more will happen and nothing is left to do.' },
    ];
  });
  protected readonly tiles = computed(() => {
    const s = this.stats();
    const why = (s?.not_dialled_why ?? []).map((w) => `${w.label} ${w.count}`).join(' · ');
    return [
      { key: 'follow_up', label: 'Needs follow up', count: s?.follow_up ?? 0, sub: 'waiting on a person', help: 'Rows that calling alone cannot settle: blocked, wrong number, rejected, every try used, or answers missing. Each one gets an owner in Follow ups.' },
      { key: 'callbacks_due', label: 'Call backs due', count: s?.callbacks_due ?? 0, sub: 'asked to be called later', help: 'Contacts who asked to be called later. Echo calls back at the time given; until then they count as in progress.' },
      { key: 'answers_missing', label: 'Answers missing', count: s?.answers_missing ?? 0, sub: 'spoke, nothing saved', help: 'The contact spoke but no answers were saved, even after Echo read the transcript. A call like this is never shown as Completed.' },
      { key: 'tech_failures', label: 'No audio', count: s?.tech_failures ?? 0, sub: 'picked up, no sound', help: 'Calls that were picked up and had no audio either way.' },
      { key: 'not_dialled', label: 'Not dialled', count: s?.not_dialled ?? 0, sub: why || 'every row was dialled', help: 'Rows that were never dialled, with the reason Echo gave.' },
    ];
  });

  protected async open(key: string, label: string, help: string): Promise<void> {
    this.list.set({ key, label, help });
    try {
      const r = await firstValueFrom(this.reports.rows(this.scope(), key));
      if (this.list()?.key === key) this.list.set({ key, label, help, total: r.total, rows: r.rows });
    } catch { if (this.list()?.key === key) this.list.set({ key, label, help, total: 0, rows: [] }); }
  }
  protected close(): void { this.list.set(null); }
}
