'use client';

const ACCESS_KEY = 'didacta.access_token';
const REFRESH_KEY = 'didacta.refresh_token';
const SESSION_KEY = 'didacta.session';

export interface StoredSession {
  user: {
    id: string;
    email: string;
    name: string | null;
    tenantId: string;
    tenantSlug: string;
    roles: string[];
    mfaEnabled: boolean;
  };
  mfaRequired: boolean;
}

export const authStorage = {
  saveTokens(access: string, refresh: string) {
    if (typeof window === 'undefined') return;
    sessionStorage.setItem(ACCESS_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
  },
  getAccessToken(): string | null {
    if (typeof window === 'undefined') return null;
    return sessionStorage.getItem(ACCESS_KEY);
  },
  getRefreshToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(REFRESH_KEY);
  },
  saveSession(session: StoredSession) {
    if (typeof window === 'undefined') return;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  },
  getSession(): StoredSession | null {
    if (typeof window === 'undefined') return null;
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredSession;
    } catch {
      return null;
    }
  },
  clear() {
    if (typeof window === 'undefined') return;
    sessionStorage.removeItem(ACCESS_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};
