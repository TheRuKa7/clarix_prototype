import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, switchMap, catchError } from 'rxjs';

/** Graph app id and URL; a token for anything else is refused with 401. */
const GRAPH_AUDIENCES = ['00000003-0000-0000-c000-000000000000', 'https://graph.microsoft.com'];
const PHOTO_SCOPES = ['User.Read', 'User.ReadBasic.All', 'User.Read.All'];

@Injectable({ providedIn: 'root' })
export class MicrosoftGraphService {
  private readonly http = inject(HttpClient);
  /** Tokens Graph already refused, so a bad token is never retried on every page. */
  private readonly refused = new Set<string>();

  /** True only for a Graph token that carries a scope allowed to read the profile photo. */
  canReadPhoto(accessToken: string): boolean {
    try {
      const payload = JSON.parse(atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      const scopes = String(payload.scp || '').split(' ');
      const notExpired = !payload.exp || payload.exp * 1000 > Date.now();
      return GRAPH_AUDIENCES.includes(payload.aud) && notExpired && scopes.some((s) => PHOTO_SCOPES.includes(s));
    } catch {
      return false;
    }
  }

  getProfilePhotoUrl(accessToken: string): Observable<string | null> {
    if (this.refused.has(accessToken) || !this.canReadPhoto(accessToken)) return of(null);
    return this.http.get('https://graph.microsoft.com/v1.0/me/photos/48x48/$value', {
      headers: { Authorization: `Bearer ${accessToken}` },
      responseType: 'blob'
    }).pipe(
      switchMap(blob => new Observable<string>(observer => {
        const reader = new FileReader();
        reader.onload = () => { observer.next(reader.result as string); observer.complete(); };
        reader.onerror = () => observer.error(reader.error);
        reader.readAsDataURL(blob);
      })),
      catchError(() => { this.refused.add(accessToken); return of(null); })
    );
  }
}
