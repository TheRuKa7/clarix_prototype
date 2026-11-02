import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';

@Component({
  selector: 'app-dashboard-kpi-card',
  imports: [CommonModule, LucideAngularModule],
  templateUrl: './dashboard-kpi-card.component.html',
  styleUrl: './dashboard-kpi-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardKpiCardComponent {
  readonly label = input.required<string>();
  readonly value = input.required<string | number>();
  readonly hint = input<string>('');
  readonly icon = input<string>('');
  readonly tone = input<'default' | 'positive' | 'negative' | 'warning' | 'info'>('default');
}
