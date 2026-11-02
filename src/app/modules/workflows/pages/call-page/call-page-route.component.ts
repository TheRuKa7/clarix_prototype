import { Component, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CallPageComponent, CallPageSource } from '../../../dashboard/components/call-page/call-page.component';
import { ReportService } from '../../../dashboard/services/report.service';

/** /workflows/calls/:id — the one call page (same component as Echo). Old execution links land on it too. */
@Component({
  selector: 'app-call-page-route',
  standalone: true,
  imports: [CallPageComponent],
  template: `<div class="rx-page"><app-call-page [source]="source"></app-call-page></div>`,
})
export class CallPageRouteComponent {
  private reports = inject(ReportService);
  readonly source: CallPageSource = {
    detail: (id) => firstValueFrom(this.reports.callDetail(id)),
    steps: (id) => firstValueFrom(this.reports.callSteps(id)),
    sendMessage: (id, m) => firstValueFrom(this.reports.sendCallMessage(id, m)),
    audio: (path) => firstValueFrom(this.reports.blobAt(path)),
    changeOutcome: (id, reason, note) => firstValueFrom(this.reports.changeCallOutcome(id, reason, note)),
    home: '/dashboard/overview',
    base: '/workflows/calls',
  };
}
