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
export interface ReportSummary {
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

  summary(days: number, by: string, agent = ''): Observable<ReportSummary> {
    return this.data(this.http.get<{ data: ReportSummary }>(ENDPOINTS.reports.summary, { params: new HttpParams().set('days', days).set('by', by).set('agent', agent) }));
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
