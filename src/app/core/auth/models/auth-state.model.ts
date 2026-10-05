import { CountryInfo } from './cas-response.model';

export interface AuthUser {
  userId: string;
  microsoftId: string;
  email: string;
  name: string;
  displayName: string;
  photoUrl: string | null;
  roles: string[];
  permissions: string[];
  countries: CountryInfo[];
}

export interface AuthTokens {
  microsoftToken: string;
  casToken: string;
  expiresAt: number;
}

export interface AuthState {
  isAuthenticated: boolean;
  user: AuthUser | null;
  tokens: AuthTokens | null;
  loading: boolean;
  error: string | null;
}

export interface PersistedAuthSession {
  user: AuthUser;
  tokens: AuthTokens;
  savedAt: number;
}
