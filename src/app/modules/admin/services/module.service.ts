import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { ENDPOINTS } from '../../../enpoints.service';
import { BaseResponse, ModuleEntity, ModuleRequest } from '../models/permission.model';

@Injectable({ providedIn: 'root' })
export class ModuleApiService {
  private readonly http = inject(HttpClient);

  list(opts: { page?: number; size?: number; search?: string } = {}):
    Observable<{ items: ModuleEntity[]; total: number }> {
    let params = new HttpParams()
      .set('page', opts.page ?? 0)
      .set('size', opts.size ?? 50);
    if (opts.search?.trim()) params = params.set('search', opts.search.trim());

    return this.http
      .get<BaseResponse<ModuleEntity[]>>(ENDPOINTS.adminModules.list, { params })
      .pipe(
        map(res => ({ items: res.data ?? [], total: res.totalElements ?? 0 })),
        catchError(this.handleError)
      );
  }

  create(req: ModuleRequest): Observable<ModuleEntity> {
    return this.http
      .post<BaseResponse<ModuleEntity>>(ENDPOINTS.adminModules.create, req)
      .pipe(map(res => res.data!), catchError(this.handleError));
  }

  update(id: string, req: ModuleRequest): Observable<ModuleEntity> {
    return this.http
      .put<BaseResponse<ModuleEntity>>(ENDPOINTS.adminModules.update(id), req)
      .pipe(map(res => res.data!), catchError(this.handleError));
  }

  setEnabled(id: string, enabled: boolean): Observable<ModuleEntity> {
    const params = new HttpParams().set('enabled', enabled);
    return this.http
      .patch<BaseResponse<ModuleEntity>>(ENDPOINTS.adminModules.setEnabled(id), null, { params })
      .pipe(map(res => res.data!), catchError(this.handleError));
  }

  delete(id: string): Observable<void> {
    return this.http
      .delete<BaseResponse<void>>(ENDPOINTS.adminModules.delete(id))
      .pipe(map(() => void 0), catchError(this.handleError));
  }

  private handleError(error: HttpErrorResponse): Observable<never> {
    const message = error.error?.message || error.message || 'Unexpected error';
    return throwError(() => message);
  }
}
