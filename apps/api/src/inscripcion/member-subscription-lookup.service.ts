import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import type { MemberSubscriptionMatch } from '@didacta/mod-payment-connections';
import { PrismaService } from '../prisma/prisma.service';
import { ModuleRegistryService } from '../modules/module-registry.service';

/**
 * Lookup automático de la suscripción de un miembro al registrarse.
 *
 * Cuando alguien se inscribe en `/inscripcion-miembros`, se lanza `kickoff` SIN
 * bloquear la respuesta al usuario: persiste una fila PENDING y, en segundo
 * plano (fire-and-forget), busca la suscripción del email en TODAS las cuentas
 * de pago conectadas (Stripe/PayPal/WooCommerce) vía mod.payment-connections, y
 * guarda el resultado. El admin lo ve al validar la solicitud.
 *
 * V1: fire-and-forget en proceso (no BullMQ). Si el proceso muere a mitad, la
 * fila queda PENDING y el admin puede re-lanzar (rerun). Endurecer con cola
 * persistente es un follow-up.
 */
@Injectable()
export class MemberSubscriptionLookupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ModuleRegistryService,
    private readonly logger: PinoLogger,
  ) {}

  /** Dispara el lookup en background (fire-and-forget). No esperar para responder al usuario. */
  async kickoff(tenantId: string, userId: string, email: string): Promise<void> {
    void this.runAndStore(tenantId, userId, email).catch(() => {});
  }

  /**
   * Hace el lookup completo (PENDING → busca en las cuentas conectadas → guarda
   * DONE/ERROR) y DEVUELVE los matches encontrados. Lo usa la inscripción para,
   * en background, buscar la suscripción y luego notificar al aprobador con ella.
   * Best-effort: nunca lanza (devuelve [] ante fallo).
   */
  async runAndStore(
    tenantId: string,
    userId: string,
    email: string,
  ): Promise<MemberSubscriptionMatch[]> {
    await this.prisma.memberSubscriptionLookup
      .upsert({
        where: { tenantId_userId: { tenantId, userId } },
        create: { tenantId, userId, email, status: 'PENDING', results: [], matchCount: 0 },
        update: { email, status: 'PENDING', error: null, completedAt: null },
      })
      .catch(() => {
        // Si no se pudo persistir el PENDING, seguimos igualmente con el lookup.
      });
    return this.run(tenantId, userId, email);
  }

  /** Devuelve el resultado del lookup de un usuario (o null si no se ha hecho). */
  async getForUser(tenantId: string, userId: string) {
    return this.prisma.memberSubscriptionLookup.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
    });
  }

  /** Re-lanza el lookup (p.ej. desde el panel admin si quedó PENDING/ERROR). */
  async rerun(tenantId: string, userId: string, email: string): Promise<void> {
    await this.kickoff(tenantId, userId, email);
  }

  private async run(
    tenantId: string,
    userId: string,
    email: string,
  ): Promise<MemberSubscriptionMatch[]> {
    try {
      const matches = await this.registry
        .getPaymentConnectionsService()
        .findUserSubscriptions(tenantId, email);
      await this.prisma.memberSubscriptionLookup
        .update({
          where: { tenantId_userId: { tenantId, userId } },
          data: {
            status: 'DONE',
            results: matches as never,
            matchCount: matches.length,
            error: null,
            completedAt: new Date(),
          },
        })
        .catch(() => {});
      return matches;
    } catch (err) {
      const message = ((err as Error).message ?? 'error').slice(0, 500);
      this.logger.warn({ err, tenantId, userId }, 'member-lookup: falló el lookup de suscripción');
      await this.prisma.memberSubscriptionLookup
        .update({
          where: { tenantId_userId: { tenantId, userId } },
          data: { status: 'ERROR', error: message, completedAt: new Date() },
        })
        .catch(() => {
          // La fila pudo no crearse; nada más que hacer.
        });
      return [];
    }
  }
}
