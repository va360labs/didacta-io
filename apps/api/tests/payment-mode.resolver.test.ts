/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import {
  PaymentModeResolver,
  type OwnStripeCredentialsResolver,
  type PaymentModeDb,
} from '../src/modules/payment-mode.resolver';
import {
  loadPlatformPaymentsConfig,
  type PlatformPaymentsConfig,
} from '../src/modules/payouts/platform-payments.config';
import type { ResolvedStripeCredentials } from '../src/modules/tenant-stripe-resolver.service';

/**
 * ¿Cómo cobra un tenant? El resolver decide entre claves propias (`own`),
 * cuenta de la plataforma (`platform`) o nada (`none`).
 *
 * Lo que más importa de este fichero es la primera mitad: con el modo
 * plataforma APAGADO (toda Community) el resolver devuelve exactamente lo que
 * diga `TenantStripeResolverService.resolve` y NO toca la base. La segunda
 * mitad fija las reglas del modo encendido.
 *
 * Los dobles tienen la forma exacta de las consultas; que esas consultas valen
 * contra el esquema real lo prueba
 * `tests/integration/payouts-foundations.integration.test.ts`.
 */

const T = '11111111-1111-4111-8111-111111111111';

const PROPIAS: ResolvedStripeCredentials = {
  credentials: { secretKey: 'sk_test_delCreador0000', webhookSecret: 'whsec_test_delCreador' },
  source: 'tenant',
  verified: true,
};
const DE_INSTANCIA: ResolvedStripeCredentials = {
  credentials: { secretKey: 'sk_test_deInstancia0000', webhookSecret: 'whsec_test_deInstancia' },
  source: 'global',
  verified: false,
};

const APAGADO: PlatformPaymentsConfig = loadPlatformPaymentsConfig({});
const ENCENDIDO: PlatformPaymentsConfig = loadPlatformPaymentsConfig({
  PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: 'sk_test_deLaPlataforma0000',
  PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS: 'whsec_test_plataforma_0001',
});

interface Llamadas {
  resolve: string[];
  resolveTenantOnly: string[];
  cuenta: unknown[];
  ajustes: unknown[];
}

interface Cuenta {
  stripeAccountId: string | null;
  country: string;
  status: string;
  readyAt: Date | null;
}

function montar(opts: {
  config: PlatformPaymentsConfig;
  /** Lo que devuelve `resolve` (claves propias o, si se permite, de instancia). */
  conFallback?: ResolvedStripeCredentials | null;
  /** Lo que devuelve `resolveTenantOnly` (solo las del propio tenant). */
  soloTenant?: ResolvedStripeCredentials | null;
  cuenta?: Cuenta | null;
  feeBps?: number | null;
}): { resolver: PaymentModeResolver; llamadas: Llamadas } {
  const llamadas: Llamadas = { resolve: [], resolveTenantOnly: [], cuenta: [], ajustes: [] };
  const propias: OwnStripeCredentialsResolver = {
    resolve: async (tenantId) => {
      llamadas.resolve.push(tenantId);
      return opts.conFallback ?? null;
    },
    resolveTenantOnly: async (tenantId) => {
      llamadas.resolveTenantOnly.push(tenantId);
      return opts.soloTenant ?? null;
    },
  };
  const db = {
    modPayoutsAccount: {
      findFirst: async (args: unknown) => {
        llamadas.cuenta.push(args);
        return opts.cuenta ?? null;
      },
    },
    modPayoutsSettings: {
      findUnique: async (args: unknown) => {
        llamadas.ajustes.push(args);
        return opts.feeBps === null || opts.feeBps === undefined ? null : { feeBps: opts.feeBps };
      },
    },
  } as unknown as PaymentModeDb;
  return { resolver: new PaymentModeResolver(opts.config, propias, () => db), llamadas };
}

const LISTA: Cuenta = {
  stripeAccountId: 'acct_1Creador',
  country: 'ES',
  status: 'READY',
  readyAt: new Date('2026-11-12T10:00:00Z'),
};

describe('modo plataforma APAGADO — delega en TenantStripeResolverService', () => {
  it.each([
    ['claves propias del tenant', PROPIAS],
    ['claves de instancia (fallback global permitido)', DE_INSTANCIA],
  ])('%s → own, con el MISMO objeto que devuelve el resolutor', async (_nombre, credenciales) => {
    const { resolver, llamadas } = montar({ config: APAGADO, conFallback: credenciales });

    const modo = await resolver.resolve(T);

    expect(modo).toEqual({ mode: 'own', credentials: credenciales });
    if (modo.mode === 'own') expect(modo.credentials).toBe(credenciales);
    expect(llamadas.resolve).toEqual([T]);
  });

  it('sin credenciales → none', async () => {
    const { resolver } = montar({ config: APAGADO, conFallback: null });
    expect(await resolver.resolve(T)).toEqual({ mode: 'none' });
  });

  it('no lee ninguna tabla de mod.payouts ni pregunta solo-tenant', async () => {
    // Aunque existiera una cuenta conectada lista (una instalación que apagó el
    // modo), con el modo apagado no se mira.
    const { resolver, llamadas } = montar({
      config: APAGADO,
      conFallback: PROPIAS,
      cuenta: LISTA,
      feeBps: 300,
    });

    expect(await resolver.resolve(T)).toEqual({ mode: 'own', credentials: PROPIAS });
    expect(llamadas.cuenta).toEqual([]);
    expect(llamadas.ajustes).toEqual([]);
    expect(llamadas.resolveTenantOnly).toEqual([]);
    expect(resolver.platformEnabled).toBe(false);
  });

  it('ni siquiera construye el acceso a la base', async () => {
    const resolver = new PaymentModeResolver(
      APAGADO,
      { resolve: async () => null, resolveTenantOnly: async () => null },
      () => {
        throw new Error('con el modo apagado no se debe pedir la base');
      },
    );
    await expect(resolver.resolve(T)).resolves.toEqual({ mode: 'none' });
  });
});

describe('modo plataforma ENCENDIDO', () => {
  it('cuenta conectada y lista → platform ready, con la comisión por defecto', async () => {
    const { resolver, llamadas } = montar({ config: ENCENDIDO, cuenta: LISTA });

    expect(await resolver.resolve(T)).toEqual({
      mode: 'platform',
      ready: true,
      stripeAccountId: 'acct_1Creador',
      country: 'ES',
      feeBps: 500,
    });
    expect(resolver.platformEnabled).toBe(true);
    // La consulta va acotada al tenant y deja fuera las cuentas cerradas.
    expect(llamadas.cuenta).toEqual([
      {
        where: { tenantId: T, closedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { stripeAccountId: true, country: true, status: true, readyAt: true },
      },
    ]);
    expect(llamadas.ajustes).toEqual([{ where: { tenantId: T }, select: { feeBps: true } }]);
  });

  it.each([
    [300, 300],
    [0, 0],
    [3000, 3000],
  ])('la comisión del tenant (%s) manda sobre la de por defecto', async (propia, esperada) => {
    const { resolver } = montar({ config: ENCENDIDO, cuenta: LISTA, feeBps: propia });
    expect(await resolver.resolve(T)).toMatchObject({ ready: true, feeBps: esperada });
  });

  it('la comisión por defecto sale de la configuración', async () => {
    const config = loadPlatformPaymentsConfig({
      PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: 'sk_test_deLaPlataforma0000',
      PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS: 'whsec_test_plataforma_0001',
      PAYMENTS_PLATFORM_DEFAULT_FEE_BPS: '750',
    });
    const { resolver } = montar({ config, cuenta: LISTA });
    expect(await resolver.resolve(T)).toMatchObject({ ready: true, feeBps: 750 });
  });

  it('sin cuenta y sin claves propias → platform not_connected', async () => {
    const { resolver, llamadas } = montar({ config: ENCENDIDO, cuenta: null });

    expect(await resolver.resolve(T)).toEqual({
      mode: 'platform',
      ready: false,
      reason: 'not_connected',
    });
    expect(llamadas.resolveTenantOnly).toEqual([T]);
  });

  it('NO hay fallback global: las claves de instancia no convierten al tenant en own', async () => {
    // `resolve` (con fallback) devolvería las de instancia; con el modo
    // encendido no se le pregunta, solo a `resolveTenantOnly`.
    const { resolver, llamadas } = montar({
      config: ENCENDIDO,
      conFallback: DE_INSTANCIA,
      soloTenant: null,
      cuenta: null,
    });

    expect(await resolver.resolve(T)).toEqual({
      mode: 'platform',
      ready: false,
      reason: 'not_connected',
    });
    expect(llamadas.resolve).toEqual([]);
  });

  it('claves propias heredadas y sin cuenta conectada → own', async () => {
    const { resolver, llamadas } = montar({ config: ENCENDIDO, soloTenant: PROPIAS, cuenta: null });

    expect(await resolver.resolve(T)).toEqual({ mode: 'own', credentials: PROPIAS });
    expect(llamadas.ajustes).toEqual([]);
  });

  it.each([
    [
      'fila sin cuenta en Stripe',
      { ...LISTA, stripeAccountId: null, status: 'NOT_CONNECTED', readyAt: null },
    ],
    ['alta empezada', { ...LISTA, status: 'ONBOARDING', readyAt: null }],
    ['en revisión por primera vez', { ...LISTA, status: 'PENDING_REVIEW', readyAt: null }],
    ['alta abandonada y desconectada', { ...LISTA, status: 'DISCONNECTED', readyAt: null }],
  ])('claves propias + %s (nunca operó en plataforma) → sigue en own', async (_nombre, cuenta) => {
    const { resolver } = montar({ config: ENCENDIDO, soloTenant: PROPIAS, cuenta });
    expect(await resolver.resolve(T)).toEqual({ mode: 'own', credentials: PROPIAS });
  });

  it('una vez que la cuenta ha operado, las claves propias ya no cuentan', async () => {
    const { resolver, llamadas } = montar({
      config: ENCENDIDO,
      soloTenant: PROPIAS,
      cuenta: LISTA,
    });

    expect(await resolver.resolve(T)).toMatchObject({ mode: 'platform', ready: true });
    expect(llamadas.resolveTenantOnly).toEqual([]);
  });

  it('cuenta READY sin sello readyAt: cuenta como que ha operado', async () => {
    const { resolver } = montar({
      config: ENCENDIDO,
      soloTenant: PROPIAS,
      cuenta: { ...LISTA, readyAt: null },
    });
    expect(await resolver.resolve(T)).toMatchObject({ mode: 'platform', ready: true });
  });

  it.each([
    ['NOT_CONNECTED', 'not_connected'],
    ['ONBOARDING', 'onboarding_incomplete'],
    ['PENDING_REVIEW', 'onboarding_incomplete'],
    ['RESTRICTED', 'restricted'],
    ['REJECTED', 'restricted'],
    ['DISCONNECTED', 'disconnected'],
  ])('sin claves propias, cuenta en %s → platform no lista (%s)', async (status, reason) => {
    const { resolver, llamadas } = montar({
      config: ENCENDIDO,
      cuenta: { ...LISTA, status, readyAt: null },
    });

    expect(await resolver.resolve(T)).toEqual({ mode: 'platform', ready: false, reason });
    // Sin cuenta lista no hay comisión que leer.
    expect(llamadas.ajustes).toEqual([]);
  });

  it.each([
    ['RESTRICTED', 'restricted'],
    ['DISCONNECTED', 'disconnected'],
    ['PENDING_REVIEW', 'onboarding_incomplete'],
  ])(
    'cuenta que YA operó y ahora está %s: se corta la venta aunque queden claves propias',
    async (status, reason) => {
      const { resolver } = montar({
        config: ENCENDIDO,
        soloTenant: PROPIAS,
        cuenta: { ...LISTA, status },
      });
      expect(await resolver.resolve(T)).toEqual({ mode: 'platform', ready: false, reason });
    },
  );

  it('fila con estado READY pero sin acct_ no se da por lista', async () => {
    const { resolver } = montar({
      config: ENCENDIDO,
      cuenta: { ...LISTA, stripeAccountId: null },
    });
    expect(await resolver.resolve(T)).toEqual({
      mode: 'platform',
      ready: false,
      reason: 'not_connected',
    });
  });
});
