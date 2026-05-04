/**
 * Entry-point del módulo mod.migrator-learndash.
 *
 * Shape esperado por el host marketplace (alpha.38):
 *
 *   module.exports = {
 *     onInstall?: (ctx: ModuleInstallContext) => Promise<void>,
 *     onUninstall?: (ctx: ModuleInstallContext) => Promise<void>,
 *     routes?: ModuleRoute[]   // ← imprescindible para que aparezca enrutado
 *   }
 *
 * Sin `routes`, el módulo se carga en VM pero el dispatcher NO atiende
 * peticiones bajo `/api/v1/modules/migrator-learndash/*` y el módulo
 * queda invisible. Los handlers del módulo se exponen aquí mappeados
 * al shape `ModuleRoute { method, path, handler(req) }`.
 */
import { manifest } from './manifest.js';

// Tipos del host (declarados localmente para no acoplarse al import del core).
type AllowedMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/// Cliente HTTP saliente que el host inyecta en cada request (alpha.49+).
/// El host aplica allowlist por host del manifest, rate limit por
/// (módulo, host), SSRF guard, timeout y body cap. El módulo solo
/// invoca y maneja errores tipados (`HttpError.code`).
type HttpErrorCode =
  | 'HTTP_TIMEOUT'
  | 'HTTP_BLOCKED_HOST'
  | 'HTTP_BODY_TOO_LARGE'
  | 'HTTP_RATE_LIMITED'
  | 'HTTP_NETWORK'
  | 'HTTP_ABORTED'
  | 'HTTP_INVALID_URL';

interface HttpRequestOptions {
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  maxBodyBytes?: number;
  signal?: AbortSignal;
}

interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  bytesRead: number;
}

interface SandboxedHttp {
  get(url: string, opts?: HttpRequestOptions): Promise<HttpResponse>;
  post(url: string, opts?: HttpRequestOptions): Promise<HttpResponse>;
}

interface ModuleRouteRequestContext {
  method: AllowedMethod;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  body: unknown;
  user: { sub: string; tenantId: string; roles: string[] } | null;
  /// Inyectado por el host (alpha.49+). Si el módulo se carga en un host
  /// alpha.48 o anterior, `ctx.http` será `undefined` — los handlers que
  /// lo necesiten deben validar y responder error claro al usuario.
  http?: SandboxedHttp;
}

interface ModuleRouteResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type ModuleRouteHandler = (
  req: ModuleRouteRequestContext,
) => Promise<ModuleRouteResponse> | ModuleRouteResponse;

interface ModuleRoute {
  method: AllowedMethod;
  path: string;
  handler: ModuleRouteHandler;
}

interface ModuleInstallContext {
  moduleName: string;
  moduleVersion: string;
  log: (level: 'log' | 'warn' | 'error', message: string) => void;
}

// ---- Helpers de respuesta uniforme --------------------------------

function ok(body: unknown, status = 200): ModuleRouteResponse {
  return { status, body };
}

function err(status: number, code: string, message: string, detail?: unknown): ModuleRouteResponse {
  return { status, body: { code, message, detail } };
}

function requireUser(req: ModuleRouteRequestContext): { sub: string; tenantId: string; roles: string[] } | ModuleRouteResponse {
  if (!req.user) return err(401, 'UNAUTHENTICATED', 'Esta operación requiere autenticación.');
  return req.user;
}

/// Gate de rol — el migrador es destructivo (importa miles de filas en BD,
/// crea matrículas, borra historial si rollback). NO debe poder ser
/// invocado por alumnos ni formadores autenticados; solo administradores
/// del tenant o de la instancia. El frontend ya gatea el render del
/// wizard por `super_admin`, pero los handlers también deben gatear como
/// última línea de defensa (nunca confíes solo en el cliente).
function requireAdmin(req: ModuleRouteRequestContext): { sub: string; tenantId: string; roles: string[] } | ModuleRouteResponse {
  const auth = requireUser(req);
  if (isResponse(auth)) return auth;
  const allowed = auth.roles.some((r) => r === 'super_admin' || r === 'tenant_admin');
  if (!allowed) {
    return err(
      403,
      'FORBIDDEN',
      'El migrador requiere rol super_admin o tenant_admin.',
    );
  }
  return auth;
}

function isResponse(v: unknown): v is ModuleRouteResponse {
  return typeof v === 'object' && v !== null && ('status' in v || 'body' in v);
}

// ---- Stub de almacenamiento en memoria del job (MVP) --------------
//
// El módulo NO tiene acceso a Prisma desde la VM aislada (no está en
// la allowlist de requires). Hasta que el host inyecte un PrismaService
// scoped en `ModuleInstallContext`, el módulo guarda jobs en memoria.
// Esto es suficiente para validar el flujo end-to-end del wizard;
// pierde estado al restart de la API. El item Notion del PrismaService
// scoped queda pendiente.

interface JobRecord {
  id: string;
  tenantId: string;
  status: 'pending' | 'preflight' | 'extracting' | 'transforming' | 'loading' | 'reconciling' | 'completed' | 'failed' | 'cancelled';
  phase: string | null;
  startedAt: string;
  completedAt: string | null;
  progress: { current: number; total: number; lastUpdate: string } | null;
  error: { code: string; message: string } | null;
  createdBy: string;
  options: Record<string, unknown>;
  preflight?: Record<string, unknown>;
}

const jobsByTenant = new Map<string, Map<string, JobRecord>>();

function listTenantJobs(tenantId: string): JobRecord[] {
  return Array.from(jobsByTenant.get(tenantId)?.values() ?? []);
}

function getJob(tenantId: string, jobId: string): JobRecord | undefined {
  return jobsByTenant.get(tenantId)?.get(jobId);
}

function saveJob(job: JobRecord): void {
  let tenantMap = jobsByTenant.get(job.tenantId);
  if (!tenantMap) {
    tenantMap = new Map();
    jobsByTenant.set(job.tenantId, tenantMap);
  }
  tenantMap.set(job.id, job);
}

function nowIso(): string {
  return new Date().toISOString();
}

function genJobId(): string {
  const c = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/// Base64 sin depender de Node's Buffer (no está en la allowlist del
/// sandbox para módulos third-party). Usamos `btoa` global de Node 22.
function b64encode(s: string): string {
  return (globalThis as unknown as { btoa: (s: string) => string }).btoa(s);
}

/// Conteo por entidad: hace un request `?per_page=1` y lee `X-WP-Total`.
/// Si el endpoint 404 (CPT desactivado), devuelve `unknown` y suma un
/// warning explícito en lugar de petar todo el preflight.
async function countEntity(
  http: SandboxedHttp,
  baseUrl: string,
  cpt: string,
  authHeader: string,
  warnings: Array<{ code: string; message: string }>,
): Promise<number | 'unknown'> {
  try {
    const r = await http.get(`${baseUrl}/wp-json/wp/v2/${cpt}?per_page=1`, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
      timeoutMs: 10_000,
    });
    if (r.status === 404) {
      warnings.push({
        code: 'CPT_NOT_FOUND',
        message: `${cpt}: endpoint /wp-json/wp/v2/${cpt} devolvió 404. Puede ser por permalinks rotos o plugin desactivado.`,
      });
      return 'unknown';
    }
    if (r.status === 401 || r.status === 403) {
      warnings.push({
        code: 'CPT_FORBIDDEN',
        message: `${cpt}: el usuario no tiene permiso para listar este endpoint (HTTP ${r.status}).`,
      });
      return 'unknown';
    }
    if (r.status >= 400) {
      warnings.push({
        code: 'CPT_ERROR',
        message: `${cpt}: HTTP ${r.status} al consultar /wp-json/wp/v2/${cpt}.`,
      });
      return 'unknown';
    }
    const total = Number(r.headers['x-wp-total']);
    return Number.isFinite(total) ? total : 'unknown';
  } catch (e: unknown) {
    const ce = e as { code?: string; message?: string };
    warnings.push({
      code: ce.code ?? 'CPT_NETWORK_ERROR',
      message: `${cpt}: ${ce.message ?? String(e)}`,
    });
    return 'unknown';
  }
}

/// Async iterator que pagina TODAS las páginas de un endpoint WP REST.
/// Yield batches de items (no items individuales) para que el caller
/// pueda hacer batch insert en BD downstream sin reagrupar.
///
/// Lee `X-WP-TotalPages` del primer response para saber cuántas páginas
/// pedir — defensa contra upstreams que devuelven páginas vacías sin un
/// stop signal claro. Si el header no llega, paramos cuando recibamos
/// un array vacío.
///
/// El rate limiter del host pacea cada `http.get` automáticamente; este
/// helper NO añade su propio sleep entre páginas.
///
/// Cancelación: respeta el `AbortSignal` del caller. Si se dispara entre
/// páginas, el iterator devuelve sin yield (no rompe). Si se dispara
/// durante un fetch, el cliente HTTP del host lanza HTTP_ABORTED y aquí
/// lo dejamos propagar.
export async function* paginateWp<T>(
  http: SandboxedHttp,
  url: string,
  opts: {
    perPage?: number;
    authHeader: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): AsyncGenerator<T[], void, void> {
  const perPage = Math.min(100, Math.max(1, opts.perPage ?? 100));
  // Sanity cap para que un upstream malicioso o un bug no nos haga
  // iterar 10M páginas. 10_000 páginas × 100 items = 1M items max, que
  // debería cubrir cualquier WP razonable.
  const MAX_PAGES = 10_000;

  let totalPages: number | undefined;
  let page = 1;
  while (page <= MAX_PAGES) {
    if (opts.signal?.aborted) return;

    const sep = url.includes('?') ? '&' : '?';
    const pagedUrl = `${url}${sep}per_page=${perPage}&page=${page}`;
    const resp = await http.get(pagedUrl, {
      headers: { Authorization: opts.authHeader, Accept: 'application/json' },
      timeoutMs: opts.timeoutMs ?? 30_000,
      signal: opts.signal,
    });

    // WP devuelve 400 con `code: 'rest_post_invalid_page_number'` cuando
    // pides una página más allá del total. Lo tratamos como "fin natural".
    if (resp.status === 400 && resp.body.includes('rest_post_invalid_page_number')) return;
    if (resp.status >= 400) {
      throw new Error(`paginateWp: HTTP ${resp.status} en ${pagedUrl}`);
    }

    let items: T[];
    try {
      items = JSON.parse(resp.body) as T[];
    } catch (e) {
      throw new Error(`paginateWp: respuesta no JSON en ${pagedUrl}: ${(e as Error).message}`);
    }
    if (!Array.isArray(items)) {
      throw new Error(`paginateWp: respuesta esperada array en ${pagedUrl}, recibido ${typeof items}`);
    }

    if (items.length > 0) yield items;
    if (items.length === 0) return; // upstream sin más data

    if (totalPages === undefined) {
      const tp = Number(resp.headers['x-wp-totalpages']);
      if (Number.isFinite(tp) && tp > 0) totalPages = tp;
    }
    if (totalPages !== undefined && page >= totalPages) return;

    page += 1;
  }
}

async function countAll(
  http: SandboxedHttp,
  baseUrl: string,
  authHeader: string,
  warnings: Array<{ code: string; message: string }>,
): Promise<Record<string, number | 'unknown'>> {
  // Secuencial por construcción — el rate limiter del host pace en 5rps,
  // así que paralelizar no compraría tiempo y sí complica el flujo de
  // warnings.
  const courses = await countEntity(http, baseUrl, 'sfwd-courses', authHeader, warnings);
  const lessons = await countEntity(http, baseUrl, 'sfwd-lessons', authHeader, warnings);
  const topics = await countEntity(http, baseUrl, 'sfwd-topic', authHeader, warnings);
  const quizzes = await countEntity(http, baseUrl, 'sfwd-quiz', authHeader, warnings);
  const groups = await countEntity(http, baseUrl, 'groups', authHeader, warnings);
  const users = await countEntity(http, baseUrl, 'users', authHeader, warnings);
  return { courses, lessons, topics, quizzes, groups, users };
}

// ---- Routes -------------------------------------------------------

const routes: ModuleRoute[] = [
  // Sanity check: ping libre, sin auth.
  {
    method: 'GET',
    path: '/ping',
    handler: () => ok({ ok: true, name: manifest.name, version: manifest.version, ts: nowIso() }),
  },

  // POST /preflight — valida credenciales del origen y devuelve conteos
  // REALES leyendo el header `X-WP-Total` con `?per_page=1` para cada
  // entidad. Cero paginación en preflight; la paginación llega en el
  // extract phase del job (helper `paginateWp`, alpha.49 task 7).
  //
  // Estrategia (8 reqs total, ~2s a 5rps):
  //   1) GET /wp-json/                                  → conexión + X-WP versión + auth
  //   2) GET /wp-json/ldlms/v1/sfwd-courses?per_page=1  → confirma plugin LearnDash REST
  //   3) GET /wp-json/wp/v2/sfwd-courses?per_page=1     → countof courses (X-WP-Total)
  //   4) GET /wp-json/wp/v2/sfwd-lessons?per_page=1     → lessons
  //   5) GET /wp-json/wp/v2/sfwd-topic?per_page=1       → topics
  //   6) GET /wp-json/wp/v2/sfwd-quiz?per_page=1        → quizzes
  //   7) GET /wp-json/wp/v2/groups?per_page=1           → groups
  //   8) GET /wp-json/wp/v2/users?per_page=1            → users
  //
  // Si LearnDash REST (paso 2) responde 404, fallback a CPT directo (los
  // pasos 3-6 funcionan vía wp/v2/* aunque no haya plugin REST nativo —
  // es WP standard CPT). Si TAMBIÉN los CPT 404, devolvemos counts:'unknown'
  // con warning explícito.
  {
    method: 'POST',
    path: '/preflight',
    handler: async (req) => {
      const auth = requireAdmin(req);
      if (isResponse(auth)) return auth;

      const body = (req.body ?? {}) as {
        credentials?: { baseUrl?: string; username?: string; appPassword?: string };
      };
      const creds = body.credentials;
      if (!creds?.baseUrl || !creds?.username || !creds?.appPassword) {
        return err(400, 'VALIDATION_ERROR', 'credentials.baseUrl + username + appPassword requeridos.');
      }
      if (!req.http) {
        // Host alpha.48 o anterior — no hay ctx.http inyectado. El módulo
        // no puede salir a WP. El usuario debe actualizar Didacta a alpha.49+.
        return err(
          503,
          'HTTP_NOT_AVAILABLE',
          'El host de Didacta no expone HTTP saliente a este módulo (requiere alpha.49+). Actualizá la imagen y reinstalá el módulo.',
        );
      }

      const baseUrl = creds.baseUrl.replace(/\/$/, '');
      const authHeader = `Basic ${b64encode(`${creds.username}:${creds.appPassword}`)}`;
      const warnings: Array<{ code: string; message: string }> = [];
      const startedAt = Date.now();

      // 1) Sanity check: /wp-json/ raíz
      let siteName = 'WordPress origen';
      let wpVersion: string | undefined;
      try {
        const root = await req.http.get(`${baseUrl}/wp-json/`, {
          headers: { Authorization: authHeader, Accept: 'application/json' },
          timeoutMs: 10_000,
        });
        if (root.status === 401 || root.status === 403) {
          return err(401, 'WP_AUTH_FAILED', `Las credenciales no son válidas en ${baseUrl} (HTTP ${root.status}).`);
        }
        if (root.status >= 400) {
          return err(502, 'WP_UNREACHABLE', `${baseUrl} respondió ${root.status} a /wp-json/. ¿Es un WordPress?`);
        }
        wpVersion = root.headers['x-wp-version'];
        try {
          const parsed = JSON.parse(root.body) as { name?: string };
          if (parsed.name) siteName = parsed.name;
        } catch {
          // Body no JSON — seguimos sin name.
        }
      } catch (e: unknown) {
        const ce = e as { code?: string; message?: string };
        return err(
          502,
          ce.code ?? 'WP_UNREACHABLE',
          `No se pudo contactar ${baseUrl}: ${ce.message ?? String(e)}`,
        );
      }

      // 2) Capability detection: ¿el plugin LearnDash REST está presente?
      let learndashRestAvailable = true;
      try {
        const ld = await req.http.get(
          `${baseUrl}/wp-json/ldlms/v1/sfwd-courses?per_page=1`,
          { headers: { Authorization: authHeader }, timeoutMs: 10_000 },
        );
        if (ld.status === 404) learndashRestAvailable = false;
      } catch {
        learndashRestAvailable = false;
      }
      if (!learndashRestAvailable) {
        warnings.push({
          code: 'LEARNDASH_REST_UNAVAILABLE',
          message:
            'Plugin LearnDash REST no detectado en /wp-json/ldlms/v1/. Caemos a los CPT estándar (/wp-json/wp/v2/sfwd-*) — debería funcionar en LearnDash 4.x+ pero algunos meta fields pueden faltar en el extract.',
        });
      }

      // 3-8) Conteos reales con per_page=1 + lectura de X-WP-Total
      const counts = await countAll(req.http, baseUrl, authHeader, warnings);
      const latencyMs = Date.now() - startedAt;

      return ok({
        ok: true,
        siteName,
        wpVersion,
        latencyMs,
        counts,
        warnings,
        capabilities: {
          learndashV1: learndashRestAvailable,
          learndashV2: false,
          wpRest: true,
        },
      });
    },
  },

  // POST /jobs — crea un job y lo deja en pending.
  {
    method: 'POST',
    path: '/jobs',
    handler: (req) => {
      const auth = requireAdmin(req);
      if (isResponse(auth)) return auth;
      const body = (req.body ?? {}) as { credentials?: unknown; options?: Record<string, unknown> };
      if (!body.credentials || !body.options) {
        return err(400, 'VALIDATION_ERROR', 'credentials + options requeridos.');
      }
      const job: JobRecord = {
        id: genJobId(),
        tenantId: auth.tenantId,
        status: 'pending',
        phase: null,
        startedAt: nowIso(),
        completedAt: null,
        progress: null,
        error: null,
        createdBy: auth.sub,
        options: body.options,
      };
      saveJob(job);
      return ok({ jobId: job.id }, 201);
    },
  },

  // GET /jobs — lista jobs del tenant.
  {
    method: 'GET',
    path: '/jobs',
    handler: (req) => {
      const auth = requireAdmin(req);
      if (isResponse(auth)) return auth;
      return ok({ items: listTenantJobs(auth.tenantId) });
    },
  },

  // GET /jobs/:id — estado de un job.
  {
    method: 'GET',
    path: '/jobs/:id',
    handler: (req) => {
      const auth = requireAdmin(req);
      if (isResponse(auth)) return auth;
      const id = req.params['id'];
      if (!id) return err(400, 'VALIDATION_ERROR', 'falta :id.');
      const job = getJob(auth.tenantId, id);
      if (!job) return err(404, 'JOB_NOT_FOUND', `job ${id} no encontrado en este tenant.`);
      return ok(job);
    },
  },

  // POST /jobs/:id/cancel — cancela.
  {
    method: 'POST',
    path: '/jobs/:id/cancel',
    handler: (req) => {
      const auth = requireAdmin(req);
      if (isResponse(auth)) return auth;
      const id = req.params['id'];
      if (!id) return err(400, 'VALIDATION_ERROR', 'falta :id.');
      const job = getJob(auth.tenantId, id);
      if (!job) return err(404, 'JOB_NOT_FOUND', `job ${id} no encontrado.`);
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        return err(409, 'JOB_NOT_CANCELLABLE', `el job en estado '${job.status}' no se puede cancelar.`);
      }
      job.status = 'cancelled';
      job.completedAt = nowIso();
      saveJob(job);
      return ok({ ok: true });
    },
  },

  // GET /jobs/:id/report — reporte (stub MVP).
  {
    method: 'GET',
    path: '/jobs/:id/report',
    handler: (req) => {
      const auth = requireAdmin(req);
      if (isResponse(auth)) return auth;
      const id = req.params['id'];
      if (!id) return err(400, 'VALIDATION_ERROR', 'falta :id.');
      const job = getJob(auth.tenantId, id);
      if (!job) return err(404, 'JOB_NOT_FOUND', `job ${id} no encontrado.`);
      return ok({
        jobId: job.id,
        generatedAt: nowIso(),
        totals: { sourceCount: 0, loadedCount: 0, skippedCount: 0, failedCount: 0 },
        byEntity: [],
        auditChain: { eventsCount: 0, verified: true },
      });
    },
  },
];

// ---- Lifecycle hooks -----------------------------------------------

async function onInstall(ctx: ModuleInstallContext): Promise<void> {
  ctx.log('log', `mod.migrator-learndash: onInstall (v${ctx.moduleVersion}) — ${routes.length} rutas registradas.`);
}

async function onUninstall(ctx: ModuleInstallContext): Promise<void> {
  ctx.log('log', `mod.migrator-learndash: onUninstall — limpiando jobs en memoria.`);
  jobsByTenant.clear();
}

// ---- Export con el shape EXACTO del host -----------------------------
//
// CRÍTICO: module.exports debe ser { onInstall, onUninstall, routes }.
// NO envolver en `migratorLearndashModule` ni añadir `manifest`/re-exports.
// El sandbox lee `module.exports` directamente y aplica casting al
// shape `SandboxedModule` (apps/api/src/marketplace/module-sandbox.service.ts).

export { manifest, routes, onInstall, onUninstall };
// `paginateWp` se exporta para tests + para el extract phase del job
// cuando se cablee. NO se incluye en module.exports porque el host
// solo consume `{ onInstall, onUninstall, routes }` — el helper es
// uso interno del módulo.

// CommonJS export — esbuild --format=cjs respeta esta forma.
module.exports = { onInstall, onUninstall, routes };
