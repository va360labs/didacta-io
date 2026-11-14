/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Alta del creador y estado de cobros (etapa E2) contra Postgres de verdad.
 *
 * Se monta una app Nest MÍNIMA con `PayoutsModule.register()` (controladores
 * del creador, webhook de plataforma, contrato del pool y conciliador) sobre
 * el `PrismaModule` real —con la extensión RLS— conectado como `didacta_app`
 * (NOSUPERUSER, NOBYPASSRLS), y con el doble de Stripe en vez de la red.
 *
 * Lo que se demuestra aquí y no en los unitarios:
 *  - el cerrojo del alta en Postgres: tres «Conectar» a la vez → una cuenta;
 *  - el tenant sale del token: el admin de B no ve ni toca la cuenta de A;
 *  - el webhook: firma del operador, tenant desde el registro, «sin
 *    atribuir» sin efectos, 401 con un secreto ajeno, idempotencia;
 *  - el contrato del pool exige credencial de aprovisionamiento;
 *  - con el modo apagado, las rutas no existen.
 *
 * REQUISITOS: los de `payouts-foundations.integration.test.ts` (Postgres en
 * Docker con el esquema aplicado; contenedor por `RLS_TEST_PG_CONTAINER`).
 * SKIP: sin DATABASE_URL.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Module, type DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { LoggerModule } from 'nestjs-pino';
import { LicenseModule } from '@didacta/license-sdk';
import { PrismaClient } from '@didacta/database';
import {
  InMemoryPlatformStripeClient,
  PlatformStripeApiError,
  signStripePayload,
} from '@didacta/mod-payouts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProvisioningCredentialService } from '../../src/auth/provisioning-credential.service';
import { PayoutsAccountsWorker } from '../../src/modules/payouts/payouts-accounts.worker';
import { PayoutsModule } from '../../src/modules/payouts/payouts.module';
import {
  loadPlatformPaymentsConfig,
  type PlatformPaymentsEnabled,
} from '../../src/modules/payouts/platform-payments.config';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { TenancyModule } from '../../src/tenancy/tenancy.module';
import accountsFixture from '../../../../modules/payouts/tests/fixtures/accounts-2026-11-12.json';
import { issueTestAccessJwt } from './helpers/issue-test-jwt';

const ADMIN_DATABASE_URL = process.env['DATABASE_URL'];
const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

const PG_CONTAINER = process.env['RLS_TEST_PG_CONTAINER'] ?? 'didacta-postgres-test';
const PG_USER = process.env['RLS_TEST_PG_USER'] ?? 'didacta_test';
const PG_DB = process.env['RLS_TEST_PG_DB'] ?? 'didacta_test';
const APP_PASSWORD = process.env['RLS_TEST_APP_PASSWORD'] ?? 'rls_test_didacta_app_pw';
const REPO_ROOT = resolve(__dirname, '../../../..');

/** Secretos del OPERADOR (los dos endpoints de la plataforma). */
const OPERATOR_SECRETS = ['whsec_operadorUno', 'whsec_operadorDos'];
/** Un secreto que no es del operador (p. ej. el de las claves propias de un aula). */
const FOREIGN_SECRET = 'whsec_secretoDeOtraAula';

function applySqlFileViaPsql(relPath: string): void {
  const sql = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      PG_CONTAINER,
      'psql',
      '-U',
      PG_USER,
      '-d',
      PG_DB,
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      '-',
    ],
    { input: sql, stdio: ['pipe', 'pipe', 'inherit'] },
  );
}

function didactaAppUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = 'didacta_app';
  url.password = APP_PASSWORD;
  return url.toString();
}

const CONFIG = loadPlatformPaymentsConfig({
  PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: 'sk_test_inventada',
  PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS: OPERATOR_SECRETS.join(','),
  PAYMENTS_PLATFORM_DISPLAY_NAME: 'Didacta',
}) as PlatformPaymentsEnabled;

const recorded = accountsFixture.accounts as unknown as Record<
  string,
  { account: Record<string, unknown> }
>;

/** Doble de Stripe con las formas reales del sandbox. */
function buildFakeStripe(): InMemoryPlatformStripeClient {
  const fake = new InMemoryPlatformStripeClient();
  const createAccount = () => {
    const id = `acct_${fake.nextId('INTEG').replace(/_/g, '')}`;
    fake.seed({ ...recorded['es_con_requisitos']!.account, id });
    return { id, object: 'v2.core.account', livemode: false };
  };
  fake.on('POST', '/v2/core/accounts', createAccount);
  fake.on('POST', '/v1/account_links', () => ({
    object: 'account_link',
    created: 1,
    expires_at: 1794480211,
    url: 'https://connect.stripe.test/setup/e/integ',
  }));
  fake.on('GET', '/v1/balance_settings', () => ({
    object: 'balance_settings',
    payments: {
      payouts: { schedule: { interval: 'daily' } },
      settlement_timing: { delay_days: 7 },
    },
  }));
  fake.on('POST', '/v1/balance_settings', (req) => {
    const schedule = (req.params['payments'] as { payouts: { schedule: Record<string, unknown> } })
      .payouts.schedule;
    fake.patch(req.options.account!, {
      settings: {
        payouts: {
          schedule: { ...schedule, delay_days: 7, weekly_anchor: 'monday' },
        },
      },
    });
    return {
      object: 'balance_settings',
      payments: {
        payouts: { schedule, minimum_balance_by_currency: { eur: 5000 } },
        settlement_timing: { delay_days: 7 },
      },
    };
  });
  fake.on('POST', '/v1/accounts/:id/login_links', (req) => {
    const account = fake.get(req.pathParams['id']!);
    if (!account || (account as { details_submitted?: boolean }).details_submitted !== true) {
      throw new PlatformStripeApiError(accountsFixture.links.loginLinkSinAlta.message, {
        status: 400,
        operation: 'POST /v1/accounts/:id/login_links',
      });
    }
    return { object: 'login_link', created: 1, url: 'https://connect.stripe.test/express/integ' };
  });
  return fake;
}

async function buildApp(payouts: DynamicModule): Promise<NestFastifyApplication> {
  @Module({ imports: [TenancyModule, payouts] })
  class PayoutsTestRoot {}

  const moduleRef = await Test.createTestingModule({
    imports: [
      LoggerModule.forRoot({ pinoHttp: { level: 'silent', autoLogging: false } }),
      LicenseModule.forRoot({ key: null, allowDevBypass: false }),
      PrismaModule,
      PayoutsTestRoot,
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ logger: false }),
    // Como main.ts: el webhook verifica la firma sobre el cuerpo CRUDO.
    { logger: false, rawBody: true },
  );
  app.setGlobalPrefix('api/v1');
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describeWithDb('mod.payouts E2 — alta y estado contra Postgres como didacta_app', () => {
  let admin: PrismaClient;
  let app: NestFastifyApplication;
  let appOff: NestFastifyApplication;
  let fake: InMemoryPlatformStripeClient;
  const tenants: Record<'A' | 'B' | 'C', { id: string; adminId: string; jwt: string }> =
    {} as never;
  let studentJwtA: string;
  let provisioning: string;
  let acctA: string;

  async function seedTenant(label: string) {
    const id = randomUUID();
    const adminId = randomUUID();
    await admin.tenant.create({
      data: { id, slug: `payouts-e2-${label}-${id.slice(0, 8)}`, name: `Academia ${label} Prueba` },
    });
    await admin.tenantDomain.create({
      data: {
        tenantId: id,
        hostname: `${label}-${id.slice(0, 8)}.didacta.test`,
        isPrimary: true,
        isVerified: true,
      },
    });
    await admin.user.create({
      data: { id: adminId, tenantId: id, email: `admin-${label}@academia.test`, status: 'ACTIVE' },
    });
    const jwt = await issueTestAccessJwt({
      tenantId: id,
      userId: adminId,
      roles: ['tenant_admin'],
    });
    return { id, adminId, jwt };
  }

  function call(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    opts: { auth?: string; body?: unknown; target?: NestFastifyApplication } = {},
  ) {
    return (opts.target ?? app).inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        ...(opts.auth ? { authorization: opts.auth } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      payload: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  function postEvent(event: Record<string, unknown>, secret: string) {
    const raw = JSON.stringify(event);
    return app.inject({
      method: 'POST',
      url: '/api/v1/modules/payouts/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signStripePayload(raw, secret),
      },
      payload: raw,
    });
  }

  const bearer = (jwt: string) => `Bearer ${jwt}`;

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_DATABASE_URL } } });
    await admin.$connect();
    applySqlFileViaPsql('packages/database/prisma/rls.sql');
    applySqlFileViaPsql('packages/database/prisma/grants.sql');
    await admin.$executeRawUnsafe(`ALTER ROLE didacta_app PASSWORD '${APP_PASSWORD}'`);

    tenants.A = await seedTenant('a');
    tenants.B = await seedTenant('b');
    tenants.C = await seedTenant('c');
    studentJwtA = await issueTestAccessJwt({
      tenantId: tenants.A.id,
      userId: tenants.A.adminId,
      roles: ['student'],
    });

    // El runtime conecta como la app de verdad: didacta_app + extensión RLS.
    const previousUrl = process.env['DATABASE_URL'];
    const previousRls = process.env['RLS_ENFORCEMENT'];
    process.env['DATABASE_URL'] = didactaAppUrl(ADMIN_DATABASE_URL!);
    process.env['RLS_ENFORCEMENT'] = 'on';
    try {
      fake = buildFakeStripe();
      app = await buildApp(PayoutsModule.register(CONFIG, { stripe: fake }));
      appOff = await buildApp(PayoutsModule.register({ enabled: false }));
    } finally {
      process.env['DATABASE_URL'] = previousUrl;
      if (previousRls === undefined) delete process.env['RLS_ENFORCEMENT'];
      else process.env['RLS_ENFORCEMENT'] = previousRls;
    }
    provisioning = `Provisioning ${(await app.get(ProvisioningCredentialService).issue(randomUUID())).token}`;
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await appOff?.close();
    if (!admin) return;
    const ids = Object.values(tenants).map((t) => t.id);
    const where = { tenantId: { in: ids } };
    await admin.$transaction([
      admin.$executeRawUnsafe('SET LOCAL session_replication_role = replica'),
      admin.modPayoutsWebhookEvent.deleteMany({
        where: { OR: [where, { stripeEventId: { startsWith: 'evt_integ_' } }] },
      }),
      admin.modPayoutsObjectRef.deleteMany({ where }),
      admin.modPayoutsAccount.deleteMany({ where }),
      admin.modPayoutsSettings.deleteMany({ where }),
      admin.tenantSetting.deleteMany({ where }),
      admin.auditLog.deleteMany({ where }),
      admin.user.deleteMany({ where }),
      admin.tenantDomain.deleteMany({ where }),
      admin.tenant.deleteMany({ where: { id: { in: ids } } }),
    ]);
    await admin.$disconnect();
  }, 60_000);

  it('precondición: el runtime conecta como didacta_app (NOBYPASSRLS)', async () => {
    const rows = await admin.$queryRaw<Array<{ rolbypassrls: boolean }>>`
      SELECT rolbypassrls FROM pg_roles WHERE rolname = 'didacta_app'`;
    expect(rows).toEqual([{ rolbypassrls: false }]);
    expect(new URL(didactaAppUrl(ADMIN_DATABASE_URL!)).username).toBe('didacta_app');
  });

  describe('alta del creador', () => {
    it.each(['BR', 'AR', 'CO', 'CL', 'PE', 'MX'])(
      '%s → 422 PAYOUTS_COUNTRY_UNSUPPORTED, sin llamar a Stripe ni crear filas',
      async (country) => {
        const calls = fake.calls.length;
        const res = await call('POST', '/modules/payouts/connect', {
          auth: bearer(tenants.A.jwt),
          body: { country, entityType: 'individual' },
        });
        expect(res.statusCode).toBe(422);
        expect(res.json()).toMatchObject({ code: 'PAYOUTS_COUNTRY_UNSUPPORTED', detail: country });
        expect(fake.calls.length).toBe(calls);
        expect(await admin.modPayoutsAccount.count({ where: { tenantId: tenants.A.id } })).toBe(0);
      },
    );

    it('ES: crea la cuenta prerrellenada con datos del aula, la registra y devuelve el enlace', async () => {
      const res = await call('POST', '/modules/payouts/connect', {
        auth: bearer(tenants.A.jwt),
        body: { country: 'ES', entityType: 'individual' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.onboardingUrl).toBe('https://connect.stripe.test/setup/e/integ');
      expect(body.account).toMatchObject({ status: 'ONBOARDING', country: 'ES' });
      acctA = body.account.stripeAccountId;

      const [create] = fake.callsTo('POST', '/v2/core/accounts');
      expect(create!.params).toMatchObject({
        contact_email: 'admin-a@academia.test',
        display_name: 'Academia a Prueba',
        identity: { country: 'es', entity_type: 'individual' },
        metadata: { didacta_tenant_id: tenants.A.id },
      });
      // `.didacta.test` no es un dominio público: no se manda como web.
      expect(
        (create!.params['defaults'] as { profile?: { business_url?: string } }).profile,
      ).not.toHaveProperty('business_url');
      const [link] = fake.callsTo('POST', '/v1/account_links');
      expect(link!.params['return_url']).toMatch(/\/admin\/payments\?return=1$/);
      expect(link!.params['refresh_url']).toMatch(/\/admin\/payments\?refresh=1$/);

      const rows = await admin.modPayoutsAccount.findMany({ where: { tenantId: tenants.A.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        stripeAccountId: acctA,
        status: 'ONBOARDING',
        readyAt: null,
      });
      expect(rows[0]!.payoutSchedule).toMatchObject({ interval: 'weekly', weeklyDay: 'monday' });
      const ref = await admin.modPayoutsObjectRef.findUnique({ where: { stripeObjectId: acctA } });
      expect(ref).toMatchObject({ tenantId: tenants.A.id, kind: 'account', source: 'payouts' });
    });

    it('un segundo «Conectar» devuelve la misma cuenta', async () => {
      const creates = fake.callsTo('POST', '/v2/core/accounts').length;
      const res = await call('POST', '/modules/payouts/connect', {
        auth: bearer(tenants.A.jwt),
        body: { country: 'ES', entityType: 'individual' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().account.stripeAccountId).toBe(acctA);
      expect(fake.callsTo('POST', '/v2/core/accounts').length).toBe(creates);
      expect(await admin.modPayoutsAccount.count({ where: { tenantId: tenants.A.id } })).toBe(1);
    });

    it('tres «Conectar» A LA VEZ (cerrojo real de Postgres) → una fila y una sola clave en Stripe', async () => {
      const before = fake.callsTo('POST', '/v2/core/accounts').length;
      const results = await Promise.all(
        [1, 2, 3].map(() =>
          call('POST', '/modules/payouts/connect', {
            auth: bearer(tenants.C.jwt),
            body: { country: 'FR', entityType: 'company' },
          }),
        ),
      );
      expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
      const ids = new Set(results.map((r) => r.json().account.stripeAccountId));
      expect(ids.size).toBe(1);
      expect(await admin.modPayoutsAccount.count({ where: { tenantId: tenants.C.id } })).toBe(1);
      const keys = fake
        .callsTo('POST', '/v2/core/accounts')
        .slice(before)
        .map((c) => c.options.idempotencyKey);
      expect(new Set(keys).size).toBe(1);
    });

    it('un alumno no puede conectar cobros (403)', async () => {
      const res = await call('POST', '/modules/payouts/connect', {
        auth: bearer(studentJwtA),
        body: { country: 'ES', entityType: 'individual' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('PAYOUTS_ADMIN_ROLE_REQUIRED');
    });

    it('sin sesión → 401', async () => {
      expect((await call('GET', '/modules/payouts/status')).statusCode).toBe(401);
    });
  });

  describe('aislamiento: el tenant sale del token', () => {
    it('el admin de B no ve la cuenta de A', async () => {
      const res = await call('GET', '/modules/payouts/status', { auth: bearer(tenants.B.jwt) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        platform: true,
        operatorName: 'Didacta',
        mode: 'platform',
        ready: false,
        reason: 'not_connected',
        account: null,
        feeBps: 500,
      });
      // Control: A sí la ve.
      const a = await call('GET', '/modules/payouts/status', { auth: bearer(tenants.A.jwt) });
      expect(a.json().account.stripeAccountId).toBe(acctA);
    });

    it('el país DECLARADO en el alta (tenant_setting) sale en el estado de SU aula y de ninguna otra', async () => {
      const before = await call('GET', '/modules/payouts/status', { auth: bearer(tenants.C.jwt) });
      expect(before.json().declaredCountry).toBeNull();
      await admin.tenantSetting.create({
        data: {
          tenantId: tenants.C.id,
          moduleName: 'payouts',
          key: 'declared_country',
          valueJson: 'OTHER',
          isSecret: false,
        },
      });
      const c = await call('GET', '/modules/payouts/status', { auth: bearer(tenants.C.jwt) });
      expect(c.json().declaredCountry).toBe('OTHER');
      // Control: B no ve el de C.
      const b = await call('GET', '/modules/payouts/status', { auth: bearer(tenants.B.jwt) });
      expect(b.json().declaredCountry).toBeNull();
    });

    it('B no consigue enlace ni panel de A: no tiene cuenta (404)', async () => {
      const link = await call('POST', '/modules/payouts/connect/link', {
        auth: bearer(tenants.B.jwt),
      });
      expect(link.statusCode).toBe(404);
      expect(link.json().code).toBe('PAYOUTS_ACCOUNT_NOT_FOUND');
      const panel = await call('GET', '/modules/payouts/dashboard-link', {
        auth: bearer(tenants.B.jwt),
      });
      expect(panel.statusCode).toBe(404);
    });

    it('el cuerpo no puede nombrar otra aula: un tenantId en el body se ignora', async () => {
      const res = await call('POST', '/modules/payouts/connect', {
        auth: bearer(tenants.B.jwt),
        body: { country: 'ES', entityType: 'individual', tenantId: tenants.A.id },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().account.stripeAccountId).not.toBe(acctA);
      // A sigue con UNA cuenta, la suya; B tiene la suya.
      expect(await admin.modPayoutsAccount.count({ where: { tenantId: tenants.A.id } })).toBe(1);
      expect(await admin.modPayoutsAccount.count({ where: { tenantId: tenants.B.id } })).toBe(1);
    });
  });

  describe('webhook de plataforma (eventos de cuenta)', () => {
    const evt = () => `evt_integ_${randomUUID().replace(/-/g, '')}`;

    it('firma con un secreto que no es del operador → 401, sin tocar nada', async () => {
      const id = evt();
      const res = await postEvent(
        {
          id,
          type: 'account.updated',
          livemode: false,
          account: acctA,
          data: { object: { id: acctA } },
        },
        FOREIGN_SECRET,
      );
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('PAYOUTS_WEBHOOK_SIGNATURE_INVALID');
      expect(await admin.modPayoutsWebhookEvent.count({ where: { stripeEventId: id } })).toBe(0);
    });

    it('evento de modo real con clave de prueba → 400', async () => {
      const res = await postEvent(
        { id: evt(), type: 'account.updated', livemode: true, account: acctA },
        OPERATOR_SECRETS[0]!,
      );
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('PAYOUTS_WEBHOOK_LIVEMODE_MISMATCH');
    });

    it('acct_ sin registro → archivado «sin atribuir», 200, sin consultar Stripe', async () => {
      const id = evt();
      const calls = fake.calls.length;
      const res = await postEvent(
        { id, type: 'account.updated', livemode: false, account: 'acct_SinRegistro123' },
        OPERATOR_SECRETS[1]!,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true, outcome: 'unattributed' });
      expect(fake.calls.length).toBe(calls);
      const row = await admin.modPayoutsWebhookEvent.findUnique({ where: { stripeEventId: id } });
      expect(row).toMatchObject({ tenantId: null, objectId: 'acct_SinRegistro123' });
      expect(row!.processedAt).not.toBeNull();
    });

    it('evento de A: dispara syncAccount (que consulta Stripe) y no copia el estado del evento', async () => {
      // Stripe tiene la cuenta LISTA; el evento dice cualquier cosa.
      fake.seed({ ...recorded['es_lista']!.account, id: acctA });
      const id = evt();
      const gets = fake.callsTo('GET', `/v1/accounts/${acctA}`).length;
      const res = await postEvent(
        {
          id,
          type: 'account.updated',
          livemode: false,
          account: acctA,
          data: { object: { id: acctA, charges_enabled: false, details_submitted: false } },
        },
        OPERATOR_SECRETS[0]!,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true, outcome: 'synced' });
      expect(fake.callsTo('GET', `/v1/accounts/${acctA}`).length).toBe(gets + 1);

      const account = await admin.modPayoutsAccount.findFirst({
        where: { tenantId: tenants.A.id },
      });
      expect(account).toMatchObject({ status: 'READY', cardPaymentsStatus: 'active' });
      expect(account!.readyAt).not.toBeNull();
      const row = await admin.modPayoutsWebhookEvent.findUnique({ where: { stripeEventId: id } });
      expect(row).toMatchObject({ tenantId: tenants.A.id, objectId: acctA, errorMessage: null });
      // Lo archivado no lleva `data.object` (datos personales del creador).
      expect(row!.payload).not.toHaveProperty('data');

      // Reentrega: idempotente, sin otra consulta.
      const again = await postEvent(
        { id, type: 'account.updated', livemode: false, account: acctA },
        OPERATOR_SECRETS[0]!,
      );
      expect(again.json()).toEqual({ received: true, outcome: 'duplicate' });
      expect(fake.callsTo('GET', `/v1/accounts/${acctA}`).length).toBe(gets + 1);
    });

    it('evento v2 («thin»): el acct_ sale de related_object', async () => {
      const gets = fake.callsTo('GET', `/v1/accounts/${acctA}`).length;
      const res = await postEvent(
        {
          id: evt(),
          object: 'v2.core.event',
          type: 'v2.core.account[requirements].updated',
          livemode: false,
          created: '2026-11-12T10:00:00.000Z',
          related_object: { id: acctA, type: 'v2.core.account', url: `/v2/core/accounts/${acctA}` },
        },
        OPERATOR_SECRETS[1]!,
      );
      expect(res.json()).toEqual({ received: true, outcome: 'synced' });
      expect(fake.callsTo('GET', `/v1/accounts/${acctA}`).length).toBe(gets + 1);
    });

    it('un tipo que el webhook no atiende se archiva sin efectos', async () => {
      const res = await postEvent(
        { id: evt(), type: 'customer.created', livemode: false, data: { object: { id: 'cus_x' } } },
        OPERATOR_SECRETS[0]!,
      );
      expect(res.json()).toEqual({ received: true, outcome: 'ignored' });
    });

    it('un cargo que no está en el registro (E3) se archiva «sin atribuir»', async () => {
      const res = await postEvent(
        { id: evt(), type: 'charge.updated', livemode: false, data: { object: { id: 'ch_x' } } },
        OPERATOR_SECRETS[0]!,
      );
      expect(res.json()).toEqual({ received: true, outcome: 'unattributed' });
    });

    it('con la cuenta lista, el panel de Stripe ya se abre; sin terminar el alta, 409', async () => {
      const a = await call('GET', '/modules/payouts/dashboard-link', {
        auth: bearer(tenants.A.jwt),
      });
      expect(a.statusCode).toBe(200);
      expect(a.json().url).toBe('https://connect.stripe.test/express/integ');
      const c = await call('GET', '/modules/payouts/dashboard-link', {
        auth: bearer(tenants.C.jwt),
      });
      expect(c.statusCode).toBe(409);
      expect(c.json().code).toBe('PAYOUTS_ACCOUNT_ONBOARDING_INCOMPLETE');
    });

    it('status?sync=1 (vuelta del alta) consulta Stripe y devuelve lista para vender', async () => {
      const res = await call('GET', '/modules/payouts/status?sync=1', {
        auth: bearer(tenants.A.jwt),
      });
      expect(res.json()).toMatchObject({ mode: 'platform', ready: true, reason: null });
      expect(res.json().account).toMatchObject({
        status: 'READY',
        payoutSchedule: { interval: 'weekly', weeklyDay: 'monday', delayDays: 7 },
      });
    });
  });

  describe('conciliador de cuentas', () => {
    it('el barrido de pendientes sincroniza las cuentas no listas de todos los tenants', async () => {
      const worker = app.get(PayoutsAccountsWorker);
      const result = await worker.sweep({ ready: false });
      // B y C (ONBOARDING); A ya está READY y va en el barrido diario.
      expect(result).toMatchObject({ accounts: 2, synced: 2, failed: 0 });
      const ready = await worker.sweep({ ready: true });
      expect(ready).toMatchObject({ accounts: 1, synced: 1, failed: 0 });
    });
  });

  describe('contrato del pool', () => {
    it('payouts-settings sin credencial → 401; con JWT de tenant_admin → 403', async () => {
      const none = await call('PUT', `/admin/tenants/${tenants.A.id}/payouts-settings`, {
        body: { feeBps: 300 },
      });
      expect(none.statusCode).toBe(401);
      const tenantAdmin = await call('PUT', `/admin/tenants/${tenants.A.id}/payouts-settings`, {
        auth: bearer(tenants.A.jwt),
        body: { feeBps: 300 },
      });
      expect(tenantAdmin.statusCode).toBe(403);
    });

    it.each([3001, -1, 2.5, '300'])('feeBps %s → 400', async (feeBps) => {
      const res = await call('PUT', `/admin/tenants/${tenants.A.id}/payouts-settings`, {
        auth: provisioning,
        body: { feeBps },
      });
      expect(res.statusCode).toBe(400);
    });

    it('con credencial: fija la comisión, deja auditoría y es idempotente', async () => {
      const res = await call('PUT', `/admin/tenants/${tenants.A.id}/payouts-settings`, {
        auth: provisioning,
        body: { feeBps: 300 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(['feeBps', 'tenantId', 'updatedAt']);
      expect(body).toMatchObject({ tenantId: tenants.A.id, feeBps: 300 });

      const again = await call('PUT', `/admin/tenants/${tenants.A.id}/payouts-settings`, {
        auth: provisioning,
        body: { feeBps: 300 },
      });
      expect(again.json().updatedAt).toBe(body.updatedAt);
      const audits = await admin.auditLog.count({
        where: { tenantId: tenants.A.id, action: 'payouts.settings.fee_changed' },
      });
      expect(audits).toBe(1);

      // El creador ve la comisión nueva; B sigue con la de por defecto.
      const a = await call('GET', '/modules/payouts/status', { auth: bearer(tenants.A.jwt) });
      expect(a.json().feeBps).toBe(300);
      const b = await call('GET', '/modules/payouts/status', { auth: bearer(tenants.B.jwt) });
      expect(b.json().feeBps).toBe(500);
    });

    it('GET payouts devuelve exactamente los campos del contrato', async () => {
      const res = await call('GET', `/admin/tenants/${tenants.A.id}/payouts`, {
        auth: provisioning,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(
        ['country', 'debtOutstanding', 'feeBps', 'mode', 'status', 'tenantId'].sort(),
      );
      expect(body).toEqual({
        tenantId: tenants.A.id,
        mode: 'platform',
        status: 'READY',
        country: 'ES',
        feeBps: 300,
        debtOutstanding: [],
      });
    });

    it('tenant inexistente → 404 ADMIN_TENANT_NOT_FOUND', async () => {
      for (const id of [randomUUID(), 'no-es-un-uuid']) {
        const res = await call('GET', `/admin/tenants/${id}/payouts`, { auth: provisioning });
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe('ADMIN_TENANT_NOT_FOUND');
      }
    });

    it('payouts/countries sin credencial → 401; con JWT de tenant_admin → 403', async () => {
      const none = await call('GET', '/admin/tenants/payouts/countries');
      expect(none.statusCode).toBe(401);
      const tenantAdmin = await call('GET', '/admin/tenants/payouts/countries', {
        auth: bearer(tenants.A.jwt),
      });
      expect(tenantAdmin.statusCode).toBe(403);
    });

    it('payouts/countries con credencial: exactamente `{ supportedCountries }`, la lista del alta', async () => {
      const res = await call('GET', '/admin/tenants/payouts/countries', { auth: provisioning });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body)).toEqual(['supportedCountries']);
      expect(body.supportedCountries).toEqual([...CONFIG.supportedCountries]);
      expect(body.supportedCountries).toContain('ES');
      expect(body.supportedCountries).not.toContain('BR');
      for (const country of body.supportedCountries) expect(country).toMatch(/^[A-Z]{2}$/);
    });
  });

  describe('modo plataforma apagado', () => {
    it.each([
      ['GET', '/modules/payouts/status'],
      ['POST', '/modules/payouts/connect'],
      ['POST', '/modules/payouts/connect/link'],
      ['GET', '/modules/payouts/dashboard-link'],
      ['POST', '/modules/payouts/webhook'],
      ['PUT', `/admin/tenants/00000000-0000-4000-8000-000000000001/payouts-settings`],
      ['GET', `/admin/tenants/00000000-0000-4000-8000-000000000001/payouts`],
      ['GET', '/admin/tenants/payouts/countries'],
    ] as const)('%s %s no existe (404)', async (method, url) => {
      const res = await call(method, url, {
        target: appOff,
        auth: bearer(tenants.A.jwt),
        body: method === 'GET' ? undefined : {},
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
