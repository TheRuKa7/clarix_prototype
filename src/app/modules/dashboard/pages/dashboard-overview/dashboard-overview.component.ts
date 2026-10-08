import { ChangeDetectionStrategy, Component, computed, inject, resource, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { ReportLine, ReportRow, ReportService } from '../../services/report.service';
import { ReportShareComponent } from '../../components/report-share/report-share.component';
import { GROUPS } from '../../utils/report-card';

const ALL_BYS = [{ key: 'agent', label: 'Agent' }, { key: 'campaign', label: 'Campaign' }, { key: 'day', label: 'Day' }];
const EMPTY: ReportLine = { contacts: 0, dialled: 0, reached: 0, completed: 0, not_reached: 0, failed: 0, in_progress: 0, not_dialled: 0, follow_up: 0, talk_seconds: 0 };

/**
 * The dashboard: how calling is going, in Echo's own call statuses. One funnel (dialled, reached,
 * completed), what needs a person, one bar of what happened, the same numbers compared by agent,
 * campaign, day or any column of the uploaded files, and day by day. Share sends exactly this.
 */
@Component({
  selector: 'app-dashboard-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, RouterLink, ReportShareComponent],
  templateUrl: './dashboard-overview.component.html',
  styleUrl: './dashboard-overview.component.scss',
})
export class DashboardOverviewComponent {
  private readonly reports = inject(ReportService);
  protected readonly WINDOWS = [{ days: 1, label: 'Today' }, { days: 7, label: '7 days' }, { days: 30, label: '30 days' }];
  protected readonly GROUPS = GROUPS;
  protected readonly days = signal(30);
  protected readonly by = signal('agent');
  /** One agent, or all. Nothing about the agent is assumed: its answers and file columns come from its own setup. */
  protected readonly agent = signal('');
  protected readonly showAll = signal(false);

  protected readonly report = resource({
    params: () => ({ days: this.days(), by: this.by(), agent: this.agent() }),
    loader: ({ params }) => firstValueFrom(this.reports.summary(params.days, params.by, params.agent)),
  });
  /** The last loaded report stays on screen while the next one loads, so nothing jumps. */
  private last: import('../../services/report.service').ReportSummary | null = null;
  protected readonly data = computed(() => { const v = this.report.hasValue() ? this.report.value() : undefined; if (v) this.last = v; return v ?? this.last; });
  protected readonly BYS = computed(() => ALL_BYS.filter((b) => !(this.agent() && b.key === 'agent')));
  protected readonly agents = computed(() => this.data()?.agents ?? []);
  protected readonly agentName = computed(() => this.agents().find((a) => a.key === this.agent())?.label ?? this.agent());
  protected readonly answers = computed(() => this.data()?.answers ?? []);
  protected readonly input = computed(() => (this.data()?.input?.rows ? this.data()!.input : null));
  protected readonly why = computed(() => this.data()?.why ?? null);
  protected readonly rowsLine = computed(() => this.data()?.rows_line ?? null);
  protected readonly total = computed(() => this.data()?.total ?? EMPTY);
  protected readonly columns = computed(() => this.data()?.columns ?? []);
  protected readonly isColumn = computed(() => !ALL_BYS.some((b) => b.key === this.by()));
  protected readonly byLabel = computed(() => ALL_BYS.find((b) => b.key === this.by())?.label ?? this.cap(this.columns().find((c) => c.key === this.by())?.label ?? this.by()));
  protected readonly rows = computed(() => { const r = this.data()?.rows ?? []; return this.showAll() ? r : r.slice(0, 6); });
  protected readonly period = computed(() => (this.days() === 1 ? 'Today' : `Last ${this.days()} days`) + (this.agent() ? ` · ${this.agentName()}` : ''));
  protected readonly groups = computed(() => GROUPS.map((g) => ({ ...g, count: this.total()[g.key] })).filter((g) => g.count));
  protected readonly groupTotal = computed(() => this.groups().reduce((n, g) => n + g.count, 0) || 1);
  protected readonly trend = computed(() => (this.data()?.trend ?? []).slice(-14));
  protected readonly trendMax = computed(() => Math.max(1, ...this.trend().map((d) => d.dialled)));
  protected readonly madeAt = computed(() => new Date(this.data()?.generated_at ?? Date.now()).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }));

  private cap(s: string): string { return s ? s[0].toUpperCase() + s.slice(1) : s; }
  protected pc(a: number, b: number): number { return b ? Math.round((a / b) * 100) : 0; }
  protected setBy(k: string): void { this.by.set(k || (this.agent() ? 'campaign' : 'agent')); this.showAll.set(false); }
  protected setAgent(k: string): void { this.agent.set(k); if (k ? this.by() === 'agent' : this.isColumn()) this.by.set(k ? 'campaign' : 'agent'); this.showAll.set(false); }
  protected pickAgent(ev: Event): void { this.setAgent((ev.target as HTMLSelectElement).value); }
  protected pickRow(r: ReportRow): void { if (this.by() === 'agent') this.setAgent(r.key); }
  /** CODE_WORDS and snake_case answers read as plain words; anything already written for people is left alone. */
  protected pretty(v: string): string { const s = String(v); if (!/^[A-Za-z0-9]+(_[A-Za-z0-9]+)+$/.test(s) && s !== s.toUpperCase()) return s; const t = s.replace(/_/g, ' ').toLowerCase(); return t[0].toUpperCase() + t.slice(1); }
  protected pickColumn(ev: Event): void { this.setBy((ev.target as HTMLSelectElement).value); }
  protected rowLabel(r: ReportRow): string { return this.by() === 'day' ? this.dayLabel(r.label) : r.label; }
  protected dayLabel(d: string, short = false): string { return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', short ? { day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric', month: 'short' }); }
  protected talk(seconds: number): string { const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min`; }
  protected refresh(): void { this.report.reload(); }
}
