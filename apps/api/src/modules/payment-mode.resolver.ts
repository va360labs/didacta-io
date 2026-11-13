/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PayoutsAccountStatus, PrismaClient } from '@didacta/database';
import type { PlatformPaymentsConfig } from './payouts/platform-payments.config';
import type {
  ResolvedStripeCredentials,
  TenantStripeResolverService,
} from './tenant-stripe-resolver.service';

/**
 * ¿CÓMO cobra este tenant? La única bifurcación entre los dos modos de cobro.
 *
 *  - `own`      — con SUS claves de Stripe (o las de instancia, si el candado
 *                 del fallback global lo permite). Es lo de siempre: el dinero
 *                 entra en su cuenta y Didacta no lo toca.
 *  - `platform` — en la cuenta de Stripe del OPERADOR, con `on_behalf_of` de
 *                 la cuenta conectada del creador, y se le transfiere su parte.
 *                 `ready: false` significa que aún no puede vender, y por qué.
 *  - `none`     — no puede cobrar de ninguna forma.
 *
 * Reglas:
 *
 *  1. Sin `PAYMENTS_PLATFORM_STRIPE_SECRET_KEY` (modo plataforma apagado) se
 *     delega en `TenantStripeResolverService.resolve` TAL CUAL: lo que él
 *     devuelva es `own`, y `null` es `none`. Una instalación Community no
 *     cambia ni una rama, y este fichero no lee una sola tabla.
 *  2. Con el modo encendido:
 *       a. tenant cuya cuenta conectada ha llegado a operar → `platform`, con
 *          el estado de la cuenta;
 *       b. tenant con claves propias heredadas que nunca ha operado en modo
 *          plataforma → `own` (convivencia: no se le corta la venta por
 *          empezar el alta);
 *       c. el resto → `platform` sin lista: `not_connected` o, si ya empezó
 *          el alta, el estado de su cuenta.
 *  3. Con el modo encendido NO hay fallback global: en un pool, heredar las
 *     `STRIPE_*` de instancia metería el dinero de un aula en la cuenta del
 *     operador sin pasar por el reparto. Por eso aquí se pregunta solo por las
 *     claves del propio tenant (`resolveTenantOnly`).
 *
 * Es composición entre módulos (como `course-sale-checker.ts`): lee tablas de
 * `mod.payouts` y el resolutor de claves, y ni `mod.billing` ni
 * `mod.subscriptions` saben que existe. Todavía no lo consume nadie: lo harán
 * `resolveStripeAdapter` / `resolveSubscriptionsStripeAdapter` (E3) y el
 * endpoint de estado (E2).
 */

/** Por qué un tenant en modo plataforma todavía no puede vender. */
export type PaymentModeNotReadyReason =
  /** No ha empezado a conectar sus cobros. */
  | 'not_connected'
  /** Cuenta creada; faltan datos o Stripe aún la está revisando. */
  | 'onboarding_incomplete'
  /** Stripe la ha restringido o rechazado. */
  | 'restricted'
  /** El creador (o la baja del aula) desconectó los cobros. */
  | 'disconnected';

export type PaymentMode =
  | {
      mode: 'platform';
      ready: true;
      /** `acct_…` de la cuenta conectada del creador. */
      stripeAccountId: string;
      /** País de la cuenta (ISO 3166-1 alfa-2). */
      country: string;
      /** Comisión del operador vigente para este tenant, en puntos básicos. */
      feeBps: number;
    }
  | { mode: 'platform'; ready: false; reason: PaymentModeNotReadyReason }
  | { mode: 'own'; credentials: ResolvedStripeCredentials }
  | { mode: 'none' };

/**
 * Lo que el resolver lee de la base: dos tablas de `mod.payouts`, solo lectura
 * y siempre filtrando por `tenantId`. Tipado contra el cliente Prisma real para
 * que un campo mal escrito no compile.
 */
export type PaymentModeDb = Pick<PrismaClient, 'modPayoutsAccount' | 'modPayoutsSettings'>;

/** La parte del resolutor de claves que usa este fichero. */
export type OwnStripeCredentialsResolver = Pick<
  TenantStripeResolverService,
  'resolve' | 'resolveTenantOnly'
>;

const REASON_BY_STATUS: Record<
  Exclude<PayoutsAccountStatus, 'READY'>,
  PaymentModeNotReadyReason
> = {
  NOT_CONNECTED: 'not_connected',
  ONBOARDING: 'onboarding_incomplete',
  PENDING_REVIEW: 'onboarding_incomplete',
  RESTRICTED: 'restricted',
  REJECTED: 'restricted',
  DISCONNECTED: 'disconnected',
};

export class PaymentModeResolver {
  constructor(
    private readonly config: PlatformPaymentsConfig,
    private readonly ownCredentials: OwnStripeCredentialsResolver,
    private readonly getDb: () => PaymentModeDb,
  ) {}

  /** ¿Está encendido el modo plataforma en esta instalación? */
  get platformEnabled(): boolean {
    return this.config.enabled;
  }

  async resolve(tenantId: string): Promise<PaymentMode> {
    if (!this.config.enabled) {
      const credentials = await this.ownCredentials.resolve(tenantId);
      return credentials ? { mode: 'own', credentials } : { mode: 'none' };
    }

    const db = this.getDb();
    // La cuenta vigente del tenant: la más reciente que no se haya cerrado.
    const account = await db.modPayoutsAccount.findFirst({
      where: { tenantId, closedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { stripeAccountId: true, country: true, status: true, readyAt: true },
    });

    const connected = account !== null && account.stripeAccountId !== null;
    // ¿Ha llegado a operar en modo plataforma alguna vez? `readyAt` se sella
    // la primera vez que la cuenta llega a READY y ya no se borra; se mira
    // también el estado por si una fila llegó a READY sin sellarlo.
    const everOperated = connected && (account.readyAt !== null || account.status === 'READY');

    if (!everOperated) {
      // Claves PROPIAS del tenant, sin fallback global (regla 3).
      const credentials = await this.ownCredentials.resolveTenantOnly(tenantId);
      if (credentials) return { mode: 'own', credentials };
    }

    if (!connected || account.stripeAccountId === null) {
      return { mode: 'platform', ready: false, reason: 'not_connected' };
    }
    if (account.status !== 'READY') {
      return { mode: 'platform', ready: false, reason: REASON_BY_STATUS[account.status] };
    }

    const settings = await db.modPayoutsSettings.findUnique({
      where: { tenantId },
      select: { feeBps: true },
    });
    return {
      mode: 'platform',
      ready: true,
      stripeAccountId: account.stripeAccountId,
      country: account.country,
      feeBps: settings?.feeBps ?? this.config.defaultFeeBps,
    };
  }
}
