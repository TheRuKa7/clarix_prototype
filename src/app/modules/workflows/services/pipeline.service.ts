import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ENDPOINTS } from '../../../enpoints.service';
import { BaseResponse } from '../models/workflow-template.model';
import { PipelineRun, PipelineSpec, PipelineSummary } from '../models/pipeline.model';

@Injectable({ providedIn: 'root' })
export class PipelineService {
  private readonly http = inject(HttpClient);

  list(): Observable<PipelineSummary[]> {
    return this.http.get<BaseResponse<PipelineSummary[]>>(ENDPOINTS.pipelines.list).pipe(map((res) => res.data ?? []));
  }
  get(id: string): Observable<PipelineSpec> {
    return this.http.get<BaseResponse<PipelineSpec>>(ENDPOINTS.pipelines.one(id)).pipe(map((res) => res.data as PipelineSpec));
  }
  save(spec: PipelineSpec): Observable<PipelineSpec> {
    return this.http.put<BaseResponse<PipelineSpec>>(ENDPOINTS.pipelines.one(spec.id), spec).pipe(map((res) => res.data as PipelineSpec));
  }
  /** Runs the given spec (saved or not) over the pipeline's source; with results, also fakes the call answers and writes them back. */
  run(id: string, spec: PipelineSpec | null, results: boolean): Observable<PipelineRun> {
    return this.http.post<BaseResponse<PipelineRun>>(ENDPOINTS.pipelines.run(id), { spec, results }).pipe(map((res) => res.data as PipelineRun));
  }
  useFile(id: string, file: File): Observable<PipelineSummary> {
    const form = new FormData(); form.append('file', file);
    return this.http.post<BaseResponse<PipelineSummary>>(ENDPOINTS.pipelines.source(id), form).pipe(map((res) => res.data as PipelineSummary));
  }
  useSample(id: string): Observable<PipelineSummary> {
    return this.http.delete<BaseResponse<PipelineSummary>>(ENDPOINTS.pipelines.source(id)).pipe(map((res) => res.data as PipelineSummary));
  }
}
