import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { ENDPOINTS } from '../../../enpoints.service';
import { BaseResponse, WorkflowExecution } from '../models/workflow-template.model';
import { WorkflowEventModel } from '../models/workflow-event.model';
import { EMPTY_ORG_SUMMARY, WorkflowOrgSummary } from '../models/workflow-org-summary.model';

@Injectable({ providedIn: 'root' })
export class WorkflowExecutionService {
  private readonly http = inject(HttpClient);

  /** Org-wide executions list (Call Logs) — same filters as {@link listByTemplate}, no template scope. */
  listAll(
    opts: {
      page?: number;
      size?: number;
      status?: string;
      channelType?: string;
      from?: string;
      to?: string;
      phone?: string;
      batchId?: string;
      search?: string;
    } = {}
  ): Observable<{ items: WorkflowExecution[]; total: number }> {
    let params = new HttpParams().set('page', opts.page ?? 0).set('size', opts.size ?? 20);
    if (opts.status) params = params.set('status', opts.status);
    if (opts.channelType) params = params.set('channelType', opts.channelType);
    if (opts.from) params = params.set('from', opts.from);
    if (opts.to) params = params.set('to', opts.to);
    if (opts.phone) params = params.set('phone', opts.phone);
    if (opts.batchId) params = params.set('batchId', opts.batchId);
    if (opts.search?.trim()) params = params.set('search', opts.search.trim());
    return this.http
      .get<BaseResponse<WorkflowExecution[]>>(ENDPOINTS.workflows.list, { params })
      .pipe(
        map((res) => ({ items: res.data ?? [], total: res.totalElements ?? 0 })),
        catchError(this.handleError)
      );
  }

  getOrgSummary(): Observable<WorkflowOrgSummary> {
    return this.http
      .get<BaseResponse<WorkflowOrgSummary>>(ENDPOINTS.workflows.orgSummary)
      .pipe(
        map((res) => res.data ?? EMPTY_ORG_SUMMARY),
        catchError(() => of(EMPTY_ORG_SUMMARY))
      );
  }

  listByTemplate(
    templateId: string,
    opts: {
      page?: number;
      size?: number;
      status?: string;
      channelType?: string;
      from?: string;
      to?: string;
      phone?: string;
      batchId?: string;
    } = {}
  ): Observable<{ items: WorkflowExecution[]; total: number }> {
    let params = new HttpParams()
      .set('page', opts.page ?? 0)
      .set('size', opts.size ?? 20);
    if (opts.status) params = params.set('status', opts.status);
    if (opts.channelType) params = params.set('channelType', opts.channelType);
    if (opts.from) params = params.set('from', opts.from);
    if (opts.to) params = params.set('to', opts.to);
    if (opts.phone) params = params.set('phone', opts.phone);
    if (opts.batchId) params = params.set('batchId', opts.batchId);
    return this.http
      .get<BaseResponse<WorkflowExecution[]>>(ENDPOINTS.workflows.listByTemplate(templateId), { params })
      .pipe(
        map((res) => ({ items: res.data ?? [], total: res.totalElements ?? 0 })),
        catchError(this.handleError)
      );
  }

  exportReport(
    templateId: string,
    opts: {
      status?: string;
      channelType?: string;
      from?: string;
      to?: string;
      phone?: string;
      batchId?: string;
    } = {}
  ): Observable<Blob> {
    let params = new HttpParams();
    if (opts.status) params = params.set('status', opts.status);
    if (opts.channelType) params = params.set('channelType', opts.channelType);
    if (opts.from) params = params.set('from', opts.from);
    if (opts.to) params = params.set('to', opts.to);
    if (opts.phone) params = params.set('phone', opts.phone);
    if (opts.batchId) params = params.set('batchId', opts.batchId);
    return this.http
      .get(ENDPOINTS.workflows.reportByTemplate(templateId), { params, responseType: 'blob' })
      .pipe(catchError(this.handleError));
  }

  getById(executionId: string): Observable<WorkflowExecution> {
    return this.http
      .get<BaseResponse<WorkflowExecution>>(ENDPOINTS.workflows.getById(executionId))
      .pipe(
        map((res) => res.data as WorkflowExecution),
        catchError(this.handleError)
      );
  }

  /** Reschedule an UPCOMING execution to a new time (ISO-8601 string). */
  reschedule(executionId: string, scheduledAt: string): Observable<WorkflowExecution> {
    return this.http
      .patch<BaseResponse<WorkflowExecution>>(ENDPOINTS.workflows.reschedule(executionId), { scheduledAt })
      .pipe(
        map((res) => res.data as WorkflowExecution),
        catchError(this.handleError)
      );
  }

  /** Run an UPCOMING execution immediately. */
  executeNow(executionId: string): Observable<WorkflowExecution> {
    return this.http
      .post<BaseResponse<WorkflowExecution>>(ENDPOINTS.workflows.executeNow(executionId), {})
      .pipe(
        map((res) => res.data as WorkflowExecution),
        catchError(this.handleError)
      );
  }

  /** Cancel an UPCOMING execution. */
  cancelExecution(executionId: string): Observable<WorkflowExecution> {
    return this.http
      .post<BaseResponse<WorkflowExecution>>(ENDPOINTS.workflows.cancel(executionId), {})
      .pipe(
        map((res) => res.data as WorkflowExecution),
        catchError(this.handleError)
      );
  }

  /** Stop an IN_PROGRESS execution's live call. Returns the execution now in STOPPED status. */
  stopCall(executionId: string): Observable<WorkflowExecution> {
    return this.http
      .post<BaseResponse<WorkflowExecution>>(ENDPOINTS.workflows.stop(executionId), {})
      .pipe(
        map((res) => res.data as WorkflowExecution),
        catchError(this.handleError)
      );
  }

  /** Append-only event log for an execution — backs the debug timeline. */
  getEvents(executionId: string): Observable<WorkflowEventModel[]> {
    return this.http
      .get<BaseResponse<WorkflowEventModel[]>>(ENDPOINTS.workflows.events(executionId))
      .pipe(
        map((res) => res.data ?? []),
        catchError(this.handleError)
      );
  }

  /** Manually reconcile call status by polling the call provider's call-details API (debug "Sync now"). */
  syncStatus(executionId: string): Observable<WorkflowExecution> {
    return this.http
      .post<BaseResponse<WorkflowExecution>>(ENDPOINTS.workflows.syncStatus(executionId), {})
      .pipe(
        map((res) => res.data as WorkflowExecution),
        catchError(this.handleError)
      );
  }

  private handleError(error: HttpErrorResponse): Observable<never> {
    const message = error.error?.message ?? error.message ?? 'An unexpected error occurred';
    console.error('WorkflowExecutionService error:', message);
    return throwError(() => message);
  }
}
