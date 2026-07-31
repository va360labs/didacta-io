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
 * Todo request path debe usar este wrapper (lo integra el middleware del API).
 */
export async function withTenantContext<T>(
  prisma: PrismaClient,
  tenantId: string,
  callback: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    return callback(tx as TransactionClient);
  });
}
