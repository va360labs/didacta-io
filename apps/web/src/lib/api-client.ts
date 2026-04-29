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
}

export class ApiHttpError extends Error implements ApiError {
  status: number;
  issues?: ApiError['issues'];
  code?: string;
  constructor(payload: ApiError) {
    super(payload.message);
    this.status = payload.status;
    this.issues = payload.issues;
    this.code = payload.code;
    this.name = 'ApiHttpError';
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  bearer?: string,
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
  const body = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const payload = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const error = new ApiHttpError({
      message: typeof payload.message === 'string' ? payload.message : response.statusText,
      issues: Array.isArray(payload.issues) ? (payload.issues as ApiError['issues']) : undefined,
      status: response.status,
      code: typeof payload.code === 'string' ? payload.code : undefined,
    });
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
    const raw = sessionStorage.getItem('didacta.session');
    if (!raw) return null;
    return JSON.parse(raw) as { user?: { mfaEnabled?: boolean } };
  } catch {
    return null;
  }
}
