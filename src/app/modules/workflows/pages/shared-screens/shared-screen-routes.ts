import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ReportService } from '../../../dashboard/services/report.service';
import { CallingReportComponent, CallingReportSource } from '../../../dashboard/components/calling-report/calling-report.component';
import { CampaignPageComponent, CampaignsListComponent, CampaignsSource, FollowUpsListComponent, FollowUpsSource, NewCampaignComponent, NewCampaignSource } from '../../../dashboard/components/shared-screens/shared-screens';

/** Clarix's wiring for the screens it shares with Echo (same components, Clarix API). */
function reportSource(r: ReportService, router: Router): CallingReportSource {
  return {
    report: (sc) => firstValueFrom(r.callingReport(sc)),
    calls: (sc, box, skip, limit, f) => firstValueFrom(r.callingReportCalls(sc, box, skip, limit, f)),
    exportXlsx: (sc, box, f) => firstValueFrom(r.callingReportExport(sc, box, f)),
    openCall: (row) => router.navigate(['/workflows/calls', row.id]),
  };
}
const ALL = () => ({ period: 'all' as const, from: new Date(0).toISOString(), to: new Date().toISOString(), days: 0, agents: [], includeTests: false });
function campaignsSource(r: ReportService, router: Router): CampaignsSource {
  return {
    list: (p) => firstValueFrom(r.reportCampaigns(p)), get: (id) => firstValueFrom(r.reportCampaign(id)), stop: (id) => firstValueFrom(r.stopReportCampaign(id)),
    results: (id) => firstValueFrom(r.callingReportExport({ ...ALL(), campaign: id } as any, 'uploaded')),
    open: (c) => router.navigate(['/workflows/campaigns', c.campaign_id]), newCampaign: () => router.navigate(['/workflows/campaigns/new']),
    report: reportSource(r, router), listPath: '/workflows/campaigns',
  };
}

@Component({ selector: 'app-clarix-call-logs', standalone: true, imports: [CallingReportComponent],
  template: `<div class="rx-page"><div class="rx-head"><h1 class="rx-title">Call logs</h1></div><app-calling-report mode="log" [source]="source"></app-calling-report></div>` })
export class ClarixCallLogsPage { readonly source = reportSource(inject(ReportService), inject(Router)); }

@Component({ selector: 'app-clarix-campaigns', standalone: true, imports: [CampaignsListComponent], template: `<div class="rx-page"><app-campaigns-list [source]="source"></app-campaigns-list></div>` })
export class ClarixCampaignsPage { readonly source = campaignsSource(inject(ReportService), inject(Router)); }

@Component({ selector: 'app-clarix-campaign', standalone: true, imports: [CampaignPageComponent], template: `<div class="rx-page"><app-campaign-page [source]="source"></app-campaign-page></div>` })
export class ClarixCampaignPage { readonly source = campaignsSource(inject(ReportService), inject(Router)); }

@Component({ selector: 'app-clarix-new-campaign', standalone: true, imports: [NewCampaignComponent], template: `<div class="rx-page"><app-new-campaign [source]="source"></app-new-campaign></div>` })
export class ClarixNewCampaignPage {
  private r = inject(ReportService); private router = inject(Router);
  readonly source: NewCampaignSource = {
    agents: () => firstValueFrom(this.r.newCampaignAgents()), template: (a) => firstValueFrom(this.r.newCampaignTemplate(a)),
    check: (a, f) => firstValueFrom(this.r.newCampaignPost('check', a, f)), start: (a, f) => firstValueFrom(this.r.newCampaignPost('start', a, f)),
    opened: (id) => this.router.navigate(['/workflows/campaigns', id]), cancel: () => this.router.navigate(['/workflows/campaigns']),
  };
}

@Component({ selector: 'app-clarix-follow-ups', standalone: true, imports: [FollowUpsListComponent], template: `<div class="rx-page"><app-follow-ups-list [source]="source"></app-follow-ups-list></div>` })
export class ClarixFollowUpsPage {
  private r = inject(ReportService); private router = inject(Router);
  readonly source: FollowUpsSource = {
    list: (tab, show) => firstValueFrom(this.r.reportFollowUps(tab, show)), act: (id, a) => firstValueFrom(this.r.reportFollowUpAct(id, a)),
    openCall: (row) => this.router.navigate(['/workflows/calls', row.id]),
  };
}
