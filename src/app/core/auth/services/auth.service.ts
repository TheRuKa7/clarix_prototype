import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SocialAuthService, SocialUser, MicrosoftLoginProvider } from '@abacritt/angularx-social-login';
import { firstValueFrom } from 'rxjs';
import { PermissionsService } from '../../permissions/services/permissions.service';
import { IndexedDbRepository } from '../../repository/indexed-db.repository';
import { CasApiService } from './cas-api.service';
import { AuthState, AuthUser, AuthTokens, PersistedAuthSession } from '../models/auth-state.model';
import { environment } from '../../../../environments/environment';

const DB_NAME = 'clarix-db';
const AUTH_STORE = 'auth';
const SESSION_KEY = 'session';
const INITIAL_AUTH_STATE = {
  isAuthenticated: false,
  user: null,
  tokens: null,
  loading: false,
  error: null
};


@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly socialAuthService = inject(SocialAuthService);
  private readonly casApiService = inject(CasApiService);
  private readonly router = inject(Router);
  private readonly permissionsService = inject(PermissionsService);
  private readonly sessionRepo = new IndexedDbRepository<PersistedAuthSession>(DB_NAME, AUTH_STORE);
  readonly authState = signal<AuthState>(INITIAL_AUTH_STATE);
  readonly initialized = signal(false);

  constructor() {
    console.log("auth service instance")
  }

  public async initialize(): Promise<boolean> {
    if (!(await this.tryRestoreSession()) && environment.demo) await this.demoSession();
    this.initialized.set(true);
    return firstValueFrom(this.socialAuthService.initState);
  }

  private async tryRestoreSession(): Promise<boolean> {
    try {
      const session = await this.sessionRepo.findById(SESSION_KEY);
      if (session && session.tokens.expiresAt > Date.now()) {
        this.authState.set({
          isAuthenticated: true,
          user: session.user,
          tokens: session.tokens,
          loading: false,
          error: null
        });
        return true;
      }
    } catch {
      // IndexedDB unavailable — proceed without restore
    }
    return false;
  }

  private getTokenExpiry(token: string): number {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.exp * 1000;
    } catch {
      return Date.now() + 8 * 60 * 60 * 1000;
    }
  }

  private async verifyWithCas(socialUser: SocialUser): Promise<void> {
    const idToken = socialUser.authToken ?? '';

    const casResponse = await firstValueFrom(
      this.casApiService.verify({
        email: socialUser.email ?? '',
        idToken,
        provider: 'MICROSOFT'
      })
    );

    const { token, email, countryResponseSet, roles } = casResponse.data;

    const tokens: AuthTokens = {
      microsoftToken: idToken,
      casToken: token,
      expiresAt: this.getTokenExpiry(token)
    };

    const user: AuthUser = {
      userId: email,
      microsoftId: socialUser.id ?? '',
      email: email || socialUser.email || '',
      name: socialUser.name || '',
      displayName: socialUser.name || '',
      photoUrl: socialUser.photoUrl ?? null,
      roles: roles ?? [],
      permissions: [],
      countries: countryResponseSet ?? []
    };

    this.authState.set({
      isAuthenticated: true,
      user,
      tokens,
      loading: false,
      error: null
    });

    await this.sessionRepo.save(SESSION_KEY, { user, tokens, savedAt: Date.now() });
  }

  private clearState(): void {
    this.authState.set({
      isAuthenticated: false,
      user: null,
      tokens: null,
      loading: false,
      error: null
    });
  }

  /** Demo build only: a local session with sample data, no Microsoft sign in. */
  private async demoSession(): Promise<void> {
    const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const expiresAt = Date.now() + 30 * 86400000;
    const email = 'demo@example.com';
    const user: AuthUser = {
      userId: email, microsoftId: 'demo', email, name: 'Demo Admin', displayName: 'Demo Admin', photoUrl: null, roles: ['ADMIN'], permissions: [],
      countries: [{ idCountry: 356, name: 'India', countryCode: 91, idSubsidiary: 1, subsidiary: 'Demo', idCurrency: 1, currency: 'INR', idTaxType: 1, taxType: 'GST' }] as AuthUser['countries'],
    };
    const tokens: AuthTokens = { microsoftToken: 'demo', casToken: `${b64({ alg: 'none' })}.${b64({ sub: email, exp: Math.floor(expiresAt / 1000) })}.demo`, expiresAt };
    this.authState.set({ isAuthenticated: true, user, tokens, loading: false, error: null });
    await this.sessionRepo.save(SESSION_KEY, { user, tokens, savedAt: Date.now() }).catch(() => { });
  }

  async login(): Promise<void> {
    if (environment.demo) {
      await this.demoSession();
      this.router.navigate(['/dashboard/overview']);
      return;
    }
    this.authState.update(s => ({ ...s, loading: true, error: null }));
    try {
      const socialUser = await this.socialAuthService.signIn(MicrosoftLoginProvider.PROVIDER_ID);
      await this.verifyWithCas(socialUser);
      this.permissionsService.refresh().subscribe();
      const redirectUrl = sessionStorage.getItem('expectedURL') ?? '/dashboard/overview';
      sessionStorage.removeItem('expectedURL');
      this.router.navigate([redirectUrl]);
    } catch (error) {
      this.authState.update(s => ({
        ...s,
        loading: false,
        error: error instanceof Error ? error.message : 'Authentication failed'
      }));
    }
  }

  async logout(): Promise<void> {
    await this.sessionRepo.clear().catch(() => { });
    this.permissionsService.clear();
    this.clearState();
    this.router.navigate(['/login']);
  }

  getToken(): string | null {
    return this.authState().tokens?.casToken ?? null;
  }

  isAuthenticated(): boolean {
    return this.authState().isAuthenticated;
  }

  getCurrentUser(): AuthUser | null {
    return this.authState().user;
  }
}
