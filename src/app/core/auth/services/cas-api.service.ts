import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { CasVerifyRequest, CasVerifyResponse } from '../models/cas-response.model';
import { ENDPOINTS } from '../../../enpoints.service';

@Injectable({ providedIn: 'root' })
export class CasApiService {
  private readonly http = inject(HttpClient);

  verify(request: CasVerifyRequest): Observable<CasVerifyResponse> {
    return this.http.post<CasVerifyResponse>(
      ENDPOINTS.financeap.login,
      request
    );
  }
}
