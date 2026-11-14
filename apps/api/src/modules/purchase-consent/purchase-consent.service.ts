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
import { extractClientContext } from '../../auth/client-context';
import {
  PLAIN_EMAIL_INTL_LOCALE,
  renderBrandedEmail,
  resolveEmailBranding,
  textToHtmlParagraphs,
  type BrandingPrisma,
  type EmailLang,
} from '../../common/branded-email';
import { readRequestLocale } from '../../common/checkout-locale';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { PlatformCheckoutGate } from '../payouts/platform-checkout-gate';
import { PayoutsRuntime } from '../payouts/payouts-runtime.service';
import { SmtpAdapterService } from '../smtp-adapter.service';
import { TenantSmtpResolverService } from '../tenant-smtp-resolver.service';
import {
  WITHDRAWAL_WAIVER_KIND,
  WITHDRAWAL_WAIVER_VERSION,
  renderWithdrawalWaiver,
  type PurchaseKind,
  type RenderedWaiver,
  type WaiverLang,
  type WithdrawalWaiverDto,
} from './withdrawal-waiver';

/** Correo de confirmación de la compra con el texto aceptado. Puro. */
export function purchaseConfirmationTexts(input: {
  readonly lang: WaiverLang;
  readonly tenantName: string;
  readonly itemName: string | null;
  readonly purchaseKind: PurchaseKind;
  readonly trial: boolean;
  readonly acceptedAt: Date;
  readonly text: string;
  readonly version: string;
  /**
   * Nombre fiscal del vendedor, si añade algo al del aula (que ya va en el
   * texto aceptado): «Ana Pérez».
   */
  readonly sellerLegal?: string | null;
}): { subject: string; title: string; body: string } {
  const when = new Intl.DateTimeFormat(PLAIN_EMAIL_INTL_LOCALE[input.lang], {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Madrid',
    timeZoneName: 'short',
  }).format(input.acceptedAt);
  if (input.lang === 'pt') {
    const item = input.itemName ? `“${input.itemName}”` : 'sua compra';
    const lead = input.trial
      ? `Sua assinatura de ${item} em ${input.tenantName} começou.`
      : `Seu pagamento de ${item} em ${input.tenantName} está confirmado.`;
    return {
      subject: `Sua compra em ${input.tenantName} está confirmada`,
      title: 'Compra confirmada',
      body:
        `${lead}\n\n` +
        `Antes de pagar, em ${when}, você marcou esta caixa:\n\n“${input.text}”\n\n` +
        `Por isso você tem acesso desde já e não há prazo de 14 dias para desistir desta compra.\n\n` +
        (input.sellerLegal ? `Nome legal do vendedor: ${input.sellerLegal}. ` : '') +
        `Guarde este e-mail: ele é a confirmação da sua compra (versão do texto ${input.version}).`,
    };
  }
  if (input.lang === 'en') {
    const item = input.itemName ? `"${input.itemName}"` : 'your purchase';
    const lead = input.trial
      ? `Your subscription to ${item} at ${input.tenantName} has started.`
      : `Your payment for ${item} at ${input.tenantName} is confirmed.`;
    return {
      subject: `Your purchase at ${input.tenantName} is confirmed`,
      title: 'Purchase confirmed',
      body:
        `${lead}\n\n` +
        `Before paying, on ${when}, you ticked this box:\n\n“${input.text}”\n\n` +
        `That's why you have access right away and there is no 14-day period to withdraw from this purchase.\n\n` +
        (input.sellerLegal ? `Seller's legal name: ${input.sellerLegal}. ` : '') +
        `Keep this email: it is the confirmation of your purchase (text version ${input.version}).`,
    };
  }
  const item = input.itemName ? `«${input.itemName}»` : 'tu compra';
  const lead = input.trial
    ? `Tu suscripción a ${item} en ${input.tenantName} ha empezado.`
    : `Tu pago de ${item} en ${input.tenantName} está confirmado.`;
  return {
    subject: `Confirmación de tu compra en ${input.tenantName}`,
    title: 'Compra confirmada',
    body:
      `${lead}\n\n` +
      `Antes de pagar, el ${when}, marcaste esta casilla:\n\n«${input.text}»\n\n` +
      `Por eso tienes acceso desde ya y no hay plazo de 14 días para desistir de esta compra.\n\n` +
      (input.sellerLegal ? `Nombre fiscal del vendedor: ${input.sellerLegal}. ` : '') +
      `Guarda este correo: es la confirmación de tu compra (versión del texto ${input.version}).`,
  };
}

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
    private readonly tenantResolver: TenantResolverService,
    @Optional() private readonly smtpResolver?: TenantSmtpResolverService,
    @Optional() private readonly smtp?: SmtpAdapterService,
    /** Solo con el modo plataforma: para apuntar el modo de cobro. */
    @Optional() private readonly payoutsGate?: PlatformCheckoutGate,
    /** Solo con el modo plataforma: el nombre fiscal del creador (correo). */
    @Optional() private readonly payouts?: PayoutsRuntime,
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
   * Webhook: Stripe confirmó el pago de una sesión (o el alta de una prueba
   * gratis). Marca el pago y manda UNA vez la confirmación con el texto
   * aceptado. Nunca lanza: un correo que no sale no deshace la compra.
   */
  async confirmCheckout(tenantId: string, event: Stripe.Event): Promise<void> {
    try {
      if (
        event.type !== 'checkout.session.completed' &&
        event.type !== 'checkout.session.async_payment_succeeded'
      ) {
        return;
      }
      const session = event.data.object as Stripe.Checkout.Session;
      const paid =
        event.type === 'checkout.session.async_payment_succeeded' ||
        session.payment_status === 'paid' ||
        session.payment_status === 'no_payment_required';
      if (!paid || !session.id) return;
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
      if (!consent?.buyerEmail) return;
      const sent = await this.sendConfirmation(tenantId, {
        to: consent.buyerEmail,
        lang: storedWaiverLang(consent.locale),
        purchaseKind: consent.purchaseKind as PurchaseKind,
        itemName: consent.itemName,
        trial: session.payment_status === 'no_payment_required',
        acceptedAt: consent.acceptedAt,
        text: consent.text,
        version: consent.version,
        sellerName: consent.sellerName,
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

  private async sendConfirmation(
    tenantId: string,
    input: {
      to: string;
      lang: EmailLang;
      purchaseKind: PurchaseKind;
      itemName: string | null;
      trial: boolean;
      acceptedAt: Date;
      text: string;
      version: string;
      sellerName: string;
    },
  ): Promise<boolean> {
    if (!this.smtpResolver || !this.smtp) return false;
    const resolved = await this.smtpResolver.resolve(tenantId);
    if (!resolved) {
      this.logger.warn({ tenantId }, 'purchase-consent: sin SMTP — confirmación no enviada');
      return false;
    }
    const base = await this.tenantResolver.resolveTenantWebBaseUrlForBackground(tenantId);
    const branding = await resolveEmailBranding(
      this.prisma as unknown as BrandingPrisma,
      tenantId,
      base,
    );
    const legalName = await this.sellerLegalName(tenantId);
    const texts = purchaseConfirmationTexts({
      lang: input.lang,
      tenantName: branding.tenantName,
      itemName: input.itemName,
      purchaseKind: input.purchaseKind,
      trial: input.trial,
      acceptedAt: input.acceptedAt,
      text: input.text,
      version: input.version,
      sellerLegal:
        legalName && legalName.toLowerCase() !== input.sellerName.toLowerCase() ? legalName : null,
    });
    const { html, text } = renderBrandedEmail(branding, {
      lang: input.lang,
      title: texts.title,
      bodyHtml: textToHtmlParagraphs(texts.body),
      bodyText: texts.body,
    });
    const result = await this.smtp.send(
      resolved.config,
      { to: input.to, subject: texts.subject, text, html },
      branding.tenantName,
    );
    if (!result.ok) {
      this.logger.warn({ tenantId, error: result.error }, 'purchase-consent: el correo no salió');
    }
    return result.ok;
  }

  /** Nombre fiscal del creador (solo modo plataforma y si ya lo dio). */
  private async sellerLegalName(tenantId: string): Promise<string | null> {
    try {
      const profiles = this.payouts?.taxProfiles;
      if (!profiles) return null;
      const profile = await runAsTenant(tenantId, () => profiles.full(tenantId));
      return profile?.complete ? profile.legalName : null;
    } catch {
      return null;
    }
  }
}
