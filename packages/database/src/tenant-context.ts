/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { Prisma, PrismaClient } from '@prisma/client';

type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Ejecuta una operación dentro de una transacción con `app.current_tenant_id`
 * seteado. Las políticas RLS del schema se aplican automáticamente a toda query
 * dentro del callback.
 *
 * Única implementación canónica del tenant-scope: TenantPrismaService y
 * SuperAdminPrismaService del API delegan aquí. El GUC se setea con
 * `set_config(..., true)` (equivalente transaccional de SET LOCAL) y el
 * tenantId viaja como parámetro bind — nunca interpolado en el SQL.
 */
export async function withTenantContext<T>(
  prisma: PrismaClient,
  tenantId: string,
  callback: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
    return callback(tx as TransactionClient);
  });
}
