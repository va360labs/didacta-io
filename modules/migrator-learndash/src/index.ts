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

/// Base64 sin Buffer ni btoa: el sandbox del host NO expone ninguno de
/// los dos (Buffer no está en la allowlist de requires; btoa no está
/// expuesto como global). Implementación manual usando solo primitivas
/// permitidas: Uint8Array + bitwise ops + String.fromCharCode.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64encode(s: string): string {
  // UTF-8 encode → bytes
  const bytes = new TextEncoder().encode(s);
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const b0 = bytes[i]!, b1 = bytes[i + 1]!, b2 = bytes[i + 2]!;
    out += B64[b0 >> 2]!;
    out += B64[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    out += B64[((b1 & 0x0f) << 2) | (b2 >> 6)]!;
    out += B64[b2 & 0x3f]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const b0 = bytes[i]!;
    out += B64[b0 >> 2]!;
    out += B64[(b0 & 0x03) << 4]!;
    out += '==';
  } else if (rem === 2) {
    const b0 = bytes[i]!, b1 = bytes[i + 1]!;
    out += B64[b0 >> 2]!;
    out += B64[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    out += B64[(b1 & 0x0f) << 2]!;
    out += '=';
  }
  return out;
}

/// Item de muestra para que el usuario VEA qué hay en su WP origen sin
/// tener que migrar primero. Solo metadata legible — sin payloads pesados.
interface Sample {
  id: string;
  title: string;
  slug: string;
  status: string;
  modified: string;
}

interface EntityProbe {
  count: number | 'unknown';
  samples: Sample[];
}

/// Sondeo por entidad: 1 request con `per_page=5` + `_fields` minimalista
/// + `orderby=modified&order=desc`. Devuelve count (header X-WP-Total) y
/// las 5 entidades más recientes con metadata legible.
///
/// Para `users` el shape es distinto (no tienen status/modified — usamos
/// `name` en lugar de `title.rendered` y `registered_date` en lugar de
/// `modified`). Lo normalizamos al shape uniforme `Sample`.
async function probeEntity(
  http: SandboxedHttp,
  baseUrl: string,
  cpt: string,
  authHeader: string,
  warnings: Array<{ code: string; message: string }>,
): Promise<EntityProbe> {
  const isUsers = cpt === 'users';
  const fields = isUsers ? 'id,name,slug,registered_date' : 'id,title,slug,status,modified';
  // status=any para ver TODO (publish + draft + private + future); WP por
  // default solo lista publish. Si el endpoint no acepta status (users),
  // simplemente lo ignora.
  const statusParam = isUsers ? '' : '&status=any';
  const orderParam = isUsers ? '' : '&orderby=modified&order=desc';
  const url = `${baseUrl}/wp-json/wp/v2/${cpt}?per_page=5&_fields=${fields}${statusParam}${orderParam}`;
  try {
    const r = await http.get(url, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
      timeoutMs: 5_000,
    });
    if (r.status === 404) {
      warnings.push({
        code: 'CPT_NOT_FOUND',
        message: `${cpt}: endpoint /wp-json/wp/v2/${cpt} devolvió 404. Puede ser por permalinks rotos o plugin desactivado.`,
      });
      return { count: 'unknown', samples: [] };
    }
    if (r.status === 401 || r.status === 403) {
      warnings.push({
        code: 'CPT_FORBIDDEN',
        message: `${cpt}: el usuario no tiene permiso para listar este endpoint (HTTP ${r.status}).`,
      });
      return { count: 'unknown', samples: [] };
    }
    if (r.status >= 400) {
      warnings.push({
        code: 'CPT_ERROR',
        message: `${cpt}: HTTP ${r.status} al consultar /wp-json/wp/v2/${cpt}.`,
      });
      return { count: 'unknown', samples: [] };
    }
    const totalRaw = Number(r.headers['x-wp-total']);
    const count: number | 'unknown' = Number.isFinite(totalRaw) ? totalRaw : 'unknown';
    let samples: Sample[] = [];
    try {
      const items = JSON.parse(r.body) as Array<{
        id: number | string;
        title?: { rendered?: string };
        name?: string;
        slug?: string;
        status?: string;
        modified?: string;
        registered_date?: string;
      }>;
      if (Array.isArray(items)) {
        samples = items.map((it) => ({
          id: String(it.id),
          title: it.title?.rendered ?? it.name ?? it.slug ?? `(sin título · id=${it.id})`,
          slug: it.slug ?? '',
          status: it.status ?? (isUsers ? 'user' : 'unknown'),
          modified: it.modified ?? it.registered_date ?? '',
        }));
      }
    } catch {
      // Body no JSON — devolvemos count pero samples vacío.
    }
    return { count, samples };
  } catch (e: unknown) {
    const ce = e as { code?: string; message?: string };
    warnings.push({
      code: ce.code ?? 'CPT_NETWORK_ERROR',
      message: `${cpt}: ${ce.message ?? String(e)}`,
    });
    return { count: 'unknown', samples: [] };
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

async function probeAll(
  http: SandboxedHttp,
  baseUrl: string,
  authHeader: string,
  warnings: Array<{ code: string; message: string }>,
): Promise<{
  counts: Record<string, number | 'unknown'>;
  samples: Record<string, Sample[]>;
}> {
  // Paralelo: los 6 sondeos arrancan a la vez, el rate limiter del host
  // (5rps + burst 10) los pace si hace falta. Cada probe trae count
  // (X-WP-Total) Y los 5 items más recientes con metadata legible para
  // que el usuario decida qué migrar antes de confirmar.
  const entities = ['sfwd-courses', 'sfwd-lessons', 'sfwd-topic', 'sfwd-quiz', 'groups', 'users'] as const;
  const labels = ['courses', 'lessons', 'topics', 'quizzes', 'groups', 'users'] as const;
  const results = await Promise.all(
    entities.map((cpt) => probeEntity(http, baseUrl, cpt, authHeader, warnings)),
  );
  const counts: Record<string, number | 'unknown'> = {};
  const samples: Record<string, Sample[]> = {};
  for (let i = 0; i < entities.length; i += 1) {
    counts[labels[i]!] = results[i]!.count;
    samples[labels[i]!] = results[i]!.samples;
  }
  return { counts, samples };
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
          // 422 (no 502): es un error del USUARIO (URL mal, WP caído desde su
          // perspectiva). 5xx haría que el reverse proxy de Easypanel/Traefik
          // reemplace el body JSON con su propia página HTML "Bad Gateway"
          // y el frontend pete con "Unexpected token '<'" al hacer JSON.parse.
          return err(422, 'WP_UNREACHABLE', `${baseUrl} respondió ${root.status} a /wp-json/. ¿Es un WordPress?`);
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
        // 422 (no 502): mismo razonamiento que arriba — Easypanel/Traefik
        // reemplaza 5xx con HTML, rompiendo el JSON.parse del frontend.
        // Causa típica: HTTP_BLOCKED_HOST (user puso http://localhost o IP
        // privada — bloqueado por SSRF guard), HTTP_NETWORK (DNS no resuelve),
        // HTTP_TIMEOUT (WP no responde a tiempo).
        return err(
          422,
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

      // 3-8) Sondeo real por entidad: count (X-WP-Total) + 5 muestras con
      //      metadata legible (id, title, slug, status, modified). Esto
      //      permite al usuario VER qué hay en su WP antes de confirmar
      //      la migración.
      const { counts, samples } = await probeAll(req.http, baseUrl, authHeader, warnings);
      const latencyMs = Date.now() - startedAt;

      return ok({
        ok: true,
        siteName,
        wpVersion,
        latencyMs,
        counts,
        samples,
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
  //
  // ⚠️ Estado actual del migrador (alpha.49): el preflight es funcional —
  // valida credenciales del WP origen y muestra count + samples reales por
  // entidad. PERO el procesamiento real del job (extract → transform →
  // load → reconcile) NO está implementado todavía. El job se registra y
  // queda en `pending` para siempre. La respuesta incluye un campo
  // `notice` que el wizard debería mostrar al usuario para que sepa que
  // la migración real es manual hasta próximas versiones.
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
      return ok(
        {
          jobId: job.id,
          notice: {
            code: 'EXTRACT_PIPELINE_NOT_READY',
            severity: 'warning',
            message:
              'El job se registró correctamente. El procesamiento real (extract → transform → load) NO está habilitado todavía: hoy el preflight valida tu origen y muestra qué hay para migrar, pero la importación efectiva llegará en próximas versiones de Didacta. Este job queda en estado pending y NO se ejecutará automáticamente.',
          },
        },
        201,
      );
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
