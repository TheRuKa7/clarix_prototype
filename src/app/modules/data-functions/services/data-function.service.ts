import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { ENDPOINTS } from '../../../enpoints.service';
import {
  BaseResponse,
  DataFunction,
  DataFunctionRequest,
  DataFunctionTestResult,
} from '../models/data-function.model';

@Injectable({ providedIn: 'root' })
export class DataFunctionService {
  private readonly http = inject(HttpClient);

  list(opts: { page?: number; size?: number; search?: string } = {}):
    Observable<{ items: DataFunction[]; total: number }> {
    let params = new HttpParams()
      .set('page', opts.page ?? 0)
      .set('size', opts.size ?? 50);
    if (opts.search?.trim()) params = params.set('search', opts.search.trim());

    return this.http
      .get<BaseResponse<DataFunction[]>>(ENDPOINTS.dataFunctions.list, { params })
      .pipe(
        map(res => ({ items: res.data ?? [], total: res.totalElements ?? 0 })),
        catchError(this.handleError)
      );
  }

  getById(id: string): Observable<DataFunction> {
    return this.http
      .get<BaseResponse<DataFunction>>(ENDPOINTS.dataFunctions.getById(id))
      .pipe(map(res => res.data!), catchError(this.handleError));
  }

  create(req: DataFunctionRequest): Observable<DataFunction> {
    return this.http
      .post<BaseResponse<DataFunction>>(ENDPOINTS.dataFunctions.create, req)
      .pipe(map(res => res.data!), catchError(this.handleError));
  }

  update(id: string, req: DataFunctionRequest): Observable<DataFunction> {
    return this.http
      .put<BaseResponse<DataFunction>>(ENDPOINTS.dataFunctions.update(id), req)
      .pipe(map(res => res.data!), catchError(this.handleError));
  }

  setEnabled(id: string, enabled: boolean): Observable<DataFunction> {
    const params = new HttpParams().set('enabled', enabled);
    return this.http
      .patch<BaseResponse<DataFunction>>(ENDPOINTS.dataFunctions.setEnabled(id), null, { params })
      .pipe(map(res => res.data!), catchError(this.handleError));
  }

  delete(id: string): Observable<void> {
    return this.http
      .delete<BaseResponse<void>>(ENDPOINTS.dataFunctions.delete(id))
      .pipe(map(() => void 0), catchError(this.handleError));
  }

  test(id: string, inputs: Record<string, unknown>): Observable<DataFunctionTestResult> {
    return this.http
      .post<BaseResponse<DataFunctionTestResult>>(ENDPOINTS.dataFunctions.test(id), { inputs })
      .pipe(map(res => res.data!), catchError(this.handleError));
  }

  private handleError(error: HttpErrorResponse): Observable<never> {
    const message = error.error?.message || error.message || 'Unexpected error';
    return throwError(() => message);
  }
}
