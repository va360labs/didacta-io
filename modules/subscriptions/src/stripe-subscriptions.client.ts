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
import {
  currentPeriodEndFromSubscription,
  currentPeriodStartFromSubscription,
  intervalMonthsFromSubscription,
  pauseCollectionFromSubscription,
  subscriptionHasDiscount,
} from './stripe-shape.js';

export interface SubscriptionsStripeAdapter {
  createCheckoutSession(
    params: CreateSubscriptionCheckoutParams,
  ): Promise<StripeSubscriptionCheckoutResult>;
  /**
   * Estado de una sesión ya creada, para la vuelta del pago EMBEBIDO (allí se
   * vuelve a `return_url` aunque un medio con redirección falle). No concede
   * nada: el acceso lo da el webhook.
   */
  retrieveCheckoutSession(sessionId: string): Promise<SubscriptionCheckoutSessionStatus>;
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
  /**
   * Estado de la suscripción EN STRIPE (oferta al darse de baja): periodo en
   * curso, cada cuántos meses se cobra, si ya está en pausa o con descuento.
   * La oferta se decide con esto y no con la fila local, que puede ir atrasada.
   */
  retrieveSubscription(subscriptionId: string): Promise<StripeSubscriptionDetails>;
  /**
   * Pausa el cobro: Stripe sigue renovando, pero ANULA cada factura nueva
   * (`pause_collection.behavior = void`) hasta `resumesAt`. El periodo ya
   * pagado no se toca. Idempotente por `idempotencyKey`.
   */
  pauseCollection(params: PauseCollectionParams): Promise<StripeSubscriptionDetails>;
  /**
   * Descuento de retención: crea un cupón de UN SOLO USO y lo aplica a la
   * suscripción. Vale para las próximas facturas (`repeating` N meses, u
   * `once`: solo la siguiente). Idempotente por `idempotencyKey`.
   */
  applyRetentionDiscount(params: RetentionDiscountParams): Promise<RetentionDiscountResult>;
}

/** Lo que la oferta al darse de baja necesita saber de una suscripción en Stripe. */
export interface StripeSubscriptionDetails {
  id: string;
  /** Estado literal de Stripe (`active`, `trialing`, `past_due`…). */
  status: string;
  cancelAtPeriodEnd: boolean;
  /** Epoch en segundos. */
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  /** Meses por cobro (1 mensual, 3 trimestral, 12 anual) o null (semanas/días). */
  intervalMonths: number | null;
  /** `null` = cobrando con normalidad. */
  pauseCollection: { behavior: string; resumesAt: number | null } | null;
  /** ¿Tiene ya un descuento vivo? (no se apila otro). */
  hasDiscount: boolean;
}

export interface PauseCollectionParams {
  subscriptionId: string;
  /** Epoch en segundos: desde aquí Stripe vuelve a cobrar las facturas nuevas. */
  resumesAt: number;
  idempotencyKey: string;
}

export interface RetentionDiscountParams {
  subscriptionId: string;
  /** 1..99 */
  percentOff: number;
  /** `repeating` = las facturas de los próximos `durationInMonths` meses; `once` = la siguiente. */
  duration: 'repeating' | 'once';
  durationInMonths?: number;
  /** Nombre del cupón (lo ve el alumno en su factura). Máx. 40 caracteres. */
  name: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface RetentionDiscountResult {
  couponId: string;
  /** Epoch en segundos en que deja de aplicarse (null con `once`). */
  discountEnd: number | null;
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

/**
 * `hosted`: la página de Stripe (redirect), lo de siempre. `embedded`: la
 * MISMA sesión con `ui_mode: 'embedded'` dentro de la página de venta del
 * aula; vuelve a `returnUrl` al completarse (sin success/cancel).
 */
export type SubscriptionCheckoutUiMode = 'hosted' | 'embedded';

export interface CreateSubscriptionCheckoutParams {
  priceId: string;
  /** Solo en el alojado. */
  successUrl: string;
  /** Solo en el alojado. */
  cancelUrl: string;
  /** Por defecto `hosted`: sin este campo, la sesión es la de siempre. */
  uiMode?: SubscriptionCheckoutUiMode;
  /** Vuelta del embebido, con `{CHECKOUT_SESSION_ID}`. Obligatoria con `embedded`. */
  returnUrl?: string;
  /** Idioma de la pantalla de pago (`es`, `en`, `pt-BR`); sin él, el del navegador. */
  locale?: 'es' | 'en' | 'pt-BR';
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
  /** Página alojada de Stripe; `null` en el embebido. */
  url: string | null;
  /** Secreto del embebido; `null`/ausente en el alojado. */
  clientSecret?: string | null;
  /**
   * Lo que cobrará ESTA sesión (unidad mínima) y en qué moneda, tal como la
   * creó Stripe. La pantalla de pago enseña esto y no el precio que se pintó
   * al cargar la página: si el precio cambió entretanto, manda la sesión.
   */
  amountTotal?: number | null;
  currency?: string | null;
}

/** Lo justo de una sesión para la pantalla de vuelta del pago. */
export interface SubscriptionCheckoutSessionStatus {
  id: string;
  status: 'open' | 'complete' | 'expired' | null;
  paymentStatus: string | null;
  metadata: Record<string, string>;
  /** Importe de la sesión (unidad mínima) y moneda, para la pantalla de gracias. */
  amountTotal: number | null;
  currency: string | null;
  /** Creación de la sesión, en segundos Unix. */
  created: number | null;
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
    const embedded = p.uiMode === 'embedded';
    if (embedded && !p.returnUrl) {
      throw new StripeApiError('El pago embebido necesita returnUrl');
    }
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
        // Embebido: la misma sesión dentro de la página de venta del aula, que
        // vuelve a `return_url` (Stripe no admite success/cancel en este modo).
        ...(embedded
          ? { ui_mode: 'embedded' as const, return_url: p.returnUrl }
          : { success_url: p.successUrl, cancel_url: p.cancelUrl }),
        ...(p.locale ? { locale: p.locale } : {}),
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
      if (embedded) {
        if (!session.client_secret) {
          throw new StripeApiError('Stripe devolvió session embebida sin client_secret');
        }
        return {
          id: session.id,
          url: null,
          clientSecret: session.client_secret,
          amountTotal: session.amount_total ?? null,
          currency: session.currency ?? null,
        };
      }
      if (!session.url) {
        throw new StripeApiError('Stripe devolvió session sin URL hosted');
      }
      return { id: session.id, url: session.url };
    } catch (err) {
      if (err instanceof StripeApiError) throw err;
      throw new StripeApiError((err as Error).message);
    }
  }

  async retrieveCheckoutSession(sessionId: string): Promise<SubscriptionCheckoutSessionStatus> {
    try {
      const session = await this.client.checkout.sessions.retrieve(sessionId);
      return {
        id: session.id,
        status: session.status ?? null,
        paymentStatus: session.payment_status ?? null,
        metadata: { ...(session.metadata ?? {}) },
        amountTotal: session.amount_total ?? null,
        currency: session.currency ?? null,
        created: session.created ?? null,
      };
    } catch (err) {
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

  async retrieveSubscription(subscriptionId: string): Promise<StripeSubscriptionDetails> {
    try {
      return subscriptionDetails(await this.client.subscriptions.retrieve(subscriptionId));
    } catch (err) {
      throw new StripeApiError((err as Error).message);
    }
  }

  async pauseCollection(p: PauseCollectionParams): Promise<StripeSubscriptionDetails> {
    if (!Number.isInteger(p.resumesAt) || p.resumesAt <= 0) {
      throw new StripeApiError(`fecha de reanudación no válida: ${p.resumesAt}`);
    }
    try {
      const sub = await this.client.subscriptions.update(
        p.subscriptionId,
        { pause_collection: { behavior: 'void', resumes_at: p.resumesAt } },
        { idempotencyKey: p.idempotencyKey },
      );
      return subscriptionDetails(sub);
    } catch (err) {
      throw new StripeApiError((err as Error).message);
    }
  }

  async applyRetentionDiscount(p: RetentionDiscountParams): Promise<RetentionDiscountResult> {
    if (!Number.isInteger(p.percentOff) || p.percentOff < 1 || p.percentOff > 99) {
      throw new StripeApiError(`porcentaje no válido: ${p.percentOff}`);
    }
    if (
      p.duration === 'repeating' &&
      (!Number.isInteger(p.durationInMonths) || (p.durationInMonths ?? 0) < 1)
    ) {
      throw new StripeApiError(`meses no válidos: ${p.durationInMonths}`);
    }
    try {
      // Un cupón POR ACEPTACIÓN y de un solo uso: en una cuenta compartida
      // (cobros de plataforma) un cupón reutilizable valdría en cualquier
      // academia. Se aplica en el servidor, sin código que se pueda compartir.
      const coupon = await this.client.coupons.create(
        {
          percent_off: p.percentOff,
          duration: p.duration,
          ...(p.duration === 'repeating' ? { duration_in_months: p.durationInMonths } : {}),
          max_redemptions: 1,
          name: p.name.slice(0, 40),
          metadata: p.metadata,
        },
        { idempotencyKey: `${p.idempotencyKey}:coupon` },
      );
      const sub = await this.client.subscriptions.update(
        p.subscriptionId,
        // Sin prorrateo: el descuento vale para las facturas que vengan, no
        // reescribe lo ya cobrado.
        { discounts: [{ coupon: coupon.id }], proration_behavior: 'none' },
        { idempotencyKey: `${p.idempotencyKey}:subscription` },
      );
      return { couponId: coupon.id, discountEnd: discountEndOf(sub, coupon.id) };
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

/** La vista que necesita la oferta, leída con los lectores tolerantes. */
export function subscriptionDetails(sub: unknown): StripeSubscriptionDetails {
  const s = sub as { id?: unknown; status?: unknown; cancel_at_period_end?: unknown };
  return {
    id: typeof s.id === 'string' ? s.id : '',
    status: typeof s.status === 'string' ? s.status : 'unknown',
    cancelAtPeriodEnd: s.cancel_at_period_end === true,
    currentPeriodStart: currentPeriodStartFromSubscription(sub),
    currentPeriodEnd: currentPeriodEndFromSubscription(sub),
    intervalMonths: intervalMonthsFromSubscription(sub),
    pauseCollection: pauseCollectionFromSubscription(sub),
    hasDiscount: subscriptionHasDiscount(sub),
  };
}

/**
 * Fin del descuento de ESE cupón en la suscripción devuelta por Stripe:
 * `discount.end` (versiones viejas) o el de la lista `discounts` si viene
 * expandida. `null` si no se puede leer (con `once` no hay fecha).
 */
function discountEndOf(sub: unknown, couponId: string): number | null {
  const s = sub as { discount?: unknown; discounts?: unknown };
  const candidates: unknown[] = [s.discount, ...(Array.isArray(s.discounts) ? s.discounts : [])];
  for (const d of candidates) {
    if (!d || typeof d !== 'object') continue;
    const disc = d as { end?: unknown; coupon?: unknown; source?: unknown };
    const fromCoupon =
      disc.coupon && typeof disc.coupon === 'object'
        ? (disc.coupon as { id?: unknown }).id
        : undefined;
    const fromSource =
      disc.source && typeof disc.source === 'object'
        ? (disc.source as { coupon?: unknown }).coupon
        : undefined;
    const id = fromCoupon ?? fromSource;
    const couponMatches =
      id === couponId || (id && typeof id === 'object' && (id as { id?: unknown }).id === couponId);
    if (!couponMatches) continue;
    return typeof disc.end === 'number' ? disc.end : null;
  }
  return null;
}
