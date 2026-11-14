/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  ConflictException,
  Injectable,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Logger as PinoLogger } from 'nestjs-pino';
import type Stripe from 'stripe';
import { extractClientContext, type ClientContext } from '../../auth/client-context';
import type { EmailLang } from '../../common/branded-email';
import { readRequestLocale } from '../../common/checkout-locale';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { PlatformCheckoutGate } from '../payouts/platform-checkout-gate';
import { SaleEmailsService } from '../sale-emails/sale-emails.service';
import {
  WITHDRAWAL_WAIVER_KIND,
  WITHDRAWAL_WAIVER_VERSION,
  renderWithdrawalWaiver,
  type PurchaseKind,
  type RenderedWaiver,
  type WithdrawalWaiverDto,
} from './withdrawal-waiver';

/**
 * Idioma guardado con la prueba (`WaiverLang`) → idioma del correo. Lo que no
 * sea un idioma con copy (una fila escrita a mano) sale en español, como antes.
 */
export function storedWaiverLang(stored: string | null | undefined): EmailLang {
  return stored === 'en' || stored === 'pt' ? stored : 'es';
}

/**
 * Prueba del consentimiento del comprador antes de pagar contenido digital
 * (renuncia al desistimiento, `withdrawal-waiver.ts`) y confirmación por
 * correo cuando Stripe confirma el pago.
 *
 * En TODOS los modos de cobro: con la plataforma (cobra el operador en nombre
 * del creador) y con las claves propias del aula. El texto no viaja a Stripe:
 * la sesión de pago es byte a byte la de siempre.
 */
@Injectable()
export class PurchaseConsentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    /** Solo con el modo plataforma: para apuntar el modo de cobro. */
    @Optional() private readonly payoutsGate?: PlatformCheckoutGate,
    /**
     * El recibo de la compra (con el texto aceptado, el acceso y los datos).
     * Sin él (pruebas que montan solo esto) se marca el pago y no sale correo.
     */
    @Optional() private readonly saleEmails?: SaleEmailsService,
  ) {}

  /** El texto de la casilla para esta aula, en el idioma del comprador. */
  async render(
    tenantId: string,
    purchaseKind: PurchaseKind,
    locale: string | null | undefined,
  ): Promise<RenderedWaiver> {
    const tenant = await runAsTenant(tenantId, () =>
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    );
    return renderWithdrawalWaiver({ purchaseKind, locale, sellerName: tenant?.name ?? '' });
  }

  /**
   * Comprueba que el comprador marcó la casilla con el texto vigente y guarda
   * la prueba ANTES de crear la sesión de pago. Sin casilla → 422; texto viejo
   * → 409. Devuelve el id para asociarle después la sesión.
   */
  async accept(args: {
    readonly req: FastifyRequest;
    readonly tenantId: string;
    readonly purchaseKind: PurchaseKind;
    readonly itemRef: string;
    readonly itemName?: string | null;
    readonly userId?: string | null;
    readonly buyerEmail?: string | null;
    readonly waiver: WithdrawalWaiverDto | undefined;
  }): Promise<string> {
    if (!args.waiver || args.waiver.accepted !== true) {
      throw new UnprocessableEntityException({
        message:
          'Para comprar tienes que marcar la casilla: pides acceso inmediato y aceptas que pierdes el derecho a desistir en 14 días.',
        code: 'CHECKOUT_WITHDRAWAL_WAIVER_REQUIRED',
      });
    }
    if (args.waiver.version !== WITHDRAWAL_WAIVER_VERSION) {
      throw new ConflictException({
        message: 'El texto de la casilla ha cambiado. Recarga la página y vuelve a marcarla.',
        code: 'CHECKOUT_WITHDRAWAL_WAIVER_OUTDATED',
      });
    }
    // El idioma en que la web enseñó el texto; si no lo dice, el de la cookie.
    const locale = args.waiver.locale ?? readRequestLocale(args.req.headers);
    const rendered = await this.render(args.tenantId, args.purchaseKind, locale);
    const client = extractClientContext(args.req);
    const platform = this.payoutsGate
      ? (await this.payoutsGate.publicCheckoutInfo(args.tenantId)).platform
      : false;
    const row = await runAsTenant(args.tenantId, () =>
      this.prisma.purchaseConsent.create({
        data: {
          tenantId: args.tenantId,
          kind: WITHDRAWAL_WAIVER_KIND,
          purchaseKind: args.purchaseKind,
          itemRef: args.itemRef,
          itemName: args.itemName?.slice(0, 300) ?? null,
          userId: args.userId ?? null,
          buyerEmail: args.buyerEmail?.trim().toLowerCase() || null,
          sellerName: rendered.sellerName,
          paymentMode: platform ? 'platform' : 'own',
          version: rendered.version,
          locale: rendered.locale,
          text: rendered.text,
          ip: client.ip ?? null,
          userAgent: client.userAgent?.slice(0, 500) ?? null,
          acceptedAt: new Date(),
        },
        select: { id: true },
      }),
    );
    return row.id;
  }

  /** Asocia la sesión de Stripe (y la orden) recién creada al consentimiento. */
  async attachSession(
    tenantId: string,
    consentId: string,
    session: { readonly sessionId: string; readonly orderId?: string | null },
  ): Promise<void> {
    await runAsTenant(tenantId, () =>
      this.prisma.purchaseConsent.updateMany({
        where: { id: consentId, tenantId, stripeCheckoutSessionId: null },
        data: {
          stripeCheckoutSessionId: session.sessionId,
          ...(session.orderId ? { orderId: session.orderId } : {}),
        },
      }),
    );
  }

  /**
   * ¿Va a salir el RECIBO de esta compra? (pago confirmado de una sesión con
   * su prueba de consentimiento todavía sin confirmar). Lo preguntan los
   * webhooks ANTES de repartir el evento: si sale el recibo, él lleva el
   * enlace para elegir contraseña y la bienvenida suelta no se manda (un solo
   * correo, no dos). Nunca lanza: en la duda, `false` y la bienvenida sale.
   */
  async receiptPending(tenantId: string, event: Stripe.Event): Promise<boolean> {
    try {
      if (!this.saleEmails) return false;
      const session = paidSession(event);
      if (!session?.id) return false;
      const found = await runAsTenant(tenantId, () =>
        this.prisma.purchaseConsent.findFirst({
          where: { tenantId, stripeCheckoutSessionId: session.id, paidAt: null },
          select: { id: true, buyerEmail: true },
        }),
      );
      return !!found && !!(session.customer_details?.email?.trim() || found.buyerEmail);
    } catch {
      return false;
    }
  }

  /**
   * Correos al comprador DESPUÉS de repartir un evento de Stripe: el recibo de
   * la compra y, en una suscripción, el de cada renovación o el aviso de cobro
   * fallido. Nunca lanza.
   */
  async afterStripeEvent(
    tenantId: string,
    event: Stripe.Event,
    ctx?: ClientContext,
  ): Promise<void> {
    await this.confirmCheckout(tenantId, event, ctx);
    await this.saleEmails?.onInvoiceEvent(tenantId, event);
  }

  /**
   * Webhook: Stripe confirmó el pago de una sesión (o el alta de una prueba
   * gratis). Marca el pago y manda UNA vez el RECIBO: los datos de la compra,
   * el acceso y el texto aceptado (la confirmación en soporte duradero que
   * exige el art. 98.7 TRLGDCU). Nunca lanza: un correo que no sale no deshace
   * la compra.
   */
  async confirmCheckout(tenantId: string, event: Stripe.Event, ctx?: ClientContext): Promise<void> {
    try {
      const session = paidSession(event);
      if (!session?.id) return;
      const email = session.customer_details?.email?.trim().toLowerCase() ?? null;
      const consent = await runAsTenant(tenantId, async () => {
        const found = await this.prisma.purchaseConsent.findFirst({
          where: { tenantId, stripeCheckoutSessionId: session.id },
        });
        if (!found || found.paidAt) return null;
        const { count } = await this.prisma.purchaseConsent.updateMany({
          where: { id: found.id, tenantId, paidAt: null },
          data: { paidAt: new Date(), ...(email ? { buyerEmail: email } : {}) },
        });
        return count === 1 ? { ...found, buyerEmail: email ?? found.buyerEmail } : null;
      });
      if (!consent?.buyerEmail || !this.saleEmails) return;
      const sent = await this.saleEmails.sendPurchaseReceipt(tenantId, {
        to: consent.buyerEmail,
        consent: { ...consent, locale: storedWaiverLang(consent.locale) },
        session,
        ...(ctx ? { ctx } : {}),
      });
      if (sent) {
        await runAsTenant(tenantId, () =>
          this.prisma.purchaseConsent.updateMany({
            where: { id: consent.id, tenantId },
            data: { confirmationSentAt: new Date() },
          }),
        );
      }
    } catch (err) {
      this.logger.warn(
        { tenantId, eventId: event.id, err: (err as Error).message },
        'purchase-consent: no se pudo confirmar la compra por correo',
      );
    }
  }
}

/** La sesión de un evento de pago CONFIRMADO (o de una prueba gratis), si lo es. */
function paidSession(event: Stripe.Event): Stripe.Checkout.Session | null {
  if (
    event.type !== 'checkout.session.completed' &&
    event.type !== 'checkout.session.async_payment_succeeded'
  ) {
    return null;
  }
  const session = event.data.object as Stripe.Checkout.Session;
  const paid =
    event.type === 'checkout.session.async_payment_succeeded' ||
    session.payment_status === 'paid' ||
    session.payment_status === 'no_payment_required';
  return paid ? session : null;
}
