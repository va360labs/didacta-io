import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import type { MemberSubscriptionLookupResult } from '@didacta/mod-payment-connections';
import { PrismaService } from '../prisma/prisma.service';
import { ModuleRegistryService } from '../modules/module-registry.service';

/**
 * Lookup automático de la suscripción de un miembro al registrarse.
 *
 * Cuando alguien se inscribe en `/inscripcion-miembros`, se lanza el lookup SIN
 * bloquear la respuesta al usuario: persiste una fila PENDING y, en segundo
 * plano (fire-and-forget), busca la suscripción del email en TODAS las cuentas
 * de pago conectadas (Stripe/PayPal/WooCommerce) vía mod.payment-connections,
 * guarda el resultado y lo incluye en el email de validación al aprobador.
 *
 * V1: fire-and-forget en proceso (no BullMQ). Si el proceso muere a mitad, la
 * fila queda PENDING. `getForUser`/`rerun` existen para un panel admin (listar
 * PENDING/ERROR + re-lanzar) que AÚN NO está cableado a ningún endpoint —
 * endurecer con cola persistente + superficie admin es un follow-up. Hoy el
 * único canal que ve el aprobador es el email de validación.
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
   * DONE/ERROR) y DEVUELVE los matches + los fallos por proveedor. Lo usa la
   * inscripción para, en background, buscar la suscripción y luego notificar al
   * aprobador con ella. Best-effort: nunca lanza (devuelve resultado vacío ante fallo).
   */
  async runAndStore(
    tenantId: string,
    userId: string,
    email: string,
  ): Promise<MemberSubscriptionLookupResult> {
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

  /** Re-lanza el lookup. Pensado para un futuro panel admin (PENDING/ERROR); sin endpoint aún. */
  async rerun(tenantId: string, userId: string, email: string): Promise<void> {
    await this.kickoff(tenantId, userId, email);
  }

  private async run(
    tenantId: string,
    userId: string,
    email: string,
  ): Promise<MemberSubscriptionLookupResult> {
    try {
      const { matches, failures } = await this.registry
        .getPaymentConnectionsService()
        .findUserSubscriptions(tenantId, email);
      // Si alguna conexión VERIFIED falló y NO encontramos nada, el lookup no es
      // concluyente → ERROR (para no afirmar "sin suscripción" sin base). Si hubo
      // matches, es DONE aunque alguna cuenta fallara (resultado parcial pero útil).
      const partialError = failures.length
        ? `No se pudo consultar ${failures.length} cuenta(s): ${failures
            .map((f) => f.connectionName)
            .join(', ')}`.slice(0, 500)
        : null;
      const status = failures.length && matches.length === 0 ? 'ERROR' : 'DONE';
      // upsert (no update): persiste el resultado aunque el PENDING inicial fallara.
      await this.prisma.memberSubscriptionLookup
        .upsert({
          where: { tenantId_userId: { tenantId, userId } },
          create: {
            tenantId,
            userId,
            email,
            status,
            results: matches as never,
            matchCount: matches.length,
            error: partialError,
            completedAt: new Date(),
          },
          update: {
            status,
            results: matches as never,
            matchCount: matches.length,
            error: partialError,
            completedAt: new Date(),
          },
        })
        .catch(() => {});
      return { matches, failures };
    } catch (err) {
      const message = ((err as Error).message ?? 'error').slice(0, 500);
      this.logger.warn({ err, tenantId, userId }, 'member-lookup: falló el lookup de suscripción');
      // upsert (no update): garantiza una fila ERROR aunque el PENDING no se creara.
      await this.prisma.memberSubscriptionLookup
        .upsert({
          where: { tenantId_userId: { tenantId, userId } },
          create: {
            tenantId,
            userId,
            email,
            status: 'ERROR',
            results: [],
            matchCount: 0,
            error: message,
            completedAt: new Date(),
          },
          update: { status: 'ERROR', error: message, completedAt: new Date() },
        })
        .catch(() => {
          // Nada más que hacer si ni el upsert terminal funciona.
        });
      // Fallo total (p.ej. el módulo no está inicializado): lo señalamos como un
      // fallo genérico para que el email NO afirme "sin suscripción".
      return { matches: [], failures: [{ provider: '*', connectionName: 'todas', message }] };
    }
  }
}
