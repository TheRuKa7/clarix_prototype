import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ENDPOINTS } from '../../../enpoints.service';
import { BaseResponse } from '../models/workflow-template.model';
import { OrchestrationDefinition, OrchestrationDefinitionRequest, OrchestrationPreview, SampleDetail, SampleFile } from '../models/orchestration.model';

@Injectable({ providedIn: 'root' })
export class OrchestrationService {
  private readonly http = inject(HttpClient);

  list(): Observable<OrchestrationDefinition[]> {
    return this.http.get<BaseResponse<OrchestrationDefinition[]>>(ENDPOINTS.orchestration.list).pipe(map((res) => res.data ?? []));
  }
  create(request: OrchestrationDefinitionRequest): Observable<OrchestrationDefinition> {
    return this.http.post<BaseResponse<OrchestrationDefinition>>(ENDPOINTS.orchestration.create, request).pipe(map((res) => res.data as OrchestrationDefinition));
  }
  update(id: string, request: OrchestrationDefinitionRequest): Observable<OrchestrationDefinition> {
    return this.http.put<BaseResponse<OrchestrationDefinition>>(ENDPOINTS.orchestration.update(id), request).pipe(map((res) => res.data as OrchestrationDefinition));
  }
  delete(id: string): Observable<void> {
    return this.http.delete<BaseResponse<void>>(ENDPOINTS.orchestration.delete(id)).pipe(map(() => undefined));
  }

  /** Files to build rules against: recent uploads and any file uploaded on this page. */
  samples(): Observable<SampleFile[]> {
    return this.http.get<BaseResponse<SampleFile[]>>(ENDPOINTS.orchestration.samples).pipe(map((res) => res.data ?? []));
  }
  sample(id: string): Observable<SampleDetail> {
    return this.http.get<BaseResponse<SampleDetail>>(ENDPOINTS.orchestration.sample(id)).pipe(map((res) => res.data as SampleDetail));
  }
  uploadSample(file: File): Observable<SampleDetail> {
    const form = new FormData(); form.append('file', file);
    return this.http.post<BaseResponse<SampleDetail>>(ENDPOINTS.orchestration.samples, form).pipe(map((res) => res.data as SampleDetail));
  }
  /** Runs the routes, saved or not, over the whole file: rows per route, rows left over, and what each agent is missing. */
  preview(sampleId: string, definition: OrchestrationDefinitionRequest): Observable<OrchestrationPreview> {
    return this.http.post<BaseResponse<OrchestrationPreview>>(ENDPOINTS.orchestration.previewFile, { sampleId, definition }).pipe(map((res) => res.data as OrchestrationPreview));
  }
}
