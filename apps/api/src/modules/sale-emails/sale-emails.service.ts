/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Optional } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import type Stripe from 'stripe';
import type { ClientContext } from '../../auth/client-context';
import { PasswordResetService, accessLink } from '../../auth/password-reset.service';
import {
  academyLocale,
  academyTimeZone,
  type AcademyDefaultsPrisma,
} from '../../common/academy-defaults';
import {
  resolveEmailBranding,
  type BrandingPrisma,
  type EmailBranding,
  type EmailLang,
} from '../../common/branded-email';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import {
  fetchEmailOverride,
  toHubTemplateLang,
  type TemplateOverridePrisma,
} from '../notifications/email-template-catalog';
import { PayoutsRuntime } from '../payouts/payouts-runtime.service';
import {
  WITHDRAWAL_WAIVER_VERSION,
  renderWithdrawalWaiver,
} from '../purchase-consent/withdrawal-waiver';
import { PrismaTenantConfigService } from '../prisma-tenant-config.service';
import { SmtpAdapterService } from '../smtp-adapter.service';
import { withStripeTestApi } from '../stripe-test-api';
import { TenantSmtpResolverService, type ResolvedSmtp } from '../tenant-smtp-resolver.service';
import { TenantStripeResolverService } from '../tenant-stripe-resolver.service';
import {
  buildPaymentFailedEmail,
  buildPurchaseReceiptEmail,
  buildRefundEmail,
  buildRenewalReceiptEmail,
  orderReference,
  paymentMethodFromCharge,
  type AccessView,
  type PaymentMethodView,
  type ProductKind,
  type ProductView,
  type RenderedEmail,
  type SaleTemplateOverride,
  type SellerView,
} from './sale-email-render';
import {
  SALE_EMAIL_DEFAULTS,
  SALE_EMAIL_KEYS,
  SALE_EMAIL_STORAGE_LOCALE,
  SALE_EMAIL_TEMPLATE_VARIABLES,
  SALE_EMAIL_TOKENS,
  sanitizeBody,
  sanitizeSubject,
  type SaleEmailKey,
} from './sale-email-templates';

/** El comprador puede abrir el recibo días después de pagar: 7 días, como la bienvenida. */
const SET_PASSWORD_TTL_MINUTES = 7 * 24 * 60;

/** Ajuste del aula con el enlace a su política de devoluciones. */
export const SALE_EMAIL_SETTINGS = { moduleName: 'notifications', key: 'sale_emails' } as const;

export interface SaleEmailSettings {
  readonly refundPolicyUrl: string | null;
}

/** Lo que el recibo necesita de la prueba del consentimiento (`purchase_consent`). */
export interface ReceiptConsent {
  readonly purchaseKind: string;
  readonly itemRef: string;
  readonly itemName: string | null;
  readonly orderId: string | null;
  readonly sellerName: string;
  readonly paymentMode: string;
  readonly version: string;
  readonly locale: string;
  readonly text: string;
  readonly acceptedAt: Date;
}

const NO_CLIENT: ClientContext = { ip: null, userAgent: 'stripe-webhook' };

/** Comprador de ejemplo de la vista previa (lo dice la pantalla: «datos de ejemplo»). */
const SAMPLE_BUYER: Readonly<Record<EmailLang, { name: string; email: string }>> = {
  es: { name: 'Ana García', email: 'ana@example.com' },
  en: { name: 'Emma Johnson', email: 'emma@example.com' },
  pt: { name: 'Beatriz Souza', email: 'beatriz@example.com' },
};

/** Lo que el panel ve de cada correo editable. */
export interface SaleEmailAdminEntry {
  readonly key: SaleEmailKey;
  readonly variables: readonly string[];
  readonly defaults: Record<EmailLang, { subject: string; body: string }>;
  readonly overrides: Partial<
    Record<EmailLang, { subject: string | null; body: string; updatedAt: string }>
  >;
}

/** `sub_…` de una factura, en la forma vieja o la nueva de Stripe. */
function subscriptionIdOf(invoice: unknown): string | null {
  const inv = invoice as {
    subscription?: unknown;
    parent?: { subscription_details?: { subscription?: unknown } };
  };
  const idOf = (v: unknown) =>
    typeof v === 'string'
      ? v
      : v && typeof v === 'object'
        ? ((v as { id?: string }).id ?? null)
        : null;
  return idOf(inv?.subscription) ?? idOf(inv?.parent?.subscription_details?.subscription);
}

function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return null;
}

/** La dirección de un remitente «Nombre <correo>» o un correo suelto. */
function addressOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const angle = /<([^>]+)>/.exec(raw);
  const value = (angle ? angle[1]! : raw).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

function absoluteUrl(url: string | null | undefined, base: string): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  const root = (process.env['PUBLIC_API_URL']?.trim() || base).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(root)) return null;
  return `${root}${url.startsWith('/') ? url : `/${url}`}`;
}

/**
 * Correos de VENTA y ACCESO al comprador, con aspecto de recibo y la marca del
 * aula: el de cada compra (y prueba gratis), el de cada renovación cobrada, el
 * aviso de cobro fallido y la vista previa / prueba / plantillas del panel.
 *
 * Reúne los datos reales —la prueba del consentimiento, la sesión de Stripe,
 * el curso o el plan, la cuenta del comprador, el medio de pago, los datos del
 * vendedor— y deja el HTML a los composers puros de `sale-email-render.ts`.
 *
 * Nunca lanza hacia el webhook: un correo que no sale no deshace la compra.
 * Cada dato que falta (Stripe no contesta, no hay portada…) se omite del
 * recibo; lo que nunca falta es el importe, el pedido y quién vende.
 */
@Injectable()
export class SaleEmailsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    private readonly tenantResolver: TenantResolverService,
    @Optional() private readonly smtpResolver?: TenantSmtpResolverService,
    @Optional() private readonly smtp?: SmtpAdapterService,
    @Optional() private readonly passwordReset?: PasswordResetService,
    @Optional() private readonly stripeResolver?: TenantStripeResolverService,
    @Optional() private readonly tenantConfig?: PrismaTenantConfigService,
    /** Solo con cobros de plataforma: nombre fiscal y cargos de Stripe. */
    @Optional() private readonly payouts?: PayoutsRuntime,
  ) {}

  // ── Recibo de una compra ────────────────────────────────────────────────

  /**
   * Recibo al comprador al confirmar Stripe el pago (o el alta de una prueba
   * gratis). Lleva el acceso: si la cuenta no ha entrado nunca, el enlace para
   * elegir contraseña (sustituye a la bienvenida); si ya entró, el botón al
   * curso. Devuelve si salió.
   */
  async sendPurchaseReceipt(
    tenantId: string,
    input: {
      readonly to: string;
      readonly consent: ReceiptConsent;
      readonly session: Stripe.Checkout.Session;
      readonly ctx?: ClientContext;
    },
  ): Promise<boolean> {
    try {
      const resolved = await this.resolveSmtp(tenantId, 'purchase.receipt');
      if (!resolved || !this.smtp) return false;
      const { consent, session } = input;
      const lang: EmailLang =
        consent.locale === 'en' || consent.locale === 'pt' ? consent.locale : 'es';
      const base = await this.webBase(tenantId);
      const branding = await this.branding(tenantId, base);
      const timeZone = await this.timeZone(tenantId);
      const buyer = await this.findUser(tenantId, input.to);
      const product = await this.product(tenantId, consent, base);
      const subscription = await this.localSubscription(tenantId, idOf(session.subscription));
      const trial =
        session.payment_status === 'no_payment_required' && session.mode === 'subscription';
      const total = session.amount_total ?? 0;
      const access = await this.access(tenantId, base, buyer, input.to, product.path, input.ctx);
      const override = await this.override(tenantId, 'purchase.receipt', lang);
      const email = buildPurchaseReceiptEmail(
        branding,
        {
          lang,
          timeZone,
          academy: branding.tenantName,
          buyerName: session.customer_details?.name ?? buyer?.name ?? null,
          buyerEmail: input.to,
          product: { ...product.view, ...(subscription ? this.intervalOf(subscription) : {}) },
          orderRef: orderReference(consent.orderId ?? idOf(session.invoice) ?? session.id),
          paidAt: session.created ? new Date(session.created * 1000) : new Date(),
          currency: session.currency ?? subscription?.currency ?? 'eur',
          subtotal: session.amount_subtotal ?? null,
          discount: session.total_details?.amount_discount ?? 0,
          tax: session.total_details?.amount_tax ?? 0,
          total,
          paymentMethod: trial
            ? null
            : await this.paymentMethod(tenantId, {
                paymentIntentId: idOf(session.payment_intent),
                invoiceId: idOf(session.invoice),
                platform: consent.paymentMode === 'platform',
              }),
          trial: trial
            ? {
                endsAt: subscription?.trialEndsAt ?? null,
                amount: subscription?.unitAmount ?? null,
              }
            : null,
          nextRenewal:
            !trial && subscription?.currentPeriodEnd
              ? { at: subscription.currentPeriodEnd, amount: subscription.unitAmount }
              : null,
          seller: await this.seller(tenantId, branding, resolved),
          withdrawal: {
            acceptedAt: consent.acceptedAt,
            text: consent.text,
            version: consent.version,
          },
          refundPolicyUrl: (await this.settings(tenantId)).refundPolicyUrl,
          access,
        },
        override,
      );
      return await this.deliver(
        tenantId,
        resolved,
        input.to,
        email,
        branding.tenantName,
        'purchase.receipt',
      );
    } catch (err) {
      this.logger.warn(
        { tenantId, err: (err as Error).message },
        'sale-emails: el recibo de la compra no salió',
      );
      return false;
    }
  }

  // ── Renovación cobrada y cobro fallido ──────────────────────────────────

  /**
   * `invoice.paid` de una renovación → recibo; `invoice.payment_failed` de una
   * renovación → aviso para actualizar el medio de pago. El alta (la primera
   * factura) ya tiene su recibo de compra. Una vez por factura (y por intento
   * en el fallo): lo sella `sale_email_sent`.
   */
  async onInvoiceEvent(tenantId: string, event: Stripe.Event): Promise<void> {
    try {
      if (event.type !== 'invoice.paid' && event.type !== 'invoice.payment_failed') return;
      const invoice = event.data.object as Stripe.Invoice & {
        billing_reason?: string | null;
        attempt_count?: number;
        next_payment_attempt?: number | null;
        hosted_invoice_url?: string | null;
      };
      const reason = invoice.billing_reason ?? '';
      const renewal = reason === 'subscription_cycle' || reason === 'subscription_update';
      if (!renewal || !invoice.id) return;
      const sub = await this.localSubscription(tenantId, subscriptionIdOf(invoice));
      if (!sub) return;
      const user = await runAsTenant(tenantId, () =>
        this.prisma.user.findFirst({
          where: { id: sub.userId, tenantId, deletedAt: null },
          select: {
            id: true,
            email: true,
            name: true,
            locale: true,
            status: true,
            lastLoginAt: true,
          },
        }),
      );
      if (!user || user.status === 'SUSPENDED' || user.status === 'DEACTIVATED') return;

      const failed = event.type === 'invoice.payment_failed';
      const kind = failed ? 'payment_failed' : 'renewal_receipt';
      const ref = failed ? `${invoice.id}:${invoice.attempt_count ?? 1}` : invoice.id;
      if (!(await this.claim(tenantId, kind, ref))) return;

      const key: SaleEmailKey = failed ? 'purchase.payment_failed' : 'purchase.renewal_receipt';
      const resolved = await this.resolveSmtp(tenantId, key);
      if (!resolved || !this.smtp) return;
      const lang: EmailLang = toHubTemplateLang(user.locale);
      const base = await this.webBase(tenantId);
      const branding = await this.branding(tenantId, base);
      const timeZone = await this.timeZone(tenantId);
      const product = await this.productOfSubscription(tenantId, sub, base);
      const platform =
        !!this.payouts &&
        (await this.isPlatformInvoice(tenantId, invoice.id, subscriptionIdOf(invoice)));
      const method = await this.paymentMethod(tenantId, {
        paymentIntentId: idOf((invoice as { payment_intent?: unknown }).payment_intent),
        invoiceId: invoice.id,
        platform,
      });
      const seller = await this.seller(tenantId, branding, resolved);
      const override = await this.override(tenantId, key, lang);
      const manageUrl = `${base.replace(/\/+$/, '')}/account?tab=subscription`;
      const currency = invoice.currency ?? sub.currency ?? 'eur';
      let email: RenderedEmail;
      if (failed) {
        email = buildPaymentFailedEmail(
          branding,
          {
            lang,
            timeZone,
            academy: branding.tenantName,
            buyerName: user.name,
            buyerEmail: user.email,
            product,
            failedAt: new Date((event.created ?? Date.now() / 1000) * 1000),
            currency,
            amountDue: invoice.amount_due ?? sub.unitAmount,
            paymentMethod: method,
            deadline: sub.gracePeriodEndsAt,
            nextAttempt: invoice.next_payment_attempt
              ? new Date(invoice.next_payment_attempt * 1000)
              : null,
            seller,
            // Con cobros de plataforma, el portal (con el nombre del aula) está
            // en la cuenta del alumno; con claves propias, la página de pago de
            // la factura en Stripe, que es de la cuenta del propio creador.
            updateUrl: platform ? manageUrl : (invoice.hosted_invoice_url ?? manageUrl),
          },
          override,
        );
      } else {
        const discount = (invoice.total_discount_amounts ?? []).reduce(
          (sum, d) => sum + (d.amount ?? 0),
          0,
        );
        const tax = (invoice as { tax?: number | null }).tax ?? 0;
        const periodEnd = invoice.lines?.data?.[0]?.period?.end;
        email = buildRenewalReceiptEmail(
          branding,
          {
            lang,
            timeZone,
            academy: branding.tenantName,
            buyerName: user.name,
            buyerEmail: user.email,
            product,
            orderRef: orderReference(invoice.id),
            paidAt: invoice.status_transitions?.paid_at
              ? new Date(invoice.status_transitions.paid_at * 1000)
              : new Date((event.created ?? Date.now() / 1000) * 1000),
            currency,
            subtotal: invoice.subtotal ?? null,
            discount,
            tax,
            total: invoice.amount_paid ?? invoice.total ?? 0,
            paymentMethod: method,
            nextRenewal: periodEnd ? new Date(periodEnd * 1000) : (sub.currentPeriodEnd ?? null),
            seller,
            refundPolicyUrl: (await this.settings(tenantId)).refundPolicyUrl,
            manageUrl,
            academyUrl: base || null,
          },
          override,
        );
      }
      await this.deliver(tenantId, resolved, user.email, email, branding.tenantName, key);
    } catch (err) {
      this.logger.warn(
        { tenantId, eventId: event.id, err: (err as Error).message },
        'sale-emails: el correo de la factura no salió',
      );
    }
  }

  // ── Panel: plantillas, vista previa y prueba ────────────────────────────

  /** Los correos editables con su texto original por idioma y lo que el aula cambió. */
  async adminList(tenantId: string): Promise<{
    templates: SaleEmailAdminEntry[];
    tokens: typeof SALE_EMAIL_TOKENS;
    settings: SaleEmailSettings;
    academyLocale: EmailLang;
  }> {
    const rows = await runAsTenant(tenantId, () =>
      this.prisma.notificationTemplate.findMany({
        where: { tenantId, channel: 'EMAIL', key: { in: [...SALE_EMAIL_KEYS] } },
        select: { key: true, locale: true, subject: true, body: true, updatedAt: true },
      }),
    );
    const templates = SALE_EMAIL_KEYS.map((key): SaleEmailAdminEntry => {
      const overrides: SaleEmailAdminEntry['overrides'] = {};
      for (const lang of ['es', 'en', 'pt'] as const) {
        const row = rows.find((r) => r.key === key && r.locale === SALE_EMAIL_STORAGE_LOCALE[lang]);
        if (row) {
          overrides[lang] = {
            subject: row.subject,
            body: row.body,
            updatedAt: row.updatedAt.toISOString(),
          };
        }
      }
      return {
        key,
        variables: SALE_EMAIL_TEMPLATE_VARIABLES[key],
        defaults: {
          es: { ...SALE_EMAIL_DEFAULTS[key].es },
          en: { ...SALE_EMAIL_DEFAULTS[key].en },
          pt: { ...SALE_EMAIL_DEFAULTS[key].pt },
        },
        overrides,
      };
    });
    let locale: EmailLang = 'es';
    try {
      locale = await runAsTenant(tenantId, () =>
        academyLocale(this.prisma as unknown as AcademyDefaultsPrisma, tenantId),
      );
    } catch {
      // Sin poder leerlo, español.
    }
    return {
      templates,
      tokens: SALE_EMAIL_TOKENS,
      settings: await this.settings(tenantId),
      academyLocale: locale,
    };
  }

  /** Guarda el asunto y el mensaje de un correo en un idioma (saneados). */
  async saveTemplate(
    tenantId: string,
    key: SaleEmailKey,
    lang: EmailLang,
    draft: { subject: string; body: string },
  ): Promise<{ subject: string; body: string }> {
    const subject = sanitizeSubject(draft.subject);
    const body = sanitizeBody(draft.body);
    const locale = SALE_EMAIL_STORAGE_LOCALE[lang];
    await runAsTenant(tenantId, () =>
      this.prisma.notificationTemplate.upsert({
        where: { tenantId_key_channel_locale: { tenantId, key, channel: 'EMAIL', locale } },
        create: { tenantId, key, channel: 'EMAIL', locale, subject, body },
        update: { subject, body },
      }),
    );
    return { subject, body };
  }

  /** «Volver al original»: borra lo que el aula escribió para ese idioma. */
  async resetTemplate(tenantId: string, key: SaleEmailKey, lang: EmailLang): Promise<void> {
    const locale = SALE_EMAIL_STORAGE_LOCALE[lang];
    await runAsTenant(tenantId, () =>
      this.prisma.notificationTemplate.deleteMany({
        where: { tenantId, key, channel: 'EMAIL', locale },
      }),
    );
  }

  /**
   * El correo tal como saldría, con el borrador del editor (o lo guardado) y
   * DATOS DE EJEMPLO: el comprador es de ejemplo; el aula, su marca, su
   * vendedor, su curso y su política de devoluciones son los de verdad.
   */
  async preview(
    tenantId: string,
    key: SaleEmailKey,
    lang: EmailLang,
    draft: { subject?: string | null; body?: string | null } | null,
    /**
     * Dominio desde el que se mira la vista previa (el de la petición del
     * panel). Sin él, el del aula, como un envío de verdad.
     */
    viewBase?: string | null,
  ): Promise<RenderedEmail> {
    const base = viewBase?.trim() || (await this.webBase(tenantId));
    const branding = await this.branding(tenantId, base);
    const timeZone = await this.timeZone(tenantId);
    const resolved = this.smtpResolver
      ? await this.smtpResolver.resolve(tenantId).catch(() => null)
      : null;
    const seller = await this.seller(tenantId, branding, resolved);
    const override: SaleTemplateOverride | null =
      draft && (draft.subject?.trim() || draft.body?.trim())
        ? { subject: draft.subject ?? null, body: draft.body ?? '' }
        : await this.override(tenantId, key, lang);
    const sample = await this.sampleProduct(tenantId, base, key);
    const buyer = SAMPLE_BUYER[lang];
    const now = new Date();
    const inAMonth = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const card: PaymentMethodView = { type: 'card', brand: 'visa', last4: '4242' };
    const refundPolicyUrl = (await this.settings(tenantId)).refundPolicyUrl;
    const root = base.replace(/\/+$/, '');
    switch (key) {
      case 'purchase.receipt':
        return buildPurchaseReceiptEmail(
          branding,
          {
            lang,
            timeZone,
            academy: branding.tenantName,
            buyerName: buyer.name,
            buyerEmail: buyer.email,
            product: sample.view,
            orderRef: 'A1B2C3D4',
            paidAt: now,
            currency: sample.currency,
            subtotal: sample.amount,
            discount: 0,
            tax: 0,
            total: sample.amount,
            paymentMethod: card,
            trial: null,
            nextRenewal:
              sample.view.kind === 'course' ? null : { at: inAMonth, amount: sample.amount },
            seller,
            withdrawal: {
              acceptedAt: now,
              text: renderWithdrawalWaiver({
                purchaseKind: sample.view.kind,
                locale: lang,
                sellerName: branding.tenantName,
              }).text,
              version: WITHDRAWAL_WAIVER_VERSION,
            },
            refundPolicyUrl,
            access: root ? { kind: 'set_password', url: `${root}/signin` } : null,
          },
          override,
        );
      case 'purchase.renewal_receipt':
        return buildRenewalReceiptEmail(
          branding,
          {
            lang,
            timeZone,
            academy: branding.tenantName,
            buyerName: buyer.name,
            buyerEmail: buyer.email,
            product: sample.view,
            orderRef: 'A1B2C3D4',
            paidAt: now,
            currency: sample.currency,
            subtotal: sample.amount,
            discount: 0,
            tax: 0,
            total: sample.amount,
            paymentMethod: card,
            nextRenewal: inAMonth,
            seller,
            refundPolicyUrl,
            manageUrl: root ? `${root}/account?tab=subscription` : null,
            academyUrl: root || null,
          },
          override,
        );
      case 'purchase.payment_failed':
        return buildPaymentFailedEmail(
          branding,
          {
            lang,
            timeZone,
            academy: branding.tenantName,
            buyerName: buyer.name,
            buyerEmail: buyer.email,
            product: sample.view,
            failedAt: now,
            currency: sample.currency,
            amountDue: sample.amount,
            paymentMethod: card,
            deadline: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000),
            nextAttempt: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000),
            seller,
            updateUrl: root ? `${root}/account?tab=subscription` : null,
          },
          override,
        );
      case 'purchase.refund':
        return buildRefundEmail(
          branding,
          {
            lang,
            timeZone,
            academy: branding.tenantName,
            buyerName: buyer.name,
            buyerEmail: buyer.email,
            product: sample.view,
            orderRef: 'A1B2C3D4',
            refundedAt: now,
            currency: sample.currency,
            refunded: sample.amount,
            originallyPaid: sample.amount,
            full: true,
            paymentMethod: card,
            seller,
          },
          override,
        );
    }
  }

  /** Manda la vista previa (borrador incluido) a quien la pide. */
  async sendTest(
    tenantId: string,
    key: SaleEmailKey,
    lang: EmailLang,
    draft: { subject?: string | null; body?: string | null } | null,
    to: string,
  ): Promise<
    { ok: true; sentTo: string } | { ok: false; reason: 'no_smtp' | 'send_failed'; detail?: string }
  > {
    const resolved = this.smtpResolver ? await this.smtpResolver.resolve(tenantId) : null;
    if (!resolved || !this.smtp) return { ok: false, reason: 'no_smtp' };
    const email = await this.preview(tenantId, key, lang, draft);
    const branding = await this.branding(tenantId, await this.webBase(tenantId));
    const result = await this.smtp.send(
      resolved.config,
      { to, subject: email.subject, text: email.text, html: email.html },
      branding.tenantName,
    );
    if (!result.ok) return { ok: false, reason: 'send_failed', detail: result.error };
    return { ok: true, sentTo: to };
  }

  async settings(tenantId: string): Promise<SaleEmailSettings> {
    try {
      const raw = (await this.tenantConfig?.get<Partial<SaleEmailSettings>>(
        tenantId,
        SALE_EMAIL_SETTINGS.moduleName,
        SALE_EMAIL_SETTINGS.key,
      )) as Partial<SaleEmailSettings> | undefined;
      const url = typeof raw?.refundPolicyUrl === 'string' ? raw.refundPolicyUrl.trim() : '';
      return { refundPolicyUrl: /^https?:\/\//i.test(url) ? url : null };
    } catch {
      return { refundPolicyUrl: null };
    }
  }

  async saveSettings(
    tenantId: string,
    value: SaleEmailSettings,
    actorId: string | null,
  ): Promise<SaleEmailSettings> {
    if (!this.tenantConfig) return { refundPolicyUrl: null };
    const url = value.refundPolicyUrl?.trim() || null;
    await this.tenantConfig.set(
      tenantId,
      SALE_EMAIL_SETTINGS.moduleName,
      SALE_EMAIL_SETTINGS.key,
      { refundPolicyUrl: url },
      { actorId },
    );
    return this.settings(tenantId);
  }

  // ── Reembolso (lo usa el notificador de cobros de plataforma) ───────────

  /** Composición del aviso de reembolso con los datos del aula (pura salvo lecturas). */
  async renderRefund(
    tenantId: string,
    input: {
      readonly lang: EmailLang;
      readonly to: string;
      readonly buyerName: string | null;
      readonly product: ProductView;
      readonly orderRef: string | null;
      readonly refundedAt: Date;
      readonly currency: string;
      readonly refunded: number;
      readonly originallyPaid: number | null;
      readonly full: boolean;
      readonly chargeId: string | null;
    },
    resolved: ResolvedSmtp,
  ): Promise<{ email: RenderedEmail; branding: EmailBranding }> {
    const base = await this.webBase(tenantId);
    const branding = await this.branding(tenantId, base);
    const email = buildRefundEmail(
      branding,
      {
        lang: input.lang,
        timeZone: await this.timeZone(tenantId),
        academy: branding.tenantName,
        buyerName: input.buyerName,
        buyerEmail: input.to,
        product: input.product,
        orderRef: input.orderRef,
        refundedAt: input.refundedAt,
        currency: input.currency,
        refunded: input.refunded,
        originallyPaid: input.originallyPaid,
        full: input.full,
        paymentMethod: input.chargeId ? await this.platformChargeMethod(input.chargeId) : null,
        seller: await this.seller(tenantId, branding, resolved),
      },
      await this.override(tenantId, 'purchase.refund', input.lang),
    );
    return { email, branding };
  }

  // ── Datos ───────────────────────────────────────────────────────────────

  private async resolveSmtp(tenantId: string, key: string): Promise<ResolvedSmtp | null> {
    if (!this.smtpResolver || !this.smtp) return null;
    const resolved = await this.smtpResolver.resolve(tenantId);
    if (!resolved) {
      this.logger.warn({ tenantId, key }, 'sale-emails: sin SMTP — el correo no se envió');
    }
    return resolved;
  }

  private async deliver(
    tenantId: string,
    resolved: ResolvedSmtp,
    to: string,
    email: RenderedEmail,
    fromName: string,
    key: string,
  ): Promise<boolean> {
    const result = await this.smtp!.send(
      resolved.config,
      { to, subject: email.subject, text: email.text, html: email.html },
      fromName,
    );
    if (!result.ok) {
      this.logger.warn({ tenantId, key, error: result.error }, 'sale-emails: el correo no salió');
    }
    return result.ok;
  }

  private async webBase(tenantId: string): Promise<string> {
    try {
      return await this.tenantResolver.resolveTenantWebBaseUrlForBackground(tenantId);
    } catch {
      return process.env['WEB_BASE_URL'] ?? '';
    }
  }

  private async branding(tenantId: string, base: string): Promise<EmailBranding> {
    return runAsTenant(tenantId, () =>
      resolveEmailBranding(this.prisma as unknown as BrandingPrisma, tenantId, base),
    );
  }

  private async timeZone(tenantId: string): Promise<string> {
    try {
      return (
        (await runAsTenant(tenantId, () =>
          academyTimeZone(this.prisma as unknown as AcademyDefaultsPrisma, tenantId),
        )) ?? 'Europe/Madrid'
      );
    } catch {
      return 'Europe/Madrid';
    }
  }

  private async override(
    tenantId: string,
    key: SaleEmailKey,
    lang: EmailLang,
  ): Promise<SaleTemplateOverride | null> {
    return runAsTenant(tenantId, () =>
      fetchEmailOverride(
        this.prisma as unknown as TemplateOverridePrisma,
        tenantId,
        key,
        SALE_EMAIL_STORAGE_LOCALE[lang],
      ),
    );
  }

  private async findUser(tenantId: string, email: string) {
    try {
      return await runAsTenant(tenantId, () =>
        this.prisma.user.findFirst({
          where: { tenantId, email: { equals: email, mode: 'insensitive' }, deletedAt: null },
          select: { id: true, email: true, name: true, lastLoginAt: true, status: true },
        }),
      );
    } catch {
      return null;
    }
  }

  /** Quién vende: el aula, su nombre fiscal (si lo dio) y a dónde escribir. */
  private async seller(
    tenantId: string,
    branding: EmailBranding,
    resolved: ResolvedSmtp | null,
  ): Promise<SellerView> {
    let legalName: string | null = null;
    try {
      const profiles = this.payouts?.taxProfiles;
      if (profiles) {
        const profile = await runAsTenant(tenantId, () => profiles.full(tenantId));
        legalName = profile?.complete ? profile.legalName : null;
      }
    } catch {
      legalName = null;
    }
    const contactEmail =
      addressOf(resolved?.config.sender?.replyTo) ??
      (resolved?.source === 'tenant' || resolved?.source === 'tenant_unverified'
        ? addressOf(resolved.config.from)
        : null);
    return { name: branding.tenantName, legalName, contactEmail };
  }

  /** El curso o el plan comprado: título, tipo, portada y ruta en el aula. */
  private async product(
    tenantId: string,
    consent: ReceiptConsent,
    base: string,
  ): Promise<{ view: ProductView; path: string | null }> {
    const kind: ProductKind =
      consent.purchaseKind === 'membership'
        ? 'membership'
        : consent.purchaseKind === 'course_subscription'
          ? 'course_subscription'
          : 'course';
    try {
      if (kind === 'membership') {
        const plan = await runAsTenant(tenantId, () =>
          this.prisma.modSubscriptionsPlan.findFirst({
            where: { id: consent.itemRef, tenantId },
            select: { name: true, intervalMonths: true },
          }),
        );
        return {
          view: {
            title: consent.itemName ?? plan?.name ?? null,
            kind,
            intervalMonths: plan?.intervalMonths ?? null,
            imageUrl: await this.academyCover(tenantId, base),
          },
          path: null,
        };
      }
      const course = await runAsTenant(tenantId, () =>
        this.prisma.modCoursesCourse.findFirst({
          where: { id: consent.itemRef, tenantId },
          select: { title: true, slug: true, thumbnailUrl: true },
        }),
      );
      return {
        view: {
          title: consent.itemName ?? course?.title ?? null,
          kind,
          imageUrl: absoluteUrl(course?.thumbnailUrl, base),
        },
        path: course ? `/courses/${encodeURIComponent(course.slug)}` : null,
      };
    } catch {
      return { view: { title: consent.itemName, kind }, path: null };
    }
  }

  private async productOfSubscription(
    tenantId: string,
    sub: NonNullable<Awaited<ReturnType<SaleEmailsService['localSubscription']>>>,
    base: string,
  ): Promise<ProductView> {
    try {
      if (sub.planId) {
        const plan = await runAsTenant(tenantId, () =>
          this.prisma.modSubscriptionsPlan.findFirst({
            where: { id: sub.planId!, tenantId },
            select: { name: true, intervalMonths: true },
          }),
        );
        return {
          title: plan?.name ?? null,
          kind: 'membership',
          intervalMonths: plan?.intervalMonths ?? null,
          ...this.intervalOf(sub),
          imageUrl: await this.academyCover(tenantId, base),
        };
      }
      const course = sub.courseId
        ? await runAsTenant(tenantId, () =>
            this.prisma.modCoursesCourse.findFirst({
              where: { id: sub.courseId!, tenantId },
              select: { title: true, thumbnailUrl: true },
            }),
          )
        : null;
      return {
        title: course?.title ?? null,
        kind: 'course_subscription',
        ...this.intervalOf(sub),
        imageUrl: absoluteUrl(course?.thumbnailUrl, base),
      };
    } catch {
      return { title: null, kind: sub.planId ? 'membership' : 'course_subscription' };
    }
  }

  /** Periodicidad de una suscripción local (`month` / `year` de Stripe). */
  private intervalOf(sub: {
    interval: string;
  }): Pick<ProductView, 'intervalUnit' | 'intervalMonths'> {
    if (sub.interval === 'year') return { intervalUnit: 'year', intervalMonths: 1 };
    if (sub.interval === 'week') return { intervalUnit: 'week', intervalMonths: null };
    if (sub.interval === 'month') return { intervalUnit: 'month' };
    return {};
  }

  /** Portada de la academia (la de la comunidad), para una membresía sin imagen propia. */
  private async academyCover(tenantId: string, base: string): Promise<string | null> {
    try {
      const theme = await runAsTenant(tenantId, () =>
        this.prisma.modThemingTenantTheme.findUnique({
          where: { tenantId },
          select: { coverUrl: true },
        }),
      );
      return absoluteUrl(theme?.coverUrl ?? null, base);
    } catch {
      return null;
    }
  }

  private async localSubscription(tenantId: string, stripeSubscriptionId: string | null) {
    if (!stripeSubscriptionId) return null;
    try {
      return await runAsTenant(tenantId, () =>
        this.prisma.modSubscriptionsSubscription.findFirst({
          where: { tenantId, stripeSubscriptionId },
          select: {
            userId: true,
            planId: true,
            courseId: true,
            unitAmount: true,
            currency: true,
            interval: true,
            currentPeriodEnd: true,
            trialEndsAt: true,
            gracePeriodEndsAt: true,
          },
        }),
      );
    } catch {
      return null;
    }
  }

  /**
   * El botón del recibo: elegir contraseña si la cuenta nunca ha entrado (el
   * enlace hace de bienvenida, 7 días); si ya entró, ir al curso o al aula.
   */
  private async access(
    tenantId: string,
    base: string,
    user: { lastLoginAt: Date | null; status: string } | null,
    email: string,
    coursePath: string | null,
    ctx: ClientContext | undefined,
  ): Promise<AccessView | null> {
    const root = base.replace(/\/+$/, '');
    if (!root) return null;
    if (user && !user.lastLoginAt && this.passwordReset) {
      try {
        const issued = await this.passwordReset.request(
          { email, resolvedTenantId: tenantId },
          ctx ?? NO_CLIENT,
          { ttlMinutes: SET_PASSWORD_TTL_MINUTES },
        );
        if (issued)
          return { kind: 'set_password', url: accessLink(root, issued.rawToken, coursePath) };
      } catch (err) {
        this.logger.warn(
          { tenantId, err: (err as Error).message },
          'sale-emails: no se pudo emitir el enlace de contraseña del recibo',
        );
      }
    }
    if (coursePath) return { kind: 'course', url: `${root}${coursePath}` };
    return { kind: 'academy', url: `${root}/signin` };
  }

  /**
   * ¿La factura es de una suscripción cobrada por la plataforma? Por el
   * registro de objetos (la suscripción o la factura) y, si no, por la venta
   * anotada. Un cobro FALLIDO no deja venta: sin el registro se tomaría por
   * claves propias y el botón llevaría a la página de pago de la plataforma.
   */
  private async isPlatformInvoice(
    tenantId: string,
    invoiceId: string,
    subscriptionId: string | null,
  ): Promise<boolean> {
    try {
      const refs = this.payouts?.platformRefs();
      for (const id of [subscriptionId, invoiceId]) {
        if (id && refs && (await refs.isPlatformObject(id))) return true;
      }
    } catch {
      // Sin registro legible, se mira la venta.
    }
    try {
      const sale = await runAsTenant(tenantId, () =>
        this.prisma.modPayoutsSale.findFirst({
          where: { tenantId, stripeInvoiceId: invoiceId },
          select: { id: true },
        }),
      );
      return !!sale;
    } catch {
      return false;
    }
  }

  /**
   * Medio de pago (marca y 4 últimas cifras), sin bloquear: con cobros de
   * plataforma, por el cargo anotado en la venta; con claves propias, por el
   * PaymentIntent en la cuenta del aula. Si Stripe no contesta, el recibo sale
   * sin esa línea.
   */
  private async paymentMethod(
    tenantId: string,
    refs: { paymentIntentId: string | null; invoiceId: string | null; platform: boolean },
  ): Promise<PaymentMethodView | null> {
    try {
      if (refs.platform && this.payouts) {
        const sale = await runAsTenant(tenantId, () =>
          this.prisma.modPayoutsSale.findFirst({
            where: {
              tenantId,
              OR: [
                ...(refs.paymentIntentId ? [{ stripePaymentIntentId: refs.paymentIntentId }] : []),
                ...(refs.invoiceId ? [{ stripeInvoiceId: refs.invoiceId }] : []),
              ],
            },
            select: { stripeChargeId: true },
          }),
        );
        if (sale?.stripeChargeId) return await this.platformChargeMethod(sale.stripeChargeId);
        if (refs.paymentIntentId) {
          const pi = await this.payouts.stripe.v1<{ latest_charge?: unknown }>(
            'GET',
            `/v1/payment_intents/${encodeURIComponent(refs.paymentIntentId)}`,
            { expand: ['latest_charge'] },
          );
          return paymentMethodFromCharge(pi.latest_charge);
        }
        return null;
      }
      const client = await this.ownStripe(tenantId);
      if (!client) return null;
      let paymentIntentId = refs.paymentIntentId;
      if (!paymentIntentId && refs.invoiceId) {
        const invoice = (await client.invoices.retrieve(refs.invoiceId)) as {
          payment_intent?: unknown;
        };
        paymentIntentId = idOf(invoice.payment_intent);
      }
      if (!paymentIntentId) return null;
      const pi = (await client.paymentIntents.retrieve(paymentIntentId, {
        expand: ['latest_charge'],
      })) as { latest_charge?: unknown };
      return paymentMethodFromCharge(pi.latest_charge);
    } catch (err) {
      this.logger.warn(
        { tenantId, err: (err as Error).message },
        'sale-emails: sin medio de pago para el recibo (Stripe no contestó)',
      );
      return null;
    }
  }

  private async platformChargeMethod(chargeId: string): Promise<PaymentMethodView | null> {
    if (!this.payouts) return null;
    try {
      const charge = await this.payouts.stripe.v1(
        'GET',
        `/v1/charges/${encodeURIComponent(chargeId)}`,
      );
      return paymentMethodFromCharge(charge);
    } catch {
      return null;
    }
  }

  /** Cliente de Stripe con las claves del aula (o las de la instancia, si se heredan). */
  private async ownStripe(tenantId: string): Promise<{
    invoices: { retrieve(id: string): Promise<unknown> };
    paymentIntents: { retrieve(id: string, opts: { expand: string[] }): Promise<unknown> };
  } | null> {
    if (!this.stripeResolver) return null;
    const resolved = await this.stripeResolver.resolve(tenantId);
    if (!resolved) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('stripe');
    const StripeCtor = withStripeTestApi(mod.default ?? mod);
    return new StripeCtor(resolved.credentials.secretKey, {
      apiVersion: '2024-12-18.acacia',
      timeout: 6_000,
      maxNetworkRetries: 0,
    });
  }

  /** Sello de un correo repetible: `false` si ya se envió (o se está enviando). */
  private async claim(tenantId: string, kind: string, ref: string): Promise<boolean> {
    try {
      await runAsTenant(tenantId, () =>
        this.prisma.saleEmailSent.create({ data: { tenantId, kind, ref: ref.slice(0, 200) } }),
      );
      return true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'P2002') {
        this.logger.warn(
          { tenantId, kind, err: (err as Error).message },
          'sale-emails: no se pudo sellar el correo (no se envía para no duplicarlo)',
        );
      }
      return false;
    }
  }

  /** Para la vista previa: un curso de verdad del aula (o el plan), con su precio. */
  private async sampleProduct(
    tenantId: string,
    base: string,
    key: SaleEmailKey,
  ): Promise<{ view: ProductView; amount: number; currency: string }> {
    const wantsSubscription =
      key === 'purchase.renewal_receipt' || key === 'purchase.payment_failed';
    try {
      if (wantsSubscription) {
        const plan = await runAsTenant(tenantId, () =>
          this.prisma.modSubscriptionsPlan.findFirst({
            where: { tenantId, active: true },
            orderBy: [{ isFeatured: 'desc' }, { sortOrder: 'asc' }],
            select: { name: true, intervalMonths: true, amountCents: true, currency: true },
          }),
        );
        if (plan) {
          return {
            view: {
              title: plan.name,
              kind: 'membership',
              intervalMonths: plan.intervalMonths,
              imageUrl: await this.academyCover(tenantId, base),
            },
            amount: plan.amountCents ?? 4900,
            currency: plan.currency || 'eur',
          };
        }
      }
      const product = await runAsTenant(tenantId, () =>
        this.prisma.modBillingProduct.findFirst({
          where: { tenantId },
          orderBy: { createdAt: 'desc' },
          select: { courseId: true, unitAmount: true, currency: true },
        }),
      );
      const course = await runAsTenant(tenantId, () =>
        this.prisma.modCoursesCourse.findFirst({
          where: {
            tenantId,
            deletedAt: null,
            ...(product ? { id: product.courseId } : { status: 'PUBLISHED' }),
          },
          orderBy: { createdAt: 'desc' },
          select: { title: true, thumbnailUrl: true },
        }),
      );
      return {
        view: {
          title: course?.title ?? null,
          // Sin plan de membresía, la suscripción de ejemplo es la del curso.
          kind: wantsSubscription ? 'course_subscription' : 'course',
          intervalMonths: wantsSubscription ? 1 : null,
          imageUrl: absoluteUrl(course?.thumbnailUrl, base),
        },
        amount: product?.unitAmount ?? 4900,
        currency: product?.currency ?? 'eur',
      };
    } catch {
      return {
        view: { title: null, kind: wantsSubscription ? 'membership' : 'course' },
        amount: 4900,
        currency: 'eur',
      };
    }
  }
}
