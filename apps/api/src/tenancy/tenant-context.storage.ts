/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface TenantContext {
  tenantId: string;
  userId?: string;
  traceId: string;
  /**
   * true cuando el código ya corre dentro de una transacción que seteó el GUC
   * `app.current_tenant_id` (withTenantContext / asAdmin). La extensión de
   * enforcement de RLS lo lee para NO envolver esas operaciones otra vez.
   */
  gucApplied?: boolean;
}

/**
 * ALS único de proceso para el contexto de tenant.
 *
 * Vive fuera de TenantContextService para que la extensión del cliente Prisma
 * (que se instancia en la factory de PrismaModule, antes del grafo de DI)
 * pueda leer el contexto sin acoplar PrismaModule a TenancyModule.
 */
export const tenantContextStorage = new AsyncLocalStorage<TenantContext>();

const sanctionedGlobalAccessStorage = new AsyncLocalStorage<true>();

/**
 * Marca una operación de infraestructura como acceso global SANCIONADO:
 * legítimamente cross-tenant y sin contexto (barridos del outbox, resolución
 * host→tenant, healers de arranque). La telemetría RLS no la cuenta como
 * hueco.
 *
 * Cada call site de este helper es inventario del flip (RLS F3): son las
 * operaciones que deberán ejecutarse por la conexión `didacta_super` (o una
 * policy explícita) cuando el runtime conecte como `didacta_app`.
 *
 * El await ocurre DENTRO del scope del ALS a propósito: una PrismaPromise es
 * lazy y ejecuta su hook cuando se le hace await — si el caller la esperase
 * fuera del scope, el hook no vería la marca (caracterizado contra Prisma
 * 5.22).
 */
export async function runSanctionedGlobalAccess<T>(fn: () => Promise<T> | T): Promise<T> {
  return sanctionedGlobalAccessStorage.run(true, async () => await fn());
}

/** ¿La operación actual corre bajo runSanctionedGlobalAccess()? */
export function isSanctionedGlobalAccess(): boolean {
  return sanctionedGlobalAccessStorage.getStore() === true;
}

/**
 * Abre el contexto ALS de un tenant SIN gucApplied: la extensión RLS envuelve
 * cada query con su set_config. Es el patrón para caminos fuera del
 * middleware que YA conocen su tenant — endpoints públicos resueltos por
 * Host/slug/ticket y el procesado por-fila de los workers — cuyos services
 * usan su propio PrismaService inyectado (no el tx de withTenantId, que
 * marcaría gucApplied sobre queries que NO corren en esa transacción).
 *
 * El await ocurre DENTRO del scope (PrismaPromise lazy — misma razón que en
 * runSanctionedGlobalAccess).
 */
export async function runAsTenant<T>(
  tenantId: string,
  fn: () => Promise<T> | T,
  opts: { userId?: string; traceLabel?: string } = {},
): Promise<T> {
  const parent = tenantContextStorage.getStore();
  return tenantContextStorage.run(
    {
      tenantId,
      userId: opts.userId ?? parent?.userId,
      traceId: parent?.traceId ?? `${opts.traceLabel ?? 'ctx'}-${randomUUID()}`,
    },
    async () => await fn(),
  );
}
