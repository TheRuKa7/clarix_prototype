import { inject } from '@angular/core';
import { ActivatedRouteSnapshot, CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs/operators';
import { ToastService } from '../../notifications/toast.service';
import { PermissionsService } from '../services/permissions.service';

/**
 * Route guard factory. The route is allowed if the user has at least one of the listed
 * permission keys. Otherwise redirects to the dashboard and surfaces an error toast.
 *
 *   canActivate: [permissionGuard('permissions:add')]
 *   canActivate: [permissionGuard('permissions:read', 'modules:read')]
 */
export const permissionGuard = (...keys: string[]): CanActivateFn => (route: ActivatedRouteSnapshot) => {
  const permissions = inject(PermissionsService);
  const router = inject(Router);
  const toast = inject(ToastService);

  return permissions.ensureLoaded().pipe(
    map(() => {
      if (permissions.hasAny(...keys)) return true;
      const pageTitle = typeof route.title === 'string' ? route.title : null;
      const label = pageTitle ?? route.routeConfig?.title ?? 'this page';
      toast.error(`You don't have permission to access ${label}.`);
      // Direct URL entry / refresh: no prior in-app navigation -> send to dashboard.
      // Otherwise: cancel the navigation and leave the user on their current page.
      return router.navigated ? false : router.createUrlTree(['/dashboard/overview']);
    })
  );
};
