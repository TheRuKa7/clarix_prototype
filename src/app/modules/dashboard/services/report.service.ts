import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ENDPOINTS } from '../../../enpoints.service';

export interface ReportLine { contacts: number; dialled: number; reached: number; completed: number; not_reached: number; failed: number; in_progress: number; not_dialled: number; follow_up: number; talk_seconds: number }
export interface ReportRow extends ReportLine { key: string; label: string }
export interface ReportDay extends ReportLine { day: string }
export interface ReportColumn { key: string; label: string; values: string[] }
/** One answer field of an agent, summarised: counts per value for choices, total and average for numbers. */
export interface ReportAnswer { key: string; label: string; type: 'choice' | 'number'; unit: string; answered: number; values?: { value: string; count: number }[]; sum?: number; avg?: number }
/** The Input layer: uploaded rows checked against the agent's own field types. */
export interface ReportInput { rows: number; rejected: number; warned: number; clean: number; problems: { label: string; field: string; kind: 'reject' | 'warn'; rows: number }[] }
/** Stats every agent has. Each one opens the rows behind it. */
export interface ReportStats { not_dialled: number; callbacks_due: number; answers_missing: number; tech_failures: number; follow_up: number; not_dialled_why: { label: string; count: number }[] }
/** One result per row, by the default goal: call completed with answers saved. */
export interface ReportResult { successful: number; needs_action: number; in_progress: number; closed: number }
export interface StatRowItem { id: string; templateId: string; batchId: string; campaign_name: string; name: string; phone: string; status: string; why: string; call_back: string }
export interface ReportSummary {
  stats?: ReportStats; result?: ReportResult;
  by: string; days: number; generated_at: string; total: ReportLine; rows: ReportRow[]; trend: ReportDay[];
  by_outcome: { key: string; label: string; group: string; count: number }[]; columns: ReportColumn[]; campaigns: number; active_calls: number;
  agent: string; agents: { key: string; label: string }[]; answers: ReportAnswer[];
  input: ReportInput; why: { base: number; reasons: { key: string; label: string; count: number }[] }; rows_line: { uploaded: number; on_reached: number; covered: number; not_covered: number } | null;
}
export interface ReportSchedule {
  id?: string; name: string; every: 'day' | 'week'; weekdays: number[]; time: string; days: number; by: string; value: string; agent?: string;
  recipients: string[]; formats: string[]; include_follow_ups: boolean; on: boolean; last_sent_at?: string | null;
}
export interface FollowNote { text: string; by: string; at: string; system?: boolean }
export interface FollowUp {
  id: string; batchId: string; templateId: string; campaign_name: string; agent: string; name: string; phone: string; reason: string; reason_label: string; status: string; dials: number;
  since: string; telephony: { Status?: string; CustomerStatus?: string; DialStatus?: string } | null; state: 'open' | 'done'; owner: string; notes: FollowNote[]; closed_as: string;
}
export interface FollowUpList {
  rows: FollowUp[]; counts: { open: number; done: number; by_reason: Record<string, number> }; reasons: Record<string, { label: string; help: string }>; owners: { email: string }[];
}

/** Reports (the dashboard numbers, their exports and email schedules) and follow ups. Clarix mirrors Echo's call status. */
@Injectable({ providedIn: 'root' })
export class ReportService {
  private readonly http = inject(HttpClient);
  private data<T>(o: Observable<{ data: T }>): Observable<T> { return o.pipe(map((r) => r.data)); }
  /** Calling report: same scope for the dashboard, any box's calls and the 14-column export. */
  private reportParams(sc: { from: string; to: string; agents: string[]; includeTests: boolean }): HttpParams {
    return new HttpParams().set('from', sc.from).set('to', sc.to).set('agents', sc.agents.join(',')).set('include_tests', sc.includeTests ? '1' : '').set('campaign', (sc as any).campaign || '').set('unit', (sc as any).unit || '');
  }
  callingReport(sc: { from: string; to: string; agents: string[]; includeTests: boolean }, f?: { q: string; cols: Record<string, string | string[] | { op: string; a?: string; b?: string }> }): Observable<any> { return this.data(this.http.get<{ data: any }>(ENDPOINTS.callingReport.report, { params: this.logParams(this.reportParams(sc), f) })); }
  // ── Calling report extras: column values, tasks, custom stats, follow-up checklist ──
  reportColumnValues(sc: any, box: string, f: any, column: string, search = ''): Observable<any[]> { return this.data(this.http.get<{ data: any }>(`${ENDPOINTS.callingReport.report}/calls/values`, { params: this.logParams(this.reportParams(sc).set('box', box).set('column', column).set('vq', search), f) })).pipe(map((d: any) => d.values ?? [])); }
  reportTasks(sc: any): Observable<any> { return this.data(this.http.get<{ data: any }>(`${ENDPOINTS.callingReport.report}/tasks`, { params: this.reportParams(sc) })); }
  reportAgentStats(): Observable<any> { return this.data(this.http.get<{ data: any }>(`${ENDPOINTS.callingReport.report}/agent-stats`)); }
  saveReportAgentStats(agent: string, stats: any[]): Observable<any> { return this.data(this.http.put<{ data: any }>(`${ENDPOINTS.callingReport.report}/agent-stats/${encodeURIComponent(agent)}`, { stats })); }
  followChecklist(show: string, kind: string): Observable<any> { return this.data(this.http.get<{ data: any }>(`${ENDPOINTS.callingReport.report}/follow-ups/checklist`, { params: new HttpParams().set('show', show).set('kind', kind) })); }
  followChecklistExport(show: string, kind: string): Observable<Blob> { return this.http.get(`${ENDPOINTS.callingReport.report}/follow-ups/export.xlsx`, { params: new HttpParams().set('show', show).set('kind', kind), responseType: 'blob' }); }
  // ── Shared screens: campaigns, follow ups, new campaign ──
  private get callingBase(): string { return ENDPOINTS.callingReport.report; }
  reportCampaigns(p: { from: string | null; to: string | null; state: string; q: string; skip: number; limit: number }): Observable<any> {
    return this.data(this.http.get<{ data: any }>(`${this.callingBase}/campaigns`, { params: new HttpParams().set('from', p.from || '').set('to', p.to || '').set('state', p.state).set('q', p.q).set('skip', p.skip).set('limit', p.limit) }));
  }
  reportCampaign(id: string): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/campaigns/${encodeURIComponent(id)}`)); }
  stopReportCampaign(id: string): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/campaigns/${encodeURIComponent(id)}/stop`, {})); }
  reportFollowUps(tab: string, show: string): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/follow-ups`, { params: new HttpParams().set('tab', tab).set('show', show) })); }
  reportFollowUpAct(id: string, action: string): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/follow-ups/${encodeURIComponent(id)}`, { action })); }
  newCampaignAgents(): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/new-campaign/agents`)); }
  newCampaignTips(agent: string): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/new-campaign/tips`, { params: new HttpParams().set('agent', agent) })); }
  retryRules(): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/retry-rules`)); }
  // Agent data sources: connect a system, map fields, group lines into calls, schedule runs.
  dsCatalog(): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/data-sources/catalog`)); }
  dsLoad(agent: string): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/data-sources/${encodeURIComponent(agent)}`)); }
  dsSave(agent: string, setup: any): Observable<any> { return this.data(this.http.put<{ data: any }>(`${this.callingBase}/data-sources/${encodeURIComponent(agent)}`, setup)); }
  dsTest(conn: any): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/data-sources/test`, conn)); }
  dsPreview(agent: string, setup: any): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/data-sources/${encodeURIComponent(agent)}/preview`, setup)); }
  dsRun(agent: string): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/data-sources/${encodeURIComponent(agent)}/run`, { by: 'Run now' })); }
  // Wave 1: do-not-call list, alerts, call handling, re-running answers, diagnostics.
  dncLoad(q = ''): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/dnc`, { params: { q } })); }
  dncAdd(e: any): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/dnc`, e)); }
  dncRemove(phone: string, reason: string): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/dnc/remove`, { phone, reason })); }
  dncAuto(auto: boolean): Observable<any> { return this.data(this.http.put<{ data: any }>(`${this.callingBase}/dnc/settings`, { auto })); }
  alerts(): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/alerts`)); }
  saveAlerts(rules: any[]): Observable<any> { return this.data(this.http.put<{ data: any }>(`${this.callingBase}/alerts`, { rules })); }
  resumeReportCampaign(id: string): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/campaigns/${encodeURIComponent(id)}/resume`, {})); }
  callHandling(agent: string): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/call-handling/${encodeURIComponent(agent)}`)); }
  saveCallHandling(agent: string, h: any): Observable<any> { return this.data(this.http.put<{ data: any }>(`${this.callingBase}/call-handling/${encodeURIComponent(agent)}`, h)); }
  rerunCalls(sc: any, box: string, f?: any): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/calls/rerun`, {}, { params: this.logParams(this.reportParams(sc).set('box', box), f) })); }
  // Wave 2: quality checks, persona tests, versions and the A/B split, contact memory.
  quality(a: string): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/quality/${encodeURIComponent(a)}`)); }
  saveQuality(a: string, cfg: any): Observable<any> { return this.data(this.http.put<{ data: any }>(`${this.callingBase}/quality/${encodeURIComponent(a)}`, cfg)); }
  agentTests(a: string): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/tests/${encodeURIComponent(a)}`)); }
  runAgentTests(a: string, ids: string[], version: number): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/tests/${encodeURIComponent(a)}/run`, { ids, version })); }
  agentTestsFromCalls(a: string): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/tests/${encodeURIComponent(a)}/from-calls`, {})); }
  agentVersions(a: string): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/versions/${encodeURIComponent(a)}`)); }
  saveAgentDraft(a: string, d: any): Observable<any> { return this.data(this.http.put<{ data: any }>(`${this.callingBase}/versions/${encodeURIComponent(a)}/draft`, d)); }
  publishAgentDraft(a: string): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/versions/${encodeURIComponent(a)}/publish`, {})); }
  splitAgentVersions(a: string, s: any): Observable<any> { return this.data(this.http.put<{ data: any }>(`${this.callingBase}/versions/${encodeURIComponent(a)}/split`, s)); }
  // Wave 3: live calls, telephony and slots, the copilot.
  // Action needed: manual work beside the agent's queue.
  actionNeeded(p: any): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/follow-ups/actions`, { params: p })); }
  // Enterprise shell: bulk actions, Supplier 360, security center, audit log.
  actionBulk(ids: string[], a: any): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/follow-ups/actions/bulk`, { ids, ...a })); }
  supplier(phone: string): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/supplier/${encodeURIComponent(phone)}`)); }
  security(): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/security`)); }
  saveSecurity(s: any): Observable<any> { return this.data(this.http.put<{ data: any }>(`${this.callingBase}/security`, s)); }
  testSso(s: any): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/security/sso/test`, s)); }
  scimToken(): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/security/scim/token`, {})); }
  deleteContact(b: any): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/security/delete-contact`, b)); }
  // Team and access: org, sub-orgs, teams, people, roles and user types. `as` previews the screen as another person.
  access(as: string): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/access`, { params: as ? { as } : {} })); }
  accessSend(method: 'POST' | 'PUT' | 'DELETE', path: string, body: any, as: string): Observable<any> { return this.data(this.http.request<{ data: any }>(method, `${this.callingBase}/access/${path}`, { body: method === 'DELETE' ? undefined : body, params: as ? { as } : {} })); }
  auditLog(p: any): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/audit`, { params: p })); }
  auditExport(p: any): Observable<Blob> { return this.http.get(`${this.callingBase}/audit/export.xlsx`, { params: p, responseType: 'blob' }); }
  actionAct(id: string, a: any): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/follow-ups/actions/${encodeURIComponent(id)}`, a)); }
  actionExport(p: any): Observable<Blob> { return this.http.get(`${this.callingBase}/follow-ups/actions/export.xlsx`, { params: p, responseType: 'blob' }); }
  liveCalls(): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/live`)); }
  liveAct(id: string, action: string, body: any = {}): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/live/${encodeURIComponent(id)}/${action}`, body)); }
  telephony(): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/telephony`)); }
  telTest(b: any): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/telephony/test`, b)); }
  telConnect(b: any): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/telephony/connect`, b)); }
  telDisconnect(key: string): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/telephony/${encodeURIComponent(key)}/disconnect`, {})); }
  telSlots(b: any): Observable<any> { return this.data(this.http.put<{ data: any }>(`${this.callingBase}/telephony/slots`, b)); }
  askCalls(sc: any, box: string, f: any, q: string): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/copilot`, { q }, { params: this.logParams(this.reportParams(sc).set('box', box), f) })); }
  callMemory(id: string): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/call/${encodeURIComponent(id)}/memory`)); }
  callDiagnostics(id: string): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/call/${encodeURIComponent(id)}/diagnostics`)); }
  callingRules(): Observable<any> { return this.data(this.http.get<{ data: any }>(`${this.callingBase}/calling-rules`)); }
  saveCallingRule(code: string, rule: any): Observable<any> { return this.data(this.http.put<{ data: any }>(`${this.callingBase}/calling-rules/${encodeURIComponent(code)}`, rule)); }
  resetCallingRule(code: string): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/calling-rules/${encodeURIComponent(code)}/reset`, {})); }
  retryPreview(rule: any, country: string, startHour?: number): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/retry-rules/preview`, { rule, country, start_hour: startHour })); }
  saveRetryRule(agent: string, rule: any): Observable<any> { return this.data(this.http.put<{ data: any }>(`${this.callingBase}/retry-rules/${encodeURIComponent(agent)}`, rule)); }
  newCampaignRecheck(agent: string, rows: unknown): Observable<any> { return this.data(this.http.post<{ data: any }>(`${this.callingBase}/new-campaign/recheck`, { rows }, { params: new HttpParams().set('agent', agent) })); }
  newCampaignTemplate(agent: string): Observable<Blob> { return this.http.get(`${this.callingBase}/new-campaign/template.xlsx`, { params: new HttpParams().set('agent', agent), responseType: 'blob' }); }
  newCampaignPost(step: 'check' | 'start', agent: string, file: File): Observable<any> {
    const fd = new FormData(); fd.append('file', file, file.name);
    return this.data(this.http.post<{ data: any }>(`${this.callingBase}/new-campaign/${step}`, fd, { params: new HttpParams().set('agent', agent) }));
  }
  private logParams(p: HttpParams, f?: { q: string; cols: Record<string, string | string[] | { op: string; a?: string; b?: string }> }): HttpParams { return f ? p.set('q', f.q).set('filters', Object.keys(f.cols).length ? JSON.stringify(f.cols) : '') : p; }
  callingReportCalls(sc: { from: string; to: string; agents: string[]; includeTests: boolean }, box: string, skip: number, limit: number, f?: { q: string; cols: Record<string, string | string[] | { op: string; a?: string; b?: string }> }): Observable<any> {
    return this.data(this.http.get<{ data: any }>(ENDPOINTS.callingReport.calls, { params: this.logParams(this.reportParams(sc).set('box', box).set('skip', skip).set('limit', limit), f) }));
  }
  reportTestNumbers(): Observable<string[]> { return this.data(this.http.get<{ data: { numbers: string[] } }>(ENDPOINTS.callingReport.testNumbers)).pipe(map((d) => d.numbers ?? [])); }
  saveReportTestNumbers(numbers: string[]): Observable<string[]> { return this.data(this.http.put<{ data: { numbers: string[] } }>(ENDPOINTS.callingReport.testNumbers, { numbers })).pipe(map((d) => d.numbers ?? [])); }
  /** One call page: a call by report row id, its recording, and a person's change of outcome. */
  callDetail(id: string): Observable<any> { return this.data(this.http.get<{ data: any }>(`${ENDPOINTS.callingReport.report}/call/${encodeURIComponent(id)}`)); }
  callSteps(id: string): Observable<any> { return this.data(this.http.get<{ data: any }>(`${ENDPOINTS.callingReport.report}/call/${encodeURIComponent(id)}/steps`)); }
  sendCallMessage(id: string, m: any): Observable<any> { return this.data(this.http.post<{ data: any }>(`${ENDPOINTS.callingReport.report}/call/${encodeURIComponent(id)}/messages`, m)); }
  changeCallOutcome(id: string, status_reason: string, note: string): Observable<any> { return this.data(this.http.patch<{ data: any }>(`${ENDPOINTS.callingReport.report}/call/${encodeURIComponent(id)}/outcome`, { status_reason, note })); }
  /** A file under the API (the recording), with the signed-in headers. */
  blobAt(path: string): Observable<Blob> { return this.http.get(ENDPOINTS.callingReport.report.replace('/api/v1/reports/calling', '') + path, { responseType: 'blob' }); }
  callingReportExport(sc: { from: string; to: string; agents: string[]; includeTests: boolean }, box: string, f?: { q: string; cols: Record<string, string | string[] | { op: string; a?: string; b?: string }> }): Observable<Blob> {
    return this.http.get(ENDPOINTS.callingReport.exportXlsx, { params: this.logParams(this.reportParams(sc).set('box', box), f), responseType: 'blob' });
  }

  summary(days: number, by: string, agent = ''): Observable<ReportSummary> {
    return this.data(this.http.get<{ data: ReportSummary }>(ENDPOINTS.reports.summary, { params: new HttpParams().set('days', days).set('by', by).set('agent', agent) }));
  }
  /** Result and stats of one campaign (one uploaded sheet). */
  campaignSummary(batchId: string): Observable<ReportSummary> {
    return this.data(this.http.get<{ data: ReportSummary }>(ENDPOINTS.reports.summary, { params: new HttpParams().set('days', 3650).set('by', 'day').set('batchId', batchId) }));
  }
  /** The rows behind one stat or one result. */
  rows(scope: Record<string, string | number>, stat: string): Observable<{ stat: string; total: number; rows: StatRowItem[] }> {
    let params = new HttpParams().set('stat', stat);
    for (const [k, v] of Object.entries(scope)) if (v !== '' && v != null) params = params.set(k, v);
    return this.data(this.http.get<{ data: { stat: string; total: number; rows: StatRowItem[] } }>(ENDPOINTS.reports.rows, { params }));
  }
  /** The same report as a spreadsheet with five tabs. */
  spreadsheet(days: number, by: string, agent = ''): Observable<Blob> {
    return this.http.get(ENDPOINTS.reports.exportXlsx, { params: new HttpParams().set('days', days).set('by', by).set('agent', agent), responseType: 'blob' });
  }
  schedules(): Observable<ReportSchedule[]> { return this.data(this.http.get<{ data: ReportSchedule[] }>(ENDPOINTS.reports.schedules)); }
  saveSchedule(s: Partial<ReportSchedule>): Observable<ReportSchedule> {
    return this.data(s.id ? this.http.patch<{ data: ReportSchedule }>(ENDPOINTS.reports.schedule(s.id), s) : this.http.post<{ data: ReportSchedule }>(ENDPOINTS.reports.schedules, s));
  }
  deleteSchedule(id: string): Observable<unknown> { return this.http.delete(ENDPOINTS.reports.schedule(id)); }
  sendNow(id: string): Observable<unknown> { return this.http.post(ENDPOINTS.reports.sendNow(id), {}); }

  followUps(state: 'open' | 'done'): Observable<FollowUpList> { return this.data(this.http.get<{ data: FollowUpList }>(ENDPOINTS.followUps.list, { params: new HttpParams().set('state', state) })); }
  updateFollowUp(id: string, body: Record<string, unknown>): Observable<unknown> { return this.http.patch(ENDPOINTS.followUps.one(id), body); }
  callAgain(id: string): Observable<unknown> { return this.http.post(ENDPOINTS.followUps.callAgain(id), {}); }
}
