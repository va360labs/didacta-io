'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

const ACCESS_KEY = 'didacta.access_token';
const REFRESH_KEY = 'didacta.refresh_token';
const SESSION_KEY = 'didacta.session';

export interface StoredSession {
  user: {
    id: string;
    email: string;
    name: string | null;
    /** URL del avatar (https o ruta relativa de storage), o null. Se refresca
     * tras editar el perfil/onboarding y en cada login. */
    avatarUrl?: string | null;
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
    /**
     * ISO de cuándo completó el onboarding de primera vez, o `null` si aún no.
     * El shell autenticado fuerza `/onboarding` mientras sea `null`. Opcional
     * (`undefined`) para sesiones guardadas antes de introducir el flag — en
     * ese caso NO se gatea (se asume completado) hasta el próximo login.
     */
    onboardingCompletedAt?: string | null;
  };
  mfaRequired: boolean;
}

/**
 * Persistencia de sesión.
 *
 * Por defecto (login con "Mantener la sesión abierta" marcado, que es el estado
 * inicial del checkbox) access token, refresh token y sesión viven en
 * `localStorage`: la sesión sobrevive al cierre de la pestaña y se comparta
 * entre pestañas. Antes el access token y la sesión estaban SIEMPRE en
 * `sessionStorage`, lo que provocaba que se "perdiera la sesión" (token null →
 * "Sesión expirada") al abrir una pestaña nueva.
 *
 * Si el usuario DESMARCA el checkbox, los tres valores van a `sessionStorage`:
 * al cerrar la pestaña se pierden y hay que volver a entrar. Es el
 * comportamiento que promete el texto — un equipo compartido no quiere dejar la
 * sesión abierta. Todas las lecturas miran los dos almacenes (localStorage
 * primero), así que el resto de la app no distingue entre ambos modos.
 *
 * La renovación automática del access token (1h) con el refresh token (30d) la
 * maneja `apiFetch` ante un 401, escribiendo en el mismo almacén que se usó al
 * entrar (ver `writeToken` en api-client.ts).
 */

/**
 * Almacén donde debe escribirse la sesión.
 *
 * `remember` sin valor significa "sigue donde ya estaba": lo usan los pasos
 * POSTERIORES al login (verificación MFA, onboarding, edición de perfil), que
 * no vuelven a preguntar por el checkbox. Sin esta regla, un usuario que entró
 * SIN "mantener la sesión abierta" acabaría con la sesión en localStorage en
 * cuanto pasara por el segundo factor — justo lo que pidió evitar.
 */
function targetStore(remember?: boolean): Storage {
  if (remember === true) return localStorage;
  if (remember === false) return sessionStorage;
  const inSession =
    sessionStorage.getItem(REFRESH_KEY) !== null || sessionStorage.getItem(SESSION_KEY) !== null;
  const inLocal =
    localStorage.getItem(REFRESH_KEY) !== null || localStorage.getItem(SESSION_KEY) !== null;
  return inSession && !inLocal ? sessionStorage : localStorage;
}

export const authStorage = {
  /**
   * @param remember `true` → localStorage; `false` → sessionStorage (la sesión
   * muere al cerrar la pestaña); sin valor → el almacén que ya estuviera en uso.
   */
  saveTokens(access: string, refresh: string, remember?: boolean) {
    if (typeof window === 'undefined') return;
    const target = targetStore(remember);
    const other = target === localStorage ? sessionStorage : localStorage;
    target.setItem(ACCESS_KEY, access);
    target.setItem(REFRESH_KEY, refresh);
    // Nunca dejar copias en el otro almacén: si quedaran, la lectura
    // (localStorage primero) podría devolver el token de un login anterior.
    other.removeItem(ACCESS_KEY);
    other.removeItem(REFRESH_KEY);
  },
  getAccessToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(ACCESS_KEY) ?? sessionStorage.getItem(ACCESS_KEY);
  },
  getRefreshToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(REFRESH_KEY) ?? sessionStorage.getItem(REFRESH_KEY);
  },
  /** Mismo criterio de almacén que `saveTokens`. */
  saveSession(session: StoredSession, remember?: boolean) {
    if (typeof window === 'undefined') return;
    const target = targetStore(remember);
    const other = target === localStorage ? sessionStorage : localStorage;
    target.setItem(SESSION_KEY, JSON.stringify(session));
    other.removeItem(SESSION_KEY);
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
    sessionStorage.removeItem(REFRESH_KEY);
    sessionStorage.removeItem(SESSION_KEY);
  },
};
