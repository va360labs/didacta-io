/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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
// Mappers reusados desde el skeleton de etl/. Cada uno retorna MapResult con
// `ok` + `canonical` o `errorCode` + `errorMessage`. Idempotencia garantizada
// por el load phase via externalRef.
import {
  mapUser,
  mapCourse,
  mapLesson,
  mapTopic,
  mapQuiz,
  mapGroup,
  mapDirectEnrollment,
  type MapResult,
} from './mappers/index.js';

// Tipos del host (declarados localmente para no acoplarse al import del core).
type AllowedMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/// Cliente HTTP saliente que el host inyecta en cada request (alpha.49+).
/// El host aplica allowlist por host del manifest, rate limit por
/// (módulo, host), SSRF guard, timeout y body cap. El módulo solo
/// invoca y maneja errores tipados (`HttpError.code`).
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

/// Store de secretos cifrados scoped al módulo + tenant (alpha.56+). El host
/// inyecta este cliente si el manifest declara `requiresSecrets: true`. Si
/// no, recibimos un cliente que rechaza con SECRETS_NOT_DECLARED + mensaje
/// accionable. Cripto at-rest (AES-256-GCM) la maneja el host con la key
/// resuelta via `loadCipherKey()` — el módulo solo ve plaintext.
///
/// Necesario para ET-001 (extract phase): el worker BullMQ recibe ctx
/// fresco por cada tick — sin store de secrets no podríamos recordar el
/// appPassword de WP entre POST /jobs y el primer tick del worker.
interface SetSecretOptions {
  expiresAt?: Date;
}

interface SecretMeta {
  key: string;
  expiresAt: Date | null;
  approxValueBytes: number;
}

interface SandboxedSecrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: SetSecretOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<SecretMeta[]>;
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
  /// Inyectado por el host (alpha.56+). Si `requiresSecrets: true` está
  /// en el manifest, el host pasa el cliente real; si no, un cliente que
  /// rechaza todo con SECRETS_NOT_DECLARED. En hosts < alpha.56 será
  /// `undefined` — los handlers que necesiten persistir secrets deben
  /// validar y devolver 503 explicando que el host no soporta ctx.secrets.
  secrets?: SandboxedSecrets;
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

/// Resultado que `onJobTick` retorna al worker BullMQ del host (alpha.53+).
/// El worker decide si re-encolar (continue), marcar como done (completed),
/// o marcar fallido (failed). State machine y batching dependen del módulo.
type JobTickResult =
  | { status: 'continue'; delaySec?: number }
  | { status: 'completed' }
  | { status: 'failed'; reason: string };

/// Context que el worker BullMQ pasa al `onJobTick` del módulo (alpha.53+).
/// Mismo patrón que `ModuleRouteRequestContext` pero sin user/method/path —
/// los jobs corren fuera de un request HTTP, sin actor humano vivo. El
/// `tenantId` viaja explícitamente porque el ALS del worker NO tiene el
/// del request original (BullMQ procesa fuera del flow HTTP).
interface ModuleJobTickContext {
  moduleName: string;
  moduleVersion: string;
  jobId: string;
  tenantId: string;
  /// Iteración (0 = primer tick tras encolar). Útil para detección de
  /// stuck jobs (si supera N para la fase actual, abortar).
  tickIndex: number;
  log: (level: 'log' | 'warn' | 'error', message: string) => void;
  db: SandboxedDb;
  http: SandboxedHttp;
  didacta: DidactaApi;
  /// alpha.56+. Store de secretos cifrados scoped al módulo + tenant.
  /// Necesario para que ET-001 lea el appPassword de WP cada tick.
  secrets: SandboxedSecrets;
}

// Tipo placeholder — el contrato real de DidactaApi vive en el host. Lo
// declaramos local para evitar acoplarse a imports que el sandbox rechaza.
// Solo necesitamos el shape mínimo que invocará el load phase (ET-003).
type DidactaApi = unknown;

// ---- Helpers de respuesta uniforme --------------------------------

function ok(body: unknown, status = 200): ModuleRouteResponse {
  return { status, body };
}

function err(status: number, code: string, message: string, detail?: unknown): ModuleRouteResponse {
  return { status, body: { code, message, detail } };
}

function requireUser(
  req: ModuleRouteRequestContext,
): { sub: string; tenantId: string; roles: string[] } | ModuleRouteResponse {
  if (!req.user) return err(401, 'UNAUTHENTICATED', 'Esta operación requiere autenticación.');
  return req.user;
}

/// Gate de rol — el migrador es destructivo (importa miles de filas en BD,
/// crea matrículas, borra historial si rollback). NO debe poder ser
/// invocado por alumnos ni formadores autenticados; solo administradores
/// del tenant o de la instancia. El frontend ya gatea el render del
/// wizard por `super_admin`, pero los handlers también deben gatear como
/// última línea de defensa (nunca confíes solo en el cliente).
function requireAdmin(
  req: ModuleRouteRequestContext,
): { sub: string; tenantId: string; roles: string[] } | ModuleRouteResponse {
  const auth = requireUser(req);
  if (isResponse(auth)) return auth;
  const allowed = auth.roles.some((r) => r === 'super_admin' || r === 'tenant_admin');
  if (!allowed) {
    return err(403, 'FORBIDDEN', 'El migrador requiere rol super_admin o tenant_admin.');
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
  status:
    | 'pending'
    | 'preflight'
    | 'extracting'
    | 'transforming'
    | 'loading'
    | 'reconciling'
    | 'completed'
    | 'failed'
    | 'cancelled';
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

async function getJob(
  db: SandboxedDb,
  tenantId: string,
  jobId: string,
): Promise<JobRecord | undefined> {
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

/// UPDATE escapado a `progress` JSONB. Necesario para que ET-001..ET-004
/// puedan persistir el cursor de la fase actual (entity+page+completed)
/// entre ticks. La columna ya existe en `mod_migrator_learndash_jobs`
/// (init.sql alpha.51) pero `setJobStatus` no la toca para evitar
/// sobrescrituras accidentales.
async function setJobProgress(
  db: SandboxedDb,
  tenantId: string,
  jobId: string,
  progress: Record<string, unknown>,
): Promise<number> {
  const result = await db.execute(
    `UPDATE mod_migrator_learndash_jobs
        SET progress = $3::jsonb
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tenantId, jobId, JSON.stringify(progress)],
  );
  return result.rowCount;
}

/// Escribe la columna `error` del job. Sin esto, un job que moría por un fallo
/// permanente del origen (Application Password revocada, endpoint retirado) se
/// quedaba en `extracting` re-encolando cada 30 s y el operador solo veía un
/// job que no avanza, sin ningún motivo apuntado en ningún sitio.
async function setJobError(
  db: SandboxedDb,
  tenantId: string,
  jobId: string,
  error: { code: string; message: string },
): Promise<number> {
  const result = await db.execute(
    `UPDATE mod_migrator_learndash_jobs
        SET error = $3::jsonb
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tenantId, jobId, JSON.stringify({ ...error, at: nowIso() })],
  );
  return result.rowCount;
}

/// Deja en `validation_reports` cuantos registros devolvio el ORIGEN por
/// entidad, tal como los conto la paginacion. Se llama al terminar el extract
/// porque despues el cursor cambia de fase y el dato se pierde.
async function recordSourceCounts(
  db: SandboxedDb,
  tenantId: string,
  jobId: string,
  totals: Record<string, number>,
  log: (level: 'log' | 'warn' | 'error', msg: string) => void,
): Promise<void> {
  for (const [entity, total] of Object.entries(totals)) {
    try {
      await db.execute(
        `INSERT INTO mod_migrator_learndash_validation_reports
           (tenant_id, job_id, entity_type, source_count, staged_count, valid_count,
            loaded_count, skipped_count, failed_count)
         VALUES ($1::uuid, $2::uuid, $3, $4, 0, 0, 0, 0, 0)
         ON CONFLICT (tenant_id, job_id, entity_type) DO UPDATE
           SET source_count = EXCLUDED.source_count`,
        [tenantId, jobId, entity, total],
      );
    } catch (e) {
      // Que el informe no cuadre no puede tumbar la migracion.
      log(
        'warn',
        `source_count de ${entity} no se pudo grabar: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
}

/// Transición atómica vía CAS (compare-and-set). Solo aplica el UPDATE si
/// el status actual del job es exactamente `from`. Si otro tick (o el
/// endpoint de cancelación) cambió el status entre el read y el write,
/// el UPDATE devuelve `rowCount=0` y el caller sabe que debe re-leer +
/// reintentar la lógica con el estado nuevo.
///
/// Esto evita race conditions cuando dos workers procesan jobs del mismo
/// tenant en paralelo y permite cancelación cooperativa: si alguien hace
/// `setJobStatus(...,'cancelled')` justo antes de un tick, este tick lo
/// ve y NO transiciona la fase.
///
/// Postgres garantiza atomicidad del UPDATE — sin SELECT FOR UPDATE
/// adicional, la condición está en el WHERE.
async function tryTransition(
  db: SandboxedDb,
  tenantId: string,
  jobId: string,
  from: JobRecord['status'],
  to: JobRecord['status'],
): Promise<boolean> {
  const result = await db.execute(
    `UPDATE mod_migrator_learndash_jobs
        SET status = $4
      WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = $3`,
    [tenantId, jobId, from, to],
  );
  return result.rowCount === 1;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---- Checksum + WP REST helpers (Sprint 4 / ET-001) --------------------

/// SHA-256 hex de un payload con serialización estable. Idempotencia de
/// `stg_*` se basa en checksum: re-extract de la misma página NO duplica,
/// solo sobrescribe `raw_payload` con datos idénticos.
///
/// Implementación inline (sin fast-json-stable-stringify) — el sort de
/// keys garantiza estabilidad cross-version del cliente, sin dep externa.
function stableStringify(value: unknown): string {
  return JSON.stringify(value, function (this: unknown, _k: string, v: unknown): unknown {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

function computeChecksum(payload: unknown): string {
  // node:crypto está en la allowlist del sandbox.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('node:crypto') as typeof import('node:crypto');
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/// Header HTTP Basic con username:appPassword.
function basicAuthHeader(username: string, appPassword: string): string {
  return `Basic ${b64encode(`${username}:${appPassword}`)}`;
}

/// Fetch UNA página de un endpoint WP REST. Distinto al async-iterator
/// `paginateWp` porque ET-001 procesa 1 página por tick — el cursor vive
/// en BD entre ticks, no en una closure de generator.
///
/// **context=edit**: alpha.58 fix. WP REST con `context=view` (default)
/// devuelve solo campos públicos — para `users` el `email` queda OUT,
/// resultado: MISSING_EMAIL en transform phase. Forzamos `context=edit`
/// que pide la representación administrativa completa. Requiere que la
/// credential tenga capability suficiente (list_users para /users;
/// edit_posts para CPTs). Application Passwords de admin las tienen.
/// Para `users` específicamente sin esto el migrator es 100% inútil.
/**
 * Fallo HTTP del origen WordPress, con el status a mano. Antes era un `Error`
 * pelado: el caller no podia distinguir un 500 transitorio de un 401 por
 * Application Password revocada, y reintentaba los dos igual — para siempre.
 */
class WpHttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} fetching ${url}`);
    this.name = 'WpHttpError';
  }
}

/**
 * Un 4xx de estos no se arregla esperando: credencial revocada, permisos
 * retirados, endpoint que ya no existe. Reintentarlos deja el job girando en
 * `extracting` sin avanzar y sin decir nada.
 */
const PERMANENT_WP_STATUSES = new Set([400, 401, 403, 404, 405, 410, 451]);

/** Reintentos de una misma pagina antes de dar el job por fallido. */
const PAGE_MAX_ATTEMPTS = 5;

async function fetchOneWpPage<T>(
  http: SandboxedHttp,
  baseUrl: string,
  cpt: string,
  authHeader: string,
  page: number,
  perPage: number,
  /// Namespace REST. `wp/v2` es WordPress core (sirve users + media + cualquier
  /// CPT genérico). `ldlms/v1` es el namespace LearnDash y es OBLIGATORIO para
  /// `sfwd-courses`, `sfwd-lessons`, `sfwd-topic`, `sfwd-quiz` y `groups`: solo
  /// ahí WP REST adjunta los fields custom de LearnDash (`course`, `lesson`,
  /// `topic`). Usar `wp/v2/sfwd-lessons` devuelve el post crudo SIN parents y
  /// el transformer rebota todo con MISSING_DEPENDENCY.
  namespace: 'wp/v2' | 'ldlms/v1' = 'wp/v2',
  /// Filtros extra de query string. Para `ldlms/v1/sfwd-lessons|sfwd-topic|
  /// sfwd-quiz` se DEBE pasar `{ course: '<id>' }`: LearnDash REST v1 rebota
  /// con 404 "Invalid Curso ID" si se omite (excepto admin global, que con
  /// Application Password NO lo somos).
  extraQuery?: Record<string, string | number>,
): Promise<{ items: T[]; totalPages: number | undefined; status: number }> {
  const extra = extraQuery
    ? '&' +
      Object.entries(extraQuery)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  const url = `${baseUrl}/wp-json/${namespace}/${cpt}?per_page=${perPage}&page=${page}&context=edit&status=any&orderby=id&order=asc${extra}`;
  const resp = await http.get(url, {
    headers: { Authorization: authHeader, Accept: 'application/json' },
    timeoutMs: 30_000,
  });
  // WP devuelve 400 con code rest_post_invalid_page_number cuando el page
  // está más allá del total. Lo tratamos como fin natural.
  if (resp.status === 400 && resp.body.includes('rest_post_invalid_page_number')) {
    return { items: [], totalPages: page - 1, status: 200 };
  }
  if (resp.status >= 400) {
    throw new WpHttpError(resp.status, url);
  }
  let items: T[];
  try {
    items = JSON.parse(resp.body) as T[];
  } catch (e) {
    throw new Error(`Respuesta no JSON: ${(e as Error).message}`, { cause: e });
  }
  if (!Array.isArray(items)) {
    throw new Error(`Respuesta esperada array, recibido ${typeof items}`);
  }
  const tpRaw = Number(resp.headers['x-wp-totalpages']);
  const totalPages = Number.isFinite(tpRaw) && tpRaw > 0 ? tpRaw : undefined;
  return { items, totalPages, status: resp.status };
}

// ---- Staging UPSERTs por entidad (Sprint 4 / ET-001) -------------------
//
// Cada entidad tiene una tabla stg_<entity> con columnas similares pero
// no idénticas (lessons + topics tienen parent_*; quizzes tiene 3 parents;
// enrollments tiene shape compuesto). Una función por entidad para no
// inventar abstracciones que oculten la columna.
//
// Idempotencia: ON CONFLICT (tenant_id, job_id, source_id) DO UPDATE
// reset is_valid=false y validation_errors=NULL para que re-extract
// dispare re-transform.

async function upsertStgUser(
  db: SandboxedDb,
  tenantId: string,
  jobId: string,
  sourceId: string,
  raw: unknown,
  checksum: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO mod_migrator_learndash_stg_users
       (tenant_id, job_id, source_id, raw_payload, checksum)
     VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5)
     ON CONFLICT (tenant_id, job_id, source_id) DO UPDATE
       SET raw_payload = EXCLUDED.raw_payload,
           checksum = EXCLUDED.checksum,
           is_valid = FALSE,
           validation_errors = NULL`,
    [tenantId, jobId, sourceId, JSON.stringify(raw), checksum],
  );
}

async function upsertStgCourse(
  db: SandboxedDb,
  tenantId: string,
  jobId: string,
  sourceId: string,
  raw: unknown,
  checksum: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO mod_migrator_learndash_stg_courses
       (tenant_id, job_id, source_id, raw_payload, checksum)
     VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5)
     ON CONFLICT (tenant_id, job_id, source_id) DO UPDATE
       SET raw_payload = EXCLUDED.raw_payload,
           checksum = EXCLUDED.checksum,
           is_valid = FALSE,
           validation_errors = NULL`,
    [tenantId, jobId, sourceId, JSON.stringify(raw), checksum],
  );
}

async function upsertStgLesson(
  db: SandboxedDb,
  tenantId: string,
  jobId: string,
  sourceId: string,
  parentCourseId: string | null,
  orderIdx: number,
  raw: unknown,
  checksum: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO mod_migrator_learndash_stg_lessons
       (tenant_id, job_id, source_id, parent_course_id, order_idx, raw_payload, checksum)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (tenant_id, job_id, source_id) DO UPDATE
       SET parent_course_id = EXCLUDED.parent_course_id,
           order_idx = EXCLUDED.order_idx,
           raw_payload = EXCLUDED.raw_payload,
           checksum = EXCLUDED.checksum,
           is_valid = FALSE,
           validation_errors = NULL`,
    [tenantId, jobId, sourceId, parentCourseId, orderIdx, JSON.stringify(raw), checksum],
  );
}

async function upsertStgTopic(
  db: SandboxedDb,
  tenantId: string,
  jobId: string,
  sourceId: string,
  parentLessonId: string | null,
  parentCourseId: string | null,
  orderIdx: number,
  raw: unknown,
  checksum: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO mod_migrator_learndash_stg_topics
       (tenant_id, job_id, source_id, parent_lesson_id, parent_course_id, order_idx, raw_payload, checksum)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (tenant_id, job_id, source_id) DO UPDATE
       SET parent_lesson_id = EXCLUDED.parent_lesson_id,
           parent_course_id = EXCLUDED.parent_course_id,
           order_idx = EXCLUDED.order_idx,
           raw_payload = EXCLUDED.raw_payload,
           checksum = EXCLUDED.checksum,
           is_valid = FALSE,
           validation_errors = NULL`,
    [
      tenantId,
      jobId,
      sourceId,
      parentLessonId,
      parentCourseId,
      orderIdx,
      JSON.stringify(raw),
      checksum,
    ],
  );
}

async function upsertStgQuiz(
  db: SandboxedDb,
  tenantId: string,
  jobId: string,
  sourceId: string,
  parentCourseId: string | null,
  parentLessonId: string | null,
  parentTopicId: string | null,
  raw: unknown,
  checksum: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO mod_migrator_learndash_stg_quizzes
       (tenant_id, job_id, source_id, parent_course_id, parent_lesson_id, parent_topic_id, raw_payload, checksum)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (tenant_id, job_id, source_id) DO UPDATE
       SET parent_course_id = EXCLUDED.parent_course_id,
           parent_lesson_id = EXCLUDED.parent_lesson_id,
           parent_topic_id = EXCLUDED.parent_topic_id,
           raw_payload = EXCLUDED.raw_payload,
           checksum = EXCLUDED.checksum,
           is_valid = FALSE,
           validation_errors = NULL`,
    [
      tenantId,
      jobId,
      sourceId,
      parentCourseId,
      parentLessonId,
      parentTopicId,
      JSON.stringify(raw),
      checksum,
    ],
  );
}

async function upsertStgGroup(
  db: SandboxedDb,
  tenantId: string,
  jobId: string,
  sourceId: string,
  raw: unknown,
  checksum: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO mod_migrator_learndash_stg_groups
       (tenant_id, job_id, source_id, raw_payload, checksum)
     VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5)
     ON CONFLICT (tenant_id, job_id, source_id) DO UPDATE
       SET raw_payload = EXCLUDED.raw_payload,
           checksum = EXCLUDED.checksum,
           is_valid = FALSE,
           validation_errors = NULL`,
    [tenantId, jobId, sourceId, JSON.stringify(raw), checksum],
  );
}

/// Upsert de una matrícula a stg_enrollments (v1.1.0+). A diferencia del resto
/// de staging, aquí el `canonical` se computa en el EXTRACT (mapDirectEnrollment
/// es puro y trivial) y se persiste con `is_valid=TRUE` — no hay paso transform
/// dedicado para enrollments.
///
/// `sourceGroupId`/`sourceCourseId` se escriben como `''` (no NULL) cuando no
/// aplican: el unique index (tenant, job, source_user_id, source_course_id,
/// source_group_id, enrollment_kind) NO deduplica si una columna es NULL
/// (NULL != NULL en Postgres), así que el sentinel vacío garantiza idempotencia
/// del ON CONFLICT ante reintentos de tick.
async function upsertStgEnrollment(
  db: SandboxedDb,
  tenantId: string,
  jobId: string,
  sourceUserId: string,
  sourceCourseId: string,
  sourceGroupId: string,
  kind: 'direct' | 'group',
  raw: unknown,
  canonical: unknown | null,
  checksum: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO mod_migrator_learndash_stg_enrollments
       (tenant_id, job_id, source_user_id, source_course_id, source_group_id, enrollment_kind,
        raw_payload, canonical, is_valid, validation_errors, checksum)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, NULL, $10)
     ON CONFLICT (tenant_id, job_id, source_user_id, source_course_id, source_group_id, enrollment_kind)
     DO UPDATE
       SET raw_payload = EXCLUDED.raw_payload,
           canonical = EXCLUDED.canonical,
           is_valid = EXCLUDED.is_valid,
           validation_errors = NULL,
           checksum = EXCLUDED.checksum,
           target_id = NULL,
           loaded_at = NULL`,
    [
      tenantId,
      jobId,
      sourceUserId,
      sourceCourseId,
      sourceGroupId,
      kind,
      JSON.stringify(raw),
      canonical ? JSON.stringify(canonical) : null,
      canonical !== null,
      checksum,
    ],
  );
}

/// Catálogo de entidades paginables vía WP REST. ORDEN IMPORTA: courses
/// antes de lessons/topics (lessons llevan parent_course_id derivado del
/// payload pero el load phase de Sprint 4 / ET-003 los carga al core
/// en orden — courses primero, luego sus hijos). Users es independiente.
/// Groups es independiente.
///
/// `questions` y `enrollments` NO están aquí: son entidades "fan-out" que
/// requieren leer staging (parent IDs) para iterar — se procesarán como
/// fase aparte tras agotar las paginables. Documentado como ET-001b.
/// `perCourse: true` indica que el endpoint requiere `?course=N` (LearnDash
/// REST v1 rebota con 404 `"Invalid Curso ID"` para Application Passwords
/// sin permisos avanzados si se omite). El cursor itera courseIds del
/// staging × pages dentro de cada course.
const EXTRACT_ENTITIES: Array<{
  name: string;
  cpt: string;
  namespace: 'wp/v2' | 'ldlms/v1';
  perCourse?: boolean;
}> = [
  { name: 'users', cpt: 'users', namespace: 'wp/v2' },
  // CPTs LearnDash: ldlms/v1 obligatorio para que el payload incluya los
  // campos `course`, `lesson`, `topic` que el transformer necesita. Usar
  // wp/v2 retorna el post WP crudo sin esos parents → MISSING_DEPENDENCY.
  { name: 'courses', cpt: 'sfwd-courses', namespace: 'ldlms/v1' },
  { name: 'lessons', cpt: 'sfwd-lessons', namespace: 'ldlms/v1', perCourse: true },
  { name: 'topics', cpt: 'sfwd-topic', namespace: 'ldlms/v1', perCourse: true },
  { name: 'quizzes', cpt: 'sfwd-quiz', namespace: 'ldlms/v1', perCourse: true },
  { name: 'groups', cpt: 'groups', namespace: 'ldlms/v1' },
];

interface ExtractCursor {
  phase: 'extract';
  /// Sub-fase dentro de `extract`. Default `'paginate'` (recorrido por
  /// entity × page × course). `'fixup'` corre tras agotar todas las
  /// entities: para cada course en stg_courses hace GET /sfwd-courses/<id>/steps
  /// y CORRIGE parent_course_id / parent_lesson_id en stg_lessons|topics|quizzes
  /// — necesario porque el endpoint plano /sfwd-lessons?course=N ignora el
  /// filter con Application Passwords de admin y devuelve el catálogo entero,
  /// dejando todas las rows con el courseId del último curso iterado.
  ///
  /// `'sample-pick'` (v1.0.32+): solo se usa si el job se creó con
  /// `options.sample` set. Una única ejecución al inicio del extract que
  /// elige UN curso aleatorio con alumnos enrolados, inyecta a stg solo
  /// ese curso + N alumnos, y marca `users`/`courses`/`groups` como
  /// completed para que el paginate normal solo recorra lessons/topics/
  /// quizzes (que son perCourse y solo verán el único curso del staging).
  /// Sin esta subphase, paginate iteraría globalmente todos los users del
  /// origen aunque el job sea de prueba.
  /// `'enroll'` (v1.1.0+): tras fixup, si el scope incluye enrollments, extrae
  /// las matrículas curso→usuario (un curso por tick vía /sfwd-courses/{id}/users)
  /// y las escribe en stg_enrollments con canonical ya computado. Al agotar los
  /// cursos, transición a transforming.
  subphase?: 'sample-pick' | 'paginate' | 'fixup' | 'enroll';
  current: string;
  page: number;
  completed: string[];
  totalsPerEntity: Record<string, number>;
  /// Solo aplica cuando el entity actual tiene `perCourse: true`. Índice del
  /// curso (en stg_courses ordenado por source_id) que se está procesando.
  /// Se resetea a 0 al cambiar de entity. `null` si la entity actual no
  /// requiere iteración course-by-course.
  courseIdx?: number;
  /// Total de courses (lo cacheamos para subphase='fixup'). Lo populamos
  /// al entrar a fixup.
  fixupTotalCourses?: number;
  /// Source ID del curso elegido por sample-pick (solo en sample mode).
  /// Útil para logging y verificación.
  sampleCourseId?: string;
  /// Intentos consumidos por curso en la extracción de matrículas. Sin este
  /// contador, un corte a mitad de paginación se tragaba las páginas que
  /// faltaban y el cursor avanzaba como si el curso estuviera completo.
  enrollAttempts?: Record<string, number>;
  /// Intentos consumidos por (entity, page, course) en la paginación. Sin el
  /// contador, un error se reintentaba indefinidamente y el job nunca fallaba.
  pageAttempts?: Record<string, number>;
}

/// Intentos por curso antes de rendirse y mandar la extracción de matrículas
/// a la DLQ. Tres cubre un 5xx transitorio sin dejar el job atascado.
const ENROLL_MAX_ATTEMPTS = 3;
const ENROLL_RETRY_DELAY_SEC = 15;

function emptyExtractCursor(): ExtractCursor {
  return {
    phase: 'extract',
    subphase: 'paginate',
    current: EXTRACT_ENTITIES[0]!.name,
    page: 1,
    completed: [],
    totalsPerEntity: {},
    courseIdx: 0,
  };
}

function parseExtractCursor(progress: unknown): ExtractCursor {
  if (
    progress &&
    typeof progress === 'object' &&
    (progress as { phase?: string }).phase === 'extract' &&
    typeof (progress as { current?: unknown }).current === 'string' &&
    typeof (progress as { page?: unknown }).page === 'number'
  ) {
    const c = progress as ExtractCursor;
    const sp =
      c.subphase === 'fixup' || c.subphase === 'sample-pick' || c.subphase === 'enroll'
        ? c.subphase
        : 'paginate';
    return {
      ...c,
      subphase: sp,
      courseIdx: typeof c.courseIdx === 'number' ? c.courseIdx : 0,
    };
  }
  return emptyExtractCursor();
}

/// Lee `options.sample` del job de forma defensiva. Devuelve `null` si:
///   - el job no se creó con sample mode (el wizard no envió el campo)
///   - el shape no matchea (legacy job con options stale, garantía de no crash)
/// Caps en línea con el DTO público: courses 1..5, usersPerCourse 1..50.
function readSampleConfig(options: unknown): { courses: number; usersPerCourse: number } | null {
  if (!options || typeof options !== 'object') return null;
  const s = (options as { sample?: unknown }).sample;
  if (!s || typeof s !== 'object') return null;
  const raw = s as { courses?: unknown; usersPerCourse?: unknown };
  const courses = typeof raw.courses === 'number' ? raw.courses : 1;
  const usersPerCourse = typeof raw.usersPerCourse === 'number' ? raw.usersPerCourse : 5;
  return {
    courses: Math.min(5, Math.max(1, Math.floor(courses))),
    usersPerCourse: Math.min(50, Math.max(1, Math.floor(usersPerCourse))),
  };
}

/// Modo de migración (v1.1.0+): el operador elige QUÉ migra.
///   'courses'           → solo contenido (cursos + lecciones + temas + quizzes).
///   'enrolled-students' → solo usuarios con ≥1 matrícula + sus matrículas.
///                          Asume que los cursos YA fueron migrados (diferido).
///   'all'               → todo (comportamiento legacy, default de compat).
export type MigrationMode = 'courses' | 'enrolled-students' | 'all';

export interface ScopeConfig {
  mode: MigrationMode;
  /// Entidades que se CARGAN al core (intención del operador).
  load: Set<string>;
  /// Entidades que se EXTRAEN a staging (load ∪ dependencias). En 'enrolled-students'
  /// se extraen cursos solo para obtener sus IDs (no se cargan).
  extract: Set<string>;
  /// Solo migrar usuarios con ≥1 matrícula (modo 'enrolled-students').
  onlyEnrolledUsers: boolean;
}

/// Lee `options.mode` / `options.scope` de forma defensiva (mismo patrón que
/// `readSampleConfig`). Prioridad: (1) `options.mode` explícito; (2) derivar de
/// los booleanos de `options.scope` que manda la wizard; (3) default 'all' para
/// jobs legacy creados antes de v1.1.0 (sin el campo) — cero regresión.
///
/// Nota: las entidades 'enrollments' del set se ignoran de forma natural mientras
/// la fase de enrollments no exista en EXTRACT_ENTITIES/STG_TABLES (Inc. 2): el
/// gating filtra contra las listas reales, así que un nombre inexistente es no-op.
export function readScopeConfig(options: unknown): ScopeConfig {
  const o = options && typeof options === 'object' ? (options as Record<string, unknown>) : {};
  const rawMode = typeof o['mode'] === 'string' ? (o['mode'] as string) : null;
  const scope =
    o['scope'] && typeof o['scope'] === 'object' ? (o['scope'] as Record<string, unknown>) : null;

  let mode: MigrationMode;
  if (rawMode === 'courses' || rawMode === 'enrolled-students' || rawMode === 'all') {
    mode = rawMode;
  } else if (scope) {
    // Derivar del scope booleano (compat con wizard que solo manda `scope`).
    const wantsContent = scope['courses'] !== false;
    const wantsUsers = scope['users'] !== false;
    const wantsEnroll = scope['enrollments'] !== false;
    if (wantsContent && wantsUsers) mode = 'all';
    else if (!wantsContent && (wantsUsers || wantsEnroll)) mode = 'enrolled-students';
    else mode = 'courses';
  } else {
    mode = 'all';
  }

  switch (mode) {
    case 'courses':
      return {
        mode,
        load: new Set(['courses', 'lessons', 'topics', 'quizzes']),
        extract: new Set(['courses', 'lessons', 'topics', 'quizzes']),
        onlyEnrolledUsers: false,
      };
    case 'enrolled-students':
      return {
        mode,
        load: new Set(['users', 'enrollments']),
        extract: new Set(['courses', 'users', 'enrollments']),
        onlyEnrolledUsers: true,
      };
    case 'all':
    default:
      return {
        mode,
        load: new Set([
          'users',
          'courses',
          'lessons',
          'topics',
          'quizzes',
          'groups',
          'enrollments',
        ]),
        extract: new Set([
          'users',
          'courses',
          'lessons',
          'topics',
          'quizzes',
          'groups',
          'enrollments',
        ]),
        onlyEnrolledUsers: false,
      };
  }
}

function nextEntity(cursor: ExtractCursor): string | null {
  const idx = EXTRACT_ENTITIES.findIndex((e) => e.name === cursor.current);
  if (idx < 0) return EXTRACT_ENTITIES[0]!.name;
  for (let i = idx + 1; i < EXTRACT_ENTITIES.length; i += 1) {
    const name = EXTRACT_ENTITIES[i]!.name;
    if (!cursor.completed.includes(name)) return name;
  }
  return null;
}

// ---- Transform + Load + Reconcile helpers (Sprint 4 / ET-002..ET-005) --
//
// Cada entidad tiene su stg_<entity> table con columnas comunes
// (canonical JSONB, is_valid, validation_errors, target_id, loaded_at).
// El transform actualiza canonical + is_valid; el load actualiza
// target_id + loaded_at; el reconcile cuenta.

interface StgRow {
  id: string;
  source_id: string;
  raw_payload: unknown;
  canonical: unknown;
  is_valid: boolean;
  target_id: string | null;
  parent_course_id?: string | null;
  parent_lesson_id?: string | null;
  parent_topic_id?: string | null;
}

const TRANSFORM_BATCH_SIZE = 100;
const LOAD_BATCH_SIZE = 50;

/// Tabla stg_<entity> mapping. Las entidades fan-out (questions, enrollments)
/// se procesan en ET-002b/ET-003b — no incluidas en ET-001 simplificado.
const STG_TABLES: Record<string, string> = {
  users: 'mod_migrator_learndash_stg_users',
  courses: 'mod_migrator_learndash_stg_courses',
  lessons: 'mod_migrator_learndash_stg_lessons',
  topics: 'mod_migrator_learndash_stg_topics',
  quizzes: 'mod_migrator_learndash_stg_quizzes',
  groups: 'mod_migrator_learndash_stg_groups',
  // v1.1.0+: lo usa el conteo de reconcile (mismas columnas is_valid/target_id).
  // El LOAD de enrollments NO pasa por el path genérico de STG_TABLES — tiene un
  // branch dedicado (forma de fila distinta) que retorna antes de este lookup.
  enrollments: 'mod_migrator_learndash_stg_enrollments',
};

async function listInvalidStg(
  db: SandboxedDb,
  table: string,
  tenantId: string,
  jobId: string,
  limit: number,
): Promise<StgRow[]> {
  // alpha.59 fix: añadido `validation_errors IS NULL` al WHERE para evitar
  // bucle infinito en transform phase. ANTES: si una fila fallaba el mapper,
  // setStgCanonical guardaba validation_errors pero dejaba is_valid=FALSE;
  // el SELECT volvía a traer las mismas filas en cada tick → miles de ticks
  // observados en alpha.58 en una migración real con 600+ users sin email.
  //
  // AHORA:
  //   - Fila virgen (recién extraída): is_valid=FALSE, validation_errors=NULL → se procesa
  //   - Fila transformada OK: is_valid=TRUE → no se procesa más
  //   - Fila que falló transform: is_valid=FALSE, validation_errors=<errs> → no se reintenta
  //   - Fila re-extraída (UPSERT del extract): is_valid=FALSE, validation_errors=NULL → se re-procesa
  // Selecciona los parent_* opcionales con NULL si la tabla no los tiene.
  // PostgreSQL no soporta columnas opcionales dinámicas en SELECT, pero las
  // tablas que NO tienen estos campos (users, courses, groups) tampoco los
  // necesitan; el transformer ignora row.parent_* en esos casos. Para
  // lessons/topics/quizzes esos campos DEBEN venir poblados desde el
  // extract para que el mapper resuelva el parent — el SELECT plano sin
  // ellos hacía que `raw.course` quedara undefined aunque la columna BD
  // estuviera bien.
  const hasParents =
    table === 'mod_migrator_learndash_stg_lessons' ||
    table === 'mod_migrator_learndash_stg_topics' ||
    table === 'mod_migrator_learndash_stg_quizzes';
  const parentCols = hasParents
    ? table === 'mod_migrator_learndash_stg_quizzes'
      ? ', parent_course_id, parent_lesson_id, parent_topic_id'
      : table === 'mod_migrator_learndash_stg_topics'
        ? ', parent_course_id, parent_lesson_id'
        : ', parent_course_id'
    : '';
  const result = await db.query<StgRow>(
    `SELECT id::text AS id, source_id, raw_payload, canonical, is_valid, target_id${parentCols}
       FROM ${table}
      WHERE tenant_id = $1::uuid AND job_id = $2::uuid
        AND is_valid = FALSE AND validation_errors IS NULL
      LIMIT ${Math.max(1, Math.min(1000, limit))}`,
    [tenantId, jobId],
  );
  return result.rows;
}

async function listValidUnloadedStg(
  db: SandboxedDb,
  table: string,
  tenantId: string,
  jobId: string,
  limit: number,
): Promise<StgRow[]> {
  // v1.0.33: ahora también incluimos rows con target_id 'sentinel' (`!SKIP:%`)
  // del legacy. Antes esos rows quedaban silenciosamente fuera del re-procesado
  // — los 20 topics + 8 groups del primer reporte del operador eran víctimas
  // de eso. Ahora el loader los re-evalúa contra el adapter actual y, si
  // estuviera implementado un nuevo target, los carga. Si siguen sin tener
  // target (groups en este release), se escribirá un DLQ entry visible.
  //
  // IMPORTANTE: NO incluimos rows con target_id real (UUID) ni con `!FAIL:%`
  // porque esos ya tuvieron su tratamiento (cargados u rechazados con DLQ
  // existente). Re-procesarlos crearía duplicados en el DLQ.
  const result = await db.query<StgRow>(
    `SELECT id::text AS id, source_id, raw_payload, canonical, is_valid, target_id
       FROM ${table}
      WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND is_valid = TRUE
        AND (target_id IS NULL OR target_id LIKE '!SKIP:%')
      LIMIT ${Math.max(1, Math.min(1000, limit))}`,
    [tenantId, jobId],
  );
  return result.rows;
}

interface StgEnrollmentRow {
  id: string;
  source_user_id: string;
  source_course_id: string | null;
  source_group_id: string | null;
  enrollment_kind: string;
  canonical: unknown;
  raw_payload: unknown;
  target_id: string | null;
}

/// Como listValidUnloadedStg pero para stg_enrollments, cuya forma difiere (no
/// tiene `source_id` único sino source_user_id/source_course_id/...). Mismo
/// criterio: filas válidas aún no cargadas (target NULL o sentinel !SKIP).
async function listValidUnloadedStgEnrollments(
  db: SandboxedDb,
  tenantId: string,
  jobId: string,
  limit: number,
): Promise<StgEnrollmentRow[]> {
  const result = await db.query<StgEnrollmentRow>(
    `SELECT id::text AS id, source_user_id, source_course_id, source_group_id,
            enrollment_kind, canonical, raw_payload, target_id
       FROM mod_migrator_learndash_stg_enrollments
      WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND is_valid = TRUE
        AND (target_id IS NULL OR target_id LIKE '!SKIP:%')
      LIMIT ${Math.max(1, Math.min(1000, limit))}`,
    [tenantId, jobId],
  );
  return result.rows;
}

async function setStgCanonical(
  db: SandboxedDb,
  table: string,
  rowId: string,
  canonical: unknown,
  validationErrors: unknown | null,
): Promise<void> {
  await db.execute(
    `UPDATE ${table}
        SET canonical = $2::jsonb,
            is_valid = $3,
            validation_errors = $4::jsonb
      WHERE id = $1::uuid`,
    [
      rowId,
      JSON.stringify(canonical),
      canonical !== null,
      validationErrors ? JSON.stringify(validationErrors) : null,
    ],
  );
}

async function setStgLoaded(
  db: SandboxedDb,
  table: string,
  rowId: string,
  targetId: string,
): Promise<void> {
  await db.execute(
    `UPDATE ${table}
        SET target_id = $2,
            loaded_at = CURRENT_TIMESTAMP
      WHERE id = $1::uuid`,
    [rowId, targetId],
  );
}

async function appendDlq(
  db: SandboxedDb,
  tenantId: string,
  jobId: string,
  entityType: string,
  sourceId: string | null,
  phase: string,
  errorCode: string,
  errorMessage: string,
  rawPayload: unknown,
  canonical?: unknown,
): Promise<void> {
  await db.execute(
    `INSERT INTO mod_migrator_learndash_dlq
       (tenant_id, job_id, entity_type, source_id, phase, error_code, error_message, raw_payload, canonical)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
    [
      tenantId,
      jobId,
      entityType,
      sourceId,
      phase,
      errorCode,
      errorMessage,
      JSON.stringify(rawPayload),
      canonical ? JSON.stringify(canonical) : null,
    ],
  );
}

interface TransformCursor {
  phase: 'transform';
  current: string;
  completed: string[];
}

function parseTransformCursor(progress: unknown): TransformCursor {
  if (
    progress &&
    typeof progress === 'object' &&
    (progress as { phase?: string }).phase === 'transform'
  ) {
    return progress as TransformCursor;
  }
  return { phase: 'transform', current: EXTRACT_ENTITIES[0]!.name, completed: [] };
}

interface LoadCursor {
  phase: 'load';
  current: string;
  completed: string[];
}

function parseLoadCursor(progress: unknown): LoadCursor {
  if (
    progress &&
    typeof progress === 'object' &&
    (progress as { phase?: string }).phase === 'load'
  ) {
    return progress as LoadCursor;
  }
  // Orden load: users → courses → lessons → topics → quizzes → groups.
  // (Los module-courses como agrupador opcional se omiten en MVP.)
  return { phase: 'load', current: 'users', completed: [] };
}

function nextTransformEntity(cursor: TransformCursor): string | null {
  const idx = EXTRACT_ENTITIES.findIndex((e) => e.name === cursor.current);
  for (let i = idx + 1; i < EXTRACT_ENTITIES.length; i += 1) {
    const name = EXTRACT_ENTITIES[i]!.name;
    if (!cursor.completed.includes(name)) return name;
  }
  return null;
}

// ---- Adapter canonical → DidactaUpsertXInput (Sprint 4 / ET-003 hardening) -
//
// Los mappers de src/mappers/ producen el "canonical" interno (CanonicalUser
// etc.) que pre-data el contrato final de ctx.didacta (alpha.52). Las shapes
// NO matchean 1:1 — `displayName → name`, `roles[] → role` (singular),
// lessons necesitan `moduleExternalRef`, etc. Este adapter centraliza el
// transform para que el load phase no rompa con DIDACTA_VALIDATION_ERROR.
//
// Decisiones documentadas:
//   - `topics`: skipped (LearnDash topic vs Didacta lesson-flat — sin
//     equivalencia 1:1 sin crear synthetic course modules). target_id='!SKIP:TOPIC'.
//   - `groups`: skipped (sin target directo en ctx.didacta — los grupos
//     materializan via enrollments en ET-001b cuando se cablee).
//   - `lessons`: `moduleExternalRef` se manda apuntando al COURSE (no a un
//     module/section), aceptando que el host del core lo trate como sección
//     implícita. Si el host lo rechaza → DLQ, fixable en iteración futura.
//   - `roles`: mapping de WP roles a Didacta roles. Default 'alumno'.
//   - `users.email`: si el canonical no trae email, fail (Didacta requiere).

type DidactaRole = 'tenant_admin' | 'formador' | 'alumno' | 'auditor' | 'empresa_manager';

function mapWpToDidactaRole(roles: unknown): DidactaRole {
  if (!Array.isArray(roles) || roles.length === 0) return 'alumno';
  const set = new Set(roles.map((r) => String(r)));
  if (set.has('administrator') || set.has('tenant_admin')) return 'tenant_admin';
  if (set.has('group_leader') || set.has('instructor') || set.has('formador')) return 'formador';
  if (set.has('auditor')) return 'auditor';
  return 'alumno';
}

type AdapterResult =
  | { ok: true; ns: string; input: Record<string, unknown> }
  | { ok: false; skip?: boolean; fail?: boolean; code: string; message: string };

function adaptCanonicalToDidacta(
  entity: string,
  canonical: Record<string, unknown>,
): AdapterResult {
  // enrollments (v1.1.0+): el canonical (de mapDirectEnrollment) NO tiene
  // `sourceId` sino userSourceId/courseSourceId, así que se maneja ANTES del
  // guard genérico de sourceId. El host (enrollments.upsertByExternalRef) espera
  // externalRef propio del enrollment + userExternalRef + courseExternalRef y
  // resuelve ambos por (externalSource, externalId). Si el course no existe aún
  // lanza DIDACTA_FOREIGN_REFERENCE → DLQ (modo diferido: migrar cursos primero).
  if (entity === 'enrollments') {
    const userSourceId = String(canonical['userSourceId'] ?? '');
    const courseSourceId = String(canonical['courseSourceId'] ?? '');
    const extId = String(canonical['externalId'] ?? '');
    if (!userSourceId || !courseSourceId) {
      return {
        ok: false,
        skip: false,
        code: 'ADAPTER_ENROLLMENT_NO_REFS',
        message: `enrollment sin userSourceId/courseSourceId (user=${userSourceId} course=${courseSourceId})`,
      };
    }
    const rawStatus = String(canonical['status'] ?? 'active').toLowerCase();
    const status = rawStatus === 'completed' ? 'COMPLETED' : 'ACTIVE';
    return {
      ok: true,
      ns: 'enrollments',
      input: {
        externalSource: 'learndash',
        externalId: extId || `enrollment:${courseSourceId}:${userSourceId}`,
        userExternalRef: { externalSource: 'learndash', externalId: userSourceId },
        courseExternalRef: { externalSource: 'learndash', externalId: courseSourceId },
        status,
      },
    };
  }

  const sourceId = String(canonical['sourceId'] ?? '');
  if (!sourceId) {
    return {
      ok: false,
      skip: false,
      code: 'ADAPTER_NO_SOURCE_ID',
      message: 'canonical sin sourceId',
    };
  }
  const externalRef = { externalSource: 'learndash', externalId: sourceId };

  switch (entity) {
    case 'users': {
      const email = String(canonical['email'] ?? '').trim();
      if (!email || !email.includes('@')) {
        return {
          ok: false,
          skip: false,
          code: 'ADAPTER_USER_NO_EMAIL',
          message: `user ${sourceId} sin email válido`,
        };
      }
      const input: Record<string, unknown> = {
        ...externalRef,
        email,
        role: mapWpToDidactaRole(canonical['roles']),
        // El migrador NUNCA envía emails al crear usuarios (incidente:
        // migración envió ~2900 emails). El operador notifica después de
        // forma explícita y controlada. Ver host alpha.81 que respeta este
        // flag. Defensa: el campo es ADITIVO — si el host viejo (< alpha.81)
        // lo ignora, no rompe (es un campo extra del input).
        suppressInvite: true,
      };
      const dn = canonical['displayName'];
      if (typeof dn === 'string' && dn.trim()) input['name'] = dn.trim();
      return { ok: true, ns: 'users', input };
    }

    case 'courses': {
      const slug = String(canonical['slug'] ?? '').trim();
      const title = String(canonical['title'] ?? '').trim();
      if (!slug || !title) {
        return {
          ok: false,
          skip: false,
          code: 'ADAPTER_COURSE_MISSING_FIELDS',
          message: `course ${sourceId} sin slug/title`,
        };
      }
      const input: Record<string, unknown> = { ...externalRef, slug, title };
      const desc = canonical['description'];
      if (typeof desc === 'string' && desc.trim()) input['description'] = desc.trim();
      return { ok: true, ns: 'courses', input };
    }

    case 'lessons': {
      const parentCourseId = String(canonical['parentCourseSourceId'] ?? '').trim();
      if (!parentCourseId) {
        return {
          ok: false,
          skip: false,
          code: 'ADAPTER_LESSON_NO_PARENT',
          message: `lesson ${sourceId} sin parentCourseSourceId`,
        };
      }
      const title = String(canonical['title'] ?? '').trim() || `(sin título · ${sourceId})`;
      const contentHtml =
        typeof canonical['contentHtml'] === 'string' ? canonical['contentHtml'] : '';
      // `position` cae bajo `@@unique([moduleId, position])` en mod_courses_lesson.
      // El mapper actual pasa `orderIdx=0` siempre (applyMapper no propaga el
      // contador desde stg.order_idx), así que 447/448 lessons rebotaban con
      // DIDACTA_VALIDATION_ERROR "Unique constraint failed on fields:
      // (module_id, position)". Usamos el sourceId numérico de LearnDash como
      // position: son IDs incrementales del CPT en WP, únicos por instalación
      // y por ende dentro del CourseModule sintético (cada course tiene SU
      // propio module sintético). Mantiene además un orden natural por
      // antigüedad de creación de la lección en el origen.
      const numericId = parseInt(sourceId, 10);
      const position = Number.isFinite(numericId) && numericId > 0 ? numericId : 0;
      return {
        ok: true,
        ns: 'lessons',
        input: {
          ...externalRef,
          moduleExternalRef: { externalSource: 'learndash', externalId: parentCourseId },
          type: 'HTML',
          title,
          position,
          content: { html: contentHtml },
        },
      };
    }

    case 'topics': {
      // v1.0.33: topics ahora se mapean como lessons planas en Didacta,
      // preservando parent_lesson para conservar la jerarquía didáctica.
      // LearnDash modela `Course → Lesson → Topic`. Didacta es lesson-flat
      // (`Course → Module → Lesson`) → el Topic se "promueve" a Lesson
      // dentro del module del course padre. No tenemos endpoint para crear
      // module sintético por-lesson, así que el topic se cuelga del module
      // "General" del course (mismo externalId que el course) — los
      // operadores los reconocen porque su título conserva el de LearnDash
      // y su position usa el sourceId numérico (mismo criterio que lessons).
      const parentCourseId = String(canonical['parentCourseSourceId'] ?? '').trim();
      if (!parentCourseId) {
        return {
          ok: false,
          skip: false,
          code: 'TOPIC_NO_PARENT_COURSE',
          message: `topic ${sourceId} sin parentCourseSourceId; no se puede mapear como lesson sin curso padre`,
        };
      }
      const parentLessonId = canonical['parentLessonSourceId'];
      const title = String(canonical['title'] ?? '').trim() || `(topic sin título · ${sourceId})`;
      const contentObj = canonical['contentHtml'];
      const contentHtml = typeof contentObj === 'string' ? contentObj : '';
      const numericId = parseInt(sourceId, 10);
      const position = Number.isFinite(numericId) && numericId > 0 ? numericId : 0;
      const input: Record<string, unknown> = {
        ...externalRef,
        moduleExternalRef: { externalSource: 'learndash', externalId: parentCourseId },
        type: 'HTML',
        title,
        position,
        content: { html: contentHtml },
      };
      // parentLessonExternalRef se incluye como hint para futuros consumers
      // del canonical (auditoría, exportadores). El host actual no lo
      // consume todavía, pero conservar la referencia preserva la
      // jerarquía didáctica original sin coste.
      if (typeof parentLessonId === 'string' && parentLessonId.trim()) {
        input['parentLessonExternalRef'] = {
          externalSource: 'learndash',
          externalId: parentLessonId,
        };
      }
      return { ok: true, ns: 'lessons', input };
    }

    case 'quizzes': {
      const title = String(canonical['title'] ?? '').trim() || `(quiz sin título · ${sourceId})`;
      const input: Record<string, unknown> = { ...externalRef, title };
      const parentLessonId = canonical['parentLessonSourceId'];
      if (typeof parentLessonId === 'string' && parentLessonId.trim()) {
        input['lessonExternalRef'] = { externalSource: 'learndash', externalId: parentLessonId };
      }
      const passPct = canonical['passingPercentage'];
      if (typeof passPct === 'number' && passPct >= 0 && passPct <= 100) {
        input['passThreshold'] = passPct;
      }
      // questions queda para DD-006 — el contrato lo permite (questions?: unknown[])
      // pero el host actual NO las persiste. Pasarlas vacías para no triggerar
      // el warning de bulk-create pendiente.
      return { ok: true, ns: 'quizzes', input };
    }

    case 'groups':
      // v1.0.33: cambio de skip silencioso a fail explícito al DLQ.
      // Antes el skip se contaba como "loaded" y el operador no veía que
      // los groups se perdían. Ahora cada group queda como entry en
      // /jobs/:id/dlq con un mensaje accionable que explica por qué.
      // Groups requieren ET-001b (enrollments fan-out group→users) que
      // todavía no está cableado; mientras tanto los enrollments se
      // importan curso-a-curso, no group-a-group.
      return {
        ok: false,
        fail: true,
        code: 'ADAPTER_GROUPS_NOT_SUPPORTED',
        message:
          'Groups requieren ET-001b (enrollments fan-out). Por ahora ese flow no está implementado; los enrollments se importan curso-a-curso, no group-a-group. Groups quedan sin migrar — esto se ve en DLQ entries con este código.',
      };

    default:
      return {
        ok: false,
        skip: false,
        code: 'ADAPTER_UNKNOWN_ENTITY',
        message: `entidad ${entity} sin adapter`,
      };
  }
}

/// Aplica el mapper apropiado a un row de stg. Retorna MapResult.
function applyMapper(entity: string, raw: unknown): MapResult<unknown> {
  switch (entity) {
    case 'users':
      return mapUser(raw as Parameters<typeof mapUser>[0]);
    case 'courses':
      return mapCourse(raw as Parameters<typeof mapCourse>[0]);
    case 'lessons':
      return mapLesson(raw as Parameters<typeof mapLesson>[0]);
    case 'topics':
      return mapTopic(raw as Parameters<typeof mapTopic>[0]);
    case 'quizzes':
      return mapQuiz(raw as Parameters<typeof mapQuiz>[0]);
    case 'groups':
      return mapGroup(raw as Parameters<typeof mapGroup>[0]);
    default:
      return {
        ok: false,
        errorCode: 'UNSUPPORTED_ENTITY' as never,
        errorMessage: `Mapper no implementado para ${entity}`,
        warnings: [],
      };
  }
}

// ---- ctx.secrets helpers (alpha.56+) -----------------------------------
//
// El appPassword del WP origen viaja en POST /jobs (cliente lo envía con
// las credenciales). NO se persiste en `source_profile` JSONB porque el
// row del job es legible por todo super_admin del tenant. En lugar de
// eso, lo guardamos cifrado via ctx.secrets bajo una key job-scoped que
// el manifest fuerza con allowedKeyPattern.
//
// Clave: `job:<jobId>:learndash:appPassword`. El UUID v4 del jobId hace
// la key globalmente única dentro del tenant + módulo; el sufijo
// `learndash:appPassword` deja espacio para futuras keys del mismo job
// (ej. refresh tokens si en alguna iteración necesitamos OAuth en lugar
// de Application Passwords).
//
// Expiración: alineada con `options.retentionDays` (default 30 días en el
// HANDOFF alpha.51). El secret expira y queda invisible para get()/list()
// — un GC futuro lo borrará físico. Mientras tanto el cleanup explícito
// en setJobStatus(terminal) lo borra al cerrar el job (caso normal).

function secretKeyForAppPassword(jobId: string): string {
  return `job:${jobId}:learndash:appPassword`;
}

/// Guarda el appPassword cifrado vía ctx.secrets. Lanza si falla — el
/// caller (POST /jobs) debe rollback el row del job para no dejar un
/// job huérfano que el worker no pueda autenticar.
async function persistJobAppPassword(
  secrets: SandboxedSecrets,
  jobId: string,
  appPassword: string,
  retentionDays: number,
): Promise<void> {
  const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
  await secrets.set(secretKeyForAppPassword(jobId), appPassword, { expiresAt });
}

/// Lee el appPassword. Si retorna null → secret expiró o nunca se creó.
/// El caller (onJobTick extract phase) debe marcar el job como failed
/// con reason CREDENTIALS_NOT_FOUND.
async function readJobAppPassword(
  secrets: SandboxedSecrets,
  jobId: string,
): Promise<string | null> {
  return secrets.get(secretKeyForAppPassword(jobId));
}

/// Borra el secret. Idempotente — silente si no existe. Llamar al cerrar
/// el job (completed/failed/cancelled) para liberar slot de la quota
/// antes del expiry natural.
async function cleanupJobAppPassword(
  secrets: SandboxedSecrets | undefined,
  jobId: string,
  log: (level: 'log' | 'warn' | 'error', message: string) => void,
): Promise<void> {
  if (!secrets) return;
  try {
    await secrets.delete(secretKeyForAppPassword(jobId));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('warn', `cleanup secret falló para job ${jobId}: ${msg}. El expiry natural lo limpiará.`);
  }
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
      'Este módulo requiere persistencia (alpha.51+) y el host actual no la expone. Actualiza Didacta a alpha.51 o superior y reinstala el módulo.',
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
  if (code === 'DB_TIMEOUT')
    return err(504, code, 'La consulta tardó demasiado, intenta de nuevo.');
  if (
    code === 'DB_UNIQUE_VIOLATION' ||
    code === 'DB_FK_VIOLATION' ||
    code === 'DB_CHECK_VIOLATION'
  ) {
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
    const b0 = bytes[i]!,
      b1 = bytes[i + 1]!,
      b2 = bytes[i + 2]!;
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
    const b0 = bytes[i]!,
      b1 = bytes[i + 1]!;
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
      throw new Error(`paginateWp: respuesta no JSON en ${pagedUrl}: ${(e as Error).message}`, {
        cause: e,
      });
    }
    if (!Array.isArray(items)) {
      throw new Error(
        `paginateWp: respuesta esperada array en ${pagedUrl}, recibido ${typeof items}`,
      );
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
  const entities = [
    'sfwd-courses',
    'sfwd-lessons',
    'sfwd-topic',
    'sfwd-quiz',
    'groups',
    'users',
  ] as const;
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
        return err(
          400,
          'VALIDATION_ERROR',
          'credentials.baseUrl + username + appPassword requeridos.',
        );
      }
      if (!req.http) {
        // Host alpha.48 o anterior — no hay ctx.http inyectado. El módulo
        // no puede salir a WP. El usuario debe actualizar Didacta a alpha.49+.
        return err(
          503,
          'HTTP_NOT_AVAILABLE',
          'El host de Didacta no expone HTTP saliente a este módulo (requiere alpha.49+). Actualiza la imagen y reinstala el módulo.',
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
          return err(
            401,
            'WP_AUTH_FAILED',
            `Las credenciales no son válidas en ${baseUrl} (HTTP ${root.status}).`,
          );
        }
        if (root.status >= 400) {
          // 422 (no 502): es un error del USUARIO (URL mal, WP caído desde su
          // perspectiva). 5xx haría que el reverse proxy (Traefik, Nginx)
          // reemplace el body JSON con su propia página HTML "Bad Gateway"
          // y el frontend pete con "Unexpected token '<'" al hacer JSON.parse.
          return err(
            422,
            'WP_UNREACHABLE',
            `${baseUrl} respondió ${root.status} a /wp-json/. ¿Es un WordPress?`,
          );
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
        // 422 (no 502): mismo razonamiento que arriba — el reverse proxy
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
        const ld = await req.http.get(`${baseUrl}/wp-json/ldlms/v1/sfwd-courses?per_page=1`, {
          headers: { Authorization: authHeader },
          timeoutMs: 10_000,
        });
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

  // POST /jobs — crea un job y lo encola en el job runner del host.
  //
  // Flujo (alpha.55+):
  //   1. Persiste el row en `mod_migrator_learndash_jobs` con status='pending'
  //      (ctx.db inyectado por el host).
  //   2. Llama `ctx.jobs.scheduleTick({ jobId })` — encola tickIndex=0 en la
  //      queue BullMQ `didacta.mod-jobs` del host. El worker invocará nuestro
  //      `onJobTick` en cuanto haya cupo (concurrency=4 por host).
  //   3. Devuelve 201 con jobId y un notice 'JOB_ENQUEUED' que el wizard
  //      muestra al usuario.
  //
  // Estado del pipeline (alpha.55):
  //   - State machine completa cableada en `onJobTick` (pending → preflight →
  //     extracting → transforming → loading → reconciling → completed).
  //   - Las fases `extracting` / `transforming` / `loading` / `reconciling`
  //     son STUBs (Sprint 4: ET-001..ET-005). Avanzan sin procesar datos.
  //   - El job llega a `completed` en ≤5 ticks pero NO migra contenido real
  //     hasta que el Sprint 4 reemplace los STUBs. El wizard debería avisar.
  {
    method: 'POST',
    path: '/jobs',
    handler: async (req) => {
      const auth = requireAdmin(req);
      if (isResponse(auth)) return auth;
      const db = requireDb(req);
      if (isResponse(db)) return db;
      const body = (req.body ?? {}) as {
        credentials?: { baseUrl?: string; username?: string; appPassword?: string };
        options?: Record<string, unknown>;
      };
      if (!body.credentials || !body.options) {
        return err(400, 'VALIDATION_ERROR', 'credentials + options requeridos.');
      }
      if (!body.credentials.appPassword) {
        return err(
          400,
          'VALIDATION_ERROR',
          'credentials.appPassword es obligatorio (Application Password de WP).',
        );
      }
      // ctx.secrets es REQUERIDO desde alpha.56 — sin él no podemos
      // guardar el appPassword cifrado y el worker BullMQ del primer
      // tick no tendría cómo autenticar contra WP. Si el host es
      // alpha.55 o anterior → 503 con mensaje accionable para que el
      // admin actualice antes de crear jobs.
      const secrets = req.secrets;
      if (!secrets) {
        return err(
          503,
          'SECRETS_NOT_AVAILABLE',
          'Este módulo requiere ctx.secrets (alpha.56+) y el host actual no lo expone. ' +
            'Actualiza Didacta a alpha.56 o superior y reinstala el módulo.',
        );
      }
      const sourceProfile = {
        baseUrl: body.credentials.baseUrl ?? null,
        username: body.credentials.username ?? null,
      };
      let jobId: string;
      try {
        jobId = await insertJob(db, auth.tenantId, auth.sub, sourceProfile, body.options);
      } catch (e) {
        return dbErrToResponse(e);
      }
      // Guardar el appPassword cifrado ANTES de encolar el primer tick.
      // Si falla, hacemos rollback del row (DELETE) para no dejar un job
      // huérfano que el worker no pueda procesar. Si el rollback falla,
      // logueamos pero respondemos al cliente con el error de secrets —
      // el admin verá un job en `pending` que ya nunca avanza y deberá
      // cancelarlo manualmente.
      const retentionDays =
        typeof body.options?.['retentionDays'] === 'number'
          ? (body.options['retentionDays'] as number)
          : 30;
      try {
        await persistJobAppPassword(secrets, jobId, body.credentials.appPassword, retentionDays);
      } catch (e) {
        const code = (e as { code?: string })?.code ?? 'SECRETS_WRITE_FAILED';
        const msg = e instanceof Error ? e.message : String(e);
        // Best-effort rollback. Si esto también falla, el job queda en
        // pending sin credenciales — el operador deberá cancelar manual.
        try {
          await db.execute(
            `DELETE FROM mod_migrator_learndash_jobs WHERE tenant_id = $1::uuid AND id = $2::uuid`,
            [auth.tenantId, jobId],
          );
        } catch {
          /* ignore */
        }
        return err(500, code, `No se pudo guardar appPassword cifrado: ${msg}. Job descartado.`);
      }
      // Encolar primer tick. Si la queue del host está deshabilitada
      // (REDIS_URL ausente) ctx.jobs lanza JOBS_QUEUE_DISABLED y NO
      // intentamos rollback del row — el operador puede setear Redis,
      // reiniciar el API y re-encolar manualmente con
      // POST /jobs/:id/retry (Sprint 4) sin perder el row.
      const ctxJobs = (req as { jobs?: { scheduleTick: (a: { jobId: string }) => Promise<void> } })
        .jobs;
      if (!ctxJobs || typeof ctxJobs.scheduleTick !== 'function') {
        return ok(
          {
            jobId,
            notice: {
              code: 'JOBS_HOST_TOO_OLD',
              severity: 'warning',
              message:
                'Job registrado pero el host es < alpha.55 — ctx.jobs.scheduleTick no está disponible. Actualiza el container para que el worker recoja el job.',
            },
          },
          201,
        );
      }
      try {
        await ctxJobs.scheduleTick({ jobId });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const code =
          e instanceof Error && 'code' in e && typeof (e as { code?: string }).code === 'string'
            ? (e as { code: string }).code
            : 'JOBS_ENQUEUE_FAILED';
        return ok(
          {
            jobId,
            notice: {
              code,
              severity: 'warning',
              message: `Job persistido pero NO se pudo encolar: ${msg}. Verifica REDIS_URL en el host.`,
            },
          },
          201,
        );
      }
      return ok(
        {
          jobId,
          notice: {
            code: 'JOB_ENQUEUED',
            severity: 'info',
            message:
              'Job encolado en el runner. El worker procesará los ticks automáticamente. ' +
              'Avance visible en GET /jobs/:id (status: pending → preflight → extracting → transforming → loading → reconciling → completed). ' +
              'Sprint 4 (alpha.56) implementó las fases reales: extract paginable (users/courses/lessons/topics/quizzes/groups), transform vía mappers + DLQ, load vía ctx.didacta.upsertByExternalRef, reconcile con validation_reports, audit chain SHA-256. ' +
              'Pendiente Sprint 5 (ET-001b): fan-out de questions per-quiz, enrollments per-course/group, media y progress. Hasta entonces, quizzes migran solo el shell (sin preguntas).',
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
          return err(
            409,
            'JOB_RACE',
            'el estado del job cambió durante la cancelación, recarga y reintenta.',
          );
        }
        // alpha.56: limpiar el appPassword cifrado para liberar slot de
        // quota antes del expiry natural. Best-effort: si falla, el log
        // queda y el expiry natural eventualmente lo limpia.
        await cleanupJobAppPassword(req.secrets, id, (level, message) =>
          console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
            `[mod.migrator-learndash] ${message}`,
          ),
        );
        return ok({ ok: true });
      } catch (e) {
        return dbErrToResponse(e);
      }
    },
  },

  // GET /jobs/:id/report — reporte real desde validation_reports + audit_events.
  // alpha.58: ya no es STUB. Lee mod_migrator_learndash_validation_reports
  // (escrito por ET-004) + mod_migrator_learndash_audit_events (escrito por
  // ET-005) y agrega totales. La UI Monitor lo consume al expandir un job.
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

        const reportsR = await db.query<{
          entity_type: string;
          source_count: number | string;
          staged_count: number | string;
          valid_count: number | string;
          loaded_count: number | string;
          skipped_count: number | string;
          failed_count: number | string;
        }>(
          `SELECT entity_type, source_count, staged_count, valid_count,
                  loaded_count, skipped_count, failed_count
             FROM mod_migrator_learndash_validation_reports
            WHERE tenant_id = $1::uuid AND job_id = $2::uuid
            ORDER BY entity_type`,
          [auth.tenantId, id],
        );
        const byEntity = reportsR.rows.map((r) => ({
          entityType: r.entity_type,
          sourceCount: Number(r.source_count),
          stagedCount: Number(r.staged_count),
          validCount: Number(r.valid_count),
          loadedCount: Number(r.loaded_count),
          skippedCount: Number(r.skipped_count),
          failedCount: Number(r.failed_count),
        }));
        const totals = byEntity.reduce(
          (acc, e) => ({
            sourceCount: acc.sourceCount + e.sourceCount,
            loadedCount: acc.loadedCount + e.loadedCount,
            skippedCount: acc.skippedCount + e.skippedCount,
            failedCount: acc.failedCount + e.failedCount,
          }),
          { sourceCount: 0, loadedCount: 0, skippedCount: 0, failedCount: 0 },
        );

        const auditR = await db.query<{
          count: string;
          first_hash: string | null;
          last_hash: string | null;
        }>(
          `SELECT COUNT(*)::text AS count,
                  MIN(hash) FILTER (WHERE prev_hash IS NULL) AS first_hash,
                  (SELECT hash FROM mod_migrator_learndash_audit_events
                    WHERE tenant_id = $1::uuid AND job_id = $2::uuid
                    ORDER BY occurred_at DESC LIMIT 1) AS last_hash
             FROM mod_migrator_learndash_audit_events
            WHERE tenant_id = $1::uuid AND job_id = $2::uuid`,
          [auth.tenantId, id],
        );
        const audit = auditR.rows[0];
        const eventsCount = Number(audit?.count ?? '0');

        return ok({
          jobId: job.id,
          status: job.status,
          generatedAt: nowIso(),
          totals,
          byEntity,
          auditChain: {
            eventsCount,
            firstHash: audit?.first_hash ?? null,
            lastHash: audit?.last_hash ?? null,
            verified: eventsCount > 0,
          },
        });
      } catch (e) {
        return dbErrToResponse(e);
      }
    },
  },

  // GET /jobs/:id/dlq — listado paginado de filas en DLQ del job. La UI
  // Monitor lo usa al expandir un job para mostrar las primeras N causas
  // de fallo (transform: MISSING_EMAIL / MISSING_DEPENDENCY / MALFORMED_PAYLOAD;
  // load: DIDACTA_VALIDATION_ERROR / DIDACTA_FOREIGN_REFERENCE / etc.).
  // Query params:
  //   - limit (default 20, cap 200)
  //   - phase (optional: 'transform' | 'load' — filtro)
  //   - entity (optional: filtro por entity_type)
  {
    method: 'GET',
    path: '/jobs/:id/dlq',
    handler: async (req) => {
      const auth = requireAdmin(req);
      if (isResponse(auth)) return auth;
      const db = requireDb(req);
      if (isResponse(db)) return db;
      const id = req.params['id'];
      if (!id) return err(400, 'VALIDATION_ERROR', 'falta :id.');
      const rawLimit = Number(req.query['limit']);
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(200, Math.floor(rawLimit)) : 20;
      const phaseFilter =
        typeof req.query['phase'] === 'string' ? (req.query['phase'] as string) : null;
      const entityFilter =
        typeof req.query['entity'] === 'string' ? (req.query['entity'] as string) : null;
      try {
        const conditions = ['tenant_id = $1::uuid', 'job_id = $2::uuid'];
        const params: unknown[] = [auth.tenantId, id];
        if (phaseFilter) {
          params.push(phaseFilter);
          conditions.push(`phase = $${params.length}`);
        }
        if (entityFilter) {
          params.push(entityFilter);
          conditions.push(`entity_type = $${params.length}`);
        }
        const result = await db.query<{
          entity_type: string;
          source_id: string | null;
          phase: string;
          error_code: string;
          error_message: string;
          created_at: string;
        }>(
          `SELECT entity_type, source_id, phase, error_code, error_message, created_at
             FROM mod_migrator_learndash_dlq
            WHERE ${conditions.join(' AND ')}
            ORDER BY created_at DESC
            LIMIT ${limit}`,
          params,
        );
        const countR = await db.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total
             FROM mod_migrator_learndash_dlq
            WHERE ${conditions.join(' AND ')}`,
          params,
        );
        return ok({
          items: result.rows.map((r) => ({
            entityType: r.entity_type,
            sourceId: r.source_id,
            phase: r.phase,
            errorCode: r.error_code,
            errorMessage: r.error_message,
            createdAt: r.created_at,
          })),
          total: Number(countR.rows[0]?.total ?? '0'),
          limit,
          phase: phaseFilter,
          entity: entityFilter,
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
      'mod.migrator-learndash: ctx.db NO inyectado — los handlers /jobs devolverán 503 hasta que actualices el host a alpha.51+.',
    );
  }
}

async function onUninstall(ctx: ModuleInstallContext): Promise<void> {
  ctx.log(
    'log',
    `mod.migrator-learndash: onUninstall — las tablas mod_migrator_learndash_* persisten (DDL DROP la haría el operador via psql tras backup; nunca el módulo).`,
  );
}

// ---- onJobTick: state machine cooperativa (alpha.53+ / Sprint 3) ------
//
// El worker BullMQ del host invoca esta función por cada tick del job.
// El módulo decide qué hacer en cada tick según `job.status`. Cada tick
// avanza UNA fase O un batch dentro de una fase y devuelve un resultado
// que indica al worker si re-encolar (continue), terminar (completed),
// o fallar (failed).
//
// Estados:
//   pending → preflight → extracting → transforming → loading
//                                                  → reconciling
//                                                  → completed
//                       ↘ cancelled
//                       ↘ failed
//
// Reglas:
// 1. Cancelación cooperativa (JR-005): cada tick lee el status actual
//    PRIMERO. Si está `cancelled`, retornamos `completed` sin trabajo —
//    el cambio de status lo dispara `POST /jobs/:id/cancel` de forma
//    asíncrona, este tick lo respeta sin race.
// 2. Transiciones atómicas (JR-004): cada cambio de fase usa CAS
//    (`tryTransition`). Si dos workers procesan el mismo job en
//    paralelo, solo uno tiene éxito en cada transición; el otro re-lee
//    y procede con el nuevo estado.
// 3. Idempotencia: re-correr el mismo tick (BullMQ retry, network
//    glitch, restart del worker) no debe corromper. Las transiciones
//    son CAS-protected; los batches dentro de una fase ya tienen
//    idempotencia via externalRef (ctx.didacta.upsertByExternalRef).
//
// Sprint 4 (ET-001..ET-005) implementa las fases reales de extracting/
// transforming/loading/reconciling. En alpha.53 son STUBs que solo
// avanzan al siguiente estado para validar el wiring end-to-end.

async function onJobTick(ctx: ModuleJobTickContext): Promise<JobTickResult> {
  const { db, tenantId, jobId, tickIndex } = ctx;

  // 1. Leer estado actual. Si el job no existe, abortamos (puede haber
  //    sido borrado por un cleanup del operador entre encolado y tick).
  let job: JobRecord | undefined;
  try {
    job = await getJob(db, tenantId, jobId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.log('error', `tick ${tickIndex}: error leyendo job ${jobId}: ${msg}`);
    return { status: 'failed', reason: `db_error_reading_job: ${msg}` };
  }
  if (!job) {
    ctx.log(
      'warn',
      `tick ${tickIndex}: job ${jobId} no encontrado — fue borrado o el ID es inválido.`,
    );
    return { status: 'failed', reason: 'JOB_NOT_FOUND' };
  }

  // 2. Cancelación cooperativa (JR-005). Si POST /jobs/:id/cancel marcó
  //    el status como 'cancelled', este tick respeta el cambio y
  //    completa sin trabajo. Sin signals globales ni race condition:
  //    el read-then-decide en cada tick es la garantía.
  if (job.status === 'cancelled') {
    ctx.log('log', `tick ${tickIndex}: job ${jobId} cancelado — completando tick sin trabajo.`);
    return { status: 'completed' };
  }

  // 3. Estados terminales: nada más que hacer. Esto sucede si BullMQ
  //    re-encola un job tras una completion exitosa por error de
  //    deduplicación, o si el worker re-procesa un job ya finalizado.
  if (job.status === 'completed' || job.status === 'failed') {
    return { status: 'completed' };
  }

  // 4. State machine. Cada case avanza UNA fase. En Sprint 4 cada case
  //    procesará UN batch dentro de la fase y solo transicionará al
  //    siguiente estado cuando ese batch sea el último.
  try {
    switch (job.status) {
      case 'pending': {
        const advanced = await tryTransition(db, tenantId, jobId, 'pending', 'preflight');
        if (!advanced) {
          // Otro tick ya cambió el estado. Re-encolamos sin delay para
          // procesar el nuevo estado en el próximo tick.
          return { status: 'continue', delaySec: 0 };
        }
        ctx.log('log', `tick ${tickIndex}: job ${jobId} pending → preflight.`);
        return { status: 'continue', delaySec: 0 };
      }

      case 'preflight': {
        // El preflight real ya se ejecuta en POST /preflight (handler
        // sincrónico, antes de crear el job). En esta fase solo
        // confirmamos el setup y avanzamos. Sprint 4 podría mover el
        // preflight async aquí si fuera muy lento.
        const advanced = await tryTransition(db, tenantId, jobId, 'preflight', 'extracting');
        if (!advanced) return { status: 'continue', delaySec: 0 };
        ctx.log('log', `tick ${tickIndex}: job ${jobId} preflight → extracting.`);
        return { status: 'continue', delaySec: 0 };
      }

      case 'extracting': {
        // Sprint 4 / ET-001 — extract phase per-tick.
        //
        // Cada tick:
        //   1. Leer cursor de progress JSONB. Inicial = users page 1.
        //   2. Recuperar appPassword via ctx.secrets (escrito en POST /jobs).
        //   3. Fetch UNA página de la entity actual via paginateWp (1 req WP).
        //   4. Para cada item de la página, upsert a stg_<entity>.
        //   5. Avanzar cursor: page++ si la página llegó completa; si fue
        //      la última página de la entity (vacía o page>=totalPages),
        //      marcar entity completed y mover a la siguiente entity (page=1).
        //   6. Cuando completed.length == EXTRACT_ENTITIES.length →
        //      tryTransition a 'transforming'.
        //
        // Idempotencia: re-extract por re-tick del BullMQ no duplica porque
        // upsert por (tenant_id, job_id, source_id). El checksum SHA-256
        // permite a la transform phase saltar items idénticos.
        //
        // Limitación documentada: entities "fan-out" (questions por quiz,
        // enrollments por course/group) NO están en este loop. Quedan para
        // ET-001b — necesitan leer staging para listar parents y luego
        // hacer N requests por parent. La phase termina sin ellas; se
        // ejecutarán al final del extract antes de transicionar.

        const job0 = job;
        const sourceProfile = (job0 as unknown as { sourceProfile?: Record<string, unknown> })
          .sourceProfile;
        // sourceProfile no viene en JobRecord — leemos de BD si falta.
        let baseUrl: string | null = (sourceProfile?.['baseUrl'] as string) ?? null;
        let username: string | null = (sourceProfile?.['username'] as string) ?? null;
        if (!baseUrl || !username) {
          const r = await db.query<{ source_profile: { baseUrl?: string; username?: string } }>(
            `SELECT source_profile FROM mod_migrator_learndash_jobs WHERE tenant_id = $1::uuid AND id = $2::uuid LIMIT 1`,
            [tenantId, jobId],
          );
          const sp = r.rows[0]?.source_profile ?? {};
          baseUrl = baseUrl ?? sp.baseUrl ?? null;
          username = username ?? sp.username ?? null;
        }
        if (!baseUrl || !username) {
          await setJobStatus(db, tenantId, jobId, 'failed', nowIso());
          await cleanupJobAppPassword(ctx.secrets, jobId, ctx.log);
          return { status: 'failed', reason: 'SOURCE_PROFILE_INCOMPLETE' };
        }

        const appPassword = await readJobAppPassword(ctx.secrets, jobId);
        if (!appPassword) {
          ctx.log(
            'error',
            `tick ${tickIndex}: appPassword no encontrado para job ${jobId}. Marcando failed.`,
          );
          await setJobStatus(db, tenantId, jobId, 'failed', nowIso());
          return { status: 'failed', reason: 'CREDENTIALS_NOT_FOUND' };
        }
        const authHeader = basicAuthHeader(username, appPassword);

        let cursor = parseExtractCursor(job0.progress);

        // Sample mode (v1.0.32+): si el job se creó con options.sample y este
        // es el primer tick del extract (cursor fresh — completed vacío),
        // forzar subphase 'sample-pick' antes del paginate global. Sin esto,
        // un job sample arrancaría paginate normal y traería los miles de
        // usuarios del origen igual que un import full — exactamente el bug
        // que el flag está para evitar.
        const sampleCfg = readSampleConfig((job0 as { options?: unknown }).options);
        const isFreshExtract =
          cursor.completed.length === 0 &&
          (cursor.totalsPerEntity == null || Object.keys(cursor.totalsPerEntity).length === 0);
        if (
          sampleCfg &&
          isFreshExtract &&
          cursor.subphase !== 'sample-pick' &&
          cursor.subphase !== 'fixup'
        ) {
          cursor = { ...cursor, subphase: 'sample-pick' };
        }

        // Scope (v1.1.0+): en extract, saltar las entidades fuera del scope
        // marcándolas como `completed` en el cursor fresco — el paginate normal
        // (nextEntity) no las recorrerá. Mismo mecanismo que sample-pick. No
        // aplica en sample-pick (gestiona su propio completed) ni en modo 'all'
        // (extract.set las contiene todas → skipped vacío → cero cambio).
        const scopeCfg = readScopeConfig((job0 as { options?: unknown }).options);
        if (isFreshExtract && cursor.subphase !== 'sample-pick' && cursor.subphase !== 'fixup') {
          const allNames = EXTRACT_ENTITIES.map((e) => e.name);
          const skipped = allNames.filter((n) => !scopeCfg.extract.has(n));
          if (skipped.length > 0) {
            const firstNeeded = allNames.find((n) => scopeCfg.extract.has(n)) ?? allNames[0]!;
            cursor = {
              ...cursor,
              current: firstNeeded,
              completed: Array.from(new Set([...cursor.completed, ...skipped])),
            };
            ctx.log(
              'log',
              `tick ${tickIndex}: scope='${scopeCfg.mode}' — extract salta [${skipped.join(', ')}], arranca en '${firstNeeded}'.`,
            );
          }
        }

        // SUBPHASE SAMPLE-PICK: ejecuta UNA VEZ por job en sample mode.
        // Elige UN curso aleatorio del origen que tenga ≥1 alumno enrolado,
        // inyecta a stg_courses ese único curso + a stg_users hasta N alumnos
        // del curso, y avanza a subphase 'paginate' con users/courses/groups
        // marcados como completed. El paginate normal continuará desde
        // 'lessons' (perCourse), procesando solo el único curso del staging.
        //
        // Coste: 1 paginación completa de /sfwd-courses (1-N requests) + un
        // /sfwd-courses/{id}/users por candidato hasta encontrar uno con
        // alumnos. Para academias típicas (<500 cursos, mayoría con alumnos)
        // termina en 2-5 requests.
        //
        // Fallback: si NINGÚN curso del origen tiene alumnos, procesamos el
        // primer shuffled sin enrollments (sample sigue siendo útil para
        // validar el flow estructural extract→transform→load) + warning.
        if (cursor.subphase === 'sample-pick') {
          if (!sampleCfg) {
            // Defensa: cursor dice sample-pick pero options no tiene sample.
            // Reset a paginate normal para no quedar atascado.
            cursor = emptyExtractCursor();
            await setJobProgress(db, tenantId, jobId, cursor as unknown as Record<string, unknown>);
            ctx.log(
              'warn',
              `tick ${tickIndex}: cursor en sample-pick sin options.sample. Reset a paginate.`,
            );
            return { status: 'continue', delaySec: 0 };
          }

          // 1) Listar todos los cursos del origen (paginado).
          const allCourses: Array<{
            id: number;
            title?: { rendered?: string } | string;
            slug?: string;
          }> = [];
          let coursePage = 1;
          // Hard cap por defensa contra fuente que pretenda paginar infinitamente.
          const MAX_COURSE_PAGES = 50;
          while (coursePage <= MAX_COURSE_PAGES) {
            let pr;
            try {
              pr = await fetchOneWpPage<{
                id: number;
                title?: { rendered?: string } | string;
                slug?: string;
              }>(ctx.http, baseUrl, 'sfwd-courses', authHeader, coursePage, 100, 'ldlms/v1');
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              ctx.log(
                'warn',
                `sample-pick: paginar courses page=${coursePage} falló: ${msg}. Re-encolando.`,
              );
              return { status: 'continue', delaySec: 30 };
            }
            allCourses.push(...pr.items);
            if (
              pr.items.length === 0 ||
              (pr.totalPages !== undefined && coursePage >= pr.totalPages)
            ) {
              break;
            }
            coursePage += 1;
          }

          if (allCourses.length === 0) {
            await setJobStatus(db, tenantId, jobId, 'failed', nowIso());
            await cleanupJobAppPassword(ctx.secrets, jobId, ctx.log);
            ctx.log(
              'error',
              `sample-pick: el origen no devolvió ningún curso. Job marcado failed.`,
            );
            return { status: 'failed', reason: 'SAMPLE_NO_COURSES_IN_SOURCE' };
          }

          // 2) Shuffle Fisher-Yates con Math.random — no necesitamos determinismo
          // en producción (cada job de prueba debe elegir distinto si se reintenta).
          for (let i = allCourses.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [allCourses[i], allCourses[j]] = [allCourses[j]!, allCourses[i]!];
          }

          // 3) Buscar primer curso con ≥1 alumno enrolado.
          let selectedCourse: (typeof allCourses)[number] | null = null;
          let selectedUsers: Array<Record<string, unknown> & { id: number }> = [];
          const targetUsers = sampleCfg.usersPerCourse;
          for (const candidate of allCourses) {
            try {
              // GET /sfwd-courses/{id}/users devuelve WpUser[] con detalles
              // completos (no solo IDs). Limitamos via per_page = targetUsers
              // (la API respeta el cap; si el curso tiene menos, devuelve todos).
              const url = `${baseUrl}/wp-json/ldlms/v1/sfwd-courses/${candidate.id}/users?per_page=${targetUsers}&page=1`;
              const r = await ctx.http.get(url, {
                headers: { Authorization: authHeader, Accept: 'application/json' },
                timeoutMs: 30_000,
              });
              if (r.status >= 400) continue;
              const parsed: unknown = JSON.parse(r.body);
              if (Array.isArray(parsed) && parsed.length >= 1) {
                selectedCourse = candidate;
                selectedUsers = parsed.slice(0, targetUsers) as typeof selectedUsers;
                break;
              }
            } catch {
              // Curso candidato dio error en /users — pasamos al siguiente.
            }
          }

          let fallbackNote: string | null = null;
          if (!selectedCourse) {
            // Ningún curso con alumnos. Tomamos el primer shuffled.
            selectedCourse = allCourses[0]!;
            selectedUsers = [];
            fallbackNote =
              'Ningún curso del origen tiene alumnos enrolados. Sample procesará solo la estructura del curso (sin alumnos).';
            ctx.log('warn', `sample-pick: ${fallbackNote} courseId=${selectedCourse.id}.`);
          }

          // 4) Upsert curso elegido a stg_courses.
          await upsertStgCourse(
            db,
            tenantId,
            jobId,
            String(selectedCourse.id),
            selectedCourse,
            computeChecksum(selectedCourse),
          );

          // 5) Upsert alumnos del sample a stg_users.
          for (const u of selectedUsers) {
            await upsertStgUser(db, tenantId, jobId, String(u.id), u, computeChecksum(u));
          }

          // 6) Avanzar cursor a paginate desde lessons.
          // courses/users/groups quedan completed → no se iteran globalmente.
          // lessons/topics/quizzes son perCourse y solo verán el único curso
          // que acabamos de inyectar.
          const newCursor: ExtractCursor = {
            phase: 'extract',
            subphase: 'paginate',
            current: 'lessons',
            page: 1,
            courseIdx: 0,
            completed: ['users', 'courses', 'groups'],
            totalsPerEntity: {
              users: selectedUsers.length,
              courses: 1,
              groups: 0,
            },
            sampleCourseId: String(selectedCourse.id),
          };
          await setJobProgress(
            db,
            tenantId,
            jobId,
            newCursor as unknown as Record<string, unknown>,
          );
          ctx.log(
            'log',
            `sample-pick OK: curso ${selectedCourse.id} (de ${allCourses.length} disponibles) con ${selectedUsers.length} alumnos. Avanza a paginate desde lessons.${fallbackNote ? ` ${fallbackNote}` : ''}`,
          );
          return { status: 'continue', delaySec: 0 };
        }

        // SUBPHASE FIXUP: corregir parent_course_id en stg via /steps por curso.
        // Cada tick procesa UN curso (1 GET + N UPDATEs). Cuando agotamos
        // todos, transicionamos a 'transforming'.
        if (cursor.subphase === 'fixup') {
          const coursesQ = await db.query<{ source_id: string }>(
            `SELECT source_id FROM mod_migrator_learndash_stg_courses
              WHERE tenant_id = $1::uuid AND job_id = $2::uuid
              ORDER BY source_id ASC`,
            [tenantId, jobId],
          );
          const courseIds = coursesQ.rows.map((r) => r.source_id);
          const totalCourses = cursor.fixupTotalCourses ?? courseIds.length;
          const idx = cursor.courseIdx ?? 0;

          // NOTA: en 1.0.22-24 había un RESET masivo a NULL en idx===0.
          // Ese reset corría idempotente (cada tick re-evaluaba idx===0) y,
          // combinado con re-encolados del BullMQ, terminaba sobrescribiendo
          // los UPDATEs que el propio fixup hacía. Lo quitamos: las lessons
          // que NO aparezcan en ningún /steps quedan con el parent_course_id
          // del último iter del paginate (curso ASC string último = 9919).
          // No ideal pero RECUPERABLE: los UPDATEs subsiguientes lo corrigen
          // para las que SÍ aparecen.

          if (idx >= courseIds.length) {
            // Todos los cursos procesados en fixup. Si el scope incluye
            // enrollments (modos 'all' / 'enrolled-students'), pasamos a la
            // subfase 'enroll'; si no, transición directa a transforming.
            if (scopeCfg.extract.has('enrollments')) {
              await setJobProgress(db, tenantId, jobId, {
                ...cursor,
                subphase: 'enroll',
                courseIdx: 0,
              } as unknown as Record<string, unknown>);
              ctx.log(
                'log',
                `tick ${tickIndex}: fixup completed. Scope '${scopeCfg.mode}' incluye enrollments → subfase 'enroll'.`,
              );
              return { status: 'continue', delaySec: 0 };
            }
            const advanced = await tryTransition(db, tenantId, jobId, 'extracting', 'transforming');
            if (!advanced) return { status: 'continue', delaySec: 0 };
            ctx.log(
              'log',
              `tick ${tickIndex}: fixup completed (${totalCourses} cursos). Transition a transforming.`,
            );
            return { status: 'continue', delaySec: 0 };
          }

          const courseSourceId = courseIds[idx]!;
          try {
            const stepsUrl = `${baseUrl}/wp-json/ldlms/v1/sfwd-courses/${encodeURIComponent(courseSourceId)}/steps`;
            const resp = await ctx.http.get(stepsUrl, {
              headers: { Authorization: authHeader, Accept: 'application/json' },
              timeoutMs: 30_000,
            });
            if (resp.status >= 400) {
              ctx.log(
                'warn',
                `tick ${tickIndex}: fixup /steps curso ${courseSourceId} HTTP ${resp.status}: ${resp.body.slice(0, 200)}.`,
              );
            } else {
              const parsed: unknown = JSON.parse(resp.body);
              // LearnDash REST v1 /steps retorna un OBJETO jerárquico. La
              // documentación oficial usa keys con CPT name (`sfwd-lessons:N`,
              // `sfwd-topic:N`, `sfwd-quiz:N`) pero algunas instalaciones
              // emiten shortname (`lesson:N`, `topic:N`, `quiz:N`). Aceptamos
              // ambos, además de:
              //   - posibles keys numéricas con type en el value
              //   - posibles arrays de objetos {id, type, parent}
              // El field anidado puede ser `steps` o el value mismo.
              // Aplanamos recursivamente. `parentLessonId` se hereda solo si
              // el item es topic/quiz; cuando el walker entra a una lesson,
              // su id se pasa a los hijos como nuevo parentLessonId.
              const flat: Array<{ id: number; type: string; parentLessonId: number | null }> = [];
              const resolveType = (raw: string): string | null => {
                const s = raw.toLowerCase();
                if (s === 'lesson' || s === 'sfwd-lessons' || s === 'l') return 'sfwd-lessons';
                if (s === 'topic' || s === 'sfwd-topic' || s === 't') return 'sfwd-topic';
                if (s === 'quiz' || s === 'sfwd-quiz' || s === 'r') return 'sfwd-quiz';
                return null;
              };
              // IDs de un nodo hijo de la jerarquía `h`: o un array de números,
              // o un objeto keyed-by-id (`{ "6048": [] }`). Ambos aparecen.
              const idsOf = (v: unknown): number[] => {
                if (Array.isArray(v))
                  return v
                    .map((x) => (typeof x === 'number' ? x : parseInt(String(x), 10)))
                    .filter((n) => Number.isFinite(n) && n > 0);
                if (v && typeof v === 'object')
                  return Object.keys(v as Record<string, unknown>)
                    .map((k) => parseInt(k, 10))
                    .filter((n) => Number.isFinite(n) && n > 0);
                return [];
              };

              // FORMATO REAL de LearnDash REST v1 `/sfwd-courses/{id}/steps`
              // (verificado contra un LearnDash productivo, 2026-06-26):
              //   h: { "sfwd-lessons": { "<lessonId>": { "sfwd-topic": {…|[]},
              //                                          "sfwd-quiz": {…|[]} }, … },
              //        "sfwd-quiz": {…|[]} }   // quizzes a nivel curso
              //   l: [ "sfwd-lessons:<id>", "sfwd-quiz:<id>", … ]  // lista plana
              //   sections: [ { post_title, steps: [<lessonId>…] }, … ]
              // El parser ANTERIOR (walk) solo entendía claves "type:id" — un
              // formato que ESTA instalación NO emite — así que `flat` salía
              // vacío y NINGUNA lección se reasignaba a su curso/sección (todas
              // quedaban bajo el curso catch-all del extract). Ahora leemos `h`
              // (estructura primaria) con fallback a `l` y al formato legacy.
              const hRoot = (parsed as { h?: unknown }).h;
              if (hRoot && typeof hRoot === 'object' && !Array.isArray(hRoot)) {
                const hobj = hRoot as Record<string, unknown>;
                const lessonsNode = hobj['sfwd-lessons'];
                if (lessonsNode && typeof lessonsNode === 'object' && !Array.isArray(lessonsNode)) {
                  for (const [lidStr, lval] of Object.entries(
                    lessonsNode as Record<string, unknown>,
                  )) {
                    const lid = parseInt(lidStr, 10);
                    if (!Number.isFinite(lid) || lid <= 0) continue;
                    flat.push({ id: lid, type: 'sfwd-lessons', parentLessonId: null });
                    if (lval && typeof lval === 'object') {
                      const lobj = lval as Record<string, unknown>;
                      for (const tid of idsOf(lobj['sfwd-topic']))
                        flat.push({ id: tid, type: 'sfwd-topic', parentLessonId: lid });
                      for (const qid of idsOf(lobj['sfwd-quiz']))
                        flat.push({ id: qid, type: 'sfwd-quiz', parentLessonId: lid });
                    }
                  }
                }
                for (const qid of idsOf(hobj['sfwd-quiz']))
                  flat.push({ id: qid, type: 'sfwd-quiz', parentLessonId: null });
              }

              // Fallback 1: lista plana `l` con strings "type:id" (si `h` faltó).
              if (flat.length === 0) {
                const lList = (parsed as { l?: unknown }).l;
                if (Array.isArray(lList)) {
                  for (const item of lList) {
                    if (typeof item !== 'string') continue;
                    const m = item.match(/^([a-zA-Z][a-zA-Z0-9_-]*):(\d+)$/);
                    if (!m) continue;
                    const t = resolveType(m[1]!);
                    if (t) flat.push({ id: parseInt(m[2]!, 10), type: t, parentLessonId: null });
                  }
                }
              }

              // Fallback 2: formato legacy con claves "type:id" anidadas
              // (instalaciones que SÍ lo emiten). Solo si los anteriores fallan.
              if (flat.length === 0) {
                const walk = (node: unknown, parentLessonId: number | null): void => {
                  if (!node || typeof node !== 'object') return;
                  if (Array.isArray(node)) {
                    for (const it of node) {
                      if (it && typeof it === 'object') {
                        const obj = it as { id?: number | string; type?: string };
                        if (obj.id !== undefined && typeof obj.type === 'string') {
                          const t = resolveType(obj.type);
                          if (t)
                            flat.push({
                              id:
                                typeof obj.id === 'number' ? obj.id : parseInt(String(obj.id), 10),
                              type: t,
                              parentLessonId: t === 'sfwd-lessons' ? null : parentLessonId,
                            });
                        }
                        walk(it, parentLessonId);
                      }
                    }
                    return;
                  }
                  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
                    const m = key.match(/^([a-zA-Z][a-zA-Z0-9_-]*):(\d+)$/);
                    if (m) {
                      const resolvedType = resolveType(m[1]!);
                      const id = parseInt(m[2]!, 10);
                      if (resolvedType)
                        flat.push({
                          id,
                          type: resolvedType,
                          parentLessonId: resolvedType === 'sfwd-lessons' ? null : parentLessonId,
                        });
                      const newParent = resolvedType === 'sfwd-lessons' ? id : parentLessonId;
                      if (value && typeof value === 'object') {
                        const innerSteps = (value as { steps?: unknown }).steps;
                        if (innerSteps !== undefined && innerSteps !== null)
                          walk(innerSteps, newParent);
                        else walk(value, newParent);
                      }
                    } else if (value && typeof value === 'object') {
                      walk(value, parentLessonId);
                    }
                  }
                };
                walk(parsed, null);
              }

              // Parsear `sections` del response — el course builder de
              // LearnDash agrupa lessons en "section-headings" con
              // `{order, post_title, type: 'section-heading', steps: [id...]}`.
              // Los persistimos en raw_payload del course (campo `__sections`)
              // para que mapCourse los propague al canonical y el load cree
              // UN courseModule sintético por section.
              type Section = { idx: number; title: string; lessonIds: number[] };
              const parsedSections: Section[] = [];
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const sectionsField = (parsed as { sections?: unknown }).sections;
                if (Array.isArray(sectionsField)) {
                  let secIdx = 0;
                  for (const s of sectionsField) {
                    if (!s || typeof s !== 'object') continue;
                    const obj = s as { post_title?: unknown; steps?: unknown; type?: unknown };
                    const title = typeof obj.post_title === 'string' ? obj.post_title.trim() : '';
                    const steps = Array.isArray(obj.steps) ? obj.steps : [];
                    const lessonIds = steps
                      .map((x) => (typeof x === 'number' ? x : parseInt(String(x), 10)))
                      .filter((x) => Number.isFinite(x) && x > 0);
                    if (title && lessonIds.length > 0) {
                      parsedSections.push({ idx: secIdx, title, lessonIds });
                      secIdx += 1;
                    }
                  }
                }
              }

              // Map de lessonId → sectionIdx para asignar parent_course_id
              // con encoding por sección.
              const lessonToSection = new Map<number, number>();
              for (const sec of parsedSections) {
                for (const lessonId of sec.lessonIds) {
                  lessonToSection.set(lessonId, sec.idx);
                }
              }

              // Persistir las sections en stg_courses.raw_payload.__sections
              // para que mapCourse las propague al canonical.
              if (parsedSections.length > 0) {
                try {
                  await db.execute(
                    `UPDATE mod_migrator_learndash_stg_courses
                        SET raw_payload = jsonb_set(raw_payload, '{__sections}', $1::jsonb, true),
                            is_valid = FALSE,
                            validation_errors = NULL,
                            canonical = NULL
                      WHERE tenant_id = $2::uuid AND job_id = $3::uuid AND source_id = $4`,
                    [JSON.stringify(parsedSections), tenantId, jobId, courseSourceId],
                  );
                } catch (e) {
                  ctx.log(
                    'warn',
                    `fixup persist sections curso ${courseSourceId} falló: ${e instanceof Error ? e.message : e}`,
                  );
                }
              }

              let lessonsHit = 0;
              let topicsHit = 0;
              let quizzesHit = 0;
              const sampleIdsTried: string[] = [];
              for (const step of flat) {
                const stepId = String(step.id);
                if (sampleIdsTried.length < 5) sampleIdsTried.push(stepId);
                if (step.type === 'sfwd-lessons') {
                  // Si la lesson pertenece a una section, parent_course_id
                  // codifica `{course}-s{idx}` para que el load la asocie al
                  // module sintético de esa section. Sin section, queda el
                  // courseId pelado → module 'General' de fallback.
                  const sectionIdx = lessonToSection.get(step.id);
                  const moduleExtId =
                    sectionIdx !== undefined ? `${courseSourceId}-s${sectionIdx}` : courseSourceId;
                  const r = await db.execute(
                    `UPDATE mod_migrator_learndash_stg_lessons
                        SET parent_course_id = $1
                      WHERE tenant_id = $2::uuid AND job_id = $3::uuid AND source_id = $4`,
                    [moduleExtId, tenantId, jobId, stepId],
                  );
                  lessonsHit += r.rowCount ?? 0;
                } else if (step.type === 'sfwd-topic') {
                  const parentLessonId = step.parentLessonId ? String(step.parentLessonId) : null;
                  const r = await db.execute(
                    `UPDATE mod_migrator_learndash_stg_topics
                        SET parent_course_id = $1, parent_lesson_id = $2
                      WHERE tenant_id = $3::uuid AND job_id = $4::uuid AND source_id = $5`,
                    [courseSourceId, parentLessonId, tenantId, jobId, stepId],
                  );
                  topicsHit += r.rowCount ?? 0;
                } else if (step.type === 'sfwd-quiz') {
                  const r = await db.execute(
                    `UPDATE mod_migrator_learndash_stg_quizzes
                        SET parent_course_id = $1
                      WHERE tenant_id = $2::uuid AND job_id = $3::uuid AND source_id = $4`,
                    [courseSourceId, tenantId, jobId, stepId],
                  );
                  quizzesHit += r.rowCount ?? 0;
                }
              }
              // Diagnóstico del fixup en el log (NO en audit_events). Antes
              // se insertaba un evento `fixup.steps.debug` con hash sintético
              // ('debug-...') en la cadena de auditoría — rompía la
              // continuidad prev_hash→hash de la cadena SHA-256 e inflaba el
              // eventsCount que el report usa para `verified`. El diagnóstico
              // vive aquí, fuera de la cadena criptográfica.
              ctx.log(
                'log',
                `tick ${tickIndex}: fixup curso #${idx + 1}/${totalCourses} (${courseSourceId}) — flat=${flat.length} lessons=${lessonsHit} topics=${topicsHit} quizzes=${quizzesHit} sample_ids=[${sampleIdsTried.join(', ')}].`,
              );
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ctx.log(
              'warn',
              `tick ${tickIndex}: fixup curso ${courseSourceId} excepción: ${msg}. Sigue al siguiente.`,
            );
          }

          const nextIdx = idx + 1;
          const fixupCursor: ExtractCursor = {
            ...cursor,
            courseIdx: nextIdx,
            fixupTotalCourses: totalCourses,
          };
          await setJobProgress(
            db,
            tenantId,
            jobId,
            fixupCursor as unknown as Record<string, unknown>,
          );
          return { status: 'continue', delaySec: 0 };
        }

        // SUBFASE ENROLL (v1.1.0+): extraer matrículas curso→usuario. Igual que
        // fixup, procesa UN curso por tick (pagina /sfwd-courses/{id}/users) y
        // por cada alumno escribe una fila en stg_enrollments con canonical ya
        // computado (mapDirectEnrollment) e is_valid=TRUE. Idempotente por el
        // unique index. Al agotar los cursos, transición a transforming.
        if (cursor.subphase === 'enroll') {
          const coursesQ = await db.query<{ source_id: string }>(
            `SELECT source_id FROM mod_migrator_learndash_stg_courses
              WHERE tenant_id = $1::uuid AND job_id = $2::uuid
              ORDER BY source_id ASC`,
            [tenantId, jobId],
          );
          const courseIds = coursesQ.rows.map((r) => r.source_id);
          const idx = cursor.courseIdx ?? 0;
          if (idx >= courseIds.length) {
            const advanced = await tryTransition(db, tenantId, jobId, 'extracting', 'transforming');
            if (!advanced) return { status: 'continue', delaySec: 0 };
            ctx.log(
              'log',
              `tick ${tickIndex}: enroll completed (${courseIds.length} cursos). Transition a transforming.`,
            );
            return { status: 'continue', delaySec: 0 };
          }
          const courseSourceId = courseIds[idx]!;
          let enrolledCount = 0;
          // Un corte a mitad de paginación NO es el final de la lista. Antes
          // cualquier 5xx o JSON roto hacía `break` y el cursor avanzaba igual
          // (`courseIdx: idx + 1`): un 500 transitorio en la página 3 de un
          // curso de 900 alumnos perdía las páginas 3+ para siempre, sin DLQ,
          // sin reintento y sin que el informe pudiera notarlo.
          let truncado: string | null = null;
          try {
            const PER_PAGE = 100;
            const MAX_PAGES = 200; // defensa: hasta 20k alumnos/curso en un tick
            let page = 1;
            while (page <= MAX_PAGES) {
              const url = `${baseUrl}/wp-json/ldlms/v1/sfwd-courses/${encodeURIComponent(courseSourceId)}/users?per_page=${PER_PAGE}&page=${page}`;
              const r = await ctx.http.get(url, {
                headers: { Authorization: authHeader, Accept: 'application/json' },
                timeoutMs: 30_000,
              });
              if (r.status === 400 && r.body.includes('rest_post_invalid_page_number')) break;
              if (r.status >= 400) {
                ctx.log(
                  'warn',
                  `tick ${tickIndex}: enroll curso ${courseSourceId} page=${page} HTTP ${r.status}: ${r.body.slice(0, 200)}.`,
                );
                truncado = `HTTP ${r.status} en page=${page}`;
                break;
              }
              let arr: unknown;
              try {
                arr = JSON.parse(r.body);
              } catch {
                truncado = `respuesta no-JSON en page=${page}`;
                break;
              }
              if (!Array.isArray(arr) || arr.length === 0) break;
              for (const u of arr) {
                if (!u || typeof u !== 'object') continue;
                const rawId = (u as { id?: number | string }).id;
                const uid = typeof rawId === 'number' ? rawId : parseInt(String(rawId ?? ''), 10);
                if (!Number.isFinite(uid)) continue;
                const userObj = { ...(u as Record<string, unknown>), id: uid };
                const mapped = mapDirectEnrollment(
                  courseSourceId,
                  userObj as Parameters<typeof mapDirectEnrollment>[1],
                );
                await upsertStgEnrollment(
                  db,
                  tenantId,
                  jobId,
                  String(uid),
                  courseSourceId,
                  '',
                  'direct',
                  u,
                  mapped.ok ? mapped.canonical : null,
                  computeChecksum({ c: courseSourceId, u: uid }),
                );
                enrolledCount += 1;
              }
              if (arr.length < PER_PAGE) break;
              page += 1;
            }
          } catch (e) {
            truncado = e instanceof Error ? e.message : String(e);
            ctx.log(
              'warn',
              `tick ${tickIndex}: enroll curso ${courseSourceId} excepción: ${truncado}.`,
            );
          }

          if (truncado) {
            // El curso se reintenta ENTERO en el próximo tick (el upsert de
            // matrículas es idempotente por (job, source_id, course)). Tras
            // agotar los intentos se manda a la DLQ y se avanza: así el
            // operador ve la pérdida en vez de recibir un informe perfecto.
            const intentos = (cursor.enrollAttempts?.[courseSourceId] ?? 0) + 1;
            if (intentos < ENROLL_MAX_ATTEMPTS) {
              ctx.log(
                'warn',
                `tick ${tickIndex}: enroll curso ${courseSourceId} truncado (${truncado}). Reintento ${intentos}/${ENROLL_MAX_ATTEMPTS}.`,
              );
              await setJobProgress(db, tenantId, jobId, {
                ...cursor,
                enrollAttempts: { ...(cursor.enrollAttempts ?? {}), [courseSourceId]: intentos },
              } as unknown as Record<string, unknown>);
              return { status: 'continue', delaySec: ENROLL_RETRY_DELAY_SEC };
            }
            await appendDlq(
              db,
              tenantId,
              jobId,
              'enrollments',
              courseSourceId,
              'extract',
              'EXTRACT_TRUNCATED',
              `matrículas del curso ${courseSourceId} incompletas tras ${ENROLL_MAX_ATTEMPTS} intentos: ${truncado}`,
              null,
            );
            ctx.log(
              'error',
              `tick ${tickIndex}: enroll curso ${courseSourceId} ABANDONADO tras ${ENROLL_MAX_ATTEMPTS} intentos (${truncado}). Va a DLQ.`,
            );
          }

          ctx.log(
            'log',
            `tick ${tickIndex}: enroll curso #${idx + 1}/${courseIds.length} (${courseSourceId}) — ${enrolledCount} matrículas.`,
          );
          await setJobProgress(db, tenantId, jobId, {
            ...cursor,
            courseIdx: idx + 1,
          } as unknown as Record<string, unknown>);
          return { status: 'continue', delaySec: 0 };
        }

        const entity = EXTRACT_ENTITIES.find((e) => e.name === cursor.current);
        if (!entity) {
          // Cursor con entity inválida → reset al primero.
          await setJobProgress(
            db,
            tenantId,
            jobId,
            emptyExtractCursor() as unknown as Record<string, unknown>,
          );
          return { status: 'continue', delaySec: 0 };
        }

        // Si la entity itera por curso (lessons/topics/quizzes en ldlms/v1),
        // resolver el courseId actual del staging. LearnDash REST v1 requiere
        // `?course=N` en estos endpoints o devuelve 404 "Invalid Curso ID".
        let perCourseFilter: {
          courseSourceId: string;
          courseIdx: number;
          totalCourses: number;
        } | null = null;
        if (entity.perCourse) {
          const coursesQ = await db.query<{ source_id: string }>(
            `SELECT source_id FROM mod_migrator_learndash_stg_courses
              WHERE tenant_id = $1::uuid AND job_id = $2::uuid
              ORDER BY source_id ASC`,
            [tenantId, jobId],
          );
          const courseSourceIds = coursesQ.rows.map((r) => r.source_id);
          if (courseSourceIds.length === 0) {
            // No hay cursos extraídos todavía → no podemos pedir lessons.
            // Marcamos la entity como completada con 0 items y avanzamos.
            const completed = [...cursor.completed, entity.name];
            const next = nextEntity({ ...cursor, completed });
            const newCursor: ExtractCursor = {
              ...cursor,
              current: next ?? entity.name,
              page: 1,
              courseIdx: 0,
              completed,
              totalsPerEntity: cursor.totalsPerEntity,
            };
            await setJobProgress(
              db,
              tenantId,
              jobId,
              newCursor as unknown as Record<string, unknown>,
            );
            ctx.log(
              'warn',
              `tick ${tickIndex}: ${entity.name} perCourse pero stg_courses vacío. Skip.`,
            );
            return { status: 'continue', delaySec: 0 };
          }
          const idx = Math.min(cursor.courseIdx ?? 0, courseSourceIds.length - 1);
          perCourseFilter = {
            courseSourceId: courseSourceIds[idx]!,
            courseIdx: idx,
            totalCourses: courseSourceIds.length,
          };
        }

        let pageResult;
        try {
          pageResult = await fetchOneWpPage<{
            id: number;
            course?: number;
            lesson?: number;
            topic?: number;
          }>(
            ctx.http,
            baseUrl,
            entity.cpt,
            authHeader,
            cursor.page,
            100,
            entity.namespace,
            perCourseFilter ? { course: perCourseFilter.courseSourceId } : undefined,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const status = e instanceof WpHttpError ? e.status : null;
          const donde = `${entity.name}#${cursor.page}${perCourseFilter ? `(course=${perCourseFilter.courseSourceId})` : ''}`;

          // Permanente: la credencial se revocó a mitad, el endpoint ya no
          // existe, el rol perdió permisos. Esperar no lo arregla y el job se
          // quedaba girando en `extracting` re-encolando un tick fallido cada
          // 30 s para siempre — el operador solo veía un job que no avanza.
          if (status !== null && PERMANENT_WP_STATUSES.has(status)) {
            await setJobError(db, tenantId, jobId, {
              code: 'SOURCE_PERMANENT_ERROR',
              message: `extract ${donde}: ${msg}`,
            });
            await setJobStatus(db, tenantId, jobId, 'failed', nowIso());
            ctx.log(
              'error',
              `tick ${tickIndex}: extract ${donde} falló de forma permanente: ${msg}.`,
            );
            return { status: 'failed', reason: `SOURCE_PERMANENT_ERROR:${status}` };
          }

          const clave = `${entity.name}:${cursor.page}:${perCourseFilter?.courseSourceId ?? '-'}`;
          const intentos = (cursor.pageAttempts?.[clave] ?? 0) + 1;
          if (intentos >= PAGE_MAX_ATTEMPTS) {
            await setJobError(db, tenantId, jobId, {
              code: 'SOURCE_UNREACHABLE',
              message: `extract ${donde}: ${msg} (tras ${PAGE_MAX_ATTEMPTS} intentos)`,
            });
            await setJobStatus(db, tenantId, jobId, 'failed', nowIso());
            ctx.log(
              'error',
              `tick ${tickIndex}: extract ${donde} agotó ${PAGE_MAX_ATTEMPTS} intentos: ${msg}.`,
            );
            return { status: 'failed', reason: 'SOURCE_UNREACHABLE' };
          }

          ctx.log(
            'warn',
            `tick ${tickIndex}: extract page ${donde} falló: ${msg}. Reintento ${intentos}/${PAGE_MAX_ATTEMPTS}.`,
          );
          await setJobProgress(db, tenantId, jobId, {
            ...cursor,
            pageAttempts: { ...(cursor.pageAttempts ?? {}), [clave]: intentos },
          } as unknown as Record<string, unknown>);
          return { status: 'continue', delaySec: 30 };
        }

        // Upsert items a la stg table apropiada. Si la entity es perCourse
        // y `item.course` viene vacío del API, usamos el courseId del filtro
        // (sabemos que esos items pertenecen al curso del query string).
        const fallbackCourseId = perCourseFilter?.courseSourceId ?? null;
        for (const item of pageResult.items) {
          const sourceId = String(item.id);
          const checksum = computeChecksum(item);
          const resolvedCourseId = item.course ? String(item.course) : fallbackCourseId;
          try {
            switch (entity.name) {
              case 'users':
                await upsertStgUser(db, tenantId, jobId, sourceId, item, checksum);
                break;
              case 'courses':
                await upsertStgCourse(db, tenantId, jobId, sourceId, item, checksum);
                break;
              case 'lessons':
                await upsertStgLesson(
                  db,
                  tenantId,
                  jobId,
                  sourceId,
                  resolvedCourseId,
                  0,
                  item,
                  checksum,
                );
                break;
              case 'topics':
                await upsertStgTopic(
                  db,
                  tenantId,
                  jobId,
                  sourceId,
                  item.lesson ? String(item.lesson) : null,
                  resolvedCourseId,
                  0,
                  item,
                  checksum,
                );
                break;
              case 'quizzes':
                await upsertStgQuiz(
                  db,
                  tenantId,
                  jobId,
                  sourceId,
                  resolvedCourseId,
                  item.lesson ? String(item.lesson) : null,
                  item.topic ? String(item.topic) : null,
                  item,
                  checksum,
                );
                break;
              case 'groups':
                await upsertStgGroup(db, tenantId, jobId, sourceId, item, checksum);
                break;
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ctx.log(
              'warn',
              `extract upsert falló para ${entity.name}#${sourceId}: ${msg}. Saltando item.`,
            );
          }
        }

        // Avanzar cursor.
        const newTotals = { ...cursor.totalsPerEntity };
        newTotals[entity.name] = (newTotals[entity.name] ?? 0) + pageResult.items.length;

        let newCursor: ExtractCursor;
        const isLastPage =
          pageResult.items.length === 0 ||
          (pageResult.totalPages !== undefined && cursor.page >= pageResult.totalPages);

        // En modo perCourse, isLastPage solo termina ESTE curso. Pasamos al
        // siguiente courseIdx; entity completed solo cuando agotamos todos
        // los cursos.
        if (perCourseFilter && isLastPage) {
          const nextCourseIdx = perCourseFilter.courseIdx + 1;
          if (nextCourseIdx < perCourseFilter.totalCourses) {
            newCursor = {
              ...cursor,
              page: 1,
              courseIdx: nextCourseIdx,
              totalsPerEntity: newTotals,
            };
            await setJobProgress(
              db,
              tenantId,
              jobId,
              newCursor as unknown as Record<string, unknown>,
            );
            ctx.log(
              'log',
              `tick ${tickIndex}: extract ${entity.name} course ${perCourseFilter.courseSourceId} done (page ${cursor.page}, items=${pageResult.items.length}). Próximo: course #${nextCourseIdx + 1}/${perCourseFilter.totalCourses}.`,
            );
            return { status: 'continue', delaySec: 0 };
          }
          // Agotamos todos los cursos → entity completada. Caer al flujo
          // estándar de avance entre entities (de aquí abajo).
        }

        if (isLastPage) {
          const completed = [...cursor.completed, entity.name];
          const next = nextEntity({ ...cursor, completed });
          if (next === null) {
            // Todas las paginables agotadas. Pasamos a subphase 'fixup'
            // para corregir parent_course_id usando /sfwd-courses/<id>/steps
            // (el filter ?course=N que usamos en paginate es ignorado por
            // Application Passwords de admin, así que las rows quedan con el
            // courseId del último curso iterado, no del real). Status del
            // job sigue 'extracting' hasta que fixup también termine.
            newCursor = {
              ...cursor,
              subphase: 'fixup',
              current: entity.name,
              page: cursor.page,
              courseIdx: 0,
              completed,
              totalsPerEntity: newTotals,
            };
            await setJobProgress(
              db,
              tenantId,
              jobId,
              newCursor as unknown as Record<string, unknown>,
            );
            // Congela lo que el ORIGEN devolvió, entity a entity, antes de que
            // el cursor cambie de fase y se pierda. Es el único numero que
            // permite al informe de validación detectar registros perdidos: el
            // reconcile cableaba `source_count = staged_count`, asi que solo
            // podía darse la razon a si mismo. Su `ON CONFLICT DO UPDATE` no
            // toca `source_count`, de modo que este valor sobrevive.
            await recordSourceCounts(db, tenantId, jobId, newTotals, ctx.log);
            ctx.log(
              'log',
              `tick ${tickIndex}: paginate completed (${Object.entries(newTotals)
                .map(([k, v]) => `${k}=${v}`)
                .join(', ')}). Entrando a subphase fixup.`,
            );
            return { status: 'continue', delaySec: 0 };
          }
          newCursor = {
            ...cursor,
            current: next,
            page: 1,
            courseIdx: 0,
            completed,
            totalsPerEntity: newTotals,
          };
        } else {
          newCursor = { ...cursor, page: cursor.page + 1, totalsPerEntity: newTotals };
        }
        await setJobProgress(db, tenantId, jobId, newCursor as unknown as Record<string, unknown>);
        ctx.log(
          'log',
          `tick ${tickIndex}: extract ${entity.name} page ${cursor.page}, items=${pageResult.items.length}. Próximo: ${newCursor.current} page ${newCursor.page}.`,
        );
        return { status: 'continue', delaySec: 0 };
      }

      case 'transforming': {
        // Sprint 4 / ET-002 — transform phase per-tick.
        //
        // Cada tick: lee batch de stg_<entity> con is_valid=false, aplica
        // mapper (reusando src/mappers/), calcula canonical, escribe.
        // Errores tipados van a DLQ con phase='transform'.
        //
        // Cursor: { phase: 'transform', current: entity, completed[] }.
        // Cuando un batch llega vacío para la entity actual, marca
        // completed y mueve a la siguiente. Cuando todas completas
        // → tryTransition('transforming','loading').

        const cursor = parseTransformCursor(job.progress);
        const table = STG_TABLES[cursor.current];
        if (!table) {
          // Cursor con entity desconocida — reset.
          await setJobProgress(db, tenantId, jobId, {
            phase: 'transform',
            current: EXTRACT_ENTITIES[0]!.name,
            completed: [],
          } as unknown as Record<string, unknown>);
          return { status: 'continue', delaySec: 0 };
        }
        const batch = await listInvalidStg(db, table, tenantId, jobId, TRANSFORM_BATCH_SIZE);
        if (batch.length === 0) {
          const completed = [...cursor.completed, cursor.current];
          const next = nextTransformEntity({ ...cursor, completed });
          if (next === null) {
            await setJobProgress(db, tenantId, jobId, { ...cursor, completed } as unknown as Record<
              string,
              unknown
            >);
            const advanced = await tryTransition(db, tenantId, jobId, 'transforming', 'loading');
            if (!advanced) return { status: 'continue', delaySec: 0 };
            ctx.log('log', `tick ${tickIndex}: transform completed. Transition a loading.`);
            return { status: 'continue', delaySec: 0 };
          }
          await setJobProgress(db, tenantId, jobId, {
            ...cursor,
            current: next,
            completed,
          } as unknown as Record<string, unknown>);
          return { status: 'continue', delaySec: 0 };
        }
        let okCount = 0;
        let dlqCount = 0;
        for (const row of batch) {
          // Inyectar los parents resueltos por el extract en el raw_payload
          // antes de mapear. LearnDash REST v1 NO incluye `course`/`lesson`
          // en el payload de lessons/topics/quizzes; los obtuvimos via /steps
          // y los persistimos en la columna `parent_*_id` del staging. El
          // mapper espera `raw.course` numérico. Para lessons en una section,
          // parent_course_id tiene encoding `{courseId}-s{idx}` (e.g. '9919-s5');
          // extraemos solo la parte numérica inicial para que el mapper valide,
          // y SOBREESCRIBIMOS `canonical.parentCourseSourceId` con el string
          // completo después del map → así el adapter envía
          // moduleExternalRef apuntando al module sintético de la section.
          const extractNumericPrefix = (v: string): number | undefined => {
            const m = v.match(/^(\d+)/);
            if (!m) return undefined;
            const n = parseInt(m[1]!, 10);
            return Number.isFinite(n) ? n : undefined;
          };
          const rawWithParents =
            row.parent_course_id || row.parent_lesson_id || row.parent_topic_id
              ? (() => {
                  const r = { ...(row.raw_payload as Record<string, unknown>) };
                  if (row.parent_course_id && !r['course']) {
                    const n = extractNumericPrefix(row.parent_course_id);
                    if (n !== undefined) r['course'] = n;
                  }
                  if (row.parent_lesson_id && !r['lesson']) {
                    const n = extractNumericPrefix(row.parent_lesson_id);
                    if (n !== undefined) r['lesson'] = n;
                  }
                  if (row.parent_topic_id && !r['topic']) {
                    const n = extractNumericPrefix(row.parent_topic_id);
                    if (n !== undefined) r['topic'] = n;
                  }
                  return r;
                })()
              : row.raw_payload;
          const result = applyMapper(cursor.current, rawWithParents);

          // Override post-map: si stg.parent_course_id tiene encoding compuesto
          // (e.g. '9919-s5'), reemplazar el parentCourseSourceId numérico del
          // mapper con ese string. El adapter de lessons lo usa tal cual como
          // moduleExternalRef.externalId, y el core encuentra el module sintético
          // de la section que el load creó al cargar el course.
          if (
            result.ok &&
            (cursor.current === 'lessons' ||
              cursor.current === 'topics' ||
              cursor.current === 'quizzes') &&
            row.parent_course_id &&
            row.parent_course_id.includes('-')
          ) {
            const can = result.canonical as Record<string, unknown>;
            can['parentCourseSourceId'] = row.parent_course_id;
          }

          if (result.ok) {
            await setStgCanonical(db, table, row.id, result.canonical, null);
            okCount += 1;
          } else {
            const errs = {
              errorCode: result.errorCode,
              errorMessage: result.errorMessage,
              warnings: result.warnings,
            };
            await setStgCanonical(db, table, row.id, null, errs);
            await appendDlq(
              db,
              tenantId,
              jobId,
              cursor.current,
              row.source_id,
              'transform',
              result.errorCode,
              result.errorMessage,
              row.raw_payload,
            );
            dlqCount += 1;
          }
        }
        ctx.log(
          'log',
          `tick ${tickIndex}: transform ${cursor.current} batch ok=${okCount} dlq=${dlqCount}.`,
        );
        return { status: 'continue', delaySec: 0 };
      }

      case 'loading': {
        // Sprint 4 / ET-003 — load phase per-tick.
        //
        // Cada tick: lee batch de stg_<entity> con is_valid=true AND
        // target_id IS NULL. Llama ctx.didacta.<entity>.upsertByExternalRef
        // con externalRef = { externalSource: 'learndash', externalId: source_id }.
        // Idempotencia garantizada por el core (alpha.52 ADR-014). Escribe
        // target_id devuelto por el core. Errores tipados → DLQ.
        //
        // Orden de carga (deps de FK lógicas):
        //   users → courses → lessons → topics → quizzes → groups
        //
        // Limitación documentada: quizzes carga solo el shell (sin las
        // questions) hasta que se cierre DD-006 (ctx.didacta.quizzes.upsertQuestions
        // bulk-create). Por ahora el shell se crea con externalRef y queda
        // marcado como cargado; las questions persisten en stg pero no se
        // suben al core. Pendiente: ET-003b cuando DD-006 esté listo.

        const cursor0 = parseLoadCursor(job.progress);
        // Scope (v1.1.0+): cargar solo las entidades dentro de scope.load, en el
        // orden de deps. En modo 'courses' el cursor fresco arranca en 'users'
        // (default de parseLoadCursor) que queda fuera del scope → lo reubicamos
        // a la primera entidad cargable, si no se transicionaría a reconciling
        // saltándose courses. En modo 'all' el filtro no cambia nada.
        const scopeCfg = readScopeConfig((job as { options?: unknown }).options);
        // enrollments al final: requiere que los cursos ya estén cargados (en
        // este mismo job o en uno previo — idempotencia por externalRef).
        const loadOrder = [
          'users',
          'courses',
          'lessons',
          'topics',
          'quizzes',
          'groups',
          'enrollments',
        ].filter((e) => scopeCfg.load.has(e));
        const cursor =
          loadOrder.length === 0 || loadOrder.includes(cursor0.current)
            ? cursor0
            : { ...cursor0, current: loadOrder[0]! };

        // Branch dedicado de enrollments: forma de fila distinta (no source_id),
        // load vía ctx.didacta.enrollments.upsertByExternalRef. Retorna antes del
        // path genérico de STG_TABLES.
        if (cursor.current === 'enrollments') {
          const rows = await listValidUnloadedStgEnrollments(db, tenantId, jobId, LOAD_BATCH_SIZE);
          if (rows.length === 0) {
            const completed = [...cursor.completed, 'enrollments'];
            const idx = loadOrder.indexOf('enrollments');
            const next = idx >= 0 && idx + 1 < loadOrder.length ? loadOrder[idx + 1]! : null;
            if (next === null) {
              await setJobProgress(db, tenantId, jobId, {
                ...cursor,
                completed,
              } as unknown as Record<string, unknown>);
              const advanced = await tryTransition(db, tenantId, jobId, 'loading', 'reconciling');
              if (!advanced) return { status: 'continue', delaySec: 0 };
              ctx.log(
                'log',
                `tick ${tickIndex}: load completed (enrollments). Transition a reconciling.`,
              );
              return { status: 'continue', delaySec: 0 };
            }
            await setJobProgress(db, tenantId, jobId, {
              ...cursor,
              current: next,
              completed,
            } as unknown as Record<string, unknown>);
            return { status: 'continue', delaySec: 0 };
          }
          const enrollApi = (
            ctx.didacta as Record<
              string,
              { upsertByExternalRef: (i: Record<string, unknown>) => Promise<{ id: string }> }
            >
          )['enrollments'];
          let okE = 0;
          let dlqE = 0;
          const enrollTable = 'mod_migrator_learndash_stg_enrollments';
          for (const row of rows) {
            const canonical = (row.canonical ?? {}) as Record<string, unknown>;
            const adapted = adaptCanonicalToDidacta('enrollments', canonical);
            if (!adapted.ok) {
              await appendDlq(
                db,
                tenantId,
                jobId,
                'enrollments',
                row.source_user_id,
                'load',
                adapted.code,
                adapted.message,
                row.raw_payload,
                canonical,
              );
              await setStgLoaded(db, enrollTable, row.id, `!FAIL:${adapted.code}`);
              dlqE += 1;
              continue;
            }
            if (!enrollApi || typeof enrollApi.upsertByExternalRef !== 'function') {
              await appendDlq(
                db,
                tenantId,
                jobId,
                'enrollments',
                row.source_user_id,
                'load',
                'DIDACTA_NS_MISSING',
                'ctx.didacta.enrollments no disponible',
                row.raw_payload,
                canonical,
              );
              await setStgLoaded(db, enrollTable, row.id, '!FAIL:NS');
              dlqE += 1;
              continue;
            }
            try {
              const result = await enrollApi.upsertByExternalRef(adapted.input);
              await setStgLoaded(db, enrollTable, row.id, result.id);
              okE += 1;
            } catch (e) {
              const code = (e as { code?: string })?.code ?? 'DIDACTA_UPSERT_FAILED';
              const msg = e instanceof Error ? e.message : String(e);
              await appendDlq(
                db,
                tenantId,
                jobId,
                'enrollments',
                row.source_user_id,
                'load',
                code,
                msg,
                row.raw_payload,
                canonical,
              );
              await setStgLoaded(db, enrollTable, row.id, `!FAIL:${code}`);
              dlqE += 1;
            }
          }
          ctx.log('log', `tick ${tickIndex}: load enrollments batch ok=${okE} dlq=${dlqE}.`);
          return { status: 'continue', delaySec: 0 };
        }

        const table = STG_TABLES[cursor.current];
        const didacta = ctx.didacta as Record<
          string,
          { upsertByExternalRef: (input: Record<string, unknown>) => Promise<{ id: string }> }
        >;
        if (!table) {
          await setJobProgress(db, tenantId, jobId, {
            phase: 'load',
            current: 'users',
            completed: [],
          } as unknown as Record<string, unknown>);
          return { status: 'continue', delaySec: 0 };
        }
        // onlyEnrolledUsers (modo 'enrolled-students'): excluir del load los
        // usuarios SIN ninguna matrícula marcándolos is_valid=FALSE. Así
        // listValidUnloadedStg (que exige is_valid=TRUE) no los toma y nunca se
        // cargan. El transform ya corrió (load es posterior) → no se revierte.
        // Idempotente (re-ejecutar el UPDATE no cambia nada).
        if (cursor.current === 'users' && scopeCfg.onlyEnrolledUsers) {
          await db.execute(
            `UPDATE mod_migrator_learndash_stg_users u
                SET is_valid = FALSE,
                    validation_errors = '{"skipped":"NOT_ENROLLED"}'::jsonb
              WHERE u.tenant_id = $1::uuid AND u.job_id = $2::uuid
                AND u.target_id IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM mod_migrator_learndash_stg_enrollments e
                   WHERE e.tenant_id = u.tenant_id AND e.job_id = u.job_id
                     AND e.source_user_id = u.source_id
                )`,
            [tenantId, jobId],
          );
        }
        const batch = await listValidUnloadedStg(db, table, tenantId, jobId, LOAD_BATCH_SIZE);
        if (batch.length === 0) {
          const completed = [...cursor.completed, cursor.current];
          const idx = loadOrder.indexOf(cursor.current);
          const next = idx >= 0 && idx + 1 < loadOrder.length ? loadOrder[idx + 1]! : null;
          if (next === null) {
            await setJobProgress(db, tenantId, jobId, { ...cursor, completed } as unknown as Record<
              string,
              unknown
            >);
            const advanced = await tryTransition(db, tenantId, jobId, 'loading', 'reconciling');
            if (!advanced) return { status: 'continue', delaySec: 0 };
            ctx.log('log', `tick ${tickIndex}: load completed. Transition a reconciling.`);
            return { status: 'continue', delaySec: 0 };
          }
          await setJobProgress(db, tenantId, jobId, {
            ...cursor,
            current: next,
            completed,
          } as unknown as Record<string, unknown>);
          return { status: 'continue', delaySec: 0 };
        }
        // Adapter canonical → DidactaUpsertXInput por entity. Maneja los
        // mismatches entre el shape canonical (escrito alpha.51, pre-ctx.didacta)
        // y el contrato actual del host (alpha.52+). Decide si entity es
        // skippable (topics, groups) — esos no se intentan cargar, target_id
        // se marca '!SKIP:<code>' para excluirlos del re-procesado.
        let okCount = 0;
        let dlqCount = 0;
        let skipCount = 0;
        for (const row of batch) {
          const canonical = (row.canonical ?? {}) as Record<string, unknown>;
          // v1.0.33: si el row ya estaba marcado con un sentinel `!SKIP:%`
          // de un release anterior (ej. ADAPTER_TOPIC_SKIPPED, ADAPTER_GROUPS_NO_TARGET),
          // dejamos una entry en el DLQ ANTES de re-procesarlo. Esto cubre
          // el reporte del operador que no veía por qué se "perdían" 20
          // topics y 8 groups: el código anterior los saltaba silencioso.
          // El re-procesado posterior puede cargarlos (topics → lesson) o
          // re-failearlos (groups → ADAPTER_GROUPS_NOT_SUPPORTED). En cualquier
          // caso queda traza explícita.
          const priorTarget = row.target_id;
          if (typeof priorTarget === 'string' && priorTarget.startsWith('!SKIP:')) {
            const priorCode = priorTarget.slice('!SKIP:'.length);
            await appendDlq(
              db,
              tenantId,
              jobId,
              cursor.current,
              row.source_id,
              'load',
              'SKIP_ALREADY_LOADED_IN_PREVIOUS_RUN',
              `Esta fila estaba marcada con sentinel skip (${priorCode}) por una versión previa del adapter. Antes de v1.0.33 esos rows quedaban silenciosamente fuera del re-procesado y el operador no podía diagnosticarlo. v1.0.33 los re-evalúa contra el adapter actual: si el adapter ahora sabe cargarlos, se cargarán; si no, quedarán como entries DLQ con su código real.`,
              row.raw_payload,
              canonical,
            );
            // No incrementamos dlqCount aquí — la visibility entry no cuenta
            // como "failure", es una nota informativa. Si el re-procesado
            // falla, el código de abajo agregará la entry de failure real.
          }
          const adapted = adaptCanonicalToDidacta(cursor.current, canonical);
          if (!adapted.ok) {
            if (adapted.skip) {
              // Skippable conscientemente — marcamos target con sentinel para
              // no reprocesar pero sin contar como loaded ni failed.
              await setStgLoaded(db, table, row.id, `!SKIP:${adapted.code}`);
              skipCount += 1;
            } else {
              await appendDlq(
                db,
                tenantId,
                jobId,
                cursor.current,
                row.source_id,
                'load',
                adapted.code,
                adapted.message,
                row.raw_payload,
                canonical,
              );
              // Marcamos también con sentinel para no reprocesar en bucle.
              await setStgLoaded(db, table, row.id, `!FAIL:${adapted.code}`);
              dlqCount += 1;
            }
            continue;
          }
          const apiObj = didacta[adapted.ns];
          if (!apiObj || typeof apiObj.upsertByExternalRef !== 'function') {
            await appendDlq(
              db,
              tenantId,
              jobId,
              cursor.current,
              row.source_id,
              'load',
              'DIDACTA_NS_MISSING',
              `ctx.didacta.${adapted.ns} no disponible`,
              row.raw_payload,
              canonical,
            );
            await setStgLoaded(db, table, row.id, '!FAIL:NS');
            dlqCount += 1;
            continue;
          }
          try {
            const result = await apiObj.upsertByExternalRef(adapted.input);
            await setStgLoaded(db, table, row.id, result.id);
            okCount += 1;

            // Tras cargar un course, crear los CourseModules sintéticos.
            // LearnDash agrupa lessons en "section-headings" (course builder);
            // Didacta tiene jerarquía Course → CourseModule → Lesson. Mapping:
            //   - Module "General" con externalId = courseId (FALLBACK para
            //     lessons huérfanas que no estén en ninguna section).
            //   - Module por section con externalId = `{course}-s{idx}` y
            //     title = section.title (capturadas en el fixup del extract).
            // Los syntheticIds coinciden con los parent_course_id que el
            // fixup grabó en stg_lessons → cada lesson cae en su module real.
            if (cursor.current === 'courses') {
              const modulesApi = didacta['courseModules'];
              if (modulesApi && typeof modulesApi.upsertByExternalRef === 'function') {
                const courseSourceId = String(canonical['sourceId'] ?? '');
                if (courseSourceId) {
                  // ¿Hay lessons huérfanas (parent_course_id pelado, sin
                  // encoding `-sN`)? Solo creamos el module "General" si las
                  // hay — evita modules vacíos en cursos donde todas las
                  // lessons están agrupadas en sections explícitas.
                  let hasOrphans = false;
                  try {
                    // Cuenta lessons huérfanas Y TEMAS. Los temas SIEMPRE se
                    // adaptan con `moduleExternalRef = courseId` pelado, así
                    // que siempre necesitan "General"; mirar solo las lessons
                    // hacía que en un curso 100 % seccionado con temas el
                    // module nunca se creara y cada upsert de tema acabara en
                    // la DLQ.
                    const q = await db.query<{ n: string }>(
                      `SELECT (
                            (SELECT COUNT(*) FROM mod_migrator_learndash_stg_lessons
                              WHERE tenant_id = $1::uuid AND job_id = $2::uuid
                                AND parent_course_id = $3)
                          + (SELECT COUNT(*) FROM mod_migrator_learndash_stg_topics
                              WHERE tenant_id = $1::uuid AND job_id = $2::uuid
                                AND parent_course_id = $3)
                         )::text AS n`,
                      [tenantId, jobId, courseSourceId],
                    );
                    hasOrphans = parseInt(q.rows[0]?.n ?? '0', 10) > 0;
                  } catch {
                    // Si la query falla, somos conservadores: creamos General
                    // de todas formas (mejor un module extra que perder lessons).
                    hasOrphans = true;
                  }

                  if (hasOrphans) {
                    try {
                      await modulesApi.upsertByExternalRef({
                        externalSource: 'learndash',
                        externalId: courseSourceId,
                        courseExternalRef: {
                          externalSource: 'learndash',
                          externalId: courseSourceId,
                        },
                        title: 'General',
                        position: 0,
                      });
                    } catch (e) {
                      const msg = e instanceof Error ? e.message : String(e);
                      ctx.log(
                        'warn',
                        `tick ${tickIndex}: courseModule "General" para curso ${courseSourceId} falló: ${msg}.`,
                      );
                    }
                  }

                  // Modules por section (course builder de LearnDash).
                  const sections = canonical['sections'];
                  if (Array.isArray(sections)) {
                    for (const sec of sections as Array<{
                      idx: number;
                      title: string;
                      lessonIds?: number[];
                    }>) {
                      if (!sec || typeof sec.title !== 'string') continue;
                      try {
                        await modulesApi.upsertByExternalRef({
                          externalSource: 'learndash',
                          externalId: `${courseSourceId}-s${sec.idx}`,
                          courseExternalRef: {
                            externalSource: 'learndash',
                            externalId: courseSourceId,
                          },
                          title: sec.title,
                          // position: si hay General, empieza en 1; si no, en 0.
                          position: hasOrphans ? sec.idx + 1 : sec.idx,
                        });
                      } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        ctx.log(
                          'warn',
                          `tick ${tickIndex}: courseModule section ${courseSourceId}-s${sec.idx} ("${sec.title}") falló: ${msg}.`,
                        );
                      }
                    }
                  }
                }
              }
            }
          } catch (e) {
            const code = (e as { code?: string })?.code ?? 'DIDACTA_UPSERT_FAILED';
            const msg = e instanceof Error ? e.message : String(e);
            await appendDlq(
              db,
              tenantId,
              jobId,
              cursor.current,
              row.source_id,
              'load',
              code,
              msg,
              row.raw_payload,
              canonical,
            );
            await setStgLoaded(db, table, row.id, '!FAIL:DIDACTA');
            dlqCount += 1;
          }
        }
        ctx.log(
          'log',
          `tick ${tickIndex}: load ${cursor.current} batch ok=${okCount} dlq=${dlqCount} skip=${skipCount}.`,
        );
        return { status: 'continue', delaySec: 0 };
      }

      case 'reconciling': {
        // Sprint 4 / ET-004 + ET-005 — reconcile + audit chain en un tick.
        //
        // ET-004: agrega counts por entidad (source/staged/valid/loaded/failed)
        // a mod_migrator_learndash_validation_reports. UPSERT por (tenant,
        // job, entity_type) para idempotencia si el tick se re-corre.
        //
        // ET-005: append a mod_migrator_learndash_audit_events con cadena
        // SHA-256. Cada evento incluye prev_hash (último hash del job) +
        // body; hash = SHA-256(prev_hash + body_json). Permite verificar
        // integridad post-mortem en GET /jobs/:id/report.
        //
        // Por simplicidad el reconcile se hace en un único tick (operación
        // mayormente count + insert; escala bien hasta ~50 entidades).
        // Si necesitamos partir por entidad en el futuro, refactor a cursor.

        // Scope (v1.1.0+): reconciliar solo las entidades que entraron al scope
        // de extracción (lo que realmente se procesó en este job).
        const scopeCfg = readScopeConfig((job as { options?: unknown }).options);
        const entities = [
          'users',
          'courses',
          'lessons',
          'topics',
          'quizzes',
          'groups',
          'enrollments',
        ].filter((e) => scopeCfg.extract.has(e));
        for (const entity of entities) {
          const table = STG_TABLES[entity];
          if (!table) continue;
          const counts = await db.query<{
            staged_count: string;
            valid_count: string;
            loaded_count: string;
            skipped_count: string;
            failed_target_count: string;
          }>(
            `SELECT
               COUNT(*)::text AS staged_count,
               COUNT(*) FILTER (WHERE is_valid = TRUE)::text AS valid_count,
               COUNT(*) FILTER (WHERE target_id IS NOT NULL AND target_id NOT LIKE '!%')::text AS loaded_count,
               COUNT(*) FILTER (WHERE target_id LIKE '!SKIP:%')::text AS skipped_count,
               COUNT(*) FILTER (WHERE target_id LIKE '!FAIL:%')::text AS failed_target_count
               FROM ${table}
              WHERE tenant_id = $1::uuid AND job_id = $2::uuid`,
            [tenantId, jobId],
          );
          const c = counts.rows[0] ?? {
            staged_count: '0',
            valid_count: '0',
            loaded_count: '0',
            skipped_count: '0',
            failed_target_count: '0',
          };
          const staged = Number(c.staged_count);
          const valid = Number(c.valid_count);
          const loaded = Number(c.loaded_count);
          const skipped = Number(c.skipped_count);

          // Failed por entity = filas en DLQ para esta entity (puede contar
          // doble vs failed_target si una fila falló transform Y load).
          const failedR = await db.query<{ failed_count: string }>(
            `SELECT COUNT(*)::text AS failed_count
               FROM mod_migrator_learndash_dlq
              WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND entity_type = $3`,
            [tenantId, jobId, entity],
          );
          const failed = Number(failedR.rows[0]?.failed_count ?? '0');

          await db.execute(
            `INSERT INTO mod_migrator_learndash_validation_reports
               (tenant_id, job_id, entity_type, source_count, staged_count, valid_count, loaded_count, skipped_count, failed_count)
             VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (tenant_id, job_id, entity_type) DO UPDATE
               SET staged_count = EXCLUDED.staged_count,
                   valid_count = EXCLUDED.valid_count,
                   loaded_count = EXCLUDED.loaded_count,
                   skipped_count = EXCLUDED.skipped_count,
                   failed_count = EXCLUDED.failed_count,
                   generated_at = CURRENT_TIMESTAMP`,
            // `source_count` solo se escribe si la fila NO existía: la de
            // verdad la deja el final del extract con lo que el origen
            // devolvió. Cablearlo a `staged` hacía que el informe de
            // validación no pudiera detectar registros perdidos — solo podía
            // darse la razón a sí mismo. Si el extract no llegó a escribirla
            // (job antiguo), `staged` sigue siendo el mejor valor disponible.
            [tenantId, jobId, entity, staged, staged, valid, loaded, skipped, failed],
          );
        }

        // ET-005: append audit event "phase.reconcile.completed" con cadena.
        // node:crypto está en la allowlist del sandbox.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const crypto = require('node:crypto') as typeof import('node:crypto');
        const prevR = await db.query<{ hash: string }>(
          `SELECT hash FROM mod_migrator_learndash_audit_events
            WHERE tenant_id = $1::uuid AND job_id = $2::uuid
            ORDER BY occurred_at DESC LIMIT 1`,
          [tenantId, jobId],
        );
        const prevHash = prevR.rows[0]?.hash ?? null;
        const body = { phase: 'reconcile', completedAt: nowIso() };
        const hash = crypto
          .createHash('sha256')
          .update(stableStringify({ prevHash: prevHash ?? '', body }))
          .digest('hex');
        await db.execute(
          `INSERT INTO mod_migrator_learndash_audit_events
             (tenant_id, job_id, actor, action, entity_type, entity_id, meta, prev_hash, hash)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
          [
            tenantId,
            jobId,
            'system',
            'phase.completed',
            null,
            null,
            JSON.stringify(body),
            prevHash,
            hash,
          ],
        );

        const advanced = await tryTransition(db, tenantId, jobId, 'reconciling', 'completed');
        if (!advanced) return { status: 'continue', delaySec: 0 };
        await setJobStatus(db, tenantId, jobId, 'completed', nowIso());
        await cleanupJobAppPassword(ctx.secrets, jobId, ctx.log);
        ctx.log(
          'log',
          `tick ${tickIndex}: job ${jobId} completed (ET-004 reports + ET-005 audit chain emitidos).`,
        );
        return { status: 'completed' };
      }

      default: {
        ctx.log('error', `tick ${tickIndex}: estado inesperado ${job.status} en job ${jobId}.`);
        return { status: 'failed', reason: `unexpected_status:${job.status}` };
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.log('error', `tick ${tickIndex}: error en state machine de job ${jobId}: ${msg}`);
    // Re-encolar con backoff — error transitorio (deadlock Postgres,
    // network glitch). Si persiste, BullMQ dará up tras `attempts`.
    return { status: 'continue', delaySec: 30 };
  }
}

// ---- Export con el shape EXACTO del host -----------------------------
//
// CRÍTICO: module.exports debe ser { onInstall, onUninstall, routes,
// onJobTick }. NO envolver en `migratorLearndashModule` ni añadir
// `manifest`/re-exports. El sandbox lee `module.exports` directamente y
// aplica casting al shape `SandboxedModule` (apps/api/src/marketplace/
// module-sandbox.service.ts). El host enrutará `onJobTick` al worker
// BullMQ si el manifest declara `jobLifecycle.onTickFn = 'onJobTick'`.

export { manifest, routes, onInstall, onUninstall, onJobTick };
// Helpers exportados solo para testing del state machine (sample mode).
// El sandbox del host NO los consume — lee únicamente las exports listadas
// arriba via `module.exports[fn]`. Re-exportar para vitest es seguro.
export { readSampleConfig, parseExtractCursor, emptyExtractCursor };
export type { ExtractCursor };
// v1.0.33: exportamos `adaptCanonicalToDidacta` para que los unit tests de
// topics/groups puedan invocarlo sin levantar todo el state machine del job.
// El sandbox NO lo consume — sigue siendo uso interno del módulo (lo invoca
// `onJobTick` en el case `'loading'`).
export { adaptCanonicalToDidacta };
// `paginateWp` se exporta para tests + para el extract phase del job
// cuando se cablee. NO se incluye en module.exports porque el host
// solo consume `{ onInstall, onUninstall, routes }` — el helper es
// uso interno del módulo.

// CommonJS export — esbuild --format=cjs respeta esta forma.
// IMPORTANTE: incluir onJobTick aquí o el sandbox falla con MODULE_BOOT_FAILED
// porque solo lee `module.exports` (las líneas `export { ... }` quedan como
// código muerto en el bundle CJS final emitido por esbuild).
module.exports = { onInstall, onUninstall, routes, onJobTick };
