/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Cliente HTTP mínimo.
 *
 * En el browser usamos same-origin (`API_URL = ''`): el frontend hace requests
 * al mismo dominio que lo sirve, y Next.js reescribe internamente `/api/*` a
 * la API en localhost:4000 (configurado en next.config.ts). Sin CORS, sin
 * mismatch de cookies, sin variables públicas que filtrar.
 *
 * En server-side (RSC, server actions) llamamos directo a la API por loopback.
 */

// Lib hoja sin dependencias — no acopla el cliente HTTP a nada más.
import { rememberIntendedPath } from './post-login-redirect';

const API_URL =
  typeof window === 'undefined' ? (process.env.API_INTERNAL_URL ?? 'http://localhost:4000') : '';

export interface ApiError {
  message: string;
  issues?: Array<{ path: string; message: string; code: string }>;
  status: number;
  /**
   * Código de error semántico que el backend opta por incluir en el body
   * cuando el cliente debe reaccionar a algo más concreto que un status.
   * Casos vivos:
   *   - 'mfa_required' (LMS-109): admin con sesión sin verificar MFA →
   *     el cliente redirige a /mfa/setup o /mfa/verify según mfaEnabled.
   *   - 'AMBIGUOUS_TENANT': signin con email en >1 tenant → mostrar selector.
   */
  code?: string;
  /**
   * Diagnóstico CRUDO de un sistema externo (el mensaje de Stripe al rechazar
   * una clave, el del MTA al rechazar un envío) que el backend manda como campo
   * APARTE del `message`.
   *
   * Existe porque `message` es una frase en español con el diagnóstico ya
   * incrustado: al traducir esa frase por `code`, el dato se perdía. Con el
   * campo separado, cada catálogo escribe su propia frase e interpola
   * `{detail}` (ver `CODES_WITH_DETAIL` en `lib/i18n/api-error.ts`).
   *
   * No es copy: nunca se traduce, viene tal cual del proveedor.
   */
  detail?: string;
  /**
   * Los MISMOS datos crudos que `detail`, pero CON NOMBRE, para los `message`
   * que interpolan dos o más valores con copy español entre medias
   * (`Provider ${provider} falló: ${reason}`).
   *
   * Con un `detail` único la frase inglesa heredaría el conector español
   * («The AI provider failed: openai *falló*: timeout»). Nombrados, cada
   * catálogo escribe su frase e interpola `{provider}` y `{reason}` donde su
   * gramática los pide (ver `CODES_WITH_PARAMS` en `lib/i18n/api-error.ts`).
   *
   * Tampoco es copy: los valores vienen tal cual del backend o del proveedor.
   * Un code usa `detail` o `params`, nunca los dos.
   */
  params?: Record<string, string>;
}

export class ApiHttpError extends Error implements ApiError {
  status: number;
  issues?: ApiError['issues'];
  code?: string;
  detail?: string;
  params?: Record<string, string>;
  constructor(payload: ApiError) {
    super(payload.message);
    this.status = payload.status;
    this.issues = payload.issues;
    this.code = payload.code;
    this.detail = payload.detail;
    this.params = payload.params;
    this.name = 'ApiHttpError';
  }
}

// Claves de almacenamiento (duplicadas de auth-storage.ts a propósito para no
// acoplar el cliente HTTP a ese módulo — ver nota en readStoredSessionSafe).
const ACCESS_KEY = 'didacta.access_token';
const REFRESH_KEY = 'didacta.refresh_token';
const SESSION_KEY = 'didacta.session';

/**
 * Promesa de refresco en vuelo, compartida entre todas las peticiones que
 * reciban 401 a la vez para no disparar N refrescos en paralelo.
 */
let refreshInFlight: Promise<string | null> | null = null;

/**
 * Los tokens viven en localStorage (login con "Mantener la sesión abierta") o
 * en sessionStorage (sin marcar) — ver `auth-storage.ts`. Toda lectura mira los
 * dos, localStorage primero.
 */
function readToken(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Escribe respetando el almacén donde ya vivía la sesión: si el usuario entró
 * sin "mantener la sesión abierta", el token renovado NO debe acabar en
 * localStorage (sobreviviría al cierre de la pestaña, justo lo contrario de lo
 * que pidió).
 */
function writeToken(key: string, value: string): void {
  try {
    const store = localStorage.getItem(REFRESH_KEY) !== null ? localStorage : sessionStorage;
    store.setItem(key, value);
  } catch {
    /* almacenamiento no disponible */
  }
}

function clearAuthAndRedirect(): void {
  try {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(ACCESS_KEY);
    sessionStorage.removeItem(REFRESH_KEY);
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* almacenamiento no disponible */
  }
  if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/signin')) {
    // Sesión expirada a mitad de navegación: recordamos dónde estaba el usuario
    // para devolverlo ahí tras re-autenticarse.
    rememberIntendedPath(window.location.pathname + window.location.search);
    window.location.assign('/signin');
  }
}

/**
 * Intenta renovar el access token con el refresh token guardado. Devuelve el
 * nuevo access token (y rota el refresh) o null si no hay refresh / falla.
 * Coalesce: varias llamadas concurrentes comparten el mismo refresco.
 */
async function refreshAccessToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const refreshToken = readToken(REFRESH_KEY);
      if (!refreshToken) return null;
      try {
        const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as {
          tokens?: { accessToken?: string; refreshToken?: string };
        };
        const newAccess = data.tokens?.accessToken;
        if (typeof newAccess !== 'string') return null;
        // El refresh se escribe DESPUÉS del access a propósito: `writeToken`
        // decide el almacén mirando dónde está el refresh actual, así que hay
        // que rotarlo al final para que ambas escrituras coincidan de almacén.
        writeToken(ACCESS_KEY, newAccess);
        if (typeof data.tokens?.refreshToken === 'string') {
          writeToken(REFRESH_KEY, data.tokens.refreshToken);
        }
        return newAccess;
      } catch {
        return null;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * `params` del body de error → mapa de strings, o `undefined`.
 *
 * Es estricto a propósito: un valor que no sea string se descarta ENTERO (no
 * se coerce ni se conserva a medias). Interpolar `undefined` o `[object
 * Object]` dentro de la frase traducida sería peor que degradar al `message`
 * crudo del backend, que es lo que hace `apiErrorMessage` cuando el mapa falta.
 */
function readStringMap(raw: unknown): Record<string, string> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') return undefined;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  bearer?: string,
  // Interno: marca el reintento tras un refresco para no entrar en bucle.
  _isRetry = false,
): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_URL}${path}`;
  const headers = new Headers(init.headers);
  // Solo setear Content-Type cuando hay body. Fastify (en la API) rechaza
  // con 400 "Body cannot be empty when content-type is set to
  // 'application/json'" si llega Content-Type sin body — afecta a llamadas
  // POST/DELETE sin payload.
  if (init.body !== undefined && init.body !== null) {
    headers.set('Content-Type', 'application/json');
  }
  if (bearer) headers.set('Authorization', `Bearer ${bearer}`);

  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  // El body se parsea de forma TOLERANTE. Con `JSON.parse` pelado, un 502/504
  // en el que el proxy devuelve una pagina HTML lanzaba SyntaxError aqui
  // mismo: se saltaba el refresh-and-retry del 401 de mas abajo y los callers
  // recibian un error sin `status` con el que no podian decidir nada.
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const payload = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const error = new ApiHttpError({
      message: typeof payload.message === 'string' ? payload.message : response.statusText,
      issues: Array.isArray(payload.issues) ? (payload.issues as ApiError['issues']) : undefined,
      status: response.status,
      code: typeof payload.code === 'string' ? payload.code : undefined,
      detail: typeof payload.detail === 'string' ? payload.detail : undefined,
      params: readStringMap(payload.params),
    });

    // Sesión expirada: el access token (1h) caducó pero el refresh (30d) puede
    // seguir vivo. Intentamos renovar y reintentar la petición UNA vez de forma
    // transparente; si no hay refresh o también caducó, limpiamos y mandamos al
    // login. No aplica a los propios endpoints de auth ni al reintento.
    const isAuthEndpoint = path.includes('/auth/refresh') || path.includes('/auth/signin');
    if (
      response.status === 401 &&
      typeof window !== 'undefined' &&
      !_isRetry &&
      !isAuthEndpoint &&
      error.code !== 'mfa_required'
    ) {
      const newToken = await refreshAccessToken();
      if (newToken) {
        return apiFetch<T>(path, init, newToken, true);
      }
      clearAuthAndRedirect();
      throw error;
    }

    // Auto-redirect del cliente cuando el API rechaza con mfa_required
    // (LMS-109). Cualquier admin que abra una pantalla protegida con sesión
    // sin verificar acaba derivado al flujo MFA en lugar de ver un toast
    // críptico. Sólo aplica en el browser; los callers en SSR siguen
    // recibiendo el throw para decidir ellos.
    if (error.code === 'mfa_required' && typeof window !== 'undefined') {
      const session = readStoredSessionSafe();
      const target = session?.user?.mfaEnabled ? '/mfa/verify' : '/mfa/setup';
      if (window.location.pathname !== target) {
        window.location.assign(target);
      }
    }
    throw error;
  }

  return body as T;
}

/**
 * Acceso defensivo al sessionStorage para no acoplar el cliente HTTP a
 * `auth-storage.ts` (lo que crearía un ciclo: api-client → auth-storage →
 * api-client). Lee el shape mínimo que necesita la redirección.
 */
function readStoredSessionSafe(): { user?: { mfaEnabled?: boolean } } | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY) ?? sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as { user?: { mfaEnabled?: boolean } };
  } catch {
    return null;
  }
}
