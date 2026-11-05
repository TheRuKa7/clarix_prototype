import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ReportService } from '../../../dashboard/services/report.service';
import { CallingReportComponent, CallingReportSource } from '../../../dashboard/components/calling-report/calling-report.component';
import { AlertsComponent, AlertsSource, TelephonyHubComponent, TelephonySource, SupplierPageComponent, SupplierSource, SecurityCenterComponent, SecuritySource, AuditLogComponent, AuditSource, AccessComponent, AccessSource, CallingRulesComponent, CallingRulesSource, DncListComponent, DncSource, CampaignPageComponent, CampaignsListComponent, CampaignsSource, FollowUpsListComponent, FollowUpsSource, NewCampaignComponent, NewCampaignSource } from '../../../dashboard/components/shared-screens/shared-screens';

/** Clarix's wiring for the screens it shares with Echo (same components, Clarix API). */
function reportSource(r: ReportService, router: Router): CallingReportSource {
  return {
    report: (sc, f) => firstValueFrom(r.callingReport(sc, f)),
    calls: (sc, box, skip, limit, f) => firstValueFrom(r.callingReportCalls(sc, box, skip, limit, f)),
    exportXlsx: (sc, box, f) => firstValueFrom(r.callingReportExport(sc, box, f)),
    rerun: (sc, box, f) => firstValueFrom(r.rerunCalls(sc, box, f)),
    ask: (sc, box, f, q) => firstValueFrom(r.askCalls(sc, box, f, q)),
    values: (sc, box, f, col, q) => firstValueFrom(r.reportColumnValues(sc, box, f, col, q)),
    openCall: (row) => router.navigate(['/workflows/calls', row.id]),
  };
}
const ALL = () => ({ period: 'all' as const, from: new Date(0).toISOString(), to: new Date().toISOString(), days: 0, agents: [], includeTests: false });
function campaignsSource(r: ReportService, router: Router): CampaignsSource {
  return {
    list: (p) => firstValueFrom(r.reportCampaigns(p)), get: (id) => firstValueFrom(r.reportCampaign(id)), stop: (id) => firstValueFrom(r.stopReportCampaign(id)), resume: (id) => firstValueFrom(r.resumeReportCampaign(id)),
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
    dataSource: (a) => firstValueFrom(this.r.dsLoad(a)), previewSource: (a, s) => firstValueFrom(this.r.dsPreview(a, s)), runSource: (a) => firstValueFrom(this.r.dsRun(a)),
    editSource: (a) => this.router.navigate(['/workflows/build/agents'], { queryParams: { templateId: a } }),
    tips: (a) => firstValueFrom(this.r.newCampaignTips(a)), retryRules: () => firstValueFrom(this.r.retryRules()), saveRetryRule: (a, r) => firstValueFrom(this.r.saveRetryRule(a, r)), retryPreview: (r, c) => firstValueFrom(this.r.retryPreview(r, c)),
    recheck: (a, rows) => firstValueFrom(this.r.newCampaignRecheck(a, rows)),
    opened: (id) => this.router.navigate(['/workflows/campaigns', id]), cancel: () => this.router.navigate(['/workflows/campaigns']),
  };
}

@Component({ selector: 'app-clarix-follow-ups', standalone: true, imports: [FollowUpsListComponent], template: `<div class="rx-page"><app-follow-ups-list [source]="source"></app-follow-ups-list></div>` })
export class ClarixFollowUpsPage {
  private r = inject(ReportService); private router = inject(Router);
  readonly source: FollowUpsSource = {
    list: (p) => firstValueFrom(this.r.actionNeeded(p)), act: (id, a) => firstValueFrom(this.r.actionAct(id, a)), exportXlsx: (p) => firstValueFrom(this.r.actionExport(p)),
    bulk: (ids, a) => firstValueFrom(this.r.actionBulk(ids, a)), openSupplier: (phone) => this.router.navigate(['/workflows/suppliers', phone]),
    openCall: (row) => this.router.navigate(['/workflows/calls', row.id]),
  };
}

@Component({ selector: 'app-clarix-calling-rules', standalone: true, imports: [CallingRulesComponent], template: `<div class="rx-page"><app-calling-rules [source]="source" [page]="true"></app-calling-rules></div>` })
export class ClarixCallingRulesPage {
  private r = inject(ReportService);
  /** Calling rules per country: hours, rest days, holidays, do-not-call registers. */
  readonly source: CallingRulesSource = {
    list: () => firstValueFrom(this.r.callingRules()), save: (c, x) => firstValueFrom(this.r.saveCallingRule(c, x)), reset: (c) => firstValueFrom(this.r.resetCallingRule(c)),
    preview: (x, c, h) => firstValueFrom(this.r.retryPreview(x, c, h)),
  };
}

@Component({ selector: 'app-clarix-dnc', standalone: true, imports: [DncListComponent], template: `<div class="rx-page"><app-dnc-list [source]="source" [page]="true"></app-dnc-list></div>` })
export class ClarixDncPage {
  private r = inject(ReportService); private router = inject(Router);
  /** The workspace do-not-call list. */
  readonly source: DncSource = {
    load: (q) => firstValueFrom(this.r.dncLoad(q)), add: (e) => firstValueFrom(this.r.dncAdd(e)), remove: (p, why) => firstValueFrom(this.r.dncRemove(p, why)),
    setAuto: (on) => firstValueFrom(this.r.dncAuto(on)), openCall: (id) => this.router.navigate(['/workflows/calls', id]),
  };
}

@Component({ selector: 'app-clarix-alerts', standalone: true, imports: [AlertsComponent], template: `<div class="rx-page"><app-alerts [source]="source" [page]="true"></app-alerts></div>` })
export class ClarixAlertsPage {
  private r = inject(ReportService); private router = inject(Router);
  /** Alerts that tell the owner and pause a campaign that is going wrong. */
  readonly source: AlertsSource = {
    load: () => firstValueFrom(this.r.alerts()), save: (x) => firstValueFrom(this.r.saveAlerts(x)), resume: (id) => firstValueFrom(this.r.resumeReportCampaign(id)),
    openCampaign: (id) => this.router.navigate(['/workflows/campaigns', id]),
  };
}

@Component({ selector: 'app-clarix-telephony', standalone: true, imports: [TelephonyHubComponent], template: `<div class="rx-page"><app-telephony-hub [source]="source" [page]="true"></app-telephony-hub></div>` })
export class ClarixTelephonyPage {
  private r = inject(ReportService);
  /** Carriers, caller IDs and concurrency slots. */
  readonly source: TelephonySource = {
    load: () => firstValueFrom(this.r.telephony()), test: (b) => firstValueFrom(this.r.telTest(b)), connect: (b) => firstValueFrom(this.r.telConnect(b)),
    disconnect: (k) => firstValueFrom(this.r.telDisconnect(k)), saveSlots: (b) => firstValueFrom(this.r.telSlots(b)),
  };
}

@Component({ selector: 'app-clarix-supplier', standalone: true, imports: [SupplierPageComponent], template: `<div class="rx-page"><app-supplier-page [source]="source"></app-supplier-page></div>` })
export class ClarixSupplierPage {
  private r = inject(ReportService); private router = inject(Router);
  /** Supplier 360: every call, PO, promise and open action for one number. */
  readonly source: SupplierSource = { load: (p) => firstValueFrom(this.r.supplier(p)), openCall: (id) => this.router.navigate(['/workflows/calls', id]), openActions: () => this.router.navigate(['/workflows/follow-ups']), back: () => history.back() };
}

@Component({ selector: 'app-clarix-security', standalone: true, imports: [SecurityCenterComponent], template: `<div class="rx-page"><app-security-center [source]="source" [page]="true"></app-security-center></div>` })
export class ClarixSecurityPage {
  private r = inject(ReportService);
  /** Sign-in, provisioning, data protection and deletion. */
  readonly source: SecuritySource = {
    load: () => firstValueFrom(this.r.security()), save: (x) => firstValueFrom(this.r.saveSecurity(x)), testSso: (x) => firstValueFrom(this.r.testSso(x)),
    scimToken: () => firstValueFrom(this.r.scimToken()), deleteContact: (b) => firstValueFrom(this.r.deleteContact(b)),
  };
}

@Component({ selector: 'app-clarix-audit', standalone: true, imports: [AuditLogComponent], template: `<div class="rx-page"><app-audit-log [source]="source" [page]="true"></app-audit-log></div>` })
export class ClarixAuditPage {
  private r = inject(ReportService);
  /** Every change and export, with who did it. */
  readonly source: AuditSource = { load: (p) => firstValueFrom(this.r.auditLog(p)), exportXlsx: (p) => firstValueFrom(this.r.auditExport(p)) };
}

@Component({ selector: 'app-clarix-access', standalone: true, imports: [AccessComponent], template: `<div class="rx-page"><app-access [source]="source" [page]="true"></app-access></div>` })
export class ClarixAccessPage {
  private r = inject(ReportService);
  /** Org, sub-orgs, teams, people, roles and user types. */
  readonly source: AccessSource = {
    load: (as) => firstValueFrom(this.r.access(as)), create: (k, b, as) => firstValueFrom(this.r.accessSend('POST', k, b, as)),
    update: (k, id, b, as) => firstValueFrom(this.r.accessSend('PUT', `${k}/${encodeURIComponent(id)}`, b, as)), remove: (k, id, as) => firstValueFrom(this.r.accessSend('DELETE', `${k}/${encodeURIComponent(id)}`, {}, as)),
  };
}
