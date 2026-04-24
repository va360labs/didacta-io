import type { PrismaClient } from '@prisma/client';

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
  callback: (
    tx: Omit<
      PrismaClient,
      '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
    >,
  ) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    return callback(tx);
  });
}
