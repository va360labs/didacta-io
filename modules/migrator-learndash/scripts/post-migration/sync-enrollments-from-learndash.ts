/* eslint-disable no-console */

/*
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/*
 * sync-enrollments-from-learndash.ts
 * ----------------------------------
 *
 * QUÉ HACE
 *   Tras un job FULL del migrator-learndash, este script crea en Didacta las
 *   ENROLLMENTS faltantes leyendo la fuente real (WordPress + LearnDash). El
 *   módulo importa users y courses con `externalSource=learndash` + `externalId=<wpId>`,
 *   pero el flow `Course → Users` no está cubierto por el wizard (groups está
 *   marcado `ADAPTER_GROUPS_NOT_SUPPORTED` y los enrollments curso-a-curso quedan
 *   pendientes de ET-001b). Mientras tanto, este script cubre el hueco.
 *
 *   Flow:
 *     1) Signin como admin → bearer token + tenantId resuelto desde tenantSlug.
 *     2) Construye el mapa Map<wpUserId, didactaUserId> paginando
 *        GET /api/v1/admin/users?externalSource=learndash.
 *     3) Lista cursos del tenant (GET /api/v1/modules/courses), filtra client-side
 *        por externalSource === 'learndash'.
 *     4) Para CADA curso, paginar GET {wp}/wp-json/ldlms/v1/sfwd-courses/{externalId}/users
 *        → lista de WP user IDs enrolados.
 *     5) Para CADA WP user enrolado, buscar UUID en el mapa. Si existe, POST
 *        /api/v1/modules/learning/enrollments { userId, courseId } (UUIDs Didacta).
 *        201 = creado, 409 = ya existía (OK).
 *     6) Imprime summary JSON.
 *
 * CUÁNDO CORRERLO
 *   DESPUÉS de un job FULL del migrator-learndash (estado `completed`). Idempotente:
 *   se puede correr múltiples veces sin duplicar enrollments — los 409 se cuentan
 *   como `alreadyExisted`.
 *
 * CÓMO CORRERLO
 *   cd modules/migrator-learndash
 *   E2E_BASE_URL="https://dev.didacta.io" \
 *   E2E_ADMIN_EMAIL="admin@acme.com" \
 *   E2E_ADMIN_PASSWORD="************" \
 *   E2E_TENANT_SLUG="acme" \
 *   E2E_LD_BASE_URL="https://wp.example.com" \
 *   E2E_LD_USERNAME="admin" \
 *   E2E_LD_APP_PASSWORD="xxxx xxxx xxxx xxxx xxxx xxxx" \
 *   SYNC_DRY_RUN="false" \
 *   SYNC_THROTTLE_RPS="5" \
 *   pnpm dlx tsx scripts/post-migration/sync-enrollments-from-learndash.ts
 *
 * EXIT CODES
 *   0  → OK (con o sin alreadyExisted). usersNotFound no bloquea.
 *   1  → fail-rate por curso ≥10% en errors no transient, o error fatal en signin/setup.
 *
 * SALIDA
 *   Logs estructurados JSON a stdout (errors a stderr). Summary final a stdout.
 */

// ---------------------------------------------------------------------------
// Tipos públicos (exportados para los tests del directorio __tests__/)
// ---------------------------------------------------------------------------

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

export type Logger = (
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string,
  fields?: Record<string, unknown>,
) => void;

export interface SyncConfig {
  didactaBaseUrl: string;
  adminEmail: string;
  adminPassword: string;
  tenantSlug: string;
  wpBaseUrl: string;
  wpUsername: string;
  wpAppPassword: string;
  dryRun: boolean;
  throttleRps: number;
}

export interface SyncSummary {
  tenant: string;
  processedCourses: number;
  totalEnrollmentsCreated: number;
  alreadyExisted: number;
  usersNotFound: number;
  courseUsersFailedToFetch: number;
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Throttle — token bucket simple
// ---------------------------------------------------------------------------

/**
 * Throttle simple basado en token bucket. `capacity` tokens, se rellenan a
 * `tokensPerSec`. `take()` espera hasta que haya 1 token disponible.
 * Implementado de forma testable inyectando `now` y `sleep`.
 */
export function createThrottle(opts: {
  ratePerSec: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): { take: () => Promise<void> } {
  const rate = Math.max(0.001, opts.ratePerSec);
  const capacity = Math.max(1, Math.ceil(rate));
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let tokens = capacity;
  let lastRefill = now();

  return {
    async take(): Promise<void> {
      // Refill basado en tiempo transcurrido.
      const t = now();
      const elapsedSec = (t - lastRefill) / 1000;
      tokens = Math.min(capacity, tokens + elapsedSec * rate);
      lastRefill = t;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      // No hay token: dormir lo justo para obtener 1.
      const needed = 1 - tokens;
      const waitMs = Math.max(1, Math.ceil((needed / rate) * 1000));
      await sleep(waitMs);
      // Tras dormir, asumir 1 token recién regenerado.
      const t2 = now();
      const elapsed2 = (t2 - lastRefill) / 1000;
      tokens = Math.min(capacity, tokens + elapsed2 * rate);
      lastRefill = t2;
      // Consumir el token (defensa: si por timing aún <1, forzar a 0).
      tokens = Math.max(0, tokens - 1);
    },
  };
}

// ---------------------------------------------------------------------------
// Logging estructurado
// ---------------------------------------------------------------------------

export function createLogger(): Logger {
  return (level, msg, fields) => {
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(fields ?? {}),
    };
    const line = JSON.stringify(entry);
    if (level === 'error') {
      // Errors a stderr para que CI pueda separarlos.
      // eslint-disable-next-line no-console
      console.error(line);
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  };
}

// ---------------------------------------------------------------------------
// HTTP con retry / backoff
// ---------------------------------------------------------------------------

export interface HttpDoOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  maxRetries?: number;
  log?: Logger;
}

export interface HttpDoResult {
  status: number;
  body: string;
  parsed: unknown;
}

/**
 * Hace una petición HTTP con retry exponencial en errores transient
 * (status >= 500 o error de red). 4xx NO se reintenta (es bug, no transient).
 * Vuelve `{ status, body, parsed }` aunque sea 4xx — el caller decide.
 */
export async function httpDo(
  fetchImpl: FetchLike,
  url: string,
  opts: HttpDoOpts = {},
  sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
): Promise<HttpDoResult> {
  const maxRetries = opts.maxRetries ?? 3;
  const method = opts.method ?? 'GET';
  const headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const r = await fetchImpl(url, { method, headers, body });
      const text = await r.text();
      if (r.status >= 500 && attempt < maxRetries) {
        const backoff = Math.min(8000, 250 * 2 ** attempt);
        opts.log?.('warn', 'http_transient_retry', {
          url,
          method,
          status: r.status,
          attempt,
          backoffMs: backoff,
        });
        await sleep(backoff);
        continue;
      }
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      return { status: r.status, body: text, parsed };
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) {
        const backoff = Math.min(8000, 250 * 2 ** attempt);
        opts.log?.('warn', 'http_network_retry', {
          url,
          method,
          attempt,
          backoffMs: backoff,
          error: e instanceof Error ? e.message : String(e),
        });
        await sleep(backoff);
        continue;
      }
    }
  }
  throw lastErr ?? new Error(`http_failed_after_retries: ${method} ${url}`);
}

// ---------------------------------------------------------------------------
// Signin Didacta
// ---------------------------------------------------------------------------

export interface SigninResult {
  accessToken: string;
  tenantId: string;
  userId: string;
}

export async function signin(
  fetchImpl: FetchLike,
  cfg: Pick<SyncConfig, 'didactaBaseUrl' | 'adminEmail' | 'adminPassword' | 'tenantSlug'>,
  log: Logger,
): Promise<SigninResult> {
  const url = `${cfg.didactaBaseUrl}/api/v1/auth/signin`;
  const r = await httpDo(fetchImpl, url, {
    method: 'POST',
    body: {
      tenantSlug: cfg.tenantSlug,
      email: cfg.adminEmail,
      password: cfg.adminPassword,
    },
    log,
  });
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`signin_failed status=${r.status} body=${r.body.slice(0, 300)}`);
  }
  const parsed = r.parsed as {
    tokens?: { accessToken?: string };
    user?: { id?: string; tenantId?: string; tenantSlug?: string };
  } | null;
  const accessToken = parsed?.tokens?.accessToken;
  const tenantId = parsed?.user?.tenantId;
  const userId = parsed?.user?.id;
  if (!accessToken || !tenantId || !userId) {
    throw new Error(`signin_response_invalid body=${r.body.slice(0, 300)}`);
  }
  log('info', 'signin_ok', { tenantId, tenantSlug: parsed?.user?.tenantSlug ?? cfg.tenantSlug });
  return { accessToken, tenantId, userId };
}

// ---------------------------------------------------------------------------
// Build user map (wpUserId → didactaUserId)
// ---------------------------------------------------------------------------

interface AdminUserListResponse {
  items: Array<{
    id: string;
    externalSource: string | null;
    externalId: string | null;
  }>;
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export async function buildUserLookup(
  fetchImpl: FetchLike,
  cfg: Pick<SyncConfig, 'didactaBaseUrl'>,
  accessToken: string,
  log: Logger,
  throttle?: { take: () => Promise<void> },
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const limit = 500;
  let page = 1;
  const MAX_PAGES = 200; // hard cap defensivo (=100k users)
  while (page <= MAX_PAGES) {
    if (throttle) await throttle.take();
    const url = `${cfg.didactaBaseUrl}/api/v1/admin/users?externalSource=learndash&page=${page}&limit=${limit}`;
    const r = await httpDo(fetchImpl, url, {
      headers: { authorization: `Bearer ${accessToken}` },
      log,
    });
    if (r.status !== 200) {
      throw new Error(`admin_users_list_failed status=${r.status} page=${page}`);
    }
    const parsed = r.parsed as AdminUserListResponse | null;
    if (!parsed || !Array.isArray(parsed.items)) {
      throw new Error(`admin_users_list_invalid_shape page=${page}`);
    }
    for (const u of parsed.items) {
      if (u.externalSource === 'learndash' && u.externalId) {
        // El externalId del módulo viene como 'learndash:<wpId>' (helper externalId()
        // de mappers). Aceptamos ambos formatos para defensa:
        const wpId = u.externalId.startsWith('learndash:')
          ? u.externalId.slice('learndash:'.length)
          : u.externalId;
        map.set(wpId, u.id);
      }
    }
    if (!parsed.hasMore) break;
    page += 1;
  }
  log('info', 'user_lookup_built', { mapSize: map.size });
  return map;
}

// ---------------------------------------------------------------------------
// Listar cursos Didacta con externalSource=learndash
// ---------------------------------------------------------------------------

export interface DidactaCourse {
  id: string;
  externalSource: string | null;
  externalId: string | null;
  title?: string;
}

export async function listLearndashCourses(
  fetchImpl: FetchLike,
  cfg: Pick<SyncConfig, 'didactaBaseUrl'>,
  accessToken: string,
  log: Logger,
  throttle?: { take: () => Promise<void> },
): Promise<DidactaCourse[]> {
  if (throttle) await throttle.take();
  const url = `${cfg.didactaBaseUrl}/api/v1/modules/courses`;
  const r = await httpDo(fetchImpl, url, {
    headers: { authorization: `Bearer ${accessToken}` },
    log,
  });
  if (r.status !== 200) {
    throw new Error(`courses_list_failed status=${r.status}`);
  }
  const arr = (r.parsed ?? []) as DidactaCourse[];
  if (!Array.isArray(arr)) {
    throw new Error(`courses_list_invalid_shape`);
  }
  const filtered = arr.filter((c) => c.externalSource === 'learndash' && c.externalId);
  log('info', 'courses_listed', { total: arr.length, learndash: filtered.length });
  return filtered;
}

// ---------------------------------------------------------------------------
// Listar users enrolados en un curso de LearnDash (WP REST API)
// ---------------------------------------------------------------------------

function basicAuthHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/**
 * Devuelve la lista de WP user IDs enrolados en el curso LD `externalId`.
 * El externalId puede venir como `learndash:123` (formato del mapper) o como
 * `123` (id puro de WP). Normalizamos a `123`.
 */
export async function listWpCourseEnrolledUserIds(
  fetchImpl: FetchLike,
  cfg: Pick<SyncConfig, 'wpBaseUrl' | 'wpUsername' | 'wpAppPassword'>,
  externalId: string,
  log: Logger,
  throttle?: { take: () => Promise<void> },
): Promise<string[]> {
  const ldId = externalId.startsWith('learndash:')
    ? externalId.slice('learndash:'.length)
    : externalId;
  const auth = basicAuthHeader(cfg.wpUsername, cfg.wpAppPassword);
  const perPage = 100;
  const MAX_PAGES = 200;
  const ids = new Set<string>();
  let page = 1;
  while (page <= MAX_PAGES) {
    if (throttle) await throttle.take();
    const url = `${cfg.wpBaseUrl}/wp-json/ldlms/v1/sfwd-courses/${ldId}/users?per_page=${perPage}&page=${page}`;
    const r = await httpDo(fetchImpl, url, {
      headers: { authorization: auth, accept: 'application/json' },
      log,
    });
    if (r.status === 400 || r.status === 404) {
      // 400/404 al pasar de la última página es el comportamiento típico de WP REST.
      break;
    }
    if (r.status !== 200) {
      throw new Error(`wp_course_users_failed status=${r.status} courseId=${ldId} page=${page}`);
    }
    const items = (r.parsed ?? []) as unknown[];
    if (!Array.isArray(items)) {
      throw new Error(`wp_course_users_invalid_shape courseId=${ldId} page=${page}`);
    }
    for (const it of items) {
      if (it === null || it === undefined) continue;
      // LD V1 returns either string[] of WP user IDs OR object[] with .id field.
      // Soportar ambos formatos.
      if (typeof it === 'string' || typeof it === 'number') {
        ids.add(String(it));
      } else if (typeof it === 'object' && 'id' in it) {
        const v = (it as { id?: number | string }).id;
        if (v !== undefined && v !== null) ids.add(String(v));
      }
    }
    if (items.length < perPage) break;
    page += 1;
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// Crear enrollment
// ---------------------------------------------------------------------------

export type CreateEnrollmentResult = 'created' | 'already' | 'failed';

export async function createEnrollment(
  fetchImpl: FetchLike,
  cfg: Pick<SyncConfig, 'didactaBaseUrl'>,
  accessToken: string,
  userId: string,
  courseId: string,
  log: Logger,
  throttle?: { take: () => Promise<void> },
): Promise<CreateEnrollmentResult> {
  if (throttle) await throttle.take();
  const url = `${cfg.didactaBaseUrl}/api/v1/modules/learning/enrollments`;
  const r = await httpDo(fetchImpl, url, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
    body: { userId, courseId },
    log,
  });
  if (r.status === 201 || r.status === 200) return 'created';
  if (r.status === 409) return 'already';
  log('error', 'enrollment_create_failed', {
    status: r.status,
    userId,
    courseId,
    body: r.body.slice(0, 200),
  });
  return 'failed';
}

// ---------------------------------------------------------------------------
// Flow principal — procesa un curso
// ---------------------------------------------------------------------------

export interface CourseProcessResult {
  courseId: string;
  externalId: string;
  enrolledInWp: number;
  created: number;
  already: number;
  usersNotFound: number;
  failed: number;
  fetchFailed: boolean;
}

export async function processCourse(deps: {
  fetchImpl: FetchLike;
  cfg: SyncConfig;
  accessToken: string;
  course: DidactaCourse;
  userLookup: Map<string, string>;
  log: Logger;
  throttle?: { take: () => Promise<void> };
}): Promise<CourseProcessResult> {
  const { fetchImpl, cfg, accessToken, course, userLookup, log, throttle } = deps;
  const ext = course.externalId ?? '';
  const result: CourseProcessResult = {
    courseId: course.id,
    externalId: ext,
    enrolledInWp: 0,
    created: 0,
    already: 0,
    usersNotFound: 0,
    failed: 0,
    fetchFailed: false,
  };

  let wpUserIds: string[];
  try {
    wpUserIds = await listWpCourseEnrolledUserIds(fetchImpl, cfg, ext, log, throttle);
  } catch (e) {
    result.fetchFailed = true;
    log('error', 'course_users_fetch_failed', {
      courseId: course.id,
      externalId: ext,
      error: e instanceof Error ? e.message : String(e),
    });
    return result;
  }
  result.enrolledInWp = wpUserIds.length;

  for (const wpId of wpUserIds) {
    const didactaUserId = userLookup.get(wpId);
    if (!didactaUserId) {
      result.usersNotFound += 1;
      log('warn', 'user_not_migrated', { wpUserId: wpId, courseId: course.id });
      continue;
    }
    if (cfg.dryRun) {
      result.created += 1; // contabilidad simbólica en dry-run
      log('info', 'dry_run_would_create_enrollment', {
        userId: didactaUserId,
        courseId: course.id,
      });
      continue;
    }
    const outcome = await createEnrollment(
      fetchImpl,
      cfg,
      accessToken,
      didactaUserId,
      course.id,
      log,
      throttle,
    );
    if (outcome === 'created') result.created += 1;
    else if (outcome === 'already') result.already += 1;
    else result.failed += 1;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runSync(deps: {
  fetchImpl: FetchLike;
  cfg: SyncConfig;
  log?: Logger;
  throttle?: { take: () => Promise<void> };
}): Promise<{ summary: SyncSummary; exitCode: number }> {
  const log = deps.log ?? createLogger();
  const throttle = deps.throttle ?? createThrottle({ ratePerSec: deps.cfg.throttleRps });

  log('info', 'sync_start', {
    didactaBaseUrl: deps.cfg.didactaBaseUrl,
    tenantSlug: deps.cfg.tenantSlug,
    dryRun: deps.cfg.dryRun,
    throttleRps: deps.cfg.throttleRps,
  });

  const session = await signin(deps.fetchImpl, deps.cfg, log);

  const userLookup = await buildUserLookup(
    deps.fetchImpl,
    deps.cfg,
    session.accessToken,
    log,
    throttle,
  );
  const courses = await listLearndashCourses(
    deps.fetchImpl,
    deps.cfg,
    session.accessToken,
    log,
    throttle,
  );

  const perCourse: CourseProcessResult[] = [];
  let coursesWithHighFailRate = 0;

  for (const course of courses) {
    const r = await processCourse({
      fetchImpl: deps.fetchImpl,
      cfg: deps.cfg,
      accessToken: session.accessToken,
      course,
      userLookup,
      log,
      throttle,
    });
    perCourse.push(r);
    // ≥10% fail rate (excluyendo usersNotFound y fetchFailed, que se cuentan aparte)
    const attempted = r.created + r.already + r.failed;
    if (attempted > 0 && r.failed / attempted >= 0.1) {
      coursesWithHighFailRate += 1;
    }
  }

  const summary: SyncSummary = {
    tenant: deps.cfg.tenantSlug,
    processedCourses: perCourse.length,
    totalEnrollmentsCreated: perCourse.reduce((s, r) => s + r.created, 0),
    alreadyExisted: perCourse.reduce((s, r) => s + r.already, 0),
    usersNotFound: perCourse.reduce((s, r) => s + r.usersNotFound, 0),
    courseUsersFailedToFetch: perCourse.filter((r) => r.fetchFailed).length,
    dryRun: deps.cfg.dryRun,
  };

  log('info', 'sync_summary', summary as unknown as Record<string, unknown>);

  const exitCode = coursesWithHighFailRate > 0 ? 1 : 0;
  return { summary, exitCode };
}

// ---------------------------------------------------------------------------
// Config desde env
// ---------------------------------------------------------------------------

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SyncConfig {
  const didactaBaseUrl = env.E2E_BASE_URL ?? env.DIDACTA_URL;
  const required = {
    didactaBaseUrl,
    adminEmail: env.E2E_ADMIN_EMAIL,
    adminPassword: env.E2E_ADMIN_PASSWORD,
    tenantSlug: env.E2E_TENANT_SLUG,
    wpBaseUrl: env.E2E_LD_BASE_URL,
    wpUsername: env.E2E_LD_USERNAME,
    wpAppPassword: env.E2E_LD_APP_PASSWORD,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v || String(v).trim().length === 0)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
  const dryRun = String(env.SYNC_DRY_RUN ?? 'false').toLowerCase() === 'true';
  const throttleRps = Number(env.SYNC_THROTTLE_RPS ?? '5');
  if (!Number.isFinite(throttleRps) || throttleRps <= 0) {
    throw new Error(`SYNC_THROTTLE_RPS must be a positive number`);
  }
  return {
    didactaBaseUrl: (required.didactaBaseUrl as string).replace(/\/+$/, ''),
    adminEmail: required.adminEmail as string,
    adminPassword: required.adminPassword as string,
    tenantSlug: required.tenantSlug as string,
    wpBaseUrl: (required.wpBaseUrl as string).replace(/\/+$/, ''),
    wpUsername: required.wpUsername as string,
    wpAppPassword: required.wpAppPassword as string,
    dryRun,
    throttleRps,
  };
}

// ---------------------------------------------------------------------------
// Adapter Node fetch → FetchLike (para no acoplar el runtime al tipo nativo)
// ---------------------------------------------------------------------------

const nodeFetchAdapter: FetchLike = async (input, init) => {
  // `fetch` es global en Node 18+. Node 22 lo confirma.
  const res = await fetch(input, init as RequestInit);
  return {
    status: res.status,
    text: () => res.text(),
    json: () => res.json(),
  };
};

// ---------------------------------------------------------------------------
// Entry point CLI
// ---------------------------------------------------------------------------

async function mainCli(): Promise<void> {
  const log = createLogger();
  let cfg: SyncConfig;
  try {
    cfg = readConfigFromEnv();
  } catch (e) {
    log('error', 'config_invalid', { error: e instanceof Error ? e.message : String(e) });
    process.exit(2);
    return;
  }
  try {
    const { exitCode } = await runSync({ fetchImpl: nodeFetchAdapter, cfg, log });
    process.exit(exitCode);
  } catch (e) {
    log('error', 'sync_fatal', { error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  }
}

// Auto-ejecutar solo si es el entry-point directo (no cuando lo importan tests).
// Heurística simple: argv[1] termina con el nombre del archivo. Funciona en
// tsx + node (CJS o ESM). En vitest argv[1] apunta al runner → no se dispara.
const isDirectRun = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
  const a1 = norm(argv1);
  return (
    a1.endsWith('/sync-enrollments-from-learndash.ts') ||
    a1.endsWith('/sync-enrollments-from-learndash.js')
  );
})();

if (isDirectRun) {
  void mainCli();
}
