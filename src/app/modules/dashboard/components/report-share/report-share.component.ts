import { ChangeDetectionStrategy, Component, ElementRef, inject, input, signal } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { ReportService, ReportSummary } from '../../services/report.service';
import { ReportSchedulesComponent } from '../report-schedules/report-schedules.component';
import { downloadReportCard, saveBlob } from '../../utils/report-card';

/**
 * Share: the report on screen as a picture, a PDF or a spreadsheet, or by email on a schedule.
 * One button and a short menu, so the dashboard itself stays about the numbers.
 */
@Component({
  selector: 'app-report-share',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, ReportSchedulesComponent],
  templateUrl: './report-share.component.html',
  styleUrl: './report-share.component.scss',
  host: { '(document:click)': 'away($event)', '(document:keydown.escape)': 'open.set(false)' },
})
export class ReportShareComponent {
  private readonly reports = inject(ReportService);
  private readonly host = inject(ElementRef);
  readonly summary = input<ReportSummary | null>(null);
  readonly days = input(30);
  readonly by = input('agent');
  readonly byLabel = input('Agent');
  readonly period = input('');
  readonly agent = input('');
  readonly agents = input<{ key: string; label: string }[]>([]);

  protected readonly open = signal(false);
  protected readonly schedules = signal(false);
  protected readonly startNew = signal(false);
  private readonly today = () => new Date().toISOString().slice(0, 10);

  protected away(e: Event): void { if (this.open() && !this.host.nativeElement.contains(e.target)) this.open.set(false); }
  protected picture(): void {
    this.open.set(false); const s = this.summary(); if (!s) return;
    downloadReportCard({ title: 'Calling report', workspace: 'Clarix', period: this.period(), byLabel: this.byLabel(), summary: s }, `calling-report-${this.today()}.jpg`);
  }
  /** The browser's own print to PDF, on a layout made for paper (see .print-report in styles/reports.scss). */
  protected pdf(): void { this.open.set(false); setTimeout(() => window.print(), 50); }
  protected async sheet(): Promise<void> { this.open.set(false); saveBlob(await firstValueFrom(this.reports.spreadsheet(this.days(), this.by(), this.agent())), `calling-report-${this.today()}.xlsx`); }
  protected schedule(startNew: boolean): void { this.open.set(false); this.startNew.set(startNew); this.schedules.set(true); }
}
