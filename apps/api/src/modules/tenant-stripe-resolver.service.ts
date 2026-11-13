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
export type GlobalFallbackFlagReader = () => Promise<boolean | GlobalFallbackDecision>;

/**
 * La decisión y POR QUÉ. El porqué es lo que permite avisar del único caso que
 * nadie ha decidido: que el valor por defecto se apague solo al crear la
 * segunda aula.
 */
export interface GlobalFallbackDecision {
  allowed: boolean;
  reason:
    | 'instance-setting' // lo dice `billing.allowGlobalStripeFallback`
    | 'env' // lo dice STRIPE_ALLOW_GLOBAL_FALLBACK
    | 'single-tenant' // por defecto: una sola aula
    | 'multiple-tenants' // por defecto: varias aulas
    | 'platform-payments' // modo plataforma encendido: nunca se hereda
    | 'unknown'; // lector antiguo que solo devuelve un booleano
  /** Aulas no archivadas, cuando la decisión salió del recuento. */
  tenants?: number;
}

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
 * La clave que enciende el modo plataforma (ver
 * `payouts/platform-payments.config.ts`). Repetida aquí y no importada: este
 * fichero no puede depender de la configuración de cobros de plataforma.
 */
const PLATFORM_PAYMENTS_SECRET_KEY_ENV = 'PAYMENTS_PLATFORM_STRIPE_SECRET_KEY';

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
 *
 * Por encima de todo: con el modo plataforma encendido
 * (`PAYMENTS_PLATFORM_STRIPE_SECRET_KEY`) NUNCA se hereda. En un pool, heredar
 * las `STRIPE_*` de instancia metería el dinero de un aula en una cuenta sin
 * pasar por el reparto; las aulas cobran con sus claves o por la plataforma.
 */
export function buildGlobalFallbackFlagReader(
  store: GlobalFallbackPolicyStore,
  env: NodeJS.ProcessEnv = process.env,
): GlobalFallbackFlagReader {
  return async (): Promise<GlobalFallbackDecision> => {
    if (env[PLATFORM_PAYMENTS_SECRET_KEY_ENV]?.trim()) {
      return { allowed: false, reason: 'platform-payments' };
    }
    const row = await store.instanceSetting.findUnique({
      where: { scope_key: { scope: 'billing', key: 'allowGlobalStripeFallback' } },
    });
    if (row?.valueJson === true || row?.valueJson === false) {
      return { allowed: row.valueJson, reason: 'instance-setting' };
    }

    const fromEnv = env[STRIPE_ALLOW_GLOBAL_FALLBACK_ENV]?.trim().toLowerCase();
    if (fromEnv === 'true' || fromEnv === '1') return { allowed: true, reason: 'env' };
    if (fromEnv === 'false' || fromEnv === '0') return { allowed: false, reason: 'env' };

    const tenants = await store.tenant.count({
      where: { status: { not: 'ARCHIVED' }, deletedAt: null },
    });
    return tenants <= 1
      ? { allowed: true, reason: 'single-tenant', tenants }
      : { allowed: false, reason: 'multiple-tenants', tenants };
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

  private flagCache?: { value: GlobalFallbackDecision; expiresAt: number };

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
    return (await this.globalFallbackDecision()).allowed;
  }

  private async globalFallbackDecision(): Promise<GlobalFallbackDecision> {
    if (!this.readGlobalFallbackFlag) return { allowed: true, reason: 'unknown' };

    const now = Date.now();
    if (this.flagCache && this.flagCache.expiresAt > now) return this.flagCache.value;

    try {
      const read = await this.readGlobalFallbackFlag();
      const value: GlobalFallbackDecision =
        typeof read === 'boolean' ? { allowed: read, reason: 'unknown' } : read;
      const previous = this.flagCache?.value;
      this.flagCache = { value, expiresAt: now + FLAG_CACHE_MS };
      if (previous && previous.allowed !== value.allowed) this.reportChange(previous, value);
      return value;
    } catch (err) {
      const stale = this.flagCache?.value;
      this.logger.warn(
        `[stripe-resolver] no se pudo leer la política del fallback global de Stripe: ` +
          `${(err as Error).message.slice(0, 200)}. ` +
          (stale === undefined
            ? 'Sin valor previo: NO se hereda la cuenta de instancia.'
            : `Se mantiene el último valor conocido (${stale.allowed ? 'permitido' : 'no permitido'}).`),
      );
      return stale ?? { allowed: false, reason: 'unknown' };
    }
  }

  /**
   * Estado del fallback de instancia para quien tenga que contarlo (el panel de
   * pagos, el arranque): si hay cuenta de instancia y si las aulas sin Stripe
   * propio la heredan.
   */
  async describeGlobalFallback(): Promise<
    GlobalFallbackDecision & { instanceCredentials: boolean }
  > {
    return {
      ...(await this.globalFallbackDecision()),
      instanceCredentials: this.readGlobalConfig() !== null,
    };
  }

  /**
   * Deja en el log, bien visible, el estado del fallback cuando hay algo que
   * decir. Se llama al arrancar y justo después de crear un aula.
   *
   * Lo que se quiere evitar es el corte SILENCIOSO: una instalación de una
   * sola aula que cobra con las `STRIPE_*` de instancia y a la que le crean una
   * segunda. El valor por defecto se apaga —es lo seguro: nadie ha dicho que
   * las dos aulas sean del mismo dueño— y la PRIMERA deja de cobrar. Eso no
   * puede enterarse nadie por un cliente que no pudo pagar.
   */
  async reportGlobalFallback(when: 'startup' | 'tenant-created'): Promise<void> {
    if (when === 'tenant-created') this.invalidateGlobalFallbackFlag();
    let state: Awaited<ReturnType<TenantStripeResolverService['describeGlobalFallback']>>;
    try {
      state = await this.describeGlobalFallback();
    } catch {
      return;
    }
    // Sin cuenta de instancia no hay nada que heredar ni que cortar.
    if (!state.instanceCredentials) return;

    if (state.reason === 'platform-payments') {
      if (when === 'startup') {
        this.logger.warn(
          `[stripe-resolver] Modo plataforma encendido: la cuenta de Stripe de instancia (STRIPE_SECRET_KEY) ` +
            `no se usa para cobrar a ningún aula. Cada aula cobra con sus claves o a través de la plataforma.`,
        );
      }
      return;
    }

    if (!state.allowed && state.reason === 'multiple-tenants') {
      this.logger.error(
        `[stripe-resolver] COBROS: esta instancia tiene ${state.tenants ?? 'varias'} aulas y una cuenta de Stripe de instancia ` +
          `(STRIPE_SECRET_KEY). Con más de un aula la cuenta de instancia YA NO se hereda por defecto: las aulas que no ` +
          `tengan Stripe propio en Administración → Pagos NO PUEDEN COBRAR (el checkout responde 503 y su webhook 401). ` +
          `Si todas las aulas son del mismo dueño y deben cobrar con esa cuenta, define ${STRIPE_ALLOW_GLOBAL_FALLBACK_ENV}=true ` +
          `y reinicia. Si no, cada aula tiene que configurar la suya.`,
      );
      return;
    }
    if (state.allowed && state.reason === 'single-tenant' && when === 'startup') {
      this.logger.warn(
        `[stripe-resolver] El aula cobra con la cuenta de Stripe de instancia (STRIPE_SECRET_KEY) porque es la única. ` +
          `Si se crea una segunda aula dejará de heredarse por defecto y ESTA dejará de cobrar: antes de crearla, ` +
          `guarda las credenciales en Administración → Pagos o define ${STRIPE_ALLOW_GLOBAL_FALLBACK_ENV}=true.`,
      );
    }
  }

  /** El valor efectivo ha cambiado mientras la aplicación estaba en marcha. */
  private reportChange(previous: GlobalFallbackDecision, current: GlobalFallbackDecision): void {
    if (this.readGlobalConfig() === null) return;
    const why =
      current.reason === 'multiple-tenants'
        ? `ahora hay ${current.tenants ?? 'varias'} aulas`
        : current.reason === 'single-tenant'
          ? 'vuelve a haber una sola aula'
          : `lo dice ${current.reason === 'env' ? STRIPE_ALLOW_GLOBAL_FALLBACK_ENV : 'el ajuste de instancia billing.allowGlobalStripeFallback'}`;
    if (!current.allowed) {
      this.logger.error(
        `[stripe-resolver] COBROS: la cuenta de Stripe de instancia HA DEJADO de heredarse (${why}; antes: ${previous.reason}). ` +
          `Las aulas sin Stripe propio ya NO PUEDEN COBRAR. Si deben seguir cobrando con la cuenta de instancia, ` +
          `define ${STRIPE_ALLOW_GLOBAL_FALLBACK_ENV}=true y reinicia.`,
      );
    } else {
      this.logger.warn(
        `[stripe-resolver] La cuenta de Stripe de instancia vuelve a heredarse (${why}): las aulas sin Stripe propio cobran con ella.`,
      );
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
