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

interface ModuleRouteRequestContext {
  method: AllowedMethod;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  body: unknown;
  user: { sub: string; tenantId: string; roles: string[] } | null;
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

// ---- Routes -------------------------------------------------------

const routes: ModuleRoute[] = [
  // Sanity check: ping libre, sin auth.
  {
    method: 'GET',
    path: '/ping',
    handler: () => ok({ ok: true, name: manifest.name, version: manifest.version, ts: nowIso() }),
  },

  // POST /preflight — valida credenciales del origen y devuelve conteos.
  // En MVP sin Prisma scoped, NO hace fetch real al WP del usuario; devuelve
  // un esqueleto con la URL recibida. Suficiente para que el wizard se
  // mueva al siguiente paso. El fetch real se activará cuando el host
  // exponga StorageService/HttpService scoped al módulo.
  {
    method: 'POST',
    path: '/preflight',
    handler: (req) => {
      const auth = requireUser(req);
      if (isResponse(auth)) return auth;
      const body = (req.body ?? {}) as { credentials?: { baseUrl?: string; username?: string; appPassword?: string } };
      const creds = body.credentials;
      if (!creds?.baseUrl || !creds?.username || !creds?.appPassword) {
        return err(400, 'VALIDATION_ERROR', 'credentials.baseUrl + username + appPassword requeridos.');
      }
      // Stub: en MVP confirmamos el shape; el fetch real al WP llegará cuando el host exponga http.
      return ok({
        ok: true,
        siteName: 'WordPress origen (preflight stub)',
        latencyMs: 0,
        counts: { courses: 0, lessons: 0, topics: 0, quizzes: 0, groups: 0, users: 0, media: 0 },
        warnings: [
          {
            code: 'STUB_PREFLIGHT',
            message:
              'Preflight en modo stub: el módulo aún no tiene acceso a HTTP scoped en la VM del host. Conteos reales llegarán con la siguiente versión del marketplace.',
          },
        ],
        capabilities: { learndashV1: true, learndashV2: false, wpRest: true },
      });
    },
  },

  // POST /jobs — crea un job y lo deja en pending.
  {
    method: 'POST',
    path: '/jobs',
    handler: (req) => {
      const auth = requireUser(req);
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
      const auth = requireUser(req);
      if (isResponse(auth)) return auth;
      return ok({ items: listTenantJobs(auth.tenantId) });
    },
  },

  // GET /jobs/:id — estado de un job.
  {
    method: 'GET',
    path: '/jobs/:id',
    handler: (req) => {
      const auth = requireUser(req);
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
      const auth = requireUser(req);
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
      const auth = requireUser(req);
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

// CommonJS export — esbuild --format=cjs respeta esta forma.
module.exports = { onInstall, onUninstall, routes };
