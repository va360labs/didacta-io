/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Prisma } from '@didacta/database';

/**
 * Modo de enforcement de RLS en runtime (env RLS_ENFORCEMENT):
 *
 * - `off`  → la extensión no se instala; comportamiento previo a F1.
 * - `warn` → (default) toda operación de modelo con contexto de tenant se
 *   envuelve en una transacción batch con `set_config('app.current_tenant_id')`
 *   y toda operación SIN contexto sobre un modelo multi-tenant se loguea como
 *   hueco (la lista de huecos es el worklist de la fase 2). La app aún conecta
 *   con el usuario bootstrap, así que RLS no filtra: el modo existe para pagar
 *   el coste real, medirlo y llevar los huecos a cero ANTES del flip.
 * - `on`   → igual que `warn` pero los huecos se loguean a nivel error. El
 *   enforcement REAL llega al conectar como `didacta_app` (fase 3): entonces
 *   una query sin contexto devuelve 0 filas (fail-closed) en las tablas con
 *   tenant_id.
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
  return 'warn';
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
              if (scoped) opts.onGap({ model, operation });
              return query(args);
            }
            if (ctx.gucApplied || !scoped) {
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
