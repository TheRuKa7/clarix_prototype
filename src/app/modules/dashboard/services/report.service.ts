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
    return new HttpParams().set('from', sc.from).set('to', sc.to).set('agents', sc.agents.join(',')).set('include_tests', sc.includeTests ? '1' : '');
  }
  callingReport(sc: { from: string; to: string; agents: string[]; includeTests: boolean }): Observable<any> { return this.data(this.http.get<{ data: any }>(ENDPOINTS.callingReport.report, { params: this.reportParams(sc) })); }
  private logParams(p: HttpParams, f?: { q: string; cols: Record<string, string> }): HttpParams { return f ? p.set('q', f.q).set('filters', Object.keys(f.cols).length ? JSON.stringify(f.cols) : '') : p; }
  callingReportCalls(sc: { from: string; to: string; agents: string[]; includeTests: boolean }, box: string, skip: number, limit: number, f?: { q: string; cols: Record<string, string> }): Observable<any> {
    return this.data(this.http.get<{ data: any }>(ENDPOINTS.callingReport.calls, { params: this.logParams(this.reportParams(sc).set('box', box).set('skip', skip).set('limit', limit), f) }));
  }
  reportTestNumbers(): Observable<string[]> { return this.data(this.http.get<{ data: { numbers: string[] } }>(ENDPOINTS.callingReport.testNumbers)).pipe(map((d) => d.numbers ?? [])); }
  saveReportTestNumbers(numbers: string[]): Observable<string[]> { return this.data(this.http.put<{ data: { numbers: string[] } }>(ENDPOINTS.callingReport.testNumbers, { numbers })).pipe(map((d) => d.numbers ?? [])); }
  /** One call page: a call by report row id, its recording, and a person's change of outcome. */
  callDetail(id: string): Observable<any> { return this.data(this.http.get<{ data: any }>(`${ENDPOINTS.callingReport.report}/call/${encodeURIComponent(id)}`)); }
  changeCallOutcome(id: string, status_reason: string, note: string): Observable<any> { return this.data(this.http.patch<{ data: any }>(`${ENDPOINTS.callingReport.report}/call/${encodeURIComponent(id)}/outcome`, { status_reason, note })); }
  /** A file under the API (the recording), with the signed-in headers. */
  blobAt(path: string): Observable<Blob> { return this.http.get(ENDPOINTS.callingReport.report.replace('/api/v1/reports/calling', '') + path, { responseType: 'blob' }); }
  callingReportExport(sc: { from: string; to: string; agents: string[]; includeTests: boolean }, box: string, f?: { q: string; cols: Record<string, string> }): Observable<Blob> {
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
