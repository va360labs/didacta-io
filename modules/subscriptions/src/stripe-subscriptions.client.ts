/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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
 *   - createPortalSession (portal de cliente: tarjeta, facturas y baja).
 *   - constructWebhookEvent (verifica firma HMAC).
 */

import type Stripe from 'stripe';
import {
  StripeApiError,
  StripeConfigMissingError,
  WebhookSignatureInvalidError,
} from './errors.js';
import { currentPeriodEndFromSubscription } from './stripe-shape.js';

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
   * Crea un Price recurring para un product. `intervalMonths` (1..12) se mapea
   * a interval month/year + interval_count. Los prices de Stripe son
   * inmutables: para cambiar el importe se crea uno nuevo.
   */
  createRecurringPrice(params: CreateRecurringPriceParams): Promise<string>;
  /**
   * Sesión del portal de cliente de Stripe: el alumno cambia su tarjeta, ve sus
   * facturas y se da de baja. Devuelve la URL a la que redirigir.
   */
  createPortalSession(params: CreatePortalSessionParams): Promise<StripePortalSessionResult>;
  /**
   * Saldo del cliente (`customer.balance`): negativo = a su favor, se gasta en
   * sus próximas facturas. Lo usa el descuento por referidos para no apilar
   * abonos más allá de lo que cubre una cuota.
   */
  retrieveCustomerBalance(customerId: string): Promise<CustomerBalanceView>;
  /**
   * Abona `amountCents` a favor del cliente (transacción de saldo con importe
   * NEGATIVO): la próxima factura de su suscripción lo descuenta. Idempotente
   * por `idempotencyKey` (Stripe guarda la clave 24 h).
   */
  creditCustomerBalance(params: CreditCustomerBalanceParams): Promise<{ id: string }>;
  /**
   * Retira `amountCents` del saldo a favor del cliente (transacción de saldo
   * con importe POSITIVO): lo que se le había abonado y no ha gastado.
   * Idempotente por `idempotencyKey`.
   */
  debitCustomerBalance(params: CreditCustomerBalanceParams): Promise<{ id: string }>;
}

export interface CustomerBalanceView {
  /** En céntimos; negativo = a favor del cliente. */
  balanceCents: number;
  /** Divisa del saldo, o null si el cliente aún no tiene ninguna. */
  currency: string | null;
}

export interface CreditCustomerBalanceParams {
  customerId: string;
  /** > 0: lo que se le descuenta en sus próximas facturas. */
  amountCents: number;
  currency: string;
  description: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface CreatePortalSessionParams {
  /** Cliente de Stripe (`cus_…`) dueño de la suscripción. */
  customerId: string;
  /** A dónde vuelve el alumno al salir del portal. */
  returnUrl: string;
  /**
   * Configuración del portal (`bpc_…`). Sin ella, Stripe usa la configuración
   * por defecto de la cuenta.
   */
  configurationId?: string;
}

export interface StripePortalSessionResult {
  url: string;
}

/**
 * Opciones con las que el HOST monta el adaptador. Este módulo no sabe de
 * quién es la cuenta de Stripe ni por qué: solo aplica lo que le dicen.
 *
 * Sin opciones (lo de siempre: el tenant cobra en SU cuenta), los parámetros
 * de la sesión de checkout son exactamente los de antes — hay un test de
 * instantánea que lo vigila.
 */
export interface SubscriptionsStripeAdapterOptions {
  /**
   * Cobro en una cuenta COMPARTIDA en nombre de otra. Con esto la sesión añade
   * `subscription_data.on_behalf_of` (la suscripción, sus facturas y sus cargos
   * son en nombre de esa cuenta: es el comercio que ve el comprador) y el
   * portal de cliente se abre con `on_behalf_of` (lleva su nombre).
   */
  readonly connect?: { readonly onBehalfOf: string };
  /**
   * `'deny'` ignora `allowPromotionCodes`. En una cuenta compartida un código
   * promocional creado para una academia valdría en todas las demás.
   * Por defecto `'allow'`: manda lo que pida el servicio.
   */
  readonly promotionCodes?: 'allow' | 'deny';
}

export interface CreateRecurringPriceParams {
  productId: string;
  amountCents: number;
  currency: string;
  /**
   * Precios fijos extra por mercado (`currency_options`): moneda → importe en
   * su unidad mínima. Inmutables en Stripe: cambiarlos exige un Price nuevo.
   */
  currencyOptions?: Readonly<Record<string, number>> | null;
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
    private readonly options: SubscriptionsStripeAdapterOptions = {},
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
        // SIN `payment_method_types`, igual que mod.billing: Stripe ofrece lo
        // que cada tenant tenga activado en SU dashboard, y filtra solo lo que
        // sirve para cobros recurrentes en esa moneda. La decisión vuelve al
        // comerciante en vez de exigir una release de Didacta.
        //
        // Depende de que `fulfillMembershipCheckout` exija cobro resuelto y de
        // que PENDING → ACTIVE conceda el acceso. Hasta que esas dos cosas
        // existieron, abrir métodos de notificación diferida daba la membresía
        // sin cobrar y, cuando el cobro entraba, no la daba nunca.
        line_items: [{ price: p.priceId, quantity: 1 }],
        success_url: p.successUrl,
        cancel_url: p.cancelUrl,
        customer_email: p.customerEmail,
        client_reference_id: p.clientReferenceId ?? p.metadata['subscriptionLocalId'],
        ...(p.allowPromotionCodes && this.options.promotionCodes !== 'deny'
          ? { allow_promotion_codes: true }
          : {}),
        metadata: { ...p.metadata },
        subscription_data: {
          metadata: { ...p.metadata },
          ...(trialDays ? { trial_period_days: trialDays } : {}),
          ...(this.options.connect ? { on_behalf_of: this.options.connect.onBehalfOf } : {}),
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
        currentPeriodEnd: currentPeriodEndFromSubscription(sub),
        canceledAt: sub.canceled_at ?? null,
        latestInvoicePaid: invoice?.status === 'paid',
      };
    } catch (err) {
      throw new StripeApiError((err as Error).message);
    }
  }

  async createRecurringPrice(p: CreateRecurringPriceParams): Promise<string> {
    try {
      // Stripe solo tiene interval month/year: N meses = month × N (trimestral
      // = month × 3, semestral = month × 6…). Anual usa year × 1 (más legible
      // en el dashboard que month × 12).
      const interval = p.intervalMonths === 12 ? 'year' : 'month';
      const intervalCount = p.intervalMonths === 12 ? 1 : p.intervalMonths;
      const currencyOptions = Object.entries(p.currencyOptions ?? {});
      const price = await this.client.prices.create({
        product: p.productId,
        unit_amount: p.amountCents,
        currency: p.currency,
        ...(currencyOptions.length
          ? {
              currency_options: Object.fromEntries(
                currencyOptions.map(([code, amount]) => [code, { unit_amount: amount }]),
              ),
            }
          : {}),
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
        currentPeriodEnd: currentPeriodEndFromSubscription(sub),
        canceledAt: sub.canceled_at ?? null,
      };
    } catch (err) {
      throw new StripeApiError((err as Error).message);
    }
  }

  async createPortalSession(p: CreatePortalSessionParams): Promise<StripePortalSessionResult> {
    try {
      const session = await this.client.billingPortal.sessions.create({
        customer: p.customerId,
        return_url: p.returnUrl,
        ...(p.configurationId ? { configuration: p.configurationId } : {}),
        // En la cuenta compartida, el portal lleva el nombre y la marca de la
        // cuenta del creador, no los del operador.
        ...(this.options.connect ? { on_behalf_of: this.options.connect.onBehalfOf } : {}),
      });
      return { url: session.url };
    } catch (err) {
      throw new StripeApiError((err as Error).message);
    }
  }

  async retrieveCustomerBalance(customerId: string): Promise<CustomerBalanceView> {
    try {
      const customer = await this.client.customers.retrieve(customerId);
      if ((customer as { deleted?: boolean }).deleted) {
        throw new StripeApiError(`el cliente ${customerId} está borrado en Stripe`);
      }
      const c = customer as Stripe.Customer;
      return { balanceCents: c.balance ?? 0, currency: c.currency ?? null };
    } catch (err) {
      if (err instanceof StripeApiError) throw err;
      throw new StripeApiError((err as Error).message);
    }
  }

  async debitCustomerBalance(p: CreditCustomerBalanceParams): Promise<{ id: string }> {
    if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) {
      throw new StripeApiError(`retirada no válida: ${p.amountCents}`);
    }
    try {
      const tx = await this.client.customers.createBalanceTransaction(
        p.customerId,
        {
          amount: p.amountCents,
          currency: p.currency.toLowerCase(),
          description: p.description,
          metadata: p.metadata,
        },
        { idempotencyKey: p.idempotencyKey },
      );
      return { id: tx.id };
    } catch (err) {
      throw new StripeApiError((err as Error).message);
    }
  }

  async creditCustomerBalance(p: CreditCustomerBalanceParams): Promise<{ id: string }> {
    if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) {
      throw new StripeApiError(`abono no válido: ${p.amountCents}`);
    }
    try {
      const tx = await this.client.customers.createBalanceTransaction(
        p.customerId,
        {
          amount: -p.amountCents,
          currency: p.currency.toLowerCase(),
          description: p.description,
          metadata: p.metadata,
        },
        { idempotencyKey: p.idempotencyKey },
      );
      return { id: tx.id };
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
