import {
  MicrosoftLoginProvider,
  SOCIAL_AUTH_CONFIG,
  SocialAuthServiceConfig,
  SocialLoginModule
} from '@abacritt/angularx-social-login';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, importProvidersFrom, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withHashLocation, withViewTransitions } from '@angular/router';
import {
  AlertCircle,
  AlertTriangle,
  BarChart2,
  BarChart3,
  CheckCircle,
  CheckCircle2,
  CheckSquare,
  Edit2,
  Edit3,
  FileJson,
  HelpCircle,
  Layout,
  Loader2,
  LucideAngularModule,
  LucideIconConfig,
  MoreHorizontal,
  MoreVertical,
  PauseCircle,
  PlayCircle,
  UploadCloud,
  XCircle,
  icons
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { environment } from '../environments/environment';
import { routes } from './app.routes';
import { AuthService } from './core/auth/services/auth.service';
import { PermissionsService } from './core/permissions/services/permissions.service';
import { authInterceptor } from './interceptors/auth.interceptor';

/** Set by the single file build (mock/browser/build-single.mjs) before the app starts. */
const SINGLE_FILE = !!(globalThis as any).__SINGLE_FILE__;

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // One icon weight everywhere, matching Echo.
    provideAppInitializer(() => { inject(LucideIconConfig).strokeWidth = 1.75; }),
    // From a file on disk only # addresses work; on a web server the normal addresses stay.
    provideRouter(routes, withViewTransitions(), ...(SINGLE_FILE ? [withHashLocation()] : [])),
    // The in page mock answers fetch calls, so the single file build sends requests with fetch.
    provideHttpClient(withInterceptors([authInterceptor]), ...(SINGLE_FILE ? [withFetch()] : [])),
    importProvidersFrom(SocialLoginModule),
    {
      provide: SOCIAL_AUTH_CONFIG,
      useValue: {
        autoLogin: !environment.demo,
        // The public demo has no Microsoft app: it signs in with a local demo session (AuthService).
        providers: environment.demo ? [] : [
          {
            id: MicrosoftLoginProvider.PROVIDER_ID,
            provider: new MicrosoftLoginProvider(
              environment.microsoft.KEY,
              {
                authority: environment.microsoft.authorityUrl,
                redirect_uri: window.location.origin,
                logout_redirect_uri: window.location.origin,
                scopes: ['user.read'],
                cacheLocation: 'sessionStorage'
              }
            )
          }
        ],
        onError: (err: unknown) => console.error(err)
      } as SocialAuthServiceConfig
    },
    importProvidersFrom(
      LucideAngularModule.pick({
        ...icons,
        AlertCircle,
        AlertTriangle,
        BarChart2,
        BarChart3,
        CheckCircle,
        CheckCircle2,
        CheckSquare,
        Edit2,
        Edit3,
        FileJson,
        HelpCircle,
        Layout,
        Loader2,
        MoreHorizontal,
        MoreVertical,
        PauseCircle,
        PlayCircle,
        UploadCloud,
        XCircle
      })
    ),
    provideAppInitializer(async () => {
      const authService = inject(AuthService);
      const permissionsService = inject(PermissionsService);
      await authService.initialize();
      // Restored session → token is available, pull effective permissions before
      // the app renders so guards and menus evaluate against the real set.
      if (authService.isAuthenticated()) {
        await firstValueFrom(permissionsService.ensureLoaded());
      }
    })
  ]
};
