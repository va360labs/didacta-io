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
  retrievePrice(priceId: string): Promise<StripePriceResult>;
  retrieveProduct(productId: string): Promise<StripeProductResult>;
  /**
   * Crea Product + Price de pago único en Stripe a partir de un importe. Evita
   * que el admin tenga que crearlos a mano en el dashboard y pegar el `price_`.
   * Mismo patrón que `ensureStripePrice` de mod.subscriptions.
   */
  createOneOffPrice(params: CreateOneOffPriceParams): Promise<StripePriceResult>;
  /**
   * Verifica la firma del webhook y devuelve el evento parseado. Lanza
   * WebhookSignatureInvalidError si la firma no concuerda.
   */
  constructWebhookEvent(rawBody: string | Buffer, signatureHeader: string): Stripe.Event;
}

export interface CreateCheckoutSessionParams {
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  /**
   * Metadata que viaja con la sesión y se replica en el webhook. Lo usamos
   * para reconciliar el order interno con la session de Stripe sin lookup
   * adicional.
   */
  metadata: {
    tenantId: string;
    userId: string;
    courseId: string;
    productId: string;
    orderId: string;
  };
}

export interface StripeCheckoutSessionResult {
  id: string;
  url: string;
}

export interface CreateOneOffPriceParams {
  /** Nombre visible en el checkout de Stripe (normalmente el título del curso). */
  name: string;
  /** Importe en la unidad mínima (céntimos). */
  unitAmount: number;
  currency: string;
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
    try {
      const session = await this.client.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{ price: p.priceId, quantity: 1 }],
        success_url: p.successUrl,
        cancel_url: p.cancelUrl,
        customer_email: p.customerEmail,
        client_reference_id: p.metadata.orderId,
        metadata: { ...p.metadata },
        // Importante para reconciliar invoicing: pasamos el orderId en
        // payment_intent.metadata también, que sobrevive al checkout.
        payment_intent_data: { metadata: { ...p.metadata } },
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
      // en la pantalla de pago de Stripe.
      const product = await this.client.products.create({
        name: params.name,
        metadata: params.metadata,
      });
      const price = await this.client.prices.create({
        product: product.id,
        unit_amount: params.unitAmount,
        currency: params.currency,
        metadata: params.metadata,
      });
      return {
        id: price.id,
        productId: product.id,
        unitAmount: price.unit_amount ?? params.unitAmount,
        currency: price.currency,
        active: price.active,
      };
    } catch (err) {
      throw new StripeApiError((err as Error).message);
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
