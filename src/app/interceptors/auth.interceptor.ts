import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AuthService } from '../core/auth/services/auth.service';
import { environment } from '../../environments/environment';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  const isExternal =
    req.url.includes('login.microsoftonline.com') || req.url.includes('graph.microsoft.com');

  if (isExternal || !authService.isAuthenticated()) {
    return next(req);
  }

  const token = authService.getToken();
  const isGenbi = req.url.includes(environment.backendServices.genbi.baseURL + environment.genbiApi.baseUrl);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (!isGenbi) {
    headers['countryId'] = '356';
  }
  const authedReq = token ? req.clone({ setHeaders: headers }) : req;

  return next(authedReq).pipe(
    catchError((error: HttpErrorResponse) => {
      if (error.status === 401) {
        const currentUrl = router.url;
        if (currentUrl && currentUrl !== '/login') {
          sessionStorage.setItem('expectedURL', currentUrl);
        }
        authService.logout();
      }
      return throwError(() => error);
    })
  );
};
