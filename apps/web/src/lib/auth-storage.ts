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
    /**
     * True si la contraseña es temporal (ej. usuario creado por la inscripción
     * externa `POST /inscribe`). El shell autenticado fuerza el cambio antes de
     * dejar usar el resto de la app. Opcional para compat con sesiones guardadas
     * antes de introducir el flag.
     */
    mustChangePassword?: boolean;
  };
  mfaRequired: boolean;
}

/**
 * Persistencia de sesión.
 *
 * Access token, refresh token y sesión viven en `localStorage` para que la
 * sesión sobreviva al cierre de pestaña y se comparta entre pestañas. Antes el
 * access token y la sesión estaban en `sessionStorage`, lo que provocaba que se
 * "perdiera la sesión" (token null → "Sesión expirada") al abrir una pestaña
 * nueva o tras ciertos eventos. La renovación automática del access token (1h)
 * con el refresh token (30d) la maneja `apiFetch` ante un 401.
 */
export const authStorage = {
  saveTokens(access: string, refresh: string) {
    if (typeof window === 'undefined') return;
    localStorage.setItem(ACCESS_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
    // Limpia restos del esquema anterior (access/session en sessionStorage).
    sessionStorage.removeItem(ACCESS_KEY);
    sessionStorage.removeItem(SESSION_KEY);
  },
  getAccessToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(ACCESS_KEY) ?? sessionStorage.getItem(ACCESS_KEY);
  },
  getRefreshToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(REFRESH_KEY);
  },
  saveSession(session: StoredSession) {
    if (typeof window === 'undefined') return;
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    sessionStorage.removeItem(SESSION_KEY);
  },
  getSession(): StoredSession | null {
    if (typeof window === 'undefined') return null;
    const raw = localStorage.getItem(SESSION_KEY) ?? sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredSession;
    } catch {
      return null;
    }
  },
  clear() {
    if (typeof window === 'undefined') return;
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(ACCESS_KEY);
    sessionStorage.removeItem(SESSION_KEY);
  },
};
