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
  type CreatePortalSessionParams,
  type CreateRecurringPriceParams,
  type CreateSubscriptionCheckoutParams,
  type EndTrialNowResult,
  type StripePortalSessionResult,
  type StripePriceResult as SubscriptionsStripePriceResult,
  type StripeSubscriptionCheckoutResult,
  type StripeSubscriptionView,
  type SubscriptionsStripeAdapter,
  type SubscriptionsStripeAdapterOptions,
} from '@didacta/mod-subscriptions';
import {
  PayoutsNotReadyError,
  type ObjectRefKind,
  type ObjectRefSource,
  type PortalForAccount,
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
 * Membresías y suscripciones (`subscriptions`, etapa E5): lo mismo con
 * `PlatformSubscriptionsStripeAdapter`. La sesión lleva
 * `subscription_data.on_behalf_of` (la suscripción y cada factura son en nombre
 * del creador) y se registra a nombre del tenant; los métodos sobre objetos
 * existentes (`cancelSubscription`, `endTrialNow`, `updateProduct`,
 * `retrievePrice`, el portal del cliente) van por id registrado: de plataforma
 * → clave del operador; si no → claves propias (suscripciones vendidas cuando
 * el aula cobraba con sus claves). En ningún caso heredan las `STRIPE_*` de
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
  readonly buildSubscriptions: (
    credentials: StripeCredentials,
    options?: SubscriptionsStripeAdapterOptions,
  ) => SubscriptionsStripeAdapter;
  /**
   * Portal de cliente del creador en la cuenta del operador: su configuración
   * (`bpc_…`, creada la primera vez) y su cuenta conectada (`on_behalf_of`).
   */
  readonly portal: { forTenant(tenantId: string): Promise<PortalForAccount> };
}

/** Puerto del portal que recibe el decorador de suscripciones. */
export type PlatformPortalPort = PlatformStripeAdaptersDeps['portal'];

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
    if (mode.mode === 'none') throw new SubscriptionsStripeConfigMissingError('secretKey');

    const own = await this.deps.ownCredentials.resolveTenantOnly(tenantId);
    const platformCredentials: StripeCredentials = {
      secretKey: this.deps.config.secretKey,
      // Igual que en billing: el adaptador exige un secreto y aquí no verifica nada.
      webhookSecret: this.deps.config.webhookSecrets[0]!,
    };
    return new PlatformSubscriptionsStripeAdapter({
      tenantId,
      livemode: this.deps.config.livemode,
      platform: this.deps.buildSubscriptions(platformCredentials, {
        ...(mode.ready ? { connect: { onBehalfOf: mode.stripeAccountId } } : {}),
        promotionCodes: 'deny',
      }),
      platformFor: (onBehalfOf) =>
        this.deps.buildSubscriptions(platformCredentials, {
          connect: { onBehalfOf },
          promotionCodes: 'deny',
        }),
      own: own ? this.deps.buildSubscriptions(own.credentials) : null,
      notReadyReason: mode.ready ? null : mode.reason,
      refs: this.deps.refs,
      portal: this.deps.portal,
    });
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

/**
 * Origen del registro de un objeto de suscripción: la membresía (su sesión,
 * Product y Price llevan `membership`/`didacta: membership` o el `planId`) o
 * la suscripción a un curso.
 */
function subscriptionSource(metadata: Readonly<Record<string, string>>): ObjectRefSource {
  return metadata['membership'] === '1' ||
    metadata['didacta'] === 'membership' ||
    typeof metadata['planId'] === 'string'
    ? 'membership'
    : 'subscriptions';
}

/**
 * Adaptador de `mod.subscriptions` de un tenant que cobra por la plataforma
 * (E5). Mismo patrón que `PlatformBillingStripeAdapter`.
 */
export class PlatformSubscriptionsStripeAdapter implements SubscriptionsStripeAdapter {
  constructor(
    private readonly opts: {
      readonly tenantId: string;
      readonly livemode: boolean;
      /** SDK con la clave del operador (y `connect` si la cuenta puede vender). */
      readonly platform: SubscriptionsStripeAdapter;
      /** SDK con la clave del operador en nombre de una cuenta concreta (el portal). */
      readonly platformFor: (onBehalfOf: string) => SubscriptionsStripeAdapter;
      /** Claves propias que el tenant conserva, o `null`. */
      readonly own: SubscriptionsStripeAdapter | null;
      /** Por qué la cuenta conectada aún no puede vender; `null` si puede. */
      readonly notReadyReason: string | null;
      readonly refs: PlatformRefsPort;
      readonly portal: PlatformPortalPort;
    },
  ) {}

  /**
   * Sesión de checkout en la cuenta del operador, en nombre del creador. Se
   * registra `cs_…` a nombre del tenant con su referencia local (el plan de la
   * membresía o la suscripción local, la misma que viaja en
   * `client_reference_id`). Si el registro falla, el alta falla: una sesión
   * sin registro se cobraría y el webhook de plataforma no sabría de quién es.
   */
  async createCheckoutSession(
    params: CreateSubscriptionCheckoutParams,
  ): Promise<StripeSubscriptionCheckoutResult> {
    if (this.opts.notReadyReason) throw new PayoutsNotReadyError(this.opts.notReadyReason);
    const session = await this.opts.platform.createCheckoutSession(params);
    const source = subscriptionSource(params.metadata);
    const localRef =
      source === 'membership'
        ? (params.metadata['planId'] ?? params.clientReferenceId ?? null)
        : (params.clientReferenceId ?? params.metadata['subscriptionLocalId'] ?? null);
    await this.register(session.id, 'checkout_session', source, localRef);
    return session;
  }

  /** El catálogo se puede preparar aunque la cuenta aún no pueda vender. */
  async createProduct(name: string, metadata: Record<string, string>): Promise<string> {
    const productId = await this.opts.platform.createProduct(name, metadata);
    await this.register(
      productId,
      'product',
      subscriptionSource(metadata),
      metadata['planId'] ?? null,
    );
    return productId;
  }

  async createRecurringPrice(params: CreateRecurringPriceParams): Promise<string> {
    const priceId = await this.opts.platform.createRecurringPrice(params);
    await this.register(
      priceId,
      'price',
      subscriptionSource(params.metadata),
      params.metadata['planId'] ?? null,
      params.productId,
    );
    return priceId;
  }

  async retrievePrice(priceId: string): Promise<SubscriptionsStripePriceResult> {
    return (await this.route(priceId)).retrievePrice(priceId);
  }

  async updateProduct(productId: string, name: string): Promise<void> {
    return (await this.route(productId)).updateProduct(productId, name);
  }

  async cancelSubscription(
    subscriptionId: string,
    atPeriodEnd: boolean,
  ): Promise<StripeSubscriptionView> {
    return (await this.route(subscriptionId)).cancelSubscription(subscriptionId, atPeriodEnd);
  }

  async endTrialNow(subscriptionId: string): Promise<EndTrialNowResult> {
    return (await this.route(subscriptionId)).endTrialNow(subscriptionId);
  }

  /**
   * Portal del cliente. Cliente de plataforma → la configuración del creador y
   * `on_behalf_of` de su cuenta (lleva su nombre, también con la cuenta
   * restringida: el alumno tiene que poder darse de baja). Cliente de las
   * claves propias → el portal de esa cuenta.
   */
  async createPortalSession(params: CreatePortalSessionParams): Promise<StripePortalSessionResult> {
    const adapter = await this.route(params.customerId);
    if (adapter !== this.opts.platform) return adapter.createPortalSession(params);
    const portal = await this.opts.portal.forTenant(this.opts.tenantId);
    return this.opts.platformFor(portal.onBehalfOf).createPortalSession({
      ...params,
      configurationId: portal.configurationId,
    });
  }

  constructWebhookEvent(rawBody: string | Buffer, signatureHeader: string): Stripe.Event {
    // Nadie lo usa en modo plataforma: los heredados construyen su propio
    // adaptador y el de plataforma verifica con los secretos del operador.
    return (this.opts.own ?? this.opts.platform).constructWebhookEvent(rawBody, signatureHeader);
  }

  /** Objeto registrado como de plataforma → plataforma; si no, claves propias si las hay. */
  private async route(stripeObjectId: string): Promise<SubscriptionsStripeAdapter> {
    if (!this.opts.own) return this.opts.platform;
    return (await this.opts.refs.isPlatformObject(stripeObjectId))
      ? this.opts.platform
      : this.opts.own;
  }

  private async register(
    stripeObjectId: string,
    kind: ObjectRefKind,
    source: ObjectRefSource,
    localRef: string | null,
    parentObjectId: string | null = null,
  ): Promise<void> {
    await this.opts.refs.register({
      tenantId: this.opts.tenantId,
      stripeObjectId,
      kind,
      source,
      localRef,
      parentObjectId,
      livemode: this.opts.livemode,
    });
  }
}
