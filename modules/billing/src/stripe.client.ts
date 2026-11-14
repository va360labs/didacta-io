/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Wrapper sobre el SDK oficial de Stripe.
 *
 * Razones de existir esta capa:
 *  1. Centraliza la verificación HMAC del webhook (constructEvent + lectura
 *     del raw body). El controller solo recibe el evento ya validado.
 *  2. Aísla el SDK de Stripe del resto del código del módulo: si algún día se
 *     migrara a otro PSP, solo cambia este archivo.
 *  3. Permite mockearlo en tests unit sin levantar Stripe real.
 *
 * El SDK no se importa de forma estática — se carga vía constructor para que
 * el módulo siga funcionando sin Stripe en NODE_ENV=test si se inyecta un
 * mock (interfaz StripeAdapter abajo).
 */

import type Stripe from 'stripe';
import {
  StripeApiError,
  StripeConfigMissingError,
  WebhookSignatureInvalidError,
} from './errors.js';

/**
 * Subset de la API de Stripe que usamos. Mockeable en tests sin instalar
 * Stripe SDK como devDependency en el harness de tests.
 */
export interface StripeAdapter {
  createCheckoutSession(params: CreateCheckoutSessionParams): Promise<StripeCheckoutSessionResult>;
  /**
   * Estado de una sesión ya creada. Lo usa la vuelta del pago EMBEBIDO: allí
   * se vuelve a `return_url` también con un medio de pago con redirección que
   * falla, y la pantalla tiene que preguntar antes de decir «gracias». No
   * concede nada: el acceso lo sigue dando el webhook.
   */
  retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSessionStatus>;
  retrievePrice(priceId: string): Promise<StripePriceResult>;
  retrieveProduct(productId: string): Promise<StripeProductResult>;
  /**
   * Crea Product + Price de pago único en Stripe a partir de un importe. Evita
   * que el admin tenga que crearlos a mano en el dashboard y pegar el `price_`.
   * Mismo patrón que `ensureStripePrice` de mod.subscriptions.
   */
  createOneOffPrice(params: CreateOneOffPriceParams): Promise<StripePriceResult>;
  /**
   * Caduca una sesión de Checkout ABIERTA (`checkout.sessions.expire`) para que
   * ya no se pueda pagar. Si Stripe no la deja caducar porque ya no está abierta
   * (pagada o caducada), devuelve su estado real en vez de fallar: quien llama
   * decide con él (una pagada NO se toca, la completa su webhook).
   */
  expireCheckoutSession(sessionId: string): Promise<{ status: string }>;
  /**
   * Verifica la firma del webhook y devuelve el evento parseado. Lanza
   * WebhookSignatureInvalidError si la firma no concuerda.
   */
  constructWebhookEvent(rawBody: string | Buffer, signatureHeader: string): Stripe.Event;
}

/**
 * Dónde se pinta el pago:
 *
 *  - `hosted` — la página de Stripe (redirect a `checkout.stripe.com`). Vuelve
 *    a `successUrl` SOLO si se pagó y a `cancelUrl` si el comprador se echa
 *    atrás. Es lo de siempre.
 *  - `embedded` — la MISMA Checkout Session con `ui_mode: 'embedded'`, dentro
 *    de la ficha de venta del aula (un iframe de Stripe: los datos de la
 *    tarjeta nunca tocan nuestro dominio). No hay `successUrl`/`cancelUrl`:
 *    se vuelve a `returnUrl` al completarse. La entrega no cambia: cuelga del
 *    mismo `checkout.session.completed`.
 */
export type CheckoutUiMode = 'hosted' | 'embedded';

/**
 * Idiomas de la pantalla de pago que se fijan desde el aula: los del
 * producto. Cualquier otro (o ninguno) deja que Stripe use el del navegador.
 */
export const CHECKOUT_LOCALES = ['es', 'en', 'pt-BR'] as const;
export type CheckoutLocale = (typeof CHECKOUT_LOCALES)[number];

/** El idioma del aula en el formato de Stripe, o `undefined` (el del navegador). */
export function toCheckoutLocale(locale: string | null | undefined): CheckoutLocale | undefined {
  if (!locale) return undefined;
  const lower = locale.trim().toLowerCase();
  if (lower === 'pt-br' || lower === 'pt') return 'pt-BR';
  const base = lower.split('-')[0];
  return base === 'es' || base === 'en' ? base : undefined;
}

export interface CreateCheckoutSessionParams {
  priceId: string;
  /** Solo en el alojado (`uiMode` ausente u `hosted`). */
  successUrl: string;
  /** Solo en el alojado (`uiMode` ausente u `hosted`). */
  cancelUrl: string;
  /** Por defecto `hosted`: sin este campo, la sesión es exactamente la de siempre. */
  uiMode?: CheckoutUiMode;
  /**
   * Vuelta del EMBEBIDO (obligatoria con `uiMode: 'embedded'`). Lleva
   * `{CHECKOUT_SESSION_ID}`: la pantalla de vuelta pregunta por esa sesión.
   */
  returnUrl?: string;
  /** Idioma de la pantalla de pago; sin él, el del navegador. */
  locale?: CheckoutLocale;
  customerEmail?: string;
  /**
   * Deja que el comprador canjee un código promocional de Stripe en la pantalla
   * de pago. Mismo parámetro y mismo nombre que en mod.subscriptions, que lo
   * activa para la membresía: sin esto, la venta de cursos era el único sitio
   * donde un código creado en el dashboard no se podía usar.
   *
   * Ojo, no es gratis en términos de conversión: el campo aparece siempre, y a
   * quien no tiene código puede darle por irse a buscar uno.
   */
  allowPromotionCodes?: boolean;
  /**
   * Metadata que viaja con la sesión y se replica en el webhook. Lo usamos
   * para reconciliar el order interno con la session de Stripe sin lookup
   * adicional. `userId` falta en el checkout PÚBLICO (comprador aún sin
   * cuenta): la order es la fuente de verdad y el webhook lo materializa.
   */
  metadata: {
    tenantId: string;
    userId?: string;
    courseId: string;
    productId: string;
    orderId: string;
  };
}

export interface StripeCheckoutSessionResult {
  id: string;
  /** Página alojada de Stripe. `null` en el embebido. */
  url: string | null;
  /**
   * Secreto con el que el navegador monta el embebido. `null`/ausente en el
   * alojado. Solo sirve para pintar ESA sesión.
   */
  clientSecret?: string | null;
  /**
   * Lo que cobrará ESTA sesión (unidad mínima) y en qué moneda, tal como la
   * creó Stripe. La pantalla de pago enseña esto y no el precio que se pintó
   * al cargar la página: si el precio cambió entretanto, manda la sesión.
   */
  amountTotal?: number | null;
  currency?: string | null;
}

/** Lo justo de una sesión para decidir qué se le dice a quien vuelve del pago. */
export interface StripeCheckoutSessionStatus {
  id: string;
  /** `open` (sin completar), `complete` o `expired`. */
  status: 'open' | 'complete' | 'expired' | null;
  /** `paid`, `unpaid` o `no_payment_required`. */
  paymentStatus: string | null;
  metadata: Record<string, string>;
  /** Importe de la sesión (unidad mínima) y moneda, para la pantalla de gracias. */
  amountTotal: number | null;
  currency: string | null;
  /** Creación de la sesión, en segundos Unix. */
  created: number | null;
}

export interface CreateOneOffPriceParams {
  /** Nombre visible en el checkout de Stripe (normalmente el título del curso). */
  name: string;
  /**
   * Product de Stripe ya existente. Si se pasa, solo se crea el Price nuevo
   * sobre él — así al cambiar el importe de un curso no se acumula un Product
   * duplicado por cada cambio de precio.
   */
  productId?: string;
  /** Importe en la unidad mínima (céntimos). */
  unitAmount: number;
  currency: string;
  /**
   * Precios fijos extra por mercado (`currency_options`): moneda → importe en
   * su unidad mínima. Inmutables en Stripe: cambiarlos exige un Price nuevo.
   */
  currencyOptions?: Readonly<Record<string, number>> | null;
  metadata: Record<string, string>;
}

export interface StripePriceResult {
  id: string;
  productId: string;
  unitAmount: number;
  currency: string;
  active: boolean;
}

export interface StripeProductResult {
  id: string;
  name: string;
  active: boolean;
}

/**
 * Opciones con las que el HOST monta el adaptador. Este módulo no sabe de
 * quién es la cuenta de Stripe ni por qué: solo aplica lo que le dicen.
 *
 * Sin opciones (lo de siempre: el tenant cobra en SU cuenta), los parámetros de
 * la sesión son exactamente los de antes — hay un test de instantánea que lo
 * vigila.
 */
export interface StripeAdapterOptions {
  /**
   * Cobro en una cuenta COMPARTIDA en nombre de otra. Con esto la sesión añade
   * `payment_intent_data.on_behalf_of` (el comercio que ve el comprador y el que
   * figura en el extracto es esa cuenta) y `transfer_group: 'didacta_<orderId>'`,
   * que agrupa en Stripe el cargo y la transferencia posterior de su parte.
   *
   * Nunca `application_fee_amount` ni `transfer_data.amount`: desactivan los
   * precios multidivisa (`currency_options`) y Adaptive Pricing. La parte del
   * creador se transfiere después, con la comisión real ya conocida.
   */
  readonly connect?: { readonly onBehalfOf: string };
  /**
   * `'deny'` ignora `allowPromotionCodes`. En una cuenta compartida un código
   * promocional creado para una academia valdría en todas las demás.
   * Por defecto `'allow'`: manda lo que pida el servicio.
   */
  readonly promotionCodes?: 'allow' | 'deny';
}

/** Prefijo del `transfer_group` de una venta: agrupa cargo y transferencia en Stripe. */
export const TRANSFER_GROUP_PREFIX = 'didacta_';

/**
 * Implementación real basada en el SDK oficial de Stripe.
 *
 * Construir solo si hay STRIPE_SECRET_KEY. En tests puedes pasar un
 * StripeAdapter mockeado sin tocar este archivo.
 */
export class StripeSdkAdapter implements StripeAdapter {
  private readonly client: Stripe;

  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string,
    StripeCtor: new (key: string, opts?: Stripe.StripeConfig) => Stripe,
    private readonly options: StripeAdapterOptions = {},
  ) {
    if (!secretKey) throw new StripeConfigMissingError('secretKey');
    if (!webhookSecret) throw new StripeConfigMissingError('webhookSecret');
    // El SDK acepta apiVersion via config; lo dejamos en el default del
    // package para alinear con la versión instalada.
    this.client = new StripeCtor(secretKey, {
      apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion,
      // Opcional: timeout más estricto para no colgar el handler.
      timeout: 10_000,
      maxNetworkRetries: 1,
    });
  }

  async createCheckoutSession(
    p: CreateCheckoutSessionParams,
  ): Promise<StripeCheckoutSessionResult> {
    const embedded = p.uiMode === 'embedded';
    if (embedded && !p.returnUrl) {
      throw new StripeApiError('El pago embebido necesita returnUrl');
    }
    try {
      const session = await this.client.checkout.sessions.create({
        mode: 'payment',
        // SIN `payment_method_types`: omitirlo hace que Stripe ofrezca los
        // métodos que cada tenant tenga activados en SU dashboard. "Qué formas
        // de pago acepto" deja de ser una decisión del código —que obligaba a
        // una release para añadir PayPal o Bizum— y pasa a ser del comerciante,
        // que es de quien siempre fue.
        //
        // Esto solo es seguro desde que `onCheckoutCompleted` exige
        // `payment_status` cobrado: al abrir métodos de notificación diferida
        // (SEPA, transferencia), `checkout.session.completed` empieza a llegar
        // con el dinero todavía en el aire. Si alguien revierte aquella
        // guarda, hay que volver a poner esta línea el mismo día. En
        // mod.subscriptions rige lo mismo, con su propia guarda equivalente.
        line_items: [{ price: p.priceId, quantity: 1 }],
        // Embebido: la misma sesión pintada dentro de la ficha del aula. Sin
        // `success_url`/`cancel_url` (Stripe no los admite en este modo): se
        // vuelve a `return_url` al completarse.
        ...(embedded
          ? { ui_mode: 'embedded' as const, return_url: p.returnUrl }
          : { success_url: p.successUrl, cancel_url: p.cancelUrl }),
        ...(p.locale ? { locale: p.locale } : {}),
        customer_email: p.customerEmail,
        ...(p.allowPromotionCodes && this.options.promotionCodes !== 'deny'
          ? { allow_promotion_codes: true }
          : {}),
        client_reference_id: p.metadata.orderId,
        metadata: { ...p.metadata },
        // Importante para reconciliar invoicing: pasamos el orderId en
        // payment_intent.metadata también, que sobrevive al checkout.
        payment_intent_data: {
          metadata: { ...p.metadata },
          ...(this.options.connect
            ? {
                on_behalf_of: this.options.connect.onBehalfOf,
                transfer_group: `${TRANSFER_GROUP_PREFIX}${p.metadata.orderId}`,
              }
            : {}),
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

  async retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSessionStatus> {
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
      };
    } catch (err) {
      throw new StripeApiError((err as Error).message);
    }
  }

  async createOneOffPrice(params: CreateOneOffPriceParams): Promise<StripePriceResult> {
    try {
      // Un Product por curso, nombrado con el título: es lo que ve el comprador
      // en la pantalla de pago de Stripe. Se reutiliza si ya existe.
      const productId =
        params.productId ??
        (
          await this.client.products.create({
            name: params.name,
            metadata: params.metadata,
          })
        ).id;
      const currencyOptions = Object.entries(params.currencyOptions ?? {});
      const price = await this.client.prices.create({
        product: productId,
        unit_amount: params.unitAmount,
        currency: params.currency,
        ...(currencyOptions.length
          ? {
              currency_options: Object.fromEntries(
                currencyOptions.map(([code, amount]) => [code, { unit_amount: amount }]),
              ),
            }
          : {}),
        metadata: params.metadata,
      });
      return {
        id: price.id,
        productId,
        unitAmount: price.unit_amount ?? params.unitAmount,
        currency: price.currency,
        active: price.active,
      };
    } catch (err) {
      throw new StripeApiError((err as Error).message);
    }
  }

  async expireCheckoutSession(sessionId: string): Promise<{ status: string }> {
    try {
      const session = await this.client.checkout.sessions.expire(sessionId);
      return { status: session.status ?? 'expired' };
    } catch (err) {
      // Stripe solo caduca sesiones `open`. Si ya no lo está, su estado real
      // (complete / expired) es la respuesta; si tampoco se puede leer, falla.
      try {
        const session = await this.client.checkout.sessions.retrieve(sessionId);
        return { status: session.status ?? 'unknown' };
      } catch {
        throw new StripeApiError((err as Error).message);
      }
    }
  }

  async retrieveProduct(productId: string): Promise<StripeProductResult> {
    try {
      const product = await this.client.products.retrieve(productId);
      return { id: product.id, name: product.name, active: product.active };
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
