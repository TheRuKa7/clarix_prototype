import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
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
import { DashboardFieldBreakdown } from '../../models/workflow-dashboard.model';

interface PieChartOptions {
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
}

interface BarChartOptions {
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
}

const PALETTE = {
  positive: '#16a34a',
  negative: '#dc2626',
  neutral:  '#a8a29e',
  blue:     '#6a5fc1',
  primary:  '#6a5fc1',
  warning:  '#e28a0b',
};

@Component({
  selector: 'app-dynamic-field-chart',
  imports: [CommonModule, NgApexchartsModule],
  templateUrl: './dynamic-field-chart.component.html',
  styleUrl: './dynamic-field-chart.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DynamicFieldChartComponent {
  readonly breakdown = input.required<DashboardFieldBreakdown>();

  protected readonly chartType = computed<'donut' | 'bar' | 'line'>(() => {
    const t = this.breakdown().dataType;
    if (t === 'BOOLEAN') return 'donut';
    return 'bar';
  });

  protected readonly hasData = computed(() => {
    const b = this.breakdown();
    return b.totalAnswered + b.totalUnanswered > 0;
  });

  protected readonly donutOptions = computed<PieChartOptions>(() => {
    const b = this.breakdown();
    const dist = b.distribution ?? [];

    const labels: string[] = [];
    const values: number[] = [];
    const colors: string[] = [];

    for (const d of dist) {
      const key = d.key ?? '—';
      labels.push(this.prettyBoolean(key));
      values.push(d.count);
      colors.push(this.colorForKey(key));
    }
    if (b.totalUnanswered > 0) {
      labels.push('Unanswered');
      values.push(b.totalUnanswered);
      colors.push(PALETTE.neutral);
    }

    return {
      series: values,
      labels,
      colors,
      chart: { type: 'donut', height: 240, fontFamily: 'inherit' },
      legend: { position: 'bottom', fontSize: '12px' },
      dataLabels: { enabled: true, formatter: (v: string | number | number[]) => `${Math.round(Number(v))}%` },
      stroke: { width: 2, colors: ['transparent'] },
      tooltip: { y: { formatter: (v: number) => `${v}` } },
      plotOptions: {
        pie: {
          donut: {
            size: '62%',
            labels: {
              show: true,
              total: { show: true, label: 'Total', formatter: () => `${values.reduce((a, b) => a + b, 0)}` },
            },
          },
        },
      },
      theme: { mode: 'light' },
    };
  });

  protected readonly barOptions = computed<BarChartOptions>(() => {
    const b = this.breakdown();
    const dist = b.distribution ?? [];

    const categories = dist.map((d) => d.key ?? '—');
    const counts = dist.map((d) => d.count);
    if (b.totalUnanswered > 0) {
      categories.push('Unanswered');
      counts.push(b.totalUnanswered);
    }

    return {
      series: [{ name: b.fieldLabel, data: counts }],
      chart: { type: 'bar', height: 240, toolbar: { show: false }, fontFamily: 'inherit' },
      xaxis: {
        categories,
        labels: { style: { fontSize: '11px' }, rotate: -35, hideOverlappingLabels: true },
      },
      yaxis: { labels: { style: { fontSize: '11px' } } },
      colors: [PALETTE.primary],
      plotOptions: { bar: { borderRadius: 4, horizontal: false, columnWidth: '55%' } },
      dataLabels: { enabled: false },
      legend: { show: false },
      tooltip: { y: { formatter: (v: number) => `${v}` } },
      fill: { opacity: 0.9 },
      theme: { mode: 'light' },
    };
  });

  protected readonly lineOptions = computed<BarChartOptions>(() => {
    const b = this.breakdown();
    const dist = b.distribution ?? [];
    return {
      series: [{ name: b.fieldLabel, data: dist.map((d) => d.count) }],
      chart: { type: 'area', height: 240, toolbar: { show: false }, fontFamily: 'inherit', sparkline: { enabled: false } },
      xaxis: { categories: dist.map((d) => d.key ?? '—'), labels: { style: { fontSize: '11px' } } },
      yaxis: { labels: { style: { fontSize: '11px' } } },
      colors: [PALETTE.blue],
      plotOptions: {},
      dataLabels: { enabled: false },
      legend: { show: false },
      tooltip: { y: { formatter: (v: number) => `${v}` } },
      fill: { type: 'gradient', gradient: { shadeIntensity: 0.5, opacityFrom: 0.5, opacityTo: 0.05 } },
      theme: { mode: 'light' },
    };
  });

  private prettyBoolean(key: string): string {
    if (key === 'true') return 'Yes';
    if (key === 'false') return 'No';
    return key;
  }

  private colorForKey(key: string): string {
    if (key === 'true') return PALETTE.positive;
    if (key === 'false') return PALETTE.negative;
    return PALETTE.primary;
  }
}
