/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@didacta/database';
import {
  PayoutsAccountsService,
  PayoutsSettingsService,
  RefsService,
  createConnectedAccountsApi,
  type PayoutsDbPort,
  type PayoutsTx,
  type PlatformStripeClient,
} from '@didacta/mod-payouts';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsTenant, runGlobalWithoutTenant } from '../../tenancy/tenant-context.storage';
import { PaymentModeResolver } from '../payment-mode.resolver';
import { TenantStripeResolverService } from '../tenant-stripe-resolver.service';
import type { PlatformPaymentsEnabled } from './platform-payments.config';

/** Configuración del modo plataforma (solo existe con el modo encendido). */
export const PLATFORM_PAYMENTS_CONFIG = Symbol('PLATFORM_PAYMENTS_CONFIG');
/** Cliente de Stripe de la cuenta del operador. Los tests lo sustituyen por el doble. */
export const PLATFORM_STRIPE_CLIENT = Symbol('PLATFORM_STRIPE_CLIENT');

/**
 * Composición de `mod.payouts` en el host: une el dominio del módulo (que no
 * sabe de Nest, de RLS ni de dónde sale la clave) con la base, el contexto de
 * tenant y el resolutor de modo de cobro.
 *
 * Solo se instancia con el modo plataforma encendido: `PayoutsModule` no lo
 * registra si falta `PAYMENTS_PLATFORM_STRIPE_SECRET_KEY`.
 */
@Injectable()
export class PayoutsRuntime {
  readonly accounts: PayoutsAccountsService;
  readonly settings: PayoutsSettingsService;
  readonly mode: PaymentModeResolver;
  /** Registro objeto → tenant con el cliente global (resolver bajo acceso sancionado). */
  readonly refs: RefsService;

  constructor(
    @Inject(PLATFORM_PAYMENTS_CONFIG) readonly config: PlatformPaymentsEnabled,
    @Inject(PLATFORM_STRIPE_CLIENT) readonly stripe: PlatformStripeClient,
    readonly prisma: PrismaService,
    stripeResolver: TenantStripeResolverService,
    logger: PinoLogger,
  ) {
    const db: PayoutsDbPort = {
      // La extensión RLS del cliente inyecta el `set_config` del tenant como
      // primera sentencia del `$transaction` (y el `SET LOCAL ROLE` en el
      // acceso sancionado): toda la función corre escopada.
      inTenant: <T>(tenantId: string, fn: (tx: PayoutsTx) => Promise<T>) =>
        runAsTenant(tenantId, () => prisma.$transaction((tx) => fn(tx as unknown as PayoutsTx)), {
          traceLabel: 'payouts',
        }),
      global: <T>(fn: (tx: PayoutsTx) => Promise<T>) =>
        runGlobalWithoutTenant(() => prisma.$transaction((tx) => fn(tx as unknown as PayoutsTx))),
    };
    this.accounts = new PayoutsAccountsService(
      db,
      createConnectedAccountsApi(stripe, config.accountsApi),
      {
        supportedCountries: config.supportedCountries,
        lossesCollector: config.lossesCollector,
        livemode: config.livemode,
        payout: config.payout,
      },
      {
        logger: {
          warn: (obj, msg) => logger.warn(obj, msg),
          log: (obj, msg) => logger.log(obj, msg),
        },
      },
    );
    this.settings = new PayoutsSettingsService(db, config.defaultFeeBps);
    this.refs = new RefsService(prisma as unknown as PrismaClient);
    this.mode = new PaymentModeResolver(config, stripeResolver, () => prisma);
  }

  /** ¿De qué tenant es este `acct_`? `null` si no está registrado. Acceso sancionado. */
  async tenantOfAccount(stripeAccountId: string): Promise<string | null> {
    const resolution = await runGlobalWithoutTenant(() =>
      this.refs.resolveTenant([stripeAccountId]),
    );
    return resolution.status === 'resolved' ? resolution.tenantId : null;
  }
}
