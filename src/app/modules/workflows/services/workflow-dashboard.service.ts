import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { ENDPOINTS } from '../../../enpoints.service';
import { BaseResponse } from '../models/workflow-template.model';
import { WorkflowDashboardData } from '../models/workflow-dashboard.model';

@Injectable({ providedIn: 'root' })
export class WorkflowDashboardService {
  private readonly http = inject(HttpClient);

  getDashboard(
    templateId: string,
    opts: { from?: string; to?: string; batchId?: string } = {}
  ): Observable<WorkflowDashboardData> {
    let params = new HttpParams();
    if (opts.from) params = params.set('from', opts.from);
    if (opts.to) params = params.set('to', opts.to);
    if (opts.batchId) params = params.set('batchId', opts.batchId);
    return this.http
      .get<BaseResponse<WorkflowDashboardData>>(ENDPOINTS.workflows.dashboard(templateId), { params })
      .pipe(
        map((res) => res.data as WorkflowDashboardData),
        catchError(this.handleError)
      );
  }

  private handleError(error: HttpErrorResponse): Observable<never> {
    const message = error.error?.message ?? error.message ?? 'Failed to load dashboard';
    console.error('WorkflowDashboardService error:', message);
    return throwError(() => message);
  }
}
