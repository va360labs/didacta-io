/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { TenantConfigService } from '@didacta/core-kernel';

/**
 * Credenciales Stripe de un tenant (o del fallback global de instancia).
 * Un solo par, compartido por mod.billing y mod.subscriptions — igual que
 * hoy comparten `STRIPE_SECRET_KEY` a nivel de instancia. No pueden separarse
 * en dos pares independientes: `subscriptions-webhook.controller.ts` reenvía
 * eventos ya verificados a mod.billing (`dispatchToBilling`) sin volver a
 * comprobar firma — un secret distinto por módulo rompería ese fan-out.
 */
export const StripeCredentialsSchema = z.object({
  secretKey: z.string().min(1),
  webhookSecret: z.string().min(1),
  /** Si falta, mod.subscriptions cae a `webhookSecret` (mismo criterio que hoy con SUBSCRIPTIONS_WEBHOOK_SECRET). */
  subscriptionsWebhookSecret: z.string().min(1).optional(),
});

export type StripeCredentials = z.infer<typeof StripeCredentialsSchema>;

export type StripeCredentialsSource = 'tenant' | 'tenant_unverified' | 'global' | 'none';

export interface ResolvedStripeCredentials {
  credentials: StripeCredentials;
  source: StripeCredentialsSource;
  verified: boolean;
}

/**
 * Resolutor centralizado de credenciales Stripe por tenant.
 *
 * Mismo patrón que `TenantSmtpResolverService`:
 * 1. Si el tenant tiene credenciales propias en `tenant_setting`
 *    (scope=`billing`, key=`stripe`) → usar esas.
 * 2. Si no, si hay env globales (`STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`)
 *    → fallback de instancia (cubre despliegues que aún no migraron al panel).
 * 3. Si nada de lo anterior aplica → `null`.
 *
 * NO loguea credenciales nunca. Solo `source`/`verified` para poder
 * correlacionar fallos con el origen real sin filtrar secretos.
 */
@Injectable()
export class TenantStripeResolverService {
  private readonly logger = new Logger(TenantStripeResolverService.name);

  constructor(private readonly tenantConfig: TenantConfigService) {}

  async resolve(tenantId: string): Promise<ResolvedStripeCredentials | null> {
    const tenantResolved = await this.readTenantConfig(tenantId);
    if (tenantResolved) return tenantResolved;

    const globalCredentials = this.readGlobalConfig();
    if (globalCredentials) {
      return { credentials: globalCredentials, source: 'global', verified: false };
    }
    return null;
  }

  /** Variante solo-tenant, sin caer al fallback global — usada por el botón "Probar conexión" del panel. */
  async resolveTenantOnly(tenantId: string): Promise<ResolvedStripeCredentials | null> {
    return this.readTenantConfig(tenantId);
  }

  async hasTenantConfig(tenantId: string): Promise<boolean> {
    return (await this.readTenantConfig(tenantId)) !== null;
  }

  private async readTenantConfig(tenantId: string): Promise<ResolvedStripeCredentials | null> {
    let raw: unknown;
    try {
      raw = await this.tenantConfig.get(tenantId, 'billing', 'stripe');
    } catch (err) {
      this.logger.warn(
        `[stripe-resolver] no se pudo leer Stripe del tenant ${tenantId}: ${(err as Error).message.slice(0, 200)}. ` +
          'Cae al fallback global si está disponible.',
      );
      return null;
    }
    if (!raw) return null;

    const parsed = StripeCredentialsSchema.parse(raw);
    let meta: { verifiedAt?: string | null } | undefined;
    try {
      meta = (await this.tenantConfig.get(tenantId, 'billing', 'stripe_meta')) as
        | { verifiedAt?: string | null }
        | undefined;
    } catch {
      meta = undefined;
    }
    const verified = Boolean(meta?.verifiedAt);
    return {
      credentials: parsed,
      source: verified ? 'tenant' : 'tenant_unverified',
      verified,
    };
  }

  private readGlobalConfig(): StripeCredentials | null {
    const secretKey = process.env['STRIPE_SECRET_KEY']?.trim();
    const webhookSecret = process.env['STRIPE_WEBHOOK_SECRET']?.trim();
    if (!secretKey || !webhookSecret) return null;

    const subscriptionsWebhookSecret =
      process.env['SUBSCRIPTIONS_WEBHOOK_SECRET']?.trim() || undefined;
    const candidate = { secretKey, webhookSecret, subscriptionsWebhookSecret };
    const result = StripeCredentialsSchema.safeParse(candidate);
    return result.success ? result.data : null;
  }
}
