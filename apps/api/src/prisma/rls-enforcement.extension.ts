/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma } from '@didacta/database';

/**
 * Marca "estamos dentro de un $transaction del caller" (batch o interactiva).
 *
 * El wrap `$transaction([set_config, query])` de la extensión ejecuta la query
 * en una transacción NUEVA del cliente base — si la operación ya venía dentro
 * de una transacción del servicio, el wrap la SACA de ella (caracterizado
 * contra Prisma 5.22) y rompe su atomicidad: p.ej. el batch de messaging
 * (conversation.create + participant.create) acababa en dos transacciones
 * independientes y la FK del participant fallaba de forma intermitente.
 *
 * La factory de PrismaModule envuelve `$transaction` del cliente extendido con
 * este scope; el hook lo consulta y NO envuelve esas operaciones (quedan en su
 * transacción, sin GUC — telemetría aparte con firma `@tx`: son el worklist de
 * los ~17 `$transaction` propios de la fase 2).
 */
const prismaTransactionScope = new AsyncLocalStorage<true>();

export function markPrismaTransactionScope<T>(fn: () => Promise<T>): Promise<T> {
  return prismaTransactionScope.run(true, fn);
}

export function isInsidePrismaTransaction(): boolean {
  return prismaTransactionScope.getStore() === true;
}

/**
 * F2 (@tx): ejecuta un `$transaction` del caller inyectando el GUC del tenant
 * DENTRO de su propia transacción — primer statement en la forma batch,
 * primera operación del callback en la interactiva. Así las ~17 firmas `@tx`
 * (servicios que abren su $transaction en el request path) quedan escopadas
 * sin romper su atomicidad y sin tocar los call sites.
 *
 * El cuerpo corre bajo `runWithGucApplied` (ALS con gucApplied=true) además
 * del scope de transacción: los hooks de las ops internas ni re-envuelven ni
 * cuentan hueco. Sin contexto de tenant (o ya gucApplied, p.ej. dentro de
 * withTenantContext) el comportamiento es el previo: solo el marker.
 */
export function runCallerTransaction(opts: {
  original: (...args: unknown[]) => Promise<unknown>;
  args: unknown[];
  ctx: { tenantId?: string; gucApplied?: boolean } | undefined;
  /** Crea la PrismaPromise `SELECT set_config(...)` sobre el cliente extendido. */
  makeSetConfig: (tenantId: string) => unknown;
  /** Corre fn bajo el ALS de tenant con gucApplied=true. */
  runWithGucApplied: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<unknown> {
  const { original, args, ctx, makeSetConfig, runWithGucApplied } = opts;
  if (!ctx?.tenantId || ctx.gucApplied) {
    return markPrismaTransactionScope(() => original(...args));
  }
  const tenantId = ctx.tenantId;
  const scoped = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithGucApplied(() => markPrismaTransactionScope(fn));
  const [first, ...rest] = args;
  if (Array.isArray(first)) {
    return scoped(() => original([makeSetConfig(tenantId), ...first], ...rest)).then(
      // El caller no sabe del miembro inyectado: se descarta su resultado.
      (results) => (results as unknown[]).slice(1),
    );
  }
  if (typeof first === 'function') {
    const callback = first as (tx: unknown) => Promise<unknown>;
    const withGuc = async (tx: unknown) => {
      await (tx as { $queryRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> })
        .$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      return callback(tx);
    };
    return scoped(() => original(withGuc, ...rest));
  }
  return markPrismaTransactionScope(() => original(...args));
}

/**
 * Modo de enforcement de RLS en runtime (env RLS_ENFORCEMENT):
 *
 * - `off`  → la extensión no se instala; comportamiento previo a F1.
 * - `warn` → toda operación de modelo con contexto de tenant se envuelve en
 *   una transacción batch con `set_config('app.current_tenant_id')` y toda
 *   operación SIN contexto sobre un modelo multi-tenant se loguea como hueco
 *   (la lista de huecos es el worklist de la fase 2). La app aún conecta con
 *   el usuario bootstrap, así que RLS no filtra: el modo existe para pagar el
 *   coste real, medirlo y llevar los huecos a cero ANTES del flip.
 * - `on`   → (default desde la release intermedia F3) igual que `warn` pero
 *   los huecos se loguean a nivel error: cualquier hueco que una instalación
 *   real destape con config distinta a la nuestra sale a log-error SIN romper
 *   nada (la app sigue conectando como bootstrap y RLS aún no filtra). El
 *   enforcement REAL llega al conectar como `didacta_app` (release siguiente):
 *   entonces una query sin contexto devuelve 0 filas (fail-closed) en las
 *   tablas con tenant_id.
 *
 * Limitación conocida (caracterizada empíricamente contra Prisma 5.22):
 * una PrismaPromise devuelta DIRECTAMENTE fuera del scope del ALS (sin await
 * dentro del contexto) ejecuta su hook sin contexto y cae al camino de hueco.
 * En el request path real (TenantMiddleware envuelve todo el request) no
 * ocurre; si aparece en telemetría, la corrección es await-ear dentro del
 * contexto. Igual de importante: NUNCA usar `query(args)` dentro de una
 * transacción interactiva del hook — no se une a la transacción (verificado).
 */
export type RlsEnforcementMode = 'off' | 'warn' | 'on';

export function resolveRlsEnforcementMode(
  raw: string | undefined = process.env['RLS_ENFORCEMENT'],
): RlsEnforcementMode {
  const v = raw?.trim().toLowerCase();
  if (v === 'off' || v === 'warn' || v === 'on') return v;
  // Default `on` (decisión F3, release intermedia): telemetría de huecos a
  // error mientras la app sigue conectando como bootstrap. El flip real a
  // didacta_app es la release siguiente (cambio de DATABASE_URL).
  return 'on';
}

/**
 * Modelos cuyo aislamiento depende de RLS: los que tienen columna tenant_id.
 * Se calcula del DMMF del cliente generado; si el DMMF no está disponible se
 * asume que TODOS los modelos son multi-tenant (conservador: más telemetría,
 * nunca menos).
 */
export function buildTenantScopedModelSet(): ReadonlySet<string> {
  try {
    const models = Prisma.dmmf.datamodel.models;
    return new Set(
      models.filter((m) => m.fields.some((f) => f.name === 'tenantId')).map((m) => m.name),
    );
  } catch {
    return new Set<string>();
  }
}

export interface RlsGap {
  model: string;
  operation: string;
}

export interface RlsEnforcementOptions {
  mode: Exclude<RlsEnforcementMode, 'off'>;
  /** Lee el contexto de tenant vigente (ALS). */
  getContext: () => { tenantId?: string; gucApplied?: boolean } | undefined;
  /**
   * Modelos multi-tenant. Vacío ⇒ tratar todos como multi-tenant
   * (fallback conservador cuando el DMMF no está disponible).
   */
  tenantModels: ReadonlySet<string>;
  /** Telemetría: operación sobre modelo multi-tenant sin contexto. */
  onGap: (gap: RlsGap) => void;
  /**
   * true si la operación actual es un acceso global sancionado
   * (runSanctionedGlobalAccess): sin contexto pero legítimo — no cuenta
   * como hueco.
   */
  isSanctioned?: () => boolean;
  /**
   * true si la operación corre dentro de un `$transaction` del caller
   * (markPrismaTransactionScope): no se envuelve — el wrap la sacaría de su
   * transacción — y se telemetría con firma `@tx` (worklist F2).
   */
  isInTransaction?: () => boolean;
}

/**
 * Extensión de cliente Prisma que propaga el tenant del ALS a Postgres.
 *
 * Patrón (el oficial de Prisma para RLS, verificado contra BD real):
 * `$transaction([ set_config(..., true) , query(args) ])` — batch de dos
 * miembros sobre el cliente base; `set_config(..., local=true)` muere con la
 * transacción, y el tenantId viaja como parámetro bind.
 *
 * No envuelve cuando: no hay contexto (hueco → telemetría), el contexto marca
 * `gucApplied` (ya estamos dentro de withTenantContext/asAdmin, que setean el
 * GUC en su propia transacción), o el modelo no es multi-tenant.
 */
export function createRlsEnforcementExtension(opts: RlsEnforcementOptions) {
  return Prisma.defineExtension((client) =>
    client.$extends({
      name: 'rls-enforcement',
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const scoped = opts.tenantModels.size === 0 || opts.tenantModels.has(model);
            const ctx = opts.getContext();

            if (!ctx?.tenantId) {
              if (scoped && !opts.isSanctioned?.()) opts.onGap({ model, operation });
              return query(args);
            }
            if (ctx.gucApplied || !scoped) {
              return query(args);
            }
            if (opts.isInTransaction?.()) {
              // Dentro de un $transaction del caller: envolver la sacaría de
              // su transacción (rompe atomicidad — FK intermitentes). Corre
              // sin GUC y se registra con firma propia para el worklist F2.
              opts.onGap({ model, operation: `${operation}@tx` });
              return query(args);
            }

            const [, result] = await client.$transaction([
              client.$queryRaw`SELECT set_config('app.current_tenant_id', ${ctx.tenantId}, true)`,
              query(args) as unknown as Prisma.PrismaPromise<unknown>,
            ]);
            return result;
          },
        },
      },
    }),
  );
}
