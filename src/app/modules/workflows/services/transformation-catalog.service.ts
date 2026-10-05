import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ENDPOINTS } from '../../../enpoints.service';
import { BaseResponse } from '../models/workflow-template.model';
import { TransformationCatalogEntry } from '../models/transformation-catalog.model';

@Injectable({ providedIn: 'root' })
export class TransformationCatalogService {
  private readonly http = inject(HttpClient);

  list(): Observable<TransformationCatalogEntry[]> {
    return this.http
      .get<BaseResponse<TransformationCatalogEntry[]>>(ENDPOINTS.transformationCatalog.list)
      .pipe(map((res) => res.data ?? []));
  }
}
