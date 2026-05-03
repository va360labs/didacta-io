import { Injectable } from '@nestjs/common';
import type { Prisma } from '@didacta/database';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from './tenant-context.service';

/**
 * Cliente transaccional de la request actual, con tenant seteado.
 * Omite métodos de conexión/transacción para evitar escapes del contexto.
 */
type TenantTx = Omit<
  PrismaService,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Servicio que combina Prisma + TenantContext para ejecutar queries
 * con Row-Level Security (RLS) aplicada automáticamente.
 *
 * Uso típico en un service:
 * ```ts
 * async list() {
 *   return this.tenantPrisma.withTenant(async (tx) => {
 *     return tx.course.findMany(); // RLS filtra automáticamente por tenant
 *   });
 * }
 * ```
 *
 * El `SET LOCAL app.current_tenant_id` se ejecuta al inicio de la transacción,
 * garantizando que todas las queries dentro del callback respeten RLS.
 *
 * @see packages/database/prisma/rls.sql — políticas RLS
 * @see DISC-003 — historia de implementación
 */
@Injectable()
export class TenantPrismaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Ejecuta el callback dentro de una transacción con RLS aplicada.
   *
   * @throws Error si se llama fuera de un request con tenant (ej: cron job sin contexto)
   */
  async withTenant<T>(callback: (tx: TenantTx) => Promise<T>): Promise<T> {
    const ctx = this.tenantContext.require();
    return this.withTenantId(ctx.tenantId, callback);
  }

  /**
   * Variante que acepta tenantId explícito. Útil para workers/jobs
   * que conocen el tenant pero no pasan por el middleware HTTP.
   */
  async withTenantId<T>(tenantId: string, callback: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // SET LOCAL solo aplica a esta transacción
      await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
      return callback(tx as TenantTx);
    });
  }

  /**
   * Acceso directo al PrismaService para queries que NO necesitan RLS
   * (ej: tablas globales como `installed_module`, `tenant`).
   *
   * CUIDADO: usar solo para tablas sin `tenant_id`. Para tablas multi-tenant,
   * usar `withTenant()` siempre.
   */
  get global(): PrismaService {
    return this.prisma;
  }
}
