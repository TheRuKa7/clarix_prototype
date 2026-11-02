import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { ENDPOINTS } from '../../../enpoints.service';
import { BaseResponse, Permission, PermissionRequest } from '../models/permission.model';

@Injectable({ providedIn: 'root' })
export class PermissionApiService {
  private readonly http = inject(HttpClient);

  list(opts: { page?: number; size?: number; search?: string; category?: string } = {}):
    Observable<{ items: Permission[]; total: number }> {
    let params = new HttpParams()
      .set('page', opts.page ?? 0)
      .set('size', opts.size ?? 50);
    if (opts.search?.trim()) params = params.set('search', opts.search.trim());
    if (opts.category?.trim()) params = params.set('category', opts.category.trim());

    return this.http
      .get<BaseResponse<Permission[]>>(ENDPOINTS.adminPermissions.list, { params })
      .pipe(
        map(res => ({ items: res.data ?? [], total: res.totalElements ?? 0 })),
        catchError(this.handleError)
      );
  }

  create(req: PermissionRequest): Observable<Permission> {
    return this.http
      .post<BaseResponse<Permission>>(ENDPOINTS.adminPermissions.create, req)
      .pipe(map(res => res.data!), catchError(this.handleError));
  }

  update(id: string, req: PermissionRequest): Observable<Permission> {
    return this.http
      .put<BaseResponse<Permission>>(ENDPOINTS.adminPermissions.update(id), req)
      .pipe(map(res => res.data!), catchError(this.handleError));
  }

  delete(id: string): Observable<void> {
    return this.http
      .delete<BaseResponse<void>>(ENDPOINTS.adminPermissions.delete(id))
      .pipe(map(() => void 0), catchError(this.handleError));
  }

  listCategories(): Observable<string[]> {
    return this.http
      .get<BaseResponse<string[]>>(ENDPOINTS.adminPermissions.categories)
      .pipe(map(res => res.data ?? []), catchError(this.handleError));
  }

  private handleError(error: HttpErrorResponse): Observable<never> {
    const message = error.error?.message || error.message || 'Unexpected error';
    return throwError(() => message);
  }
}
