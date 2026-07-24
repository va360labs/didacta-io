/**
 * Wrapper sobre el SDK de Stripe específico para suscripciones recurrentes.
 *
 * Vive separado de mod.billing/stripe.client.ts (NO se importa cross-module
 * por contrato) para que cada módulo tenga su superficie aislada de Stripe.
 *
 * Cubre:
 *   - createSubscriptionCheckoutSession (mode='subscription' en Stripe).
 *   - retrievePrice + validar que es recurring.
 *   - cancelSubscription (al final del periodo o inmediato).
 *   - constructWebhookEvent (verifica firma HMAC).
 */

import type Stripe from 'stripe';
import {
  StripeApiError,
  StripeConfigMissingError,
  WebhookSignatureInvalidError,
} from './errors.js';

export interface SubscriptionsStripeAdapter {
  createCheckoutSession(
    params: CreateSubscriptionCheckoutParams,
  ): Promise<StripeSubscriptionCheckoutResult>;
  retrievePrice(priceId: string): Promise<StripePriceResult>;
  cancelSubscription(subscriptionId: string, atPeriodEnd: boolean): Promise<StripeSubscriptionView>;
  constructWebhookEvent(rawBody: string | Buffer, signatureHeader: string): Stripe.Event;
  /** Crea un Product de Stripe (membresía). Devuelve su id (prod_...). */
  createProduct(name: string, metadata: Record<string, string>): Promise<string>;
  /** Renombra un Product existente (al renombrar el plan en el admin). */
  updateProduct(productId: string, name: string): Promise<void>;
  /**
   * Termina el trial de una suscripción AHORA (`trial_end: 'now'`): Stripe
   * factura y cobra el primer periodo inmediatamente. Devuelve la vista
   * resultante + si la invoice generada quedó realmente PAGADA — el status
   * 'active' por sí solo NO es evidencia de cobro (Stripe puede devolver
   * active con la invoice aún en curso).
   */
  endTrialNow(subscriptionId: string): Promise<EndTrialNowResult>;
  /**
   * Crea un Price recurring para un product. `intervalMonths` 1|3|12 se mapea
   * a interval month/year + interval_count. Los prices de Stripe son
   * inmutables: para cambiar el importe se crea uno nuevo.
   */
  createRecurringPrice(params: CreateRecurringPriceParams): Promise<string>;
}

export interface CreateRecurringPriceParams {
  productId: string;
  amountCents: number;
  currency: string;
  intervalMonths: number;
  /** Etiqueta interna del price (nombre del plan). Solo visible en el dashboard. */
  nickname?: string;
  metadata: Record<string, string>;
}

export interface CreateSubscriptionCheckoutParams {
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  /** Días de prueba gratis (subscription_data.trial_period_days). 0/undefined = sin trial. */
  trialDays?: number;
  /** Permite introducir códigos promocionales de Stripe en el checkout. */
  allowPromotionCodes?: boolean;
  /** client_reference_id de la session (id local si existe). */
  clientReferenceId?: string;
  metadata: Record<string, string>;
}

export interface StripeSubscriptionCheckoutResult {
  id: string;
  url: string;
}

export interface StripePriceResult {
  id: string;
  productId: string;
  unitAmount: number;
  currency: string;
  active: boolean;
  /** 'month' | 'year' | otro. Si null, NO es recurring → el service rechaza. */
  recurringInterval: string | null;
}

export interface StripeSubscriptionView {
  id: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: number | null;
  canceledAt: number | null;
}

/** Resultado de endTrialNow: vista de la sub + evidencia de cobro real. */
export interface EndTrialNowResult extends StripeSubscriptionView {
  /** true solo si la latest_invoice quedó en status 'paid' (0 € por cupón cuenta). */
  latestInvoicePaid: boolean;
}

/**
 * Implementación real basada en el SDK oficial de Stripe.
 *
 * Construir solo si hay STRIPE_SECRET_KEY. En tests pasamos un adapter mockeado.
 */
export class SubscriptionsStripeSdkAdapter implements SubscriptionsStripeAdapter {
  private readonly client: Stripe;

  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string,
    StripeCtor: new (key: string, opts?: Stripe.StripeConfig) => Stripe,
  ) {
    if (!secretKey) throw new StripeConfigMissingError('secretKey');
    if (!webhookSecret) throw new StripeConfigMissingError('webhookSecret');
    this.client = new StripeCtor(secretKey, {
      apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion,
      timeout: 10_000,
      maxNetworkRetries: 1,
    });
  }

  async createCheckoutSession(
    p: CreateSubscriptionCheckoutParams,
  ): Promise<StripeSubscriptionCheckoutResult> {
    try {
      const trialDays = p.trialDays && p.trialDays > 0 ? p.trialDays : undefined;
      const session = await this.client.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{ price: p.priceId, quantity: 1 }],
        success_url: p.successUrl,
        cancel_url: p.cancelUrl,
        customer_email: p.customerEmail,
        client_reference_id: p.clientReferenceId ?? p.metadata['subscriptionLocalId'],
        ...(p.allowPromotionCodes ? { allow_promotion_codes: true } : {}),
        metadata: { ...p.metadata },
        subscription_data: {
          metadata: { ...p.metadata },
          ...(trialDays ? { trial_period_days: trialDays } : {}),
        },
      });
      if (!session.url) {
        throw new StripeApiError('Stripe devolvió session sin URL hosted');
      }
      return { id: session.id, url: session.url };
    } catch (err) {
      if (err instanceof StripeApiError) throw err;
      throw new StripeApiError((err as Error).message);
    }
  }

  async createProduct(name: string, metadata: Record<string, string>): Promise<string> {
    try {
      const product = await this.client.products.create({ name, metadata });
      return product.id;
    } catch (err) {
      throw new StripeApiError((err as Error).message);
    }
  }

  async updateProduct(productId: string, name: string): Promise<void> {
    try {
      await this.client.products.update(productId, { name });
    } catch (err) {
      throw new StripeApiError((err as Error).message);
    }
  }

  async endTrialNow(subscriptionId: string): Promise<EndTrialNowResult> {
    try {
      const sub = await this.client.subscriptions.update(subscriptionId, {
        trial_end: 'now',
        expand: ['latest_invoice'],
      });
      const invoice =
        sub.latest_invoice && typeof sub.latest_invoice !== 'string' ? sub.latest_invoice : null;
      return {
        id: sub.id,
        status: sub.status,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        currentPeriodEnd: sub.current_period_end ?? null,
        canceledAt: sub.canceled_at ?? null,
        latestInvoicePaid: invoice?.status === 'paid',
      };
    } catch (err) {
      throw new StripeApiError((err as Error).message);
    }
  }

  async createRecurringPrice(p: CreateRecurringPriceParams): Promise<string> {
    try {
      // Stripe no tiene interval 'quarter': trimestral = month × 3. Anual usa
      // year × 1 (más legible en el dashboard que month × 12).
      const interval = p.intervalMonths === 12 ? 'year' : 'month';
      const intervalCount = p.intervalMonths === 12 ? 1 : p.intervalMonths;
      const price = await this.client.prices.create({
        product: p.productId,
        unit_amount: p.amountCents,
        currency: p.currency,
        recurring: { interval, interval_count: intervalCount },
        ...(p.nickname ? { nickname: p.nickname } : {}),
        metadata: p.metadata,
      });
      return price.id;
    } catch (err) {
      throw new StripeApiError((err as Error).message);
    }
  }

  async retrievePrice(priceId: string): Promise<StripePriceResult> {
    try {
      const price = await this.client.prices.retrieve(priceId);
      const product = typeof price.product === 'string' ? price.product : price.product.id;
      return {
        id: price.id,
        productId: product,
        unitAmount: price.unit_amount ?? 0,
        currency: price.currency,
        active: price.active,
        recurringInterval: price.recurring?.interval ?? null,
      };
    } catch (err) {
      throw new StripeApiError((err as Error).message);
    }
  }

  async cancelSubscription(
    subscriptionId: string,
    atPeriodEnd: boolean,
  ): Promise<StripeSubscriptionView> {
    try {
      const sub = atPeriodEnd
        ? await this.client.subscriptions.update(subscriptionId, {
            cancel_at_period_end: true,
          })
        : await this.client.subscriptions.cancel(subscriptionId);
      return {
        id: sub.id,
        status: sub.status,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        currentPeriodEnd: sub.current_period_end ?? null,
        canceledAt: sub.canceled_at ?? null,
      };
    } catch (err) {
      throw new StripeApiError((err as Error).message);
    }
  }

  constructWebhookEvent(rawBody: string | Buffer, signatureHeader: string): Stripe.Event {
    try {
      return this.client.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);
    } catch (err) {
      throw new WebhookSignatureInvalidError((err as Error).message);
    }
  }
}
