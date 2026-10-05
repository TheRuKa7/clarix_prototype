import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { ENDPOINTS } from '../../../enpoints.service';
import { BaseResponse } from '../models/workflow-template.model';
import { EmailSchedule, EmailScheduleRequest, UpcomingSend } from '../models/email-schedule.model';

@Injectable({ providedIn: 'root' })
export class EmailScheduleService {
  private readonly http = inject(HttpClient);

  create(reportId: string, req: EmailScheduleRequest): Observable<EmailSchedule> {
    return this.http
      .post<BaseResponse<EmailSchedule>>(ENDPOINTS.executionReports.schedules(reportId), req)
      .pipe(map((res) => res.data!), catchError(this.handleError));
  }

  update(reportId: string, scheduleId: string, req: EmailScheduleRequest): Observable<EmailSchedule> {
    return this.http
      .put<BaseResponse<EmailSchedule>>(ENDPOINTS.executionReports.schedule(reportId, scheduleId), req)
      .pipe(map((res) => res.data!), catchError(this.handleError));
  }

  setEnabled(reportId: string, scheduleId: string, enabled: boolean): Observable<EmailSchedule> {
    const params = new HttpParams().set('enabled', enabled);
    return this.http
      .patch<BaseResponse<EmailSchedule>>(
        ENDPOINTS.executionReports.scheduleEnabled(reportId, scheduleId),
        null,
        { params }
      )
      .pipe(map((res) => res.data!), catchError(this.handleError));
  }

  delete(reportId: string, scheduleId: string): Observable<void> {
    return this.http
      .delete<BaseResponse<void>>(ENDPOINTS.executionReports.schedule(reportId, scheduleId))
      .pipe(map(() => void 0), catchError(this.handleError));
  }

  runNow(reportId: string, scheduleId: string): Observable<void> {
    return this.http
      .post<BaseResponse<void>>(ENDPOINTS.executionReports.scheduleRunNow(reportId, scheduleId), null)
      .pipe(map(() => void 0), catchError(this.handleError));
  }

  upcoming(reportId: string, count = 10): Observable<UpcomingSend[]> {
    const params = new HttpParams().set('count', count);
    return this.http
      .get<BaseResponse<UpcomingSend[]>>(ENDPOINTS.executionReports.schedulesUpcoming(reportId), { params })
      .pipe(map((res) => res.data ?? []), catchError(this.handleError));
  }

  private handleError(error: HttpErrorResponse): Observable<never> {
    const message = error.error?.message || error.message || 'Unexpected error';
    return throwError(() => new Error(message));
  }
}
