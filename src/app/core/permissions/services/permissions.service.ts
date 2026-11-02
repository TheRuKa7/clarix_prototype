import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map, shareReplay, tap } from 'rxjs/operators';
import { ENDPOINTS } from '../../../enpoints.service';

interface BaseResponse<T> {
  status: boolean;
  message: string;
  data: T;
}

@Injectable({ providedIn: 'root' })
export class PermissionsService {
  private readonly http = inject(HttpClient);

  private readonly permissionsSet = signal<ReadonlySet<string>>(new Set());
  private readonly loaded = signal(false);

  /** All permission keys the current user has, exposed for diagnostics / debug pages. */
  readonly permissions = computed(() => Array.from(this.permissionsSet()).sort());

  private inflight$: Observable<ReadonlySet<string>> | null = null;

  ensureLoaded(): Observable<ReadonlySet<string>> {
    if (this.loaded()) return of(this.permissionsSet());
    if (this.inflight$) return this.inflight$;
    this.inflight$ = this.fetch(ENDPOINTS.auth.myPermissions, 'get').pipe(shareReplay(1));
    return this.inflight$;
  }

  /** Force re-fetch (after admin saves a module change, after login, etc.) */
  refresh(): Observable<ReadonlySet<string>> {
    this.inflight$ = this.fetch(ENDPOINTS.auth.refreshPermissions, 'post').pipe(shareReplay(1));
    return this.inflight$;
  }

  /** Wipe permissions on logout. */
  clear(): void {
    this.permissionsSet.set(new Set());
    this.loaded.set(false);
    this.inflight$ = null;
  }

  /** Truthy if the user has the given permission key. Reads from a signal so templates auto-track. */
  has(key: string): boolean {
    return this.permissionsSet().has(key);
  }

  /** Truthy if the user has at least one of the given keys. */
  hasAny(...keys: string[]): boolean {
    if (keys.length === 0) return true;
    const set = this.permissionsSet();
    console.log(this.permissions())
    return keys.some(k => set.has(k));
  }

  private fetch(url: string, verb: 'get' | 'post'): Observable<ReadonlySet<string>> {
    const req$ = verb === 'get'
      ? this.http.get<BaseResponse<string[]>>(url)
      : this.http.post<BaseResponse<string[]>>(url, null);
    return req$.pipe(
      map(res => new Set(res?.data ?? [])),
      tap(set => {
        this.permissionsSet.set(set);
        this.loaded.set(true);
        this.inflight$ = null;
      }),
      catchError(() => {
        this.permissionsSet.set(new Set());
        this.loaded.set(true);
        this.inflight$ = null;
        return of<ReadonlySet<string>>(new Set());
      })
    );
  }
}
