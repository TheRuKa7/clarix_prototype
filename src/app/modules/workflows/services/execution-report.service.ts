import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { ENDPOINTS } from '../../../enpoints.service';
import { BaseResponse } from '../models/workflow-template.model';
import { ExecutionReport, ExecutionReportRequest } from '../models/execution-report.model';

@Injectable({ providedIn: 'root' })
export class ExecutionReportService {
  private readonly http = inject(HttpClient);

  list(opts: { page?: number; size?: number; templateId?: string } = {}):
    Observable<{ items: ExecutionReport[]; total: number }> {
    let params = new HttpParams()
      .set('page', opts.page ?? 0)
      .set('size', opts.size ?? 50);
    if (opts.templateId?.trim()) params = params.set('templateId', opts.templateId.trim());

    return this.http
      .get<BaseResponse<ExecutionReport[]>>(ENDPOINTS.executionReports.list, { params })
      .pipe(
        map((res) => ({ items: res.data ?? [], total: res.totalElements ?? 0 })),
        catchError(this.handleError)
      );
  }

  getById(id: string): Observable<ExecutionReport> {
    return this.http
      .get<BaseResponse<ExecutionReport>>(ENDPOINTS.executionReports.getById(id))
      .pipe(map((res) => res.data!), catchError(this.handleError));
  }

  create(req: ExecutionReportRequest): Observable<ExecutionReport> {
    return this.http
      .post<BaseResponse<ExecutionReport>>(ENDPOINTS.executionReports.create, req)
      .pipe(map((res) => res.data!), catchError(this.handleError));
  }

  update(id: string, req: ExecutionReportRequest): Observable<ExecutionReport> {
    return this.http
      .put<BaseResponse<ExecutionReport>>(ENDPOINTS.executionReports.update(id), req)
      .pipe(map((res) => res.data!), catchError(this.handleError));
  }

  delete(id: string): Observable<void> {
    return this.http
      .delete<BaseResponse<void>>(ENDPOINTS.executionReports.delete(id))
      .pipe(map(() => void 0), catchError(this.handleError));
  }

  download(id: string): Observable<Blob> {
    return this.http
      .get(ENDPOINTS.executionReports.download(id), { responseType: 'blob' })
      .pipe(catchError(this.handleError));
  }

  private handleError(error: HttpErrorResponse): Observable<never> {
    const message = error.error?.message || error.message || 'Unexpected error';
    return throwError(() => new Error(message));
  }
}
