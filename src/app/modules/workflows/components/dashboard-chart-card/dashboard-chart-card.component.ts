import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-dashboard-chart-card',
  imports: [CommonModule],
  templateUrl: './dashboard-chart-card.component.html',
  styleUrl: './dashboard-chart-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardChartCardComponent {
  readonly title = input.required<string>();
  readonly subtitle = input<string>('');
  readonly loading = input<boolean>(false);
  readonly empty = input<boolean>(false);
  readonly emptyMessage = input<string>('No data in selected range');
}
