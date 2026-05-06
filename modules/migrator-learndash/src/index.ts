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

/// Cliente de BD scoped al tablePrefix del módulo (alpha.51+). El host
/// aplica SQL guard: cualquier referencia a tabla fuera de
/// `mod_migrator_learndash_*` se rechaza con `DB_PREFIX_VIOLATION`. DDL
/// prohibida — la estructura de las tablas viene de
/// `prisma/migrations/20260503000000_init.sql` aplicadas en install.
type DbErrorCode =
  | 'DB_PREFIX_VIOLATION'
  | 'DB_INVALID_SQL'
  | 'DB_STATEMENT_TOO_LONG'
  | 'DB_TIMEOUT'
  | 'DB_TOO_MANY_ROWS'
  | 'DB_TX_ABORTED'
  | 'DB_TX_NESTED'
  | 'DB_UNIQUE_VIOLATION'
  | 'DB_FK_VIOLATION'
  | 'DB_NOT_NULL'
  | 'DB_CHECK_VIOLATION'
  | 'DB_NETWORK';

interface DbQueryOptions {
  timeoutMs?: number;
  maxRows?: number;
}

interface DbQueryResult<TRow = Record<string, unknown>> {
  rows: TRow[];
  rowCount: number;
}

interface SandboxedDb {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>,
    opts?: DbQueryOptions,
  ): Promise<DbQueryResult<TRow>>;
  execute(
    sql: string,
    params?: ReadonlyArray<unknown>,
    opts?: DbQueryOptions,
  ): Promise<{ rowCount: number }>;
  transaction<TResult>(fn: (tx: SandboxedDb) => Promise<TResult>): Promise<TResult>;
}

/// Forma del error que el cliente de BD lanza. El módulo SOLO debe
/// confiar en `code` — `message` está pensado para logs / debug, NO
/// para mostrar al usuario tal cual (puede contener detalle del schema).
interface DbError extends Error {
  code: DbErrorCode;
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
  /// Inyectado por el host (alpha.51+). Si `requiresDb: true` está en el
  /// manifest, el host pasa el cliente real; si no, un cliente que
  /// rechaza todo con DB_PREFIX_VIOLATION. En hosts < alpha.51 será
  /// `undefined` — los handlers que dependan de persistencia deben
  /// validar y devolver 503 explicando que el host no soporta ctx.db.
  db?: SandboxedDb;
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
  http?: SandboxedHttp;
  /// alpha.51+: cliente de BD scoped al tablePrefix del módulo. Si el
  /// `onInstall` necesita sembrar tablas iniciales (defaults de config,
  /// índices warm-up, etc.), lo hace via este cliente. El `onUninstall`
  /// recibe el mismo shape para limpieza opcional (DELETE FROM, no DROP
  /// — DDL prohibida).
  db?: SandboxedDb;
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

// ---- Persistencia de jobs (alpha.51+) ----------------------------
//
// Antes de alpha.51 los jobs vivían en un `Map<tenantId, Map<jobId,
// JobRecord>>` en memoria. Eso significaba que un restart de la API
// perdía TODOS los jobs en curso — inaceptable para un migrador que
// puede correr horas. alpha.51 introdujo `ctx.db` (cliente sandbox
// con SQL guard scoped al tablePrefix) y este módulo declara
// `requiresDb: true` en el manifest para activarlo.
//
// Las tablas se crean en install via `prisma/migrations/
// 20260503000000_init.sql`. La de jobs es `mod_migrator_learndash_jobs`
// con columnas: id, tenant_id, status, phase, source_profile, options,
// started_at, completed_at, progress, error, created_by, retention_days,
// purged_at. RLS aplica filtrado por tenant — el host setea
// `app.current_tenant_id` antes de cada query.
//
// Diseño: helpers async que reciben `db: SandboxedDb` (no globales). La
// columna `tenant_id` se filtra en cada query por defensa en
// profundidad — RLS la hace redundante pero el módulo no debe asumir
// que RLS siempre está activa (futura ejecución desde worker, etc.).

interface JobRow {
  id: string;
  tenant_id: string;
  status: string;
  phase: string | null;
  source_profile: Record<string, unknown>;
  options: Record<string, unknown>;
  started_at: string | Date;
  completed_at: string | Date | null;
  progress: { current: number; total: number; lastUpdate: string } | null;
  error: { code: string; message: string } | null;
  created_by: string;
}

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

function rowToJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status as JobRecord['status'],
    phase: row.phase,
    startedAt: typeof row.started_at === 'string' ? row.started_at : row.started_at.toISOString(),
    completedAt: row.completed_at
      ? typeof row.completed_at === 'string'
        ? row.completed_at
        : row.completed_at.toISOString()
      : null,
    progress: row.progress,
    error: row.error,
    createdBy: row.created_by,
    options: row.options,
  };
}

// Postgres NO autocastea `text → uuid` en parámetros prepared statements
// (SQLSTATE 42804: "column is of type uuid but expression is of type text").
// Forzamos cast explícito `$N::uuid` en cada parámetro UUID. Idem `::jsonb`
// para columnas JSONB. Sin estos casts, INSERT/SELECT con WHERE tenant_id
// fallan en runtime aunque los strings sean UUIDs válidos.

async function listTenantJobs(db: SandboxedDb, tenantId: string): Promise<JobRecord[]> {
  // RLS ya filtra por tenant_id, pero filtramos también explícitamente:
  // (a) defensa en profundidad, (b) el plan del query es mejor con el
  // filtro en el WHERE que delegando todo a la policy.
  const result = await db.query<JobRow>(
    `SELECT id, tenant_id, status, phase, source_profile, options, started_at,
            completed_at, progress, error, created_by
       FROM mod_migrator_learndash_jobs
      WHERE tenant_id = $1::uuid
      ORDER BY started_at DESC
      LIMIT 200`,
    [tenantId],
  );
  return result.rows.map(rowToJob);
}

async function getJob(db: SandboxedDb, tenantId: string, jobId: string): Promise<JobRecord | undefined> {
  const result = await db.query<JobRow>(
    `SELECT id, tenant_id, status, phase, source_profile, options, started_at,
            completed_at, progress, error, created_by
       FROM mod_migrator_learndash_jobs
      WHERE tenant_id = $1::uuid AND id = $2::uuid
      LIMIT 1`,
    [tenantId, jobId],
  );
  if (result.rows.length === 0) return undefined;
  return rowToJob(result.rows[0]!);
}

/// Inserta un job nuevo. `id` es UUID v4 generado por gen_random_uuid()
/// del motor (Postgres) — el módulo NO genera IDs en JS para garantizar
/// uniqueness sin coordinación. Devuelve el id asignado.
async function insertJob(
  db: SandboxedDb,
  tenantId: string,
  createdBy: string,
  sourceProfile: Record<string, unknown>,
  options: Record<string, unknown>,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO mod_migrator_learndash_jobs
       (tenant_id, status, source_profile, options, created_by)
     VALUES ($1::uuid, 'pending', $2::jsonb, $3::jsonb, $4)
     RETURNING id::text AS id`,
    [tenantId, JSON.stringify(sourceProfile), JSON.stringify(options), createdBy],
  );
  if (result.rows.length === 0) {
    throw new Error('insertJob: INSERT no devolvió id (¿el manifest no declara requiresDb?).');
  }
  return result.rows[0]!.id;
}

/// UPDATE escapado a status + completed_at. Lo hacemos como UPDATE
/// específico para evitar exponer el helper genérico de `saveJob` que
/// permitía sobreescribir cualquier campo (vector de bugs en el código
/// original — un handler que olvidara setear `tenantId` corrompería
/// otros tenants). Cualquier transición nueva (e.g. set phase, set
/// progress) requiere su propio helper estrecho.
async function setJobStatus(
  db: SandboxedDb,
  tenantId: string,
  jobId: string,
  status: JobRecord['status'],
  completedAt: string | null,
): Promise<number> {
  const result = await db.execute(
    `UPDATE mod_migrator_learndash_jobs
        SET status = $3,
            completed_at = $4::timestamp
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tenantId, jobId, status, completedAt],
  );
  return result.rowCount;
}

function nowIso(): string {
  return new Date().toISOString();
}

/// Helper para handlers que requieren `ctx.db`. Devuelve el cliente o
/// un `ModuleRouteResponse` 503 con mensaje accionable que el handler
/// debe propagar al usuario. Mantiene el patrón de control flow uniforme
/// con `requireUser`/`requireAdmin`.
function requireDb(req: ModuleRouteRequestContext): SandboxedDb | ModuleRouteResponse {
  if (!req.db) {
    return err(
      503,
      'DB_NOT_AVAILABLE',
      'Este módulo requiere persistencia (alpha.51+) y el host actual no la expone. Actualizá Didacta a alpha.51 o superior y reinstalá el módulo.',
    );
  }
  return req.db;
}

/// Mapea un DbError lanzado por ctx.db al ModuleRouteResponse correcto.
/// Códigos del sandbox:
///   - DB_PREFIX_VIOLATION → 500 (bug del módulo, NO del usuario).
///   - DB_TIMEOUT → 504 (la query tardó demasiado).
///   - DB_TOO_MANY_ROWS → 500 (paginación rota).
///   - DB_UNIQUE_VIOLATION/DB_FK_VIOLATION/DB_CHECK_VIOLATION → 409 conflict.
///   - todos los demás → 500 con el code en el body.
function dbErrToResponse(e: unknown): ModuleRouteResponse {
  const dbe = e as Partial<DbError> & { code?: string; message?: string };
  const code = dbe?.code ?? 'DB_NETWORK';
  const message = dbe?.message ?? 'Error en BD del módulo.';
  if (code === 'DB_TIMEOUT') return err(504, code, 'La consulta tardó demasiado, intentá de nuevo.');
  if (code === 'DB_UNIQUE_VIOLATION' || code === 'DB_FK_VIOLATION' || code === 'DB_CHECK_VIOLATION') {
    return err(409, code, 'Conflicto al guardar el registro.', { detail: message });
  }
  return err(500, code, 'Error en BD del módulo.', { detail: message });
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
  // ⚠️ Estado actual del migrador (alpha.51): el preflight es funcional —
  // valida credenciales del WP origen y muestra count + samples reales por
  // entidad. El job se persiste en `mod_migrator_learndash_jobs` (cliente
  // ctx.db inyectado por el host). PERO el procesamiento real (extract →
  // transform → load → reconcile) NO está implementado todavía: el job
  // queda en `pending` y NO se ejecuta automáticamente. La respuesta
  // incluye un `notice` que el wizard debería mostrar al usuario.
  {
    method: 'POST',
    path: '/jobs',
    handler: async (req) => {
      const auth = requireAdmin(req);
      if (isResponse(auth)) return auth;
      const db = requireDb(req);
      if (isResponse(db)) return db;
      const body = (req.body ?? {}) as {
        credentials?: { baseUrl?: string; username?: string };
        options?: Record<string, unknown>;
      };
      if (!body.credentials || !body.options) {
        return err(400, 'VALIDATION_ERROR', 'credentials + options requeridos.');
      }
      // NO persistimos `appPassword` — solo metadata identificativa del
      // origen (baseUrl + username). El secret se queda en el job runner
      // cuando el extract real se cablee, fuera de la BD.
      const sourceProfile = {
        baseUrl: body.credentials.baseUrl ?? null,
        username: body.credentials.username ?? null,
      };
      try {
        const jobId = await insertJob(db, auth.tenantId, auth.sub, sourceProfile, body.options);
        return ok(
          {
            jobId,
            notice: {
              code: 'EXTRACT_PIPELINE_NOT_READY',
              severity: 'warning',
              message:
                'El job se registró correctamente y quedó persistido en BD. El procesamiento real (extract → transform → load) NO está habilitado todavía: hoy el preflight valida tu origen y muestra qué hay para migrar, pero la importación efectiva llegará en próximas versiones de Didacta. Este job queda en estado pending y NO se ejecutará automáticamente.',
            },
          },
          201,
        );
      } catch (e) {
        return dbErrToResponse(e);
      }
    },
  },

  // GET /jobs — lista jobs del tenant.
  {
    method: 'GET',
    path: '/jobs',
    handler: async (req) => {
      const auth = requireAdmin(req);
      if (isResponse(auth)) return auth;
      const db = requireDb(req);
      if (isResponse(db)) return db;
      try {
        const items = await listTenantJobs(db, auth.tenantId);
        return ok({ items });
      } catch (e) {
        return dbErrToResponse(e);
      }
    },
  },

  // GET /jobs/:id — estado de un job.
  {
    method: 'GET',
    path: '/jobs/:id',
    handler: async (req) => {
      const auth = requireAdmin(req);
      if (isResponse(auth)) return auth;
      const db = requireDb(req);
      if (isResponse(db)) return db;
      const id = req.params['id'];
      if (!id) return err(400, 'VALIDATION_ERROR', 'falta :id.');
      try {
        const job = await getJob(db, auth.tenantId, id);
        if (!job) return err(404, 'JOB_NOT_FOUND', `job ${id} no encontrado en este tenant.`);
        return ok(job);
      } catch (e) {
        return dbErrToResponse(e);
      }
    },
  },

  // POST /jobs/:id/cancel — cancela.
  {
    method: 'POST',
    path: '/jobs/:id/cancel',
    handler: async (req) => {
      const auth = requireAdmin(req);
      if (isResponse(auth)) return auth;
      const db = requireDb(req);
      if (isResponse(db)) return db;
      const id = req.params['id'];
      if (!id) return err(400, 'VALIDATION_ERROR', 'falta :id.');
      try {
        const job = await getJob(db, auth.tenantId, id);
        if (!job) return err(404, 'JOB_NOT_FOUND', `job ${id} no encontrado.`);
        if (['completed', 'failed', 'cancelled'].includes(job.status)) {
          return err(
            409,
            'JOB_NOT_CANCELLABLE',
            `el job en estado '${job.status}' no se puede cancelar.`,
          );
        }
        const affected = await setJobStatus(db, auth.tenantId, id, 'cancelled', nowIso());
        if (affected === 0) {
          // Race: alguien lo cambió justo ahora. Reportar 409.
          return err(409, 'JOB_RACE', 'el estado del job cambió durante la cancelación, recargá y reintentá.');
        }
        return ok({ ok: true });
      } catch (e) {
        return dbErrToResponse(e);
      }
    },
  },

  // GET /jobs/:id/report — reporte (stub MVP).
  {
    method: 'GET',
    path: '/jobs/:id/report',
    handler: async (req) => {
      const auth = requireAdmin(req);
      if (isResponse(auth)) return auth;
      const db = requireDb(req);
      if (isResponse(db)) return db;
      const id = req.params['id'];
      if (!id) return err(400, 'VALIDATION_ERROR', 'falta :id.');
      try {
        const job = await getJob(db, auth.tenantId, id);
        if (!job) return err(404, 'JOB_NOT_FOUND', `job ${id} no encontrado.`);
        return ok({
          jobId: job.id,
          generatedAt: nowIso(),
          totals: { sourceCount: 0, loadedCount: 0, skippedCount: 0, failedCount: 0 },
          byEntity: [],
          auditChain: { eventsCount: 0, verified: true },
        });
      } catch (e) {
        return dbErrToResponse(e);
      }
    },
  },
];

// ---- Lifecycle hooks -----------------------------------------------

async function onInstall(ctx: ModuleInstallContext): Promise<void> {
  ctx.log(
    'log',
    `mod.migrator-learndash: onInstall (v${ctx.moduleVersion}) — ${routes.length} rutas registradas. Persistencia ctx.db ${ctx.db ? 'activa' : 'NO disponible (host < alpha.51)'}.`,
  );
  if (!ctx.db) {
    // No bloqueamos el install — el módulo todavía sirve preflight sin
    // BD. Pero el job pipeline no funcionará. Aviso para que el operador
    // lo vea en logs.
    ctx.log(
      'warn',
      'mod.migrator-learndash: ctx.db NO inyectado — los handlers /jobs devolverán 503 hasta que actualicés el host a alpha.51+.',
    );
  }
}

async function onUninstall(ctx: ModuleInstallContext): Promise<void> {
  ctx.log(
    'log',
    `mod.migrator-learndash: onUninstall — las tablas mod_migrator_learndash_* persisten (DDL DROP la haría el operador via psql tras backup; nunca el módulo).`,
  );
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
