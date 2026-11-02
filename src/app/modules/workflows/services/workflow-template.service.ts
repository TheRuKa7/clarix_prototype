import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { ENDPOINTS } from '../../../enpoints.service';
import {
  WorkflowTemplate,
  WorkflowTemplateRequest,
  WorkflowTemplateStats,
  BaseResponse,
  BulkTriggerResult,
  AgentSchema,
} from '../models/workflow-template.model';

@Injectable({ providedIn: 'root' })
export class WorkflowTemplateService {
  private readonly http = inject(HttpClient);

  list(opts: {
    page?: number;
    size?: number;
    search?: string;
    status?: string;
  } = {}): Observable<{ items: WorkflowTemplate[]; total: number }> {
    let params = new HttpParams()
      .set('page', opts.page ?? 0)
      .set('size', opts.size ?? 20);
    if (opts.search?.trim()) {
      params = params.set('search', opts.search.trim());
    }
    if (opts.status) {
      params = params.set('status', opts.status);
    }
    return this.http
      .get<BaseResponse<WorkflowTemplate[]>>(ENDPOINTS.workflowTemplates.list, { params })
      .pipe(
        map((res) => ({ items: res.data ?? [], total: res.totalElements ?? 0 })),
        catchError(this.handleError)
      );
  }

  getStats(): Observable<WorkflowTemplateStats> {
    return this.http
      .get<BaseResponse<WorkflowTemplateStats>>(ENDPOINTS.workflowTemplates.stats)
      .pipe(
        map((res) => res.data ?? { total: 0, active: 0, draft: 0, totalSteps: 0 }),
        catchError(this.handleError)
      );
  }

  getById(templateId: string): Observable<WorkflowTemplate> {
    return this.http
      .get<BaseResponse<WorkflowTemplate>>(ENDPOINTS.workflowTemplates.getById(templateId))
      .pipe(
        map((res) => res.data!),
        catchError(this.handleError)
      );
  }

  create(request: WorkflowTemplateRequest): Observable<WorkflowTemplate> {
    return this.http
      .post<BaseResponse<WorkflowTemplate>>(ENDPOINTS.workflowTemplates.create, request)
      .pipe(
        map((res) => res.data!),
        catchError(this.handleError)
      );
  }

  update(templateId: string, request: WorkflowTemplateRequest): Observable<WorkflowTemplate> {
    return this.http
      .put<BaseResponse<WorkflowTemplate>>(ENDPOINTS.workflowTemplates.update(templateId), request)
      .pipe(
        map((res) => res.data!),
        catchError(this.handleError)
      );
  }

  /** Only DRAFT templates with no execution history can be deleted — the backend enforces this. */
  delete(templateId: string): Observable<void> {
    return this.http
      .delete<BaseResponse>(ENDPOINTS.workflowTemplates.delete(templateId))
      .pipe(
        map(() => void 0),
        catchError(this.handleError)
      );
  }

  /**
   * The current locally-stored schema of the Exchange agent this template is routed to (never a
   * live Exchange call). Resolves to `null` for a Voxera-routed template or one with no agent
   * record yet (the backend 404s) rather than surfacing an error.
   */
  getAgentSchema(templateId: string): Observable<AgentSchema | null> {
    return this.http
      .get<BaseResponse<AgentSchema>>(ENDPOINTS.workflowTemplates.agentSchema(templateId))
      .pipe(
        map((res) => res.data ?? null),
        catchError(() => of(null))
      );
  }

  activate(templateId: string): Observable<void> {
    return this.http
      .patch<BaseResponse>(ENDPOINTS.workflowTemplates.activate(templateId), null)
      .pipe(
        map(() => void 0),
        catchError(this.handleError)
      );
  }

  deactivate(templateId: string): Observable<void> {
    return this.http
      .patch<BaseResponse>(ENDPOINTS.workflowTemplates.deactivate(templateId), null)
      .pipe(
        map(() => void 0),
        catchError(this.handleError)
      );
  }

  triggerBulk(params: {
    file: File;
    templateId: string;
    eventType?: string;
    columnMapping: {
      contact?: { phone?: string; name?: string; email?: string };
      fields?: Record<string, string>;
      enrichmentInputs?: Record<string, string>;
      reportFields?: Record<string, string>;
      scheduledAt?: string;
    };
  }): Observable<BulkTriggerResult> {
    const form = new FormData();
    form.append('file', params.file);
    form.append('templateId', params.templateId);
    if (params.eventType) {
      form.append('eventType', params.eventType);
    }
    form.append('columnMapping', JSON.stringify(params.columnMapping));
    return this.http
      .post<BaseResponse<BulkTriggerResult>>(ENDPOINTS.workflows.triggerBulk, form)
      .pipe(
        map((res) => res.data ?? { total: 0, triggered: 0, failed: 0, failedRows: [] }),
        catchError(this.handleError)
      );
  }

  private handleError(error: HttpErrorResponse): Observable<never> {
    let message = 'An unexpected error occurred';
    if (error.error?.message) {
      message = error.error.message;
    } else if (error.message) {
      message = error.message;
    }
    console.error('WorkflowTemplateService error:', message);
    return throwError(() => message);
  }
}
