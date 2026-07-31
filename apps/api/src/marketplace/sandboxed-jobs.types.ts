/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Contrato del cliente de jobs que el host expone a los módulos third-party
 * del marketplace. Introducido en alpha.55 para cerrar el hueco del Sprint 3
 * (JR-006 — primer encolado desde un handler del módulo).
 *
 * Antes de alpha.55 el módulo podía declarar `manifest.jobLifecycle.onTickFn`
 * y el host registraba el handler en `ModuleJobLifecycleRegistry`, pero el
 * módulo no tenía API para **encolar el primer tick** desde sus routes. El
 * resultado era que el handler `POST /jobs` del migrator persistía el row en
 * BD y devolvía 201, pero el worker BullMQ nunca recibía nada y el job se
 * quedaba en `pending` para siempre.
 *
 * Este contrato vive en archivo separado para que tres consumidores lo
 * compartan sin ciclos de import:
 *  1. `module-router.service.ts` — `ModuleRouteRequestContext.jobs`
 *  2. `modules-dispatcher.controller.ts` — construye `ctx.jobs` por request
 *  3. `sandboxed-jobs.service.ts` — `ScopedJobsApiFactory` (impl real)
 *
 * Reglas estructurales (todas impuestas por el host):
 *  - **Solo módulos con `jobLifecycle` declarado** pueden usar `ctx.jobs`.
 *    Si el manifest no lo declara → el módulo recibe `BlockedSandboxedJobs`
 *    que rechaza con `JOBS_NOT_DECLARED` + mensaje accionable (cómo añadir
 *    el bloque al manifest).
 *  - **tenantId implícito**: el módulo NUNCA pasa `tenantId`. La factory lo
 *    extrae del request (mismo patrón que ScopedDidactaApi) y lo congela en
 *    la closure. Eso elimina cross-tenant leak por descuido del módulo.
 *  - **moduleName implícito**: idéntico. El módulo NO puede encolar jobs en
 *    otro módulo — la factory lo congela.
 *  - **tickIndex inicial = 0**: el primer encolado es siempre el "kickoff".
 *    Los re-encolados de ticks subsiguientes los gestiona el worker
 *    automáticamente cuando `onJobTick` retorna `{ status: 'continue' }`.
 */

/// Códigos de error tipados que `ctx.jobs` puede lanzar. El módulo decide
/// qué hacer (propagar 503 al user, persistir el job como `failed`, etc.).
export type JobsErrorCode =
  /// El manifest del módulo no declara `jobLifecycle`. El módulo NO puede
  /// usar `ctx.jobs` hasta que añada el bloque al manifest y se reinstale.
  | 'JOBS_NOT_DECLARED'
  /// La queue BullMQ del host está deshabilitada (sin REDIS_URL en env, o
  /// `NODE_ENV=test`). El operador del host tiene que setear REDIS_URL y
  /// reiniciar el API antes de que los jobs se procesen.
  | 'JOBS_QUEUE_DISABLED'
  /// Redis rechazó el enqueue (red caída, OOM, etc.). Transitorio — el
  /// módulo puede reintentar con backoff.
  | 'JOBS_NETWORK';

export class JobsError extends Error {
  constructor(
    public readonly code: JobsErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'JobsError';
  }
}

export interface ScheduleTickArgs {
  /// UUID del job dentro del módulo (mismo que la fila en
  /// `mod_<slug>_jobs`). Opaco para el host — se devuelve al `onJobTick`
  /// en `ctx.jobId` sin transformaciones.
  jobId: string;
  /// Segundos a esperar antes del primer tick. Default 0 (encolar inmediato).
  /// Útil cuando el handler quiere darle al cliente HTTP unos segundos para
  /// recibir el 201 antes de empezar a trabajar.
  delaySec?: number;
}

/// Cliente que el módulo recibe vía `ctx.jobs` en sus route handlers (y, en
/// futuras iteraciones, en su `onJobTick` — para que un tick pueda encolar
/// sub-jobs si el modelo lo requiere).
export interface SandboxedJobs {
  /// Encola el primer tick (tickIndex=0) de un job. El worker BullMQ del
  /// host invocará `onJobTick` con `ctx.jobId` igual al pasado aquí. Los
  /// re-encolados subsiguientes son automáticos: si `onJobTick` retorna
  /// `{ status: 'continue' }` el worker re-encola con tickIndex+1.
  ///
  /// Idempotencia: la queue del host dedupea por
  /// `${moduleName}:${jobId}:${tickIndex}`. Si el handler se reintenta y
  /// llama a `scheduleTick` dos veces con el mismo jobId, BullMQ rechaza
  /// el segundo silenciosamente (no se lanza error).
  scheduleTick(args: ScheduleTickArgs): Promise<void>;
}

/// Implementación que el host inyecta cuando el módulo NO declara
/// `manifest.jobLifecycle`. Cualquier intento de uso falla con un
/// `JobsError` que explica exactamente qué hay que añadir al manifest.
export class BlockedSandboxedJobs implements SandboxedJobs {
  constructor(private readonly moduleName: string) {}

  async scheduleTick(_args: ScheduleTickArgs): Promise<void> {
    throw new JobsError(
      'JOBS_NOT_DECLARED',
      `El módulo "${this.moduleName}" no declara "jobLifecycle" en su manifest. ` +
        `Para usar ctx.jobs.scheduleTick(...) añadí: ` +
        `"jobLifecycle": { "onTickFn": "onJobTick" } al manifest, exportá la ` +
        `función con ese nombre desde dist/index.js, y reinstalá el módulo.`,
    );
  }
}
