import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { ENDPOINTS } from '../../../enpoints.service';
import {
  BaseResponse,
  CallProvider,
  ExchangeCampaignDetail,
  ExchangeCampaignSummary,
} from '../models/workflow-template.model';

/** Lists the call providers configured on the backend — feeds the template editor's dropdown. */
@Injectable({ providedIn: 'root' })
export class CallProviderService {
  private readonly http = inject(HttpClient);

  list(): Observable<CallProvider[]> {
    return this.http.get<BaseResponse<CallProvider[]>>(ENDPOINTS.callProviders.list).pipe(
      map((res) => res.data ?? []),
      // A template editor without this endpoint reachable still works — it just falls back to
      // the always-present "voxera" default rather than blocking the form.
      catchError(() => of<CallProvider[]>([]))
    );
  }

  /**
   * Campaign catalog for providers that organize calls under vendor-managed campaigns (Exchange).
   * Resolves to an empty list for a provider that doesn't support it (e.g. Voxera — the backend
   * 404s) rather than surfacing an error, so callers can render "no campaigns" instead of failing.
   */
  listCampaigns(providerKey: string, since?: string): Observable<ExchangeCampaignSummary[]> {
    const params = since ? new HttpParams().set('since', since) : undefined;
    return this.http
      .get<BaseResponse<ExchangeCampaignSummary[]>>(ENDPOINTS.callProviders.campaigns(providerKey), { params })
      .pipe(
        map((res) => res.data ?? []),
        catchError(() => of<ExchangeCampaignSummary[]>([]))
      );
  }

  getCampaign(providerKey: string, campaignId: string): Observable<ExchangeCampaignDetail | null> {
    return this.http
      .get<BaseResponse<ExchangeCampaignDetail>>(ENDPOINTS.callProviders.campaign(providerKey, campaignId))
      .pipe(
        map((res) => res.data ?? null),
        catchError(() => of(null))
      );
  }
}
