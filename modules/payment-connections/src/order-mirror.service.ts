import type { PrismaClient } from '@didacta/database';
import {
  classifyPurchase,
  expires,
  strongestKind,
  timedExpiryFrom,
  type EntitlementKind,
  type EntitlementRuleset,
} from './entitlement-rules.js';
import type {
  ExternalOrderRecord,
  WooCommerceReadSdkAdapter,
} from './woocommerce-reader.client.js';

/**
 * Espejo del histórico de pedidos de una tienda externa.
 *
 * Fase A del plan: **solo lee y muestra**. No toca el acceso de nadie, no crea
 * usuarios y no asigna grupos. Eso llega en fases posteriores, y a propósito:
 * un espejo que además reparte accesos es imposible de revisar antes de
 * ejecutarlo.
 *
 * Idempotente por diseño: la clave natural es (tenant, provider, externalId) y
 * todo se escribe con upsert. Reimportar la tienda entera dos veces deja el
 * mismo resultado.
 */

/** Estados de WooCommerce que representan dinero efectivamente cobrado. */
const PAID_STATUSES = new Set(['completed', 'processing']);

export interface MirrorResult {
  /** Pedidos leídos de la tienda. */
  leidos: number;
  creados: number;
  actualizados: number;
  /** Pedidos cuyo email no corresponde a ninguna cuenta de Didacta. */
  sinCuenta: number;
  /** Pedidos con dinero cobrado y no devuelto. */
  pagados: number;
  /** Suma de lo cobrado, en céntimos. */
  totalCobrado: number;
  porTipo: Record<EntitlementKind, number>;
  /** Pedidos que la tienda devolvió sin email; no se pueden atribuir a nadie. */
  descartadosSinEmail: number;
  duracionMs: number;
}

export interface MirrorOptions {
  /** Solo pedidos modificados después de esta fecha (sync incremental). */
  modifiedAfter?: Date;
  /** Reglas de clasificación del tenant. */
  ruleset?: EntitlementRuleset;
  /** Progreso, para el log de una corrida larga. */
  onProgress?: (leidos: number) => void;
}

export class OrderMirrorService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Trae el histórico de la tienda y lo refleja en Didacta.
   *
   * El cruce con las cuentas es por email normalizado. Cuando no hay match, el
   * pedido se guarda igual con `userId: null` — no es un error: el email de
   * facturación puede ser el de la pasarela de pago. Guardarlo permite
   * reclamarlo cuando esa persona se dé de alta, en vez de perderlo.
   */
  async mirrorWooCommerce(
    tenantId: string,
    connectionId: string,
    adapter: WooCommerceReadSdkAdapter,
    options: MirrorOptions = {},
  ): Promise<MirrorResult> {
    const inicio = Date.now();

    const [orders, productTypes] = await Promise.all([
      adapter.listAllOrders({
        ...(options.modifiedAfter ? { modifiedAfter: options.modifiedAfter } : {}),
        ...(options.onProgress ? { onPage: options.onProgress } : {}),
      }),
      // El tipo de producto es la señal más fiable para detectar un recurrente,
      // y se pide una sola vez para todo el barrido.
      adapter.productTypesById().catch(() => new Map<string, string>()),
    ]);

    const emails = [...new Set(orders.map((o) => o.customerEmail).filter(Boolean))];
    const userIdByEmail = await this.resolveUsers(tenantId, emails);

    const result: MirrorResult = {
      leidos: orders.length,
      creados: 0,
      actualizados: 0,
      sinCuenta: 0,
      pagados: 0,
      totalCobrado: 0,
      porTipo: { LIFETIME: 0, SUBSCRIPTION: 0, TIMED: 0, ONE_OFF: 0, INFRA: 0 },
      descartadosSinEmail: 0,
      duracionMs: 0,
    };

    for (const order of orders) {
      if (!order.customerEmail) {
        result.descartadosSinEmail += 1;
        continue;
      }

      const clasificado = this.classify(order, productTypes, options.ruleset);
      const userId = userIdByEmail.get(order.customerEmail) ?? null;
      if (!userId) result.sinCuenta += 1;

      const pagado = PAID_STATUSES.has(order.status) && order.status !== 'refunded';
      if (pagado) {
        result.pagados += 1;
        result.totalCobrado += order.total ?? 0;
      }
      result.porTipo[clasificado.kind] += 1;

      const data = {
        connectionId,
        userId,
        customerEmail: order.customerEmail,
        customerName: order.customerName,
        status: order.status,
        paid: pagado,
        totalAmount: order.total ?? 0,
        currency: order.currency,
        placedAt: parseDate(order.placedAt) ?? new Date(),
        paidAt: parseDate(order.paidAt),
        refundedAt: parseDate(order.refundedAt),
        entitlementKind: clasificado.kind,
        accessEndsAt: clasificado.accessEndsAt,
        items: clasificado.items as unknown as object,
        syncedAt: new Date(),
      };

      const existente = await this.prisma.modPaymentConnectionsOrder.findFirst({
        where: { tenantId, provider: 'woocommerce', externalId: order.externalId },
        select: { id: true },
      });

      if (existente) {
        await this.prisma.modPaymentConnectionsOrder.update({
          where: { id: existente.id },
          data,
        });
        result.actualizados += 1;
      } else {
        await this.prisma.modPaymentConnectionsOrder.create({
          data: { ...data, tenantId, provider: 'woocommerce', externalId: order.externalId },
        });
        result.creados += 1;
      }
    }

    result.duracionMs = Date.now() - inicio;
    return result;
  }

  /**
   * Clasifica el pedido y calcula, si procede, cuándo caduca el acceso.
   *
   * El vencimiento solo se calcula para `TIMED` (pago único con vigencia): es
   * el único caso del que la tienda no avisará nunca, porque para ella el
   * pedido está cerrado. Las suscripciones de verdad las mantiene al día la
   * pasarela y viven en `ModPaymentConnectionsSubscriber`.
   */
  private classify(
    order: ExternalOrderRecord,
    productTypes: Map<string, string>,
    ruleset?: EntitlementRuleset,
  ): { kind: EntitlementKind; accessEndsAt: Date | null; items: unknown[] } {
    const items = order.items.map((li) => {
      const c = classifyPurchase(
        {
          productName: li.name,
          productType: li.productId ? (productTypes.get(li.productId) ?? null) : null,
        },
        ruleset,
      );
      return {
        name: li.name,
        productId: li.productId,
        total: li.total,
        quantity: li.quantity,
        kind: c.kind,
        reason: c.reason,
        ...(c.durationMonths ? { durationMonths: c.durationMonths } : {}),
      };
    });

    const kind = strongestKind(items.map((i) => i.kind));

    let accessEndsAt: Date | null = null;
    if (kind === 'TIMED') {
      const meses = items.find((i) => i.kind === 'TIMED')?.durationMonths;
      const desde = parseDate(order.paidAt) ?? parseDate(order.placedAt);
      if (meses && desde) accessEndsAt = timedExpiryFrom(desde, meses);
    }

    return { kind, accessEndsAt, items };
  }

  /**
   * Cruza emails con las cuentas del tenant.
   *
   * Va por lotes porque un `IN` con 625 literales es una query enorme; 200 es
   * un tamaño cómodo para Postgres.
   */
  private async resolveUsers(tenantId: string, emails: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const LOTE = 200;
    for (let i = 0; i < emails.length; i += LOTE) {
      const trozo = emails.slice(i, i + LOTE);
      const rows = await this.prisma.user.findMany({
        where: { tenantId, deletedAt: null, email: { in: trozo, mode: 'insensitive' } },
        select: { id: true, email: true },
      });
      for (const r of rows) out.set(r.email.toLowerCase(), r.id);
    }
    return out;
  }

  /**
   * Refleja UN pedido que llega por webhook.
   *
   * Mismo camino que el barrido, para que una compra nueva y una reimportación
   * dejen exactamente la misma fila: si el webhook escribiera distinto,
   * tendríamos dos verdades para el mismo pedido.
   *
   * Idempotente: WooCommerce reintenta los webhooks fallidos, y `order.updated`
   * llega varias veces por el mismo pedido (al pagarse, al completarse…).
   */
  async mirrorSingleOrder(
    tenantId: string,
    connectionId: string | null,
    order: ExternalOrderRecord,
    options: { ruleset?: EntitlementRuleset; productTypes?: Map<string, string> } = {},
  ): Promise<{ orderId: string; kind: EntitlementKind; userId: string | null; creado: boolean }> {
    if (!order.customerEmail) {
      throw new Error('El pedido llega sin email de facturación: no se puede atribuir.');
    }

    const clasificado = this.classify(order, options.productTypes ?? new Map(), options.ruleset);
    const userIdByEmail = await this.resolveUsers(tenantId, [order.customerEmail]);
    const userId = userIdByEmail.get(order.customerEmail) ?? null;
    const pagado = PAID_STATUSES.has(order.status) && order.status !== 'refunded';

    const data = {
      connectionId,
      userId,
      customerEmail: order.customerEmail,
      customerName: order.customerName,
      status: order.status,
      paid: pagado,
      totalAmount: order.total ?? 0,
      currency: order.currency,
      placedAt: parseDate(order.placedAt) ?? new Date(),
      paidAt: parseDate(order.paidAt),
      refundedAt: parseDate(order.refundedAt),
      entitlementKind: clasificado.kind,
      accessEndsAt: clasificado.accessEndsAt,
      items: clasificado.items as unknown as object,
      syncedAt: new Date(),
    };

    const existente = await this.prisma.modPaymentConnectionsOrder.findFirst({
      where: { tenantId, provider: 'woocommerce', externalId: order.externalId },
      select: { id: true },
    });

    if (existente) {
      await this.prisma.modPaymentConnectionsOrder.update({ where: { id: existente.id }, data });
      return { orderId: existente.id, kind: clasificado.kind, userId, creado: false };
    }

    const fila = await this.prisma.modPaymentConnectionsOrder.create({
      data: { ...data, tenantId, provider: 'woocommerce', externalId: order.externalId },
    });
    return { orderId: fila.id, kind: clasificado.kind, userId, creado: true };
  }

  /**
   * Reclama los pedidos huérfanos de un email cuando esa persona se da de alta.
   *
   * Sin esto, quien compró antes de tener cuenta se quedaría con el histórico
   * colgando para siempre.
   */
  async claimOrphanOrders(tenantId: string, userId: string, email: string): Promise<number> {
    const res = await this.prisma.modPaymentConnectionsOrder.updateMany({
      where: { tenantId, userId: null, customerEmail: email.trim().toLowerCase() },
      data: { userId },
    });
    return res.count;
  }

  /** Pedidos de un usuario, más reciente primero. Lo consume el expediente. */
  async listForUser(tenantId: string, userId: string) {
    return this.prisma.modPaymentConnectionsOrder.findMany({
      where: { tenantId, userId },
      orderBy: { placedAt: 'desc' },
    });
  }

  /**
   * Accesos con vigencia que caducan en los próximos `dias`.
   *
   * La fase B (avisos) se apoya en esto. Se deja escrito ya porque es la razón
   * de ser de `accessEndsAt`: sin este método, la columna sería decorativa.
   */
  async listExpiringSoon(tenantId: string, dias: number) {
    const limite = new Date(Date.now() + dias * 86_400_000);
    return this.prisma.modPaymentConnectionsOrder.findMany({
      where: {
        tenantId,
        paid: true,
        entitlementKind: 'TIMED',
        accessEndsAt: { not: null, lte: limite, gte: new Date() },
      },
      orderBy: { accessEndsAt: 'asc' },
    });
  }
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Reexportado por comodidad de quien consume el módulo. */
export { expires };
