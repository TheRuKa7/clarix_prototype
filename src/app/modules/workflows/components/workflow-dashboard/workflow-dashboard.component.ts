import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import {
  ApexAxisChartSeries,
  ApexChart,
  ApexDataLabels,
  ApexFill,
  ApexLegend,
  ApexNonAxisChartSeries,
  ApexPlotOptions,
  ApexStroke,
  ApexTheme,
  ApexTooltip,
  ApexXAxis,
  ApexYAxis,
  NgApexchartsModule,
} from 'ng-apexcharts';
import { Subject, timeout } from 'rxjs';
import { finalize, takeUntil } from 'rxjs/operators';
import { WorkflowDashboardData } from '../../models/workflow-dashboard.model';
import { WorkflowDashboardService } from '../../services/workflow-dashboard.service';
import { DashboardChartCardComponent } from '../dashboard-chart-card/dashboard-chart-card.component';
import { DashboardKpiCardComponent } from '../dashboard-kpi-card/dashboard-kpi-card.component';
import { DynamicFieldChartComponent } from '../dynamic-field-chart/dynamic-field-chart.component';

const STATUS_COLORS: Record<string, string> = {
  COMPLETED: '#16a34a',
  ACTIVE: '#6a5fc1',
  IN_PROGRESS: '#6a5fc1',
  WAITING: '#e28a0b',
  PAUSED: '#e28a0b',
  FAILED: '#dc2626',
  CANCELLED: '#a8a29e',
  DRAFT: '#a8a29e',
};

/** One hue for the duration histogram: the bins are ordered, so colour carries no information. */
const DURATION_COLOR = '#6a5fc1';

@Component({
  selector: 'app-workflow-dashboard',
  imports: [
    CommonModule,
    LucideAngularModule,
    NgApexchartsModule,
    DashboardKpiCardComponent,
    DashboardChartCardComponent,
    DynamicFieldChartComponent,
  ],
  templateUrl: './workflow-dashboard.component.html',
  styleUrl: './workflow-dashboard.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowDashboardComponent {
  private readonly service = inject(WorkflowDashboardService);
  private readonly destroy$ = new Subject<void>();

  readonly templateId = input.required<string>();
  /** ISO datetime strings; undefined = no range (entire history) */
  readonly from = input<string | undefined>(undefined);
  readonly to = input<string | undefined>(undefined);
  /** Narrows the aggregate to one bulk-trigger sheet, matching the executions list below it. */
  readonly batchId = input<string | undefined>(undefined);

  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly data = signal<WorkflowDashboardData | null>(null);

  protected readonly chartsExpanded = signal(false);
  private chartsHydrated = false;

  protected readonly kpis = computed(() => this.data()?.kpis ?? null);

  protected readonly avgDurationDisplay = computed(() => {
    const ms = this.kpis()?.avgDurationMs;
    if (ms == null) return '—';
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) {
      const m = Math.floor(ms / 60000);
      const s = Math.round((ms % 60000) / 1000);
      return `${m}m ${s}s`;
    }
    const h = Math.floor(ms / 3_600_000);
    const m = Math.round((ms % 3_600_000) / 60000);
    return `${h}h ${m}m`;
  });

  protected readonly completionPctDisplay = computed(() => {
    const r = this.kpis()?.completionRate ?? 0;
    return `${Math.round(r * 100)}%`;
  });

  protected readonly reachablePctDisplay = computed(() => {
    const r = this.kpis()?.reachableContactRate ?? 0;
    return `${Math.round(r * 100)}%`;
  });

  protected readonly statusChart = computed<{
    series: ApexNonAxisChartSeries;
    chart: ApexChart;
    labels: string[];
    colors: string[];
    legend: ApexLegend;
    dataLabels: ApexDataLabels;
    stroke: ApexStroke;
    tooltip: ApexTooltip;
    plotOptions: ApexPlotOptions;
    theme: ApexTheme;
  }>(() => {
    const breakdown = this.data()?.statusBreakdown ?? [];
    const series = breakdown.map((b) => b.count);
    const labels = breakdown.map((b) => b.key ?? '—');
    const colors = labels.map((l) => STATUS_COLORS[l] ?? '#a8a29e');
    return {
      series,
      labels,
      colors,
      chart: { type: 'donut', height: 260, fontFamily: 'inherit' },
      legend: { position: 'bottom', fontSize: '12px' },
      dataLabels: { enabled: true, formatter: (v: string | number | number[]) => `${Math.round(Number(v))}%` },
      stroke: { width: 2, colors: ['transparent'] },
      tooltip: { y: { formatter: (v: number) => `${v}` } },
      plotOptions: {
        pie: {
          donut: {
            size: '64%',
            labels: {
              show: true,
              total: {
                show: true,
                label: 'Total',
                formatter: () => `${series.reduce((a, b) => a + b, 0)}`,
              },
            },
          },
        },
      },
      theme: { mode: 'light' },
    };
  });

  /**
   * Call-length histogram. The bins are ordered and the bar length already encodes the count, so
   * colour would encode nothing: one hue, no per-bar colours, and no legend for a single series.
   */
  protected readonly durationChart = computed<{
    series: ApexAxisChartSeries;
    chart: ApexChart;
    xaxis: ApexXAxis;
    yaxis: ApexYAxis;
    colors: string[];
    dataLabels: ApexDataLabels;
    plotOptions: ApexPlotOptions;
    legend: ApexLegend;
    tooltip: ApexTooltip;
    fill: ApexFill;
    theme: ApexTheme;
  }>(() => {
    const buckets = this.data()?.durationBuckets ?? [];
    const categories = buckets.map((b) => b.key ?? '—');
    const counts = buckets.map((b) => b.count);
    const total = counts.reduce((a, b) => a + b, 0);
    return {
      series: [{ name: 'Calls', data: counts }],
      chart: { type: 'bar', height: 260, toolbar: { show: false }, fontFamily: 'inherit' },
      xaxis: { categories, labels: { style: { fontSize: '11px' } } },
      yaxis: { labels: { style: { fontSize: '11px' } }, forceNiceScale: true },
      colors: [DURATION_COLOR],
      plotOptions: { bar: { borderRadius: 4, columnWidth: '55%' } },
      dataLabels: { enabled: false },
      legend: { show: false },
      tooltip: {
        y: {
          formatter: (v: number) => {
            const share = total > 0 ? Math.round((v / total) * 100) : 0;
            return `${v} call${v === 1 ? '' : 's'} · ${share}%`;
          },
        },
      },
      fill: { opacity: 0.95 },
      theme: { mode: 'light' },
    };
  });

  protected readonly timeSeriesChart = computed<{
    series: ApexAxisChartSeries;
    chart: ApexChart;
    xaxis: ApexXAxis;
    yaxis: ApexYAxis;
    colors: string[];
    dataLabels: ApexDataLabels;
    legend: ApexLegend;
    stroke: ApexStroke;
    tooltip: ApexTooltip;
    fill: ApexFill;
    theme: ApexTheme;
  }>(() => {
    const ts = this.data()?.timeSeries;
    const buckets = ts?.buckets ?? [];
    const categories = buckets.map((b) => b.date);
    return {
      series: [
        { name: 'Created', data: buckets.map((b) => b.created) },
        { name: 'Completed', data: buckets.map((b) => b.completed) },
        { name: 'Failed', data: buckets.map((b) => b.failed) },
      ],
      chart: { type: 'area', height: 260, toolbar: { show: false }, fontFamily: 'inherit' },
      xaxis: { categories, labels: { style: { fontSize: '11px' }, rotate: -35, hideOverlappingLabels: true } },
      yaxis: { labels: { style: { fontSize: '11px' } } },
      colors: ['#6a5fc1', '#16a34a', '#dc2626'],
      stroke: { curve: 'smooth', width: 2 },
      dataLabels: { enabled: false },
      legend: { position: 'top', fontSize: '12px' },
      tooltip: { x: { show: true } },
      fill: { type: 'gradient', gradient: { shadeIntensity: 0.5, opacityFrom: 0.3, opacityTo: 0.05 } },
      theme: { mode: 'light' },
    };
  });

  protected readonly hasStatusData = computed(() => (this.data()?.statusBreakdown ?? []).length > 0);
  /** All-zero bins are "no calls yet", not a histogram worth drawing. */
  protected readonly hasDurationData = computed(() =>
    (this.data()?.durationBuckets ?? []).some((b) => b.count > 0)
  );
  protected readonly hasTimeSeriesData = computed(() => {
    const buckets = this.data()?.timeSeries?.buckets ?? [];
    return buckets.some((b) => b.created > 0 || b.completed > 0 || b.failed > 0);
  });

  protected readonly fieldBreakdowns = computed(() => this.data()?.fieldBreakdowns ?? []);

  protected readonly granularityLabel = computed(() => {
    const g = this.data()?.timeSeries?.granularity;
    if (g === 'WEEK') return 'Weekly';
    if (g === 'MONTH') return 'Monthly';
    return 'Daily';
  });

  constructor() {
    effect(() => {
      const id = this.templateId();
      if (!id) return;
      if (!this.chartsHydrated) {
        this.chartsHydrated = true;
        try {
          const stored = localStorage.getItem(this.chartsKey());
          if (stored === '1') this.chartsExpanded.set(true);
        } catch {
          // localStorage may be unavailable
        }
      }
      this.fetch(id, this.from(), this.to(), this.batchId());
    });
  }

  protected toggleCharts(): void {
    const next = !this.chartsExpanded();
    this.chartsExpanded.set(next);
    try {
      localStorage.setItem(this.chartsKey(), next ? '1' : '0');
    } catch {
      // localStorage may be unavailable
    }
  }

  refresh(): void {
    this.fetch(this.templateId(), this.from(), this.to(), this.batchId());
  }

  private fetch(templateId: string, from?: string, to?: string, batchId?: string): void {
    this.loading.set(true);
    this.error.set(null);
    this.service
      .getDashboard(templateId, { from, to, batchId })
      .pipe(
        takeUntil(this.destroy$),
        timeout(60000),
        finalize(() => this.loading.set(false))
      )
      .subscribe({
        next: (d) => this.data.set(d),
        error: (err) => {
          console.error('Dashboard fetch failed', err);
          this.error.set(typeof err === 'string' ? err : 'Failed to load dashboard');
          this.data.set(null);
        },
      });
  }

  private chartsKey(): string {
    return `workflow-dashboard:chartsExpanded:${this.templateId()}`;
  }

}
