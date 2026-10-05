import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ENDPOINTS } from '../../../enpoints.service';
import { BaseResponse } from '../models/workflow-template.model';
import {
  LanePreviewResult,
  OrchestrationDefinition,
  OrchestrationDefinitionRequest,
} from '../models/orchestration.model';

@Injectable({ providedIn: 'root' })
export class OrchestrationService {
  private readonly http = inject(HttpClient);

  list(): Observable<OrchestrationDefinition[]> {
    return this.http
      .get<BaseResponse<OrchestrationDefinition[]>>(ENDPOINTS.orchestration.list)
      .pipe(map((res) => res.data ?? []));
  }

  getById(id: string): Observable<OrchestrationDefinition> {
    return this.http
      .get<BaseResponse<OrchestrationDefinition>>(ENDPOINTS.orchestration.getById(id))
      .pipe(map((res) => res.data as OrchestrationDefinition));
  }

  create(request: OrchestrationDefinitionRequest): Observable<OrchestrationDefinition> {
    return this.http
      .post<BaseResponse<OrchestrationDefinition>>(ENDPOINTS.orchestration.create, request)
      .pipe(map((res) => res.data as OrchestrationDefinition));
  }

  update(id: string, request: OrchestrationDefinitionRequest): Observable<OrchestrationDefinition> {
    return this.http
      .put<BaseResponse<OrchestrationDefinition>>(ENDPOINTS.orchestration.update(id), request)
      .pipe(map((res) => res.data as OrchestrationDefinition));
  }

  delete(id: string): Observable<void> {
    return this.http.delete<BaseResponse<void>>(ENDPOINTS.orchestration.delete(id)).pipe(map(() => undefined));
  }

  preview(id: string, csvHeaders: string[]): Observable<LanePreviewResult[]> {
    return this.http
      .post<BaseResponse<LanePreviewResult[]>>(ENDPOINTS.orchestration.preview(id), { csvHeaders })
      .pipe(map((res) => res.data ?? []));
  }
}
