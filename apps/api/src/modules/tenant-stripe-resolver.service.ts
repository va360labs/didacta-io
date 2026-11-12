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
 * ¿Puede un tenant sin credenciales propias heredar las `STRIPE_*` de la
 * instancia? Se inyecta como función y no como servicio para no arrastrar el
 * grafo de DI hasta aquí: este resolutor se construye A MANO en
 * `ModuleRegistryService` y con una factory en `AuthModule`. Las dos lo montan
 * con `buildGlobalFallbackFlagReader`, que es donde vive la política.
 */
export type GlobalFallbackFlagReader = () => Promise<boolean>;

/** Subconjunto de Prisma que necesita la política del fallback global. */
export interface GlobalFallbackPolicyStore {
  instanceSetting: {
    findUnique(args: {
      where: { scope_key: { scope: string; key: string } };
    }): Promise<{ valueJson: unknown } | null>;
  };
  tenant: {
    count(args: { where: { status: { not: 'ARCHIVED' }; deletedAt: null } }): Promise<number>;
  };
}

/** Variable de entorno que fija la política sin tocar la base. */
export const STRIPE_ALLOW_GLOBAL_FALLBACK_ENV = 'STRIPE_ALLOW_GLOBAL_FALLBACK';

/**
 * Política del fallback global de Stripe. Por orden:
 *
 *  1. `core_instance_setting` `billing.allowGlobalStripeFallback` a `true` o
 *     `false` → lo que diga. Es la decisión explícita del operador.
 *  2. Env `STRIPE_ALLOW_GLOBAL_FALLBACK` a `true`/`false` → lo que diga. Misma
 *     decisión, para quien despliega por variables y no quiere tocar la base.
 *  3. Nadie ha dicho nada → se permite SOLO si la instancia tiene una única
 *     aula (no archivada).
 *
 * El punto 3 es el cambio. Antes el valor por defecto era «permitido» siempre:
 * correcto para la instalación de una sola academia (edición Community: el
 * dueño de la instancia y el del aula son la misma persona, y cobrar por env es
 * justo lo que quiere), pero en un servidor con VARIAS aulas significaba que el
 * aula que no hubiera configurado su Stripe cobraba a sus alumnos con la cuenta
 * del OPERADOR, en silencio y sin error. Con más de un aula, heredar la cuenta
 * del operador tiene que ser una decisión, no un descuido.
 *
 * Quien tenga varias aulas PROPIAS cobrando a propósito con las `STRIPE_*` de
 * instancia lo declara con `STRIPE_ALLOW_GLOBAL_FALLBACK=true` (o el setting) y
 * sigue exactamente como estaba.
 */
export function buildGlobalFallbackFlagReader(
  store: GlobalFallbackPolicyStore,
  env: NodeJS.ProcessEnv = process.env,
): GlobalFallbackFlagReader {
  return async () => {
    const row = await store.instanceSetting.findUnique({
      where: { scope_key: { scope: 'billing', key: 'allowGlobalStripeFallback' } },
    });
    if (row?.valueJson === true || row?.valueJson === false) return row.valueJson;

    const fromEnv = env[STRIPE_ALLOW_GLOBAL_FALLBACK_ENV]?.trim().toLowerCase();
    if (fromEnv === 'true' || fromEnv === '1') return true;
    if (fromEnv === 'false' || fromEnv === '0') return false;

    const aulas = await store.tenant.count({
      where: { status: { not: 'ARCHIVED' }, deletedAt: null },
    });
    return aulas <= 1;
  };
}

/** Cuánto se cachea el candado. `resolve()` corre en cada checkout y en cada webhook. */
const FLAG_CACHE_MS = 60_000;

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
 * ⚠️ El escalón 2 es un camino HEREDADO. En un despliegue multi-tenant de verdad
 * —un pool donde conviven academias de distintos dueños— heredar la clave de
 * `STRIPE_SECRET_KEY` significa que el dinero de los alumnos de un tenant sin
 * configurar entra en la cuenta de Stripe del OPERADOR, en silencio y sin error.
 * Por eso el escalón 2 tiene candado (`buildGlobalFallbackFlagReader`): sin
 * decisión explícita del operador solo está abierto en la instancia de UNA
 * aula; con varias, el tenant sin credenciales propias resuelve a `null` → el
 * checkout falla con un error claro en vez de cobrar en la cuenta de otro.
 *
 * NO loguea credenciales nunca. Solo `source`/`verified` para poder
 * correlacionar fallos con el origen real sin filtrar secretos.
 */
@Injectable()
export class TenantStripeResolverService {
  private readonly logger = new Logger(TenantStripeResolverService.name);

  private flagCache?: { value: boolean; expiresAt: number };

  constructor(
    private readonly tenantConfig: TenantConfigService,
    private readonly readGlobalFallbackFlag?: GlobalFallbackFlagReader,
  ) {}

  async resolve(tenantId: string): Promise<ResolvedStripeCredentials | null> {
    const tenantResolved = await this.readTenantConfig(tenantId);
    if (tenantResolved) return tenantResolved;

    if (!(await this.globalFallbackAllowed())) return null;

    const globalCredentials = this.readGlobalConfig();
    if (globalCredentials) {
      return { credentials: globalCredentials, source: 'global', verified: false };
    }
    return null;
  }

  /** Invalida el cache del candado. Lo llama el panel al guardar el setting. */
  invalidateGlobalFallbackFlag(): void {
    this.flagCache = undefined;
  }

  /**
   * ¿Se permite heredar las credenciales de instancia?
   *
   * Sin lector (el resolutor construido a pelo, como en los tests) se permite:
   * es el comportamiento de siempre. Las dos construcciones de producción le
   * pasan la política de `buildGlobalFallbackFlagReader`.
   *
   * Si la lectura falla se usa el último valor conocido y, si no hay ninguno,
   * NO se permite. Antes se asumía «permitido» para que un fallo de BD no
   * cortara los cobros; pero ese mismo fallo, en un servidor con varias aulas,
   * mandaba el dinero de un aula a la cuenta del operador, que no se deshace.
   * Un checkout que falla un momento se reintenta; un cobro en la cuenta
   * equivocada, no. El fallo no se cachea: la siguiente llamada vuelve a leer.
   */
  private async globalFallbackAllowed(): Promise<boolean> {
    if (!this.readGlobalFallbackFlag) return true;

    const now = Date.now();
    if (this.flagCache && this.flagCache.expiresAt > now) return this.flagCache.value;

    try {
      const value = await this.readGlobalFallbackFlag();
      this.flagCache = { value, expiresAt: now + FLAG_CACHE_MS };
      return value;
    } catch (err) {
      const stale = this.flagCache?.value;
      this.logger.warn(
        `[stripe-resolver] no se pudo leer la política del fallback global de Stripe: ` +
          `${(err as Error).message.slice(0, 200)}. ` +
          (stale === undefined
            ? 'Sin valor previo: NO se hereda la cuenta de instancia.'
            : `Se mantiene el último valor conocido (${stale ? 'permitido' : 'no permitido'}).`),
      );
      return stale ?? false;
    }
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
