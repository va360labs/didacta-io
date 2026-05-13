import type { SandboxedDb } from '../sandboxed-db.types';
import type { SandboxedHttp } from '../sandboxed-http.types';
import type { DidactaApi } from '../sandboxed-didacta.types';
import type { SandboxedSecrets } from '../sandboxed-secrets.types';

/**
 * Tipos del runtime de jobs del marketplace (Sprint 3 / JR-002).
 *
 * Un módulo third-party puede declarar `jobLifecycle.onTickFn` en su
 * manifest y exportar la función desde `dist/index.js`. El worker
 * BullMQ (`ModJobsWorkerService`) la invoca con un context similar al
 * de un request HTTP (`ModuleRouteRequestContext`) pero sin las piezas
 * relacionadas a HTTP entrante (user, method, path, params, query, body).
 *
 * El módulo retorna un `JobTickResult` que le dice al worker qué hacer
 * a continuación: re-encolar (`continue`), terminar exitoso (`completed`)
 * o terminar con fallo (`failed`). Esto permite jobs de larga duración
 * implementados como state-machine cooperativa: cada tick procesa un
 * batch y devuelve `continue` hasta agotar el trabajo.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Resultado del tick
// ─────────────────────────────────────────────────────────────────────────────

/// Resultado que el `onJobTick` del módulo retorna al worker.
///
///  - `continue` → el módulo pidió ejecutar otro tick. `delaySec` opcional
///    indica cuántos segundos esperar antes del próximo (útil para
///    pacing contra APIs externas). Default 0 (siguiente tick lo antes
///    posible, sujeto al refill del rate limiter del módulo).
///  - `completed` → el job terminó OK. NO se re-encola.
///  - `failed` → el job terminó con error. NO se re-encola.
///    `reason` queda registrado en logs/metrics y el módulo es
///    responsable de actualizar el estado en su tabla `mod_<slug>_jobs`
///    (vía ctx.db) si quiere persistencia del fallo.
export type JobTickResult =
  | { status: 'continue'; delaySec?: number }
  | { status: 'completed' }
  | { status: 'failed'; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// Context que recibe el handler del módulo
// ─────────────────────────────────────────────────────────────────────────────

/// Context que el worker pasa al `onJobTick` del módulo. Mismo shape que
/// `ModuleRouteRequestContext` pero sin las piezas de request HTTP
/// entrante (user, method, path, params, query, body).
///
/// Reglas estructurales (equivalentes al request context):
///  - `db`: scoped al `tablePrefix` del manifest. SQL guard rechaza
///    cualquier query fuera del prefijo. Si el módulo NO declara
///    `requiresDb: true`, recibe un `BlockedSandboxedDb`.
///  - `http`: scoped al manifest.http. Allowlist + rate limit + SSRF.
///    Si el módulo NO declara `http`, recibe un `BlockedSandboxedHttp`.
///    NO lleva AbortSignal porque el job no tiene reply/connection que
///    cancelar — el timeout duro lo aplica el worker (5 min).
///  - `didacta`: scoped al `manifest.didacta.permissions`. Si el módulo
///    NO declara el bloque, recibe un `BlockedDidactaApi`.
///
/// `tickIndex` permite al módulo implementar lógica idempotente o de
/// progress (ej. "en el tick 0 cargo el catálogo, en los siguientes
/// proceso 50 cursos por vez"). Empieza en 0 y el worker lo incrementa
/// en cada re-encolado.
export interface ModuleJobTickContext {
  moduleName: string;
  moduleVersion: string;
  jobId: string;
  tenantId: string;
  tickIndex: number;
  log: (level: 'log' | 'warn' | 'error', message: string) => void;
  db: SandboxedDb;
  http: SandboxedHttp;
  didacta: DidactaApi;
  /// Store cifrado scoped al módulo + tenant (alpha.56). Si el manifest
  /// no declara `requiresSecrets: true`, recibe `BlockedSandboxedSecrets`
  /// que rechaza con SECRETS_NOT_DECLARED. En workers BullMQ el tenantId
  /// SIEMPRE está disponible (lo trae el payload del job), así que nunca
  /// recibe `AnonymousSandboxedSecrets` aquí — solo en routes anónimas.
  secrets: SandboxedSecrets;
}

/// Handler que un módulo declara y exporta como
/// `module.exports[manifest.jobLifecycle.onTickFn]`. El sandbox lo lee
/// en `loadModule()` y lo registra en `ModuleJobLifecycleRegistry`.
///
/// Puede ser sync o async; el worker lo envuelve con `Promise.race`
/// contra un timeout duro de 5 minutos. Si tarda más, el tick se aborta
/// y se re-encola con backoff (no se considera fallo terminal — los
/// jobs largos pueden necesitar más vueltas, no más tiempo por tick).
export type ModuleJobTickHandler = (
  ctx: ModuleJobTickContext,
) => Promise<JobTickResult> | JobTickResult;
