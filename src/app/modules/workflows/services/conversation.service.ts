import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { ENDPOINTS } from '../../../enpoints.service';
import { BaseResponse } from '../models/workflow-template.model';
import { ConversationDetail } from '../models/conversation.model';

@Injectable({ providedIn: 'root' })
export class ConversationService {
  private readonly http = inject(HttpClient);

  getById(conversationId: string): Observable<ConversationDetail> {
    return this.http
      .get<BaseResponse<ConversationDetail>>(ENDPOINTS.conversations.getById(conversationId))
      .pipe(
        map((res) => res.data as ConversationDetail),
        catchError(this.handleError)
      );
  }

  fetchTranscript(conversationId: string): Observable<string> {
    return this.http
      .get(ENDPOINTS.conversations.transcript(conversationId), { responseType: 'text' })
      .pipe(catchError(this.handleError));
  }

  fetchAudioBlob(conversationId: string): Observable<Blob> {
    return this.http
      .get(ENDPOINTS.conversations.audio(conversationId), { responseType: 'blob' })
      .pipe(catchError(this.handleError));
  }

  private handleError(error: HttpErrorResponse): Observable<never> {
    const message = error.error?.message ?? error.message ?? 'An unexpected error occurred';
    console.error('ConversationService error:', message);
    return throwError(() => message);
  }
}
