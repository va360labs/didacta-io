/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Webhook de plataforma y rutas del creador sin base de datos (corre en
 * `pnpm test`). El comportamiento contra Postgres real —RLS, cerrojo del
 * alta, registro de objetos— está en
 * `tests/integration/payouts-accounts.integration.test.ts`.
 */

import { ForbiddenException } from '@nestjs/common';
import {
  PayoutsCountryUnsupportedError,
  PayoutsWebhookLivemodeMismatchError,
  PayoutsWebhookSignatureInvalidError,
  signStripePayload,
} from '@didacta/mod-payouts';
import { describe, expect, it, vi } from 'vitest';
import type { SessionClaims } from '../src/auth/token.service';
import { PayoutsController } from '../src/modules/payouts/payouts.controller';
import { PAYOUTS_STATUS_BY_CODE } from '../src/modules/payouts/payouts-error.filter';
import { PlatformWebhookController } from '../src/modules/payouts/platform-webhook.controller';

const OPERATOR = ['whsec_operadorUno', 'whsec_operadorDos'];
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function buildRuntime(refs: Record<string, string> = {}) {
  const events = new Map<string, { processedAt: Date | null; tenantId: string | null }>();
  const prisma = {
    modPayoutsWebhookEvent: {
      findUnique: vi.fn(
        async ({ where }: { where: { stripeEventId: string } }) =>
          events.get(where.stripeEventId) ?? null,
      ),
      createMany: vi.fn(
        async ({
          data,
        }: {
          data: Array<{ stripeEventId: string; tenantId: string | null; processedAt?: Date }>;
        }) => {
          for (const row of data) {
            if (!events.has(row.stripeEventId)) {
              events.set(row.stripeEventId, {
                tenantId: row.tenantId,
                processedAt: row.processedAt ?? null,
              });
            }
          }
          return { count: 1 };
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { stripeEventId: string };
          data: { processedAt?: Date };
        }) => {
          const row = events.get(where.stripeEventId)!;
          if (data.processedAt) row.processedAt = data.processedAt;
          return row;
        },
      ),
    },
  };
  const runtime = {
    config: { webhookSecrets: OPERATOR, livemode: false, displayName: 'Didacta' },
    prisma,
    tenantOfAccount: vi.fn(async (acct: string) => refs[acct] ?? null),
    accounts: {
      syncAccount: vi.fn(async () => ({ status: 'READY' })),
      isCountrySupported: (c: string) => ['ES', 'FR'].includes(c),
      supportedCountries: ['ES', 'FR'],
      getAccount: vi.fn(async (tenantId: string) =>
        tenantId === TENANT_A ? { status: 'ONBOARDING', stripeAccountId: 'acct_DeAaaaaa1' } : null,
      ),
    },
    settings: { get: vi.fn(async () => ({ feeBps: 500 })) },
    mode: {
      resolve: vi.fn(async () => ({ mode: 'platform', ready: false, reason: 'not_connected' })),
    },
  };
  return { runtime, events };
}

const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn() };

function signedRequest(event: Record<string, unknown>, secret: string) {
  const raw = Buffer.from(JSON.stringify(event));
  return {
    rawBody: raw,
    headers: { 'stripe-signature': signStripePayload(raw, secret) },
  };
}

describe('PlatformWebhookController', () => {
  const acctA = 'acct_DeAaaaaa1';

  function controller(refs: Record<string, string> = { [acctA]: TENANT_A }) {
    const built = buildRuntime(refs);
    return {
      ...built,
      // Los eventos de cuenta no se reparten a módulos: el repartidor no se usa.
      webhook: new PlatformWebhookController(built.runtime as never, logger as never, {
        claims: async () => {
          throw new Error('un evento de cuenta no consulta a los módulos');
        },
        dispatch: async () => {
          throw new Error('un evento de cuenta no se reparte a los módulos');
        },
      }),
    };
  }

  it('firma con un secreto que no es del operador → error de firma (401), sin leer nada', async () => {
    const { webhook, runtime } = controller();
    await expect(
      webhook.handle(
        signedRequest(
          { id: 'evt_1', type: 'account.updated', livemode: false, account: acctA },
          'whsec_secretoDeOtraAula',
        ) as never,
      ),
    ).rejects.toBeInstanceOf(PayoutsWebhookSignatureInvalidError);
    expect(runtime.prisma.modPayoutsWebhookEvent.findUnique).not.toHaveBeenCalled();
    expect(runtime.accounts.syncAccount).not.toHaveBeenCalled();
    expect(PAYOUTS_STATUS_BY_CODE['PAYOUTS_WEBHOOK_SIGNATURE_INVALID']).toBe(401);
  });

  it('cualquiera de los secretos del operador vale', async () => {
    for (const secret of OPERATOR) {
      const { webhook } = controller();
      const res = await webhook.handle(
        signedRequest(
          {
            id: `evt_${secret.slice(-3)}`,
            type: 'account.updated',
            livemode: false,
            account: acctA,
          },
          secret,
        ) as never,
      );
      expect(res.outcome).toBe('synced');
    }
  });

  it('modo real con clave de prueba → 400', async () => {
    const { webhook } = controller();
    await expect(
      webhook.handle(
        signedRequest(
          { id: 'evt_2', type: 'account.updated', livemode: true, account: acctA },
          OPERATOR[0]!,
        ) as never,
      ),
    ).rejects.toBeInstanceOf(PayoutsWebhookLivemodeMismatchError);
  });

  it('acct_ sin registro → sin atribuir: no sincroniza nada', async () => {
    const { webhook, runtime, events } = controller({});
    const res = await webhook.process({
      id: 'evt_3',
      type: 'account.updated',
      livemode: false,
      account: 'acct_Desconocida1',
    });
    expect(res).toEqual({ received: true, outcome: 'unattributed' });
    expect(runtime.accounts.syncAccount).not.toHaveBeenCalled();
    expect(events.get('evt_3')).toMatchObject({ tenantId: null });
  });

  it('el tenant sale del registro, no del evento: la metadata que nombra a B no cuenta', async () => {
    const { webhook, runtime } = controller();
    await webhook.process({
      id: 'evt_4',
      type: 'account.updated',
      livemode: false,
      account: acctA,
      data: { object: { id: acctA, metadata: { didacta_tenant_id: TENANT_B } } },
    });
    expect(runtime.accounts.syncAccount).toHaveBeenCalledWith(TENANT_A, acctA);
  });

  it('reentrega del mismo evento → duplicate, una sola sincronización', async () => {
    const { webhook, runtime } = controller();
    const event = { id: 'evt_5', type: 'capability.updated', livemode: false, account: acctA };
    expect((await webhook.process(event)).outcome).toBe('synced');
    expect((await webhook.process(event)).outcome).toBe('duplicate');
    expect(runtime.accounts.syncAccount).toHaveBeenCalledTimes(1);
  });

  it('si Stripe falla al sincronizar, el error sube (5xx → Stripe reintenta) y no se marca procesado', async () => {
    const { webhook, runtime, events } = controller();
    runtime.accounts.syncAccount.mockRejectedValueOnce(new Error('Stripe caído'));
    await expect(
      webhook.process({ id: 'evt_6', type: 'account.updated', livemode: false, account: acctA }),
    ).rejects.toThrow('Stripe caído');
    expect(events.get('evt_6')?.processedAt).toBeNull();
    // El reintento lo procesa.
    expect(
      (
        await webhook.process({
          id: 'evt_6',
          type: 'account.updated',
          livemode: false,
          account: acctA,
        })
      ).outcome,
    ).toBe('synced');
  });
});

describe('PayoutsController', () => {
  const claims = (over: Partial<SessionClaims> = {}): SessionClaims => ({
    sub: '33333333-3333-4333-8333-333333333333',
    tenantId: TENANT_A,
    roles: ['tenant_admin'],
    mfaVerified: true,
    ...over,
  });

  function controller() {
    const { runtime } = buildRuntime();
    const tenantResolver = {
      resolvePrimaryDomain: vi.fn(async () => null),
      resolveTenantWebBaseUrl: vi.fn(async () => 'http://localhost:3000'),
    };
    return {
      runtime,
      payouts: new PayoutsController(runtime as never, tenantResolver as never),
    };
  }

  it('país no admitido → 422 antes de leer nada del aula', async () => {
    const { payouts, runtime } = controller();
    for (const country of ['BR', 'MX']) {
      await expect(
        payouts.connect({} as never, claims(), { country, entityType: 'individual' }),
      ).rejects.toBeInstanceOf(PayoutsCountryUnsupportedError);
    }
    expect(runtime.accounts.getAccount).not.toHaveBeenCalled();
    expect(PAYOUTS_STATUS_BY_CODE['PAYOUTS_COUNTRY_UNSUPPORTED']).toBe(422);
  });

  it('el estado es SIEMPRE el del tenant del token; un alumno no entra', async () => {
    const { payouts, runtime } = controller();
    const b = await payouts.status(claims({ tenantId: TENANT_B }));
    expect(b.account).toBeNull();
    expect(runtime.accounts.getAccount).toHaveBeenLastCalledWith(TENANT_B);
    const a = await payouts.status(claims());
    expect(a.account).toMatchObject({ stripeAccountId: 'acct_DeAaaaaa1' });
    await expect(payouts.status(claims({ roles: ['student'] }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('el estado no expone credenciales en modo own', async () => {
    const { payouts, runtime } = controller();
    runtime.mode.resolve.mockResolvedValueOnce({
      mode: 'own',
      credentials: { secretKey: 'sk_test_noDebeSalir' },
    } as never);
    const res = await payouts.status(claims());
    expect(res.mode).toBe('own');
    expect(JSON.stringify(res)).not.toContain('sk_test_noDebeSalir');
  });

  it('una sesión de soporte puede mirar, pero no conectar ni abrir el panel', async () => {
    const { payouts } = controller();
    const soporte = claims({ sup: 'grant-1' });
    await expect(payouts.status(soporte)).resolves.toBeDefined();
    await expect(
      payouts.connect({} as never, soporte, { country: 'ES', entityType: 'individual' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(payouts.dashboardLink(soporte)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(payouts.connectLink({} as never, soporte)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
