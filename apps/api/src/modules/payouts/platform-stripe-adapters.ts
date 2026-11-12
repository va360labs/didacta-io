/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  StripeConfigMissingError as BillingStripeConfigMissingError,
  type CreateCheckoutSessionParams,
  type CreateOneOffPriceParams,
  type StripeAdapter,
  type StripeAdapterOptions,
  type StripeCheckoutSessionResult,
  type StripePriceResult,
  type StripeProductResult,
} from '@didacta/mod-billing';
import {
  StripeConfigMissingError as SubscriptionsStripeConfigMissingError,
  type SubscriptionsStripeAdapter,
} from '@didacta/mod-subscriptions';
import {
  PayoutsNotReadyError,
  type ObjectRefKind,
  type RegisterObjectRefInput,
} from '@didacta/mod-payouts';
import type Stripe from 'stripe';
import type { PaymentMode } from '../payment-mode.resolver';
import type {
  StripeCredentials,
  TenantStripeResolverService,
} from '../tenant-stripe-resolver.service';
import type { PlatformPaymentsEnabled } from './platform-payments.config';

/**
 * Adaptadores de Stripe de `mod.billing` (y de `mod.subscriptions`) cuando el
 * modo plataforma está encendido. Es lo único que cambia para los módulos: ni
 * billing ni subscriptions saben de la plataforma; reciben del host un
 * adaptador que cumple su interfaz de siempre.
 *
 * `PlatformStripeAdapters.billing(tenantId)` pregunta al resolutor de modo:
 *
 *  - `own`  → el adaptador de siempre con las claves propias del tenant.
 *  - `platform` → un DECORADOR (`PlatformBillingStripeAdapter`) sobre el SDK
 *    con la clave del OPERADOR, que:
 *      · crea la sesión con `on_behalf_of` de la cuenta conectada y
 *        `transfer_group`, y SIN códigos promocionales (en una cuenta
 *        compartida, un código de una academia valdría en todas);
 *      · tras crearla, registra `cs_…` en `mod_payouts_object_ref` a nombre del
 *        tenant, con la orden como referencia local. Si el registro falla, la
 *        compra falla: una sesión sin registro se cobraría y el webhook de
 *        plataforma no sabría de quién es (no daría acceso);
 *      · registra también los `price_…`/`prod_…` que crea, para saber qué
 *        precios ya viven en la cuenta del operador;
 *      · enruta por id REGISTRADO los métodos sobre objetos existentes
 *        (`retrievePrice`, `retrieveProduct`): registrado → plataforma; si no y
 *        el tenant conserva claves propias → sus claves (convivencia);
 *      · con la cuenta conectada aún sin poder vender, no crea sesiones
 *        (`PAYOUTS_NOT_READY`, 409). El catálogo sí se puede preparar.
 *  - `none` → `StripeConfigMissingError` (503), como siempre.
 *
 * Membresías (`subscriptions`): todavía no se cobran por la plataforma (etapa
 * E5). Con el modo encendido usan las claves propias del tenant si las tiene y,
 * si no, no hay con qué cobrar (503). En ningún caso heredan las `STRIPE_*` de
 * instancia: en un pool eso metería el dinero de un aula en la cuenta del
 * operador sin pasar por el reparto.
 */

export interface PlatformRefsPort {
  /** Registra un objeto a nombre del tenant (transacción con RLS de ese tenant). */
  register(input: RegisterObjectRefInput): Promise<void>;
  /** ¿Está registrado como de plataforma? (acceso global sancionado). */
  isPlatformObject(stripeObjectId: string): Promise<boolean>;
}

export interface PlatformStripeAdaptersDeps {
  readonly config: PlatformPaymentsEnabled;
  readonly mode: { resolve(tenantId: string): Promise<PaymentMode> };
  readonly ownCredentials: Pick<TenantStripeResolverService, 'resolveTenantOnly'>;
  readonly refs: PlatformRefsPort;
  /** Construye el adaptador de billing del SDK (misma fábrica que el modo propio). */
  readonly buildBilling: (
    credentials: StripeCredentials,
    options?: StripeAdapterOptions,
  ) => StripeAdapter;
  readonly buildSubscriptions: (credentials: StripeCredentials) => SubscriptionsStripeAdapter;
}

export class PlatformStripeAdapters {
  constructor(private readonly deps: PlatformStripeAdaptersDeps) {}

  async billing(tenantId: string): Promise<StripeAdapter> {
    const mode = await this.deps.mode.resolve(tenantId);
    if (mode.mode === 'own') return this.deps.buildBilling(mode.credentials.credentials);
    if (mode.mode === 'none') throw new BillingStripeConfigMissingError('secretKey');

    const own = await this.deps.ownCredentials.resolveTenantOnly(tenantId);
    const platformCredentials: StripeCredentials = {
      secretKey: this.deps.config.secretKey,
      // El adaptador exige un secreto de webhook; en modo plataforma no verifica
      // nada con él (la firma la comprueba el webhook de plataforma).
      webhookSecret: this.deps.config.webhookSecrets[0]!,
    };
    const platform = this.deps.buildBilling(platformCredentials, {
      ...(mode.ready ? { connect: { onBehalfOf: mode.stripeAccountId } } : {}),
      promotionCodes: 'deny',
    });
    return new PlatformBillingStripeAdapter({
      tenantId,
      livemode: this.deps.config.livemode,
      platform,
      own: own ? this.deps.buildBilling(own.credentials) : null,
      notReadyReason: mode.ready ? null : mode.reason,
      refs: this.deps.refs,
    });
  }

  async subscriptions(tenantId: string): Promise<SubscriptionsStripeAdapter> {
    const mode = await this.deps.mode.resolve(tenantId);
    if (mode.mode === 'own') return this.deps.buildSubscriptions(mode.credentials.credentials);
    const own = await this.deps.ownCredentials.resolveTenantOnly(tenantId);
    if (own) return this.deps.buildSubscriptions(own.credentials);
    throw new SubscriptionsStripeConfigMissingError('secretKey');
  }
}

export class PlatformBillingStripeAdapter implements StripeAdapter {
  constructor(
    private readonly opts: {
      readonly tenantId: string;
      readonly livemode: boolean;
      /** SDK con la clave del operador (y `connect` si la cuenta puede vender). */
      readonly platform: StripeAdapter;
      /** Claves propias que el tenant conserva, o `null`. */
      readonly own: StripeAdapter | null;
      /** Por qué la cuenta conectada aún no puede vender; `null` si puede. */
      readonly notReadyReason: string | null;
      readonly refs: PlatformRefsPort;
    },
  ) {}

  async createCheckoutSession(
    params: CreateCheckoutSessionParams,
  ): Promise<StripeCheckoutSessionResult> {
    if (this.opts.notReadyReason) throw new PayoutsNotReadyError(this.opts.notReadyReason);
    const session = await this.opts.platform.createCheckoutSession(params);
    await this.register(session.id, 'checkout_session', params.metadata.orderId);
    return session;
  }

  async createOneOffPrice(params: CreateOneOffPriceParams): Promise<StripePriceResult> {
    const price = await this.opts.platform.createOneOffPrice(params);
    await this.register(price.productId, 'product', null);
    await this.register(price.id, 'price', null, price.productId);
    return price;
  }

  async retrievePrice(priceId: string): Promise<StripePriceResult> {
    return (await this.route(priceId)).retrievePrice(priceId);
  }

  async retrieveProduct(productId: string): Promise<StripeProductResult> {
    return (await this.route(productId)).retrieveProduct(productId);
  }

  constructWebhookEvent(rawBody: string | Buffer, signatureHeader: string): Stripe.Event {
    // Nadie lo usa en modo plataforma: los heredados construyen su propio
    // adaptador y el de plataforma verifica con los secretos del operador.
    return (this.opts.own ?? this.opts.platform).constructWebhookEvent(rawBody, signatureHeader);
  }

  /** Objeto registrado como de plataforma → plataforma; si no, claves propias si las hay. */
  private async route(stripeObjectId: string): Promise<StripeAdapter> {
    if (!this.opts.own) return this.opts.platform;
    return (await this.opts.refs.isPlatformObject(stripeObjectId))
      ? this.opts.platform
      : this.opts.own;
  }

  private async register(
    stripeObjectId: string,
    kind: ObjectRefKind,
    localRef: string | null,
    parentObjectId: string | null = null,
  ): Promise<void> {
    await this.opts.refs.register({
      tenantId: this.opts.tenantId,
      stripeObjectId,
      kind,
      source: 'billing',
      localRef,
      parentObjectId,
      livemode: this.opts.livemode,
    });
  }
}
