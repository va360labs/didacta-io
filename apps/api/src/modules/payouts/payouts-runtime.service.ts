/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import type { PrismaClient } from '@didacta/database';
import {
  PayoutsAccountsService,
  PayoutsDebtsService,
  PayoutsDisputesService,
  PayoutsOffboardingService,
  PayoutsPortalService,
  PayoutsRefundsService,
  PayoutsReportsService,
  PayoutsSettingsService,
  RefsService,
  SettlementService,
  createConnectedAccountsApi,
  type PayoutsDbPort,
  type PayoutsLogger,
  type PayoutsNotifier,
  type PayoutsTx,
  type PlatformStripeClient,
  type RegisterObjectRefInput,
} from '@didacta/mod-payouts';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsTenant, runGlobalWithoutTenant } from '../../tenancy/tenant-context.storage';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { PaymentModeResolver } from '../payment-mode.resolver';
import { SmtpAdapterService } from '../smtp-adapter.service';
import { TenantSmtpResolverService } from '../tenant-smtp-resolver.service';
import { TenantStripeResolverService } from '../tenant-stripe-resolver.service';
import { PayoutsEmailNotifier } from './payouts-notifier';
import type { PlatformPaymentsEnabled } from './platform-payments.config';
import type { PlatformPortalPort, PlatformRefsPort } from './platform-stripe-adapters';

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
  /** Transacciones con el contexto de tenant (RLS) o globales sancionadas. */
  readonly db: PayoutsDbPort;

  constructor(
    @Inject(PLATFORM_PAYMENTS_CONFIG) readonly config: PlatformPaymentsEnabled,
    @Inject(PLATFORM_STRIPE_CLIENT) readonly stripe: PlatformStripeClient,
    readonly prisma: PrismaService,
    stripeResolver: TenantStripeResolverService,
    logger: PinoLogger,
    // Correo de los avisos de E6. Opcionales: los tests que montan el runtime
    // a mano no los traen y los avisos quedan solo en el log.
    @Optional() smtpResolver?: TenantSmtpResolverService,
    @Optional() smtp?: SmtpAdapterService,
    @Optional() tenantResolver?: TenantResolverService,
  ) {
    const db: PayoutsDbPort = (this.db = {
      // La extensión RLS del cliente inyecta el `set_config` del tenant como
      // primera sentencia del `$transaction` (y el `SET LOCAL ROLE` en el
      // acceso sancionado): toda la función corre escopada.
      inTenant: <T>(tenantId: string, fn: (tx: PayoutsTx) => Promise<T>) =>
        runAsTenant(tenantId, () => prisma.$transaction((tx) => fn(tx as unknown as PayoutsTx)), {
          traceLabel: 'payouts',
        }),
      global: <T>(fn: (tx: PayoutsTx) => Promise<T>) =>
        runGlobalWithoutTenant(() => prisma.$transaction((tx) => fn(tx as unknown as PayoutsTx))),
    });
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
    this.settlement = new SettlementService(db, stripe, this.settings, {
      logger: {
        warn: (obj, msg) => logger.warn(obj, msg),
        log: (obj, msg) => logger.log(obj, msg),
        error: (obj, msg) => logger.error(obj, msg),
      },
    });
    this.reports = new PayoutsReportsService(db);
    this.portal = new PayoutsPortalService(db, stripe);

    // E6: reembolsos, disputas, deudas y desconexión.
    const moneyLogger: PayoutsLogger = {
      warn: (obj, msg) => logger.warn(obj, msg),
      log: (obj, msg) => logger.log(obj, msg),
      error: (obj, msg) => logger.error(obj, msg),
    };
    this.notifier = new PayoutsEmailNotifier({
      prisma,
      logger,
      operatorName: config.displayName,
      operatorAlertEmail: config.operatorAlertEmail,
      smtpResolver,
      smtp,
      tenantResolver,
    });
    // Tras anotar un reembolso o una disputa de una venta aún sin transferir,
    // que la venta siga su camino (con su importe ya rebajado).
    const onSaleChanged = (tenantId: string, saleId: string) =>
      this.settlement.settleSale(tenantId, saleId, { force: true });
    const lossOptions = {
      policy: config.lossPolicy,
      notifier: this.notifier,
      logger: moneyLogger,
      onSaleChanged,
    };
    this.refunds = new PayoutsRefundsService(db, stripe, lossOptions);
    this.disputes = new PayoutsDisputesService(db, stripe, lossOptions);
    this.debts = new PayoutsDebtsService(db, stripe, {
      logger: moneyLogger,
      notifier: this.notifier,
      alertThresholdMinor: config.debtAlertMinor,
    });
    this.offboarding = new PayoutsOffboardingService(db, stripe, this.accounts, {
      logger: moneyLogger,
    });
    // Sin Redis no hay barrido cada minuto: la compra y `charge.updated` se
    // liquidan en línea desde el webhook.
    this.settleInline = !process.env['REDIS_URL'];
  }

  /** Liquidación de ventas (E4). */
  readonly settlement: SettlementService;
  /** «Tus ventas», resumen por divisa y volumen del pool. */
  readonly reports: PayoutsReportsService;
  /** `true` sin `REDIS_URL`: el webhook liquida en línea. */
  readonly settleInline: boolean;
  /** Portal de cliente del creador (E5). */
  readonly portal: PayoutsPortalService;

  /**
   * Portal del creador para el adaptador de suscripciones
   * (`platform-stripe-adapters.ts`): su configuración, con el nombre del aula
   * como titular, y su cuenta conectada.
   */
  platformPortal(): PlatformPortalPort {
    return {
      forTenant: async (tenantId: string) => {
        const tenant = await runAsTenant(tenantId, () =>
          this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
        );
        return this.portal.ensureConfiguration(tenantId, { headline: tenant?.name ?? '' });
      },
    };
  }
  /** Avisos de dinero al creador y al operador (E6). */
  readonly notifier: PayoutsNotifier;
  /** Reembolsos desde el panel y detectados en Stripe (E6). */
  readonly refunds: PayoutsRefundsService;
  /** Disputas (E6). */
  readonly disputes: PayoutsDisputesService;
  /** Deudas: recobro y avisos (E6). */
  readonly debts: PayoutsDebtsService;
  /** Desconexión de cobros y baja del aula (E6). */
  readonly offboarding: PayoutsOffboardingService;

  /**
   * Registro de objetos para los adaptadores de Stripe de los módulos
   * (`platform-stripe-adapters.ts`): escribir a nombre del tenant con su RLS y
   * consultar si un id es de plataforma bajo acceso sancionado.
   */
  platformRefs(): PlatformRefsPort {
    return {
      register: async (input: RegisterObjectRefInput) => {
        await this.db.inTenant(input.tenantId, (tx) =>
          new RefsService(tx as unknown as PrismaClient).register(input),
        );
      },
      isPlatformObject: (stripeObjectId: string) =>
        runGlobalWithoutTenant(() => this.refs.isPlatformObject([stripeObjectId])),
    };
  }

  /** ¿De qué tenant es este `acct_`? `null` si no está registrado. Acceso sancionado. */
  async tenantOfAccount(stripeAccountId: string): Promise<string | null> {
    const resolution = await runGlobalWithoutTenant(() =>
      this.refs.resolveTenant([stripeAccountId]),
    );
    return resolution.status === 'resolved' ? resolution.tenantId : null;
  }
}
