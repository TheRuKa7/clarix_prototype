import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { ENDPOINTS } from '../../../enpoints.service';
import { BaseResponse } from '../models/workflow-template.model';
import { ExecutionSheet } from '../models/execution-sheet.model';

@Injectable({ providedIn: 'root' })
export class ExecutionSheetService {
  private readonly http = inject(HttpClient);

  list(
    opts: {
      page?: number;
      size?: number;
      templateId?: string;
      /** Case-insensitive substring of the uploader's email. */
      uploadedBy?: string;
      /** ISO instants bounding the upload time, inclusive. */
      from?: string;
      to?: string;
    } = {}
  ): Observable<{ items: ExecutionSheet[]; total: number }> {
    let params = new HttpParams().set('page', opts.page ?? 0).set('size', opts.size ?? 50);
    if (opts.templateId) params = params.set('templateId', opts.templateId);
    if (opts.uploadedBy?.trim()) params = params.set('uploadedBy', opts.uploadedBy.trim());
    if (opts.from) params = params.set('from', opts.from);
    if (opts.to) params = params.set('to', opts.to);
    return this.http
      .get<BaseResponse<ExecutionSheet[]>>(ENDPOINTS.executionSheets.list, { params })
      .pipe(
        map((res) => ({ items: res.data ?? [], total: res.totalElements ?? 0 })),
        catchError(this.handleError)
      );
  }

  getById(id: string): Observable<ExecutionSheet> {
    return this.http
      .get<BaseResponse<ExecutionSheet>>(ENDPOINTS.executionSheets.getById(id))
      .pipe(map((res) => res.data!), catchError(this.handleError));
  }

  /** Stop all in-progress calls in one sheet (batch). Resolves with the number stopped. */
  stopBatch(id: string): Observable<number> {
    return this.http
      .post<BaseResponse<number>>(ENDPOINTS.executionSheets.stop(id), {})
      .pipe(map((res) => res.data ?? 0), catchError(this.handleError));
  }

  private handleError(error: HttpErrorResponse): Observable<never> {
    const message = error.error?.message || error.message || 'Unexpected error';
    return throwError(() => new Error(message));
  }
}
