import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  COUNTRY_NOT_SUPPORTED_REASON,
  PayoutsAccountsService,
  deriveStatus,
  publicBusinessUrl,
  requirementCategory,
  type PayoutsAccountsConfig,
  type PayoutsDbPort,
  type PayoutsTx,
} from '../src/accounts.service.js';
import {
  PayoutsAccountAlreadyStartedError,
  PayoutsAccountNotFoundError,
  PayoutsAccountOnboardingIncompleteError,
  PayoutsCountryUnsupportedError,
  PayoutsInvalidEntityTypeError,
  PayoutsObjectRefConflictError,
  PlatformStripeApiError,
} from '../src/errors.js';
import {
  createConnectedAccountsApi,
  isCountryRejection,
  sanitizeStatementDescriptor,
  type StripeConnectedAccount,
} from '../src/stripe/accounts-api.js';
import { InMemoryPlatformStripeClient } from '../src/stripe/platform-stripe.fake.js';
import accountsFixture from './fixtures/accounts-2026-11-12.json';
import sandbox from './fixtures/sandbox-2026-11-12.json';

// ============================================================================
// Alta del creador y estado de cobros (etapa E2).
//
// `deriveStatus` se prueba con respuestas REALES del sandbox grabadas en
// `fixtures/accounts-2026-11-12.json`. El servicio, con el doble de Stripe y
// una base en memoria que imita lo que usa (incluida la visibilidad por
// tenant y la unicidad de `stripe_account_id`). El comportamiento contra
// Postgres real (cerrojo, RLS) lo cubre
// `apps/api/tests/integration/payouts-accounts.integration.test.ts`.
// ============================================================================

const SUPPORTED = ['ES', 'FR', 'DE', 'GB', 'CH', 'US', 'CA'];

const CONFIG: PayoutsAccountsConfig = {
  supportedCountries: SUPPORTED,
  lossesCollector: 'stripe',
  livemode: false,
  payout: {
    interval: 'weekly',
    weeklyDay: 'monday',
    delayDays: 7,
    // Como la variable por defecto: varias divisas. Solo se manda la de la cuenta.
    minBalance: { eur: 5000, usd: 5000, gbp: 5000 },
  },
};

const recorded = accountsFixture.accounts as unknown as Record<
  string,
  { expectedStatus: string; account: StripeConnectedAccount }
>;

describe('deriveStatus con respuestas reales del sandbox', () => {
  it.each(Object.entries(recorded))('%s → su estado', (_name, { expectedStatus, account }) => {
    expect(deriveStatus(account, { supportedCountries: SUPPORTED }).status).toBe(expectedStatus);
  });

  it('ES lista: READY, sin requisito pendiente, capacidades activas', () => {
    const derived = deriveStatus(recorded['es_lista']!.account, { supportedCountries: SUPPORTED });
    expect(derived).toMatchObject({
      status: 'READY',
      cardPaymentsStatus: 'active',
      transfersStatus: 'active',
      pendingRequirement: null,
      pastDue: [],
    });
  });

  it('ES con requisitos: ONBOARDING (recién creada, todo past_due) y dice qué falta', () => {
    const derived = deriveStatus(recorded['es_con_requisitos']!.account, {
      supportedCountries: SUPPORTED,
    });
    expect(derived.status).toBe('ONBOARDING');
    expect(derived.pastDue).toContain('external_account');
    expect(derived.pendingRequirement).toBe('business_details'); // business_profile.mcc va primero
  });

  it('MX con transferencias inactivas: RESTRICTED por país, aunque se admitiera sería ONBOARDING', () => {
    const mx = recorded['mx_transferencias_inactivas']!.account;
    expect(mx.capabilities?.['transfers']).toBe('inactive');
    const derived = deriveStatus(mx, { supportedCountries: SUPPORTED });
    expect(derived.status).toBe('RESTRICTED');
    expect(derived.disabledReason).toBe(COUNTRY_NOT_SUPPORTED_REASON);
    // Control: con MX en la lista, la misma respuesta NO está lista.
    expect(deriveStatus(mx, { supportedCountries: [...SUPPORTED, 'MX'] }).status).toBe(
      'ONBOARDING',
    );
  });

  it('MX activa en Stripe: fuera de la lista es RESTRICTED; dentro, READY (control)', () => {
    const mx = recorded['mx_activa_pais_no_admitido']!.account;
    expect(deriveStatus(mx, { supportedCountries: SUPPORTED }).status).toBe('RESTRICTED');
    expect(deriveStatus(mx, { supportedCountries: [...SUPPORTED, 'MX'] }).status).toBe('READY');
  });

  const lista = recorded['es_lista']!.account;
  const variante = (patch: Partial<StripeConnectedAccount>): StripeConnectedAccount => ({
    ...lista,
    ...patch,
  });

  it('rechazo de Stripe → REJECTED, aunque las capacidades sigan activas', () => {
    const derived = deriveStatus(
      variante({ requirements: { ...lista.requirements, disabled_reason: 'rejected.fraud' } }),
      { supportedCountries: SUPPORTED },
    );
    expect(derived.status).toBe('REJECTED');
  });

  it('enviado con algo vencido → RESTRICTED', () => {
    const derived = deriveStatus(
      variante({
        capabilities: { card_payments: 'inactive', transfers: 'inactive' },
        requirements: {
          ...lista.requirements,
          past_due: ['individual.verification.document'],
          currently_due: ['individual.verification.document'],
          disabled_reason: 'requirements.past_due',
        },
      }),
      { supportedCountries: SUPPORTED },
    );
    expect(derived).toMatchObject({
      status: 'RESTRICTED',
      pendingRequirement: 'identity_document',
    });
  });

  it('activa pero con algo vencido → RESTRICTED (se cortan ventas nuevas)', () => {
    const derived = deriveStatus(
      variante({ requirements: { ...lista.requirements, past_due: ['external_account'] } }),
      { supportedCountries: SUPPORTED },
    );
    expect(derived.status).toBe('RESTRICTED');
  });

  it('enviado y en verificación → PENDING_REVIEW', () => {
    const derived = deriveStatus(
      variante({
        capabilities: { card_payments: 'pending', transfers: 'pending' },
        requirements: {
          ...lista.requirements,
          pending_verification: ['individual.verification.document'],
          disabled_reason: 'requirements.pending_verification',
        },
      }),
      { supportedCountries: SUPPORTED },
    );
    expect(derived).toMatchObject({ status: 'PENDING_REVIEW', pendingRequirement: null });
  });

  it('enviado y Stripe pide algo más sin vencer → ONBOARDING', () => {
    const derived = deriveStatus(
      variante({
        capabilities: { card_payments: 'inactive', transfers: 'inactive' },
        requirements: { ...lista.requirements, currently_due: ['external_account'] },
      }),
      { supportedCountries: SUPPORTED },
    );
    expect(derived).toMatchObject({ status: 'ONBOARDING', pendingRequirement: 'bank_account' });
  });
});

describe('requirementCategory / publicBusinessUrl / descriptor', () => {
  it.each([
    ['external_account', 'bank_account'],
    ['individual.verification.document', 'identity_document'],
    ['representative.verification.additional_document', 'identity_document'],
    ['tos_acceptance.date', 'terms'],
    ['business_profile.url', 'business_details'],
    ['company.tax_id', 'business_details'],
    ['individual.dob.day', 'personal_details'],
    ['person_1Abc.first_name', 'personal_details'],
    ['algo.raro', 'other'],
  ])('%s → %s', (req, category) => {
    expect(requirementCategory(req)).toBe(category);
  });

  it('solo dominios públicos van a Stripe como web del negocio', () => {
    expect(publicBusinessUrl('academia.didacta.cloud')).toBe('https://academia.didacta.cloud');
    expect(publicBusinessUrl('localhost')).toBeNull();
    expect(publicBusinessUrl('127.0.0.1')).toBeNull();
    expect(publicBusinessUrl('demo.localhost')).toBeNull();
    expect(publicBusinessUrl('aula.example')).toBeNull();
    expect(publicBusinessUrl(null)).toBeNull();
  });

  it('descriptor: sin acentos, en mayúsculas, 5–22 caracteres y sin caracteres prohibidos', () => {
    expect(sanitizeStatementDescriptor('Academia de Formación «Ñandú»')).toBe(
      'ACADEMIA DE FORMACION',
    );
    expect(sanitizeStatementDescriptor('Cursos "Pepe" <*>')).toBe('CURSOS PEPE');
    expect(sanitizeStatementDescriptor('Ab')).toBeNull();
    expect(sanitizeStatementDescriptor('12345678')).toBeNull();
    expect(sanitizeStatementDescriptor('')).toBeNull();
  });
});

describe('isCountryRejection con los literales del sandbox', () => {
  const literales = Object.entries(sandbox.countryErrors as Record<string, string>);

  it.each(literales)('%s → rechazo por país', (_key, message) => {
    const err = new PlatformStripeApiError(message, {
      status: 400,
      type: 'invalid_request_error',
      operation: 'POST /v2/core/accounts',
    });
    expect(isCountryRejection(err)).toBe(true);
  });

  it('control: otros errores de Stripe NO son rechazo por país', () => {
    for (const message of [
      'Invalid URL.',
      'With a dashboard type of `express`, the Connect application must control losses.',
      'No such account',
    ]) {
      expect(
        isCountryRejection(new PlatformStripeApiError(message, { status: 400, operation: 'x' })),
      ).toBe(false);
    }
    // Un 5xx con texto parecido no se traduce: es un fallo de Stripe, no del país.
    expect(
      isCountryRejection(
        new PlatformStripeApiError(literales[0]![1], { status: 500, operation: 'x' }),
      ),
    ).toBe(false);
  });
});

// ── Base en memoria ─────────────────────────────────────────────────────────

interface AccountRowMem {
  id: string;
  tenantId: string;
  stripeAccountId: string | null;
  country: string;
  entityType: string;
  status: string;
  cardPaymentsStatus: string | null;
  transfersStatus: string | null;
  payoutsEnabled: boolean;
  requirementsCurrentlyDue: unknown;
  requirementsPastDue: unknown;
  requirementsDeadline: Date | null;
  disabledReason: string | null;
  defaultCurrency: string | null;
  feesCollector: string | null;
  lossesCollector: string | null;
  payoutSchedule: unknown;
  portalConfigurationId: string | null;
  livemode: boolean;
  readyAt: Date | null;
  lastSyncedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RefRowMem {
  stripeObjectId: string;
  tenantId: string;
  kind: string;
  source: string;
  localRef: string | null;
  parentObjectId: string | null;
  livemode: boolean;
  createdAt: Date;
}

class MemDb implements PayoutsDbPort {
  accounts: AccountRowMem[] = [];
  refs: RefRowMem[] = [];
  private seq = 0;

  private tx(tenant: string | null): PayoutsTx {
    const visible = () =>
      tenant === null ? this.accounts : this.accounts.filter((a) => a.tenantId === tenant);
    const visibleRefs = () =>
      tenant === null ? this.refs : this.refs.filter((r) => r.tenantId === tenant);
    const matches = (row: AccountRowMem, where: Record<string, unknown>) =>
      Object.entries(where).every(([key, value]) => {
        const actual = (row as unknown as Record<string, unknown>)[key];
        if (value && typeof value === 'object' && !(value instanceof Date)) {
          const cond = value as { not?: unknown; notIn?: unknown[] };
          if ('notIn' in cond) return !cond.notIn!.includes(actual);
          if ('not' in cond) return actual !== cond.not;
        }
        return actual === value;
      });
    const self = this;
    const tx = {
      $executeRaw: async () => 1,
      modPayoutsAccount: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          [...visible()]
            .filter((r) => matches(r, where))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null,
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          visible().filter((r) => matches(r, where)),
        findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
          const row = visible().find((r) => r.id === where.id);
          if (!row) throw new Error('not found');
          return { ...row };
        },
        create: async ({ data }: { data: Partial<AccountRowMem> }) => {
          if (tenant !== null && data.tenantId !== tenant) throw new Error('RLS');
          self.seq += 1;
          const now = new Date(Date.UTC(2026, 10, 12, 10, 0, self.seq));
          const row: AccountRowMem = {
            id: randomUUID(),
            stripeAccountId: null,
            cardPaymentsStatus: null,
            transfersStatus: null,
            payoutsEnabled: false,
            requirementsCurrentlyDue: [],
            requirementsPastDue: [],
            requirementsDeadline: null,
            disabledReason: null,
            defaultCurrency: null,
            feesCollector: null,
            lossesCollector: null,
            payoutSchedule: null,
            portalConfigurationId: null,
            readyAt: null,
            lastSyncedAt: null,
            closedAt: null,
            createdAt: now,
            updatedAt: now,
            status: 'NOT_CONNECTED',
            livemode: false,
            tenantId: '',
            country: '',
            entityType: '',
            ...data,
          } as AccountRowMem;
          self.accounts.push(row);
          return { ...row };
        },
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<AccountRowMem>;
        }) => {
          const row = visible().find((r) => r.id === where.id);
          if (!row) throw new Error('not found');
          if (
            data.stripeAccountId &&
            self.accounts.some((a) => a !== row && a.stripeAccountId === data.stripeAccountId)
          ) {
            throw Object.assign(new Error('Unique'), { code: 'P2002' });
          }
          Object.assign(row, data, { updatedAt: new Date() });
          return { ...row };
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Partial<AccountRowMem>;
        }) => {
          const rows = visible().filter((r) => matches(r, where));
          rows.forEach((row) => Object.assign(row, data));
          return { count: rows.length };
        },
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          const before = self.accounts.length;
          self.accounts = self.accounts.filter(
            (r) => !(visible().includes(r) && matches(r, where)),
          );
          return { count: before - self.accounts.length };
        },
      },
      modPayoutsObjectRef: {
        createMany: async ({ data }: { data: RefRowMem[] }) => {
          let count = 0;
          for (const item of data) {
            if (self.refs.some((r) => r.stripeObjectId === item.stripeObjectId)) continue;
            self.refs.push({ ...item, createdAt: new Date() });
            count += 1;
          }
          return { count };
        },
        findUnique: async ({ where }: { where: { stripeObjectId: string } }) =>
          visibleRefs().find((r) => r.stripeObjectId === where.stripeObjectId) ?? null,
      },
    };
    return tx as unknown as PayoutsTx;
  }

  /**
   * Las transacciones se ejecutan de una en una: imita el
   * `pg_advisory_xact_lock` del alta (que en Postgres real prueba el test de
   * integración) sin modelar cerrojos.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  inTenant<T>(tenantId: string, fn: (tx: PayoutsTx) => Promise<T>): Promise<T> {
    return this.serialize(() => fn(this.tx(tenantId)));
  }

  global<T>(fn: (tx: PayoutsTx) => Promise<T>): Promise<T> {
    return this.serialize(() => fn(this.tx(null)));
  }
}

// ── Servicio ────────────────────────────────────────────────────────────────

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PREFILL = {
  email: 'admin@academia.test',
  displayName: 'Academia de Prueba',
  hostname: 'academia.didacta.cloud',
  locale: 'es',
};
const URLS = {
  returnUrl: 'https://academia.didacta.cloud/admin/cobros?vuelta=1',
  refreshUrl: 'https://academia.didacta.cloud/admin/cobros?renovar=1',
};

/** Doble de Stripe que crea cuentas como las del sandbox (recién creadas: ONBOARDING). */
function buildFake(flavor: 'v2' | 'v1' = 'v2') {
  const fake = new InMemoryPlatformStripeClient();
  const fresh = recorded['es_con_requisitos']!.account;
  const createAccount = () => {
    const id = `acct_${fake.nextId('FAKE').replace(/_/g, '')}`;
    fake.seed({ ...(fresh as unknown as Record<string, unknown>), id });
    return { id, object: 'v2.core.account', livemode: false };
  };
  fake.on('POST', '/v2/core/accounts', createAccount);
  fake.on('POST', '/v1/accounts', createAccount);
  fake.on('POST', '/v1/account_links', () => ({
    object: 'account_link',
    created: 1,
    expires_at: 1794480211,
    url: 'https://connect.stripe.test/setup/e/fake',
  }));
  fake.on('GET', '/v1/balance_settings', () => ({
    object: 'balance_settings',
    payments: {
      payouts: { schedule: { interval: 'daily' } },
      settlement_timing: { delay_days: 7 },
    },
  }));
  fake.on('POST', '/v1/balance_settings', (req) => {
    const payments = req.params['payments'] as {
      payouts: { schedule: { interval: string; weekly_payout_days?: string[] } };
    };
    if ('settlement_timing' in (req.params['payments'] as object)) {
      throw new PlatformStripeApiError(accountsFixture.balanceSettings.delayDaysRechazado.message, {
        status: 400,
        operation: 'POST /v1/balance_settings',
      });
    }
    // Como Stripe (comprobado en el sandbox): la cuenta refleja el calendario
    // en `settings.payouts.schedule`.
    const acct = req.options.account!;
    const stored = fake.get(acct);
    if (stored) {
      fake.patch(acct, {
        settings: {
          payouts: {
            schedule: {
              delay_days: 7,
              interval: payments.payouts.schedule.interval,
              weekly_anchor: payments.payouts.schedule.weekly_payout_days?.[0],
              weekly_payout_days: payments.payouts.schedule.weekly_payout_days,
            },
          },
        },
      });
    }
    return {
      ...accountsFixture.balanceSettings.aplicado.body,
      payments: {
        ...accountsFixture.balanceSettings.aplicado.body.payments,
        payouts: {
          ...accountsFixture.balanceSettings.aplicado.body.payments.payouts,
          schedule: payments.payouts.schedule,
        },
      },
    };
  });
  const api = createConnectedAccountsApi(fake, flavor);
  return { fake, api };
}

describe('PayoutsAccountsService', () => {
  let db: MemDb;
  let fake: InMemoryPlatformStripeClient;
  let service: PayoutsAccountsService;

  beforeEach(() => {
    db = new MemDb();
    const built = buildFake();
    fake = built.fake;
    service = new PayoutsAccountsService(db, built.api, CONFIG, { retryDelayMs: 0 });
  });

  it.each(['BR', 'AR', 'CO', 'CL', 'PE', 'MX'])(
    '%s → 422 PAYOUTS_COUNTRY_UNSUPPORTED sin llamar a Stripe ni escribir',
    async (country) => {
      const err = await service
        .startOnboarding({
          tenantId: TENANT_A,
          country,
          entityType: 'individual',
          prefill: PREFILL,
          urls: URLS,
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PayoutsCountryUnsupportedError);
      expect((err as PayoutsCountryUnsupportedError).code).toBe('PAYOUTS_COUNTRY_UNSUPPORTED');
      expect((err as PayoutsCountryUnsupportedError).detail).toBe(country);
      expect(fake.calls).toHaveLength(0);
      expect(db.accounts).toHaveLength(0);
    },
  );

  it.each(Object.entries(sandbox.countryErrors as Record<string, string>))(
    'Stripe rechaza con «%s» → el mismo 422, y la fila sin cuenta se retira',
    async (_key, message) => {
      fake.failNext('/v2/core/accounts', { message, status: 400 });
      const err = await service
        .startOnboarding({
          tenantId: TENANT_A,
          country: 'FR',
          entityType: 'individual',
          prefill: PREFILL,
          urls: URLS,
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PayoutsCountryUnsupportedError);
      expect((err as PayoutsCountryUnsupportedError).detail).toBe('FR');
      expect(db.accounts).toHaveLength(0);
      // Y se puede volver a intentar con otro país.
      const ok = await service.startOnboarding({
        tenantId: TENANT_A,
        country: 'ES',
        entityType: 'individual',
        prefill: PREFILL,
        urls: URLS,
      });
      expect(ok.account.country).toBe('ES');
    },
  );

  it('alta ES: crea la cuenta prerrellenada, la registra, fija el calendario y da el enlace', async () => {
    const result = await service.startOnboarding({
      tenantId: TENANT_A,
      country: 'es',
      entityType: 'individual',
      prefill: PREFILL,
      urls: URLS,
    });
    expect(result.onboardingUrl).toBe('https://connect.stripe.test/setup/e/fake');
    expect(result.account).toMatchObject({ status: 'ONBOARDING', country: 'ES' });

    const [create] = fake.callsTo('POST', '/v2/core/accounts');
    expect(create!.params).toMatchObject({
      contact_email: 'admin@academia.test',
      display_name: 'Academia de Prueba',
      dashboard: 'express',
      identity: { country: 'es', entity_type: 'individual' },
      configuration: {
        merchant: {
          mcc: '8299',
          statement_descriptor: { descriptor: 'ACADEMIA DE PRUEBA' },
          capabilities: { card_payments: { requested: true } },
        },
        recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
      },
      defaults: {
        currency: 'eur',
        locales: ['es-ES'],
        profile: { business_url: 'https://academia.didacta.cloud' },
        responsibilities: { fees_collector: 'application', losses_collector: 'stripe' },
      },
      metadata: { didacta_tenant_id: TENANT_A },
    });
    expect(create!.options.idempotencyKey).toMatch(/^payouts:account:[0-9a-f-]{36}$/);

    const [link] = fake.callsTo('POST', '/v1/account_links');
    expect(link!.params).toMatchObject({
      type: 'account_onboarding',
      return_url: URLS.returnUrl,
      refresh_url: URLS.refreshUrl,
      collection_options: { fields: 'eventually_due' },
    });

    // Calendario: semanal, lunes, colchón 50 € y con Stripe-Account. Los días
    // de retención (7) ya eran los de la cuenta: no se mandan.
    const [schedule] = fake.callsTo('POST', '/v1/balance_settings');
    expect(schedule!.options.account).toBe(result.account.stripeAccountId);
    expect(schedule!.params).toEqual({
      payments: {
        payouts: {
          schedule: { interval: 'weekly', weekly_payout_days: ['monday'] },
          minimum_balance_by_currency: { eur: 5000 },
        },
      },
    });
    expect(result.account.payoutSchedule).toMatchObject({
      interval: 'weekly',
      weeklyDay: 'monday',
    });

    expect(db.refs).toEqual([
      expect.objectContaining({
        stripeObjectId: result.account.stripeAccountId,
        tenantId: TENANT_A,
        kind: 'account',
        source: 'payouts',
      }),
    ]);
  });

  it('el colchón va solo en la divisa de la cuenta (Stripe rechaza el lote con una ajena)', async () => {
    const { account } = await service.startOnboarding({
      tenantId: TENANT_A,
      country: 'GB',
      entityType: 'company',
      prefill: PREFILL,
      urls: URLS,
    });
    const [schedule] = fake.callsTo('POST', '/v1/balance_settings');
    expect(schedule!.options.account).toBe(account.stripeAccountId);
    expect(
      (schedule!.params['payments'] as { payouts: Record<string, unknown> }).payouts[
        'minimum_balance_by_currency'
      ],
    ).toEqual({ gbp: 5000 });
  });

  it('dos connect seguidos → UNA cuenta en Stripe y una fila', async () => {
    const input = {
      tenantId: TENANT_A,
      country: 'ES',
      entityType: 'individual',
      prefill: PREFILL,
      urls: URLS,
    };
    const a = await service.startOnboarding(input);
    const b = await service.startOnboarding(input);
    expect(b.account.stripeAccountId).toBe(a.account.stripeAccountId);
    expect(fake.callsTo('POST', '/v2/core/accounts')).toHaveLength(1);
    expect(db.accounts).toHaveLength(1);
  });

  it('dos connect A LA VEZ → la misma clave de idempotencia, una cuenta', async () => {
    const input = {
      tenantId: TENANT_A,
      country: 'ES',
      entityType: 'individual',
      prefill: PREFILL,
      urls: URLS,
    };
    const [a, b] = await Promise.all([
      service.startOnboarding(input),
      service.startOnboarding(input),
    ]);
    expect(b.account.stripeAccountId).toBe(a.account.stripeAccountId);
    const creates = fake.callsTo('POST', '/v2/core/accounts');
    expect(new Set(creates.map((c) => c.options.idempotencyKey)).size).toBe(1);
    expect(db.accounts).toHaveLength(1);
  });

  it('otro país con un alta ya empezada → 409, sin crear otra cuenta', async () => {
    await service.startOnboarding({
      tenantId: TENANT_A,
      country: 'ES',
      entityType: 'individual',
      prefill: PREFILL,
      urls: URLS,
    });
    await expect(
      service.startOnboarding({
        tenantId: TENANT_A,
        country: 'FR',
        entityType: 'individual',
        prefill: PREFILL,
        urls: URLS,
      }),
    ).rejects.toBeInstanceOf(PayoutsAccountAlreadyStartedError);
    expect(fake.callsTo('POST', '/v2/core/accounts')).toHaveLength(1);
  });

  it('tipo de titular no válido → 400 sin llamar a Stripe', async () => {
    await expect(
      service.startOnboarding({
        tenantId: TENANT_A,
        country: 'ES',
        entityType: 'ong',
        prefill: PREFILL,
        urls: URLS,
      }),
    ).rejects.toBeInstanceOf(PayoutsInvalidEntityTypeError);
    expect(fake.calls).toHaveLength(0);
  });

  it('dominio que Stripe no acepta → reintenta sin web (y con otra clave)', async () => {
    fake.failNext('/v2/core/accounts', {
      message: 'Invalid URL.',
      status: 400,
      stripeCode: 'url_invalid',
      param: 'defaults.profile.business_url',
    });
    const result = await service.startOnboarding({
      tenantId: TENANT_A,
      country: 'ES',
      entityType: 'company',
      prefill: PREFILL,
      urls: URLS,
    });
    expect(result.account.stripeAccountId).toMatch(/^acct_/);
    const creates = fake.callsTo('POST', '/v2/core/accounts');
    expect(creates).toHaveLength(2);
    const profile = (creates[1]!.params['defaults'] as Record<string, Record<string, unknown>>)[
      'profile'
    ];
    expect(profile).not.toHaveProperty('business_url');
    expect(profile).toHaveProperty('product_description');
    expect(creates[1]!.options.idempotencyKey).toMatch(/:sin-url$/);
  });

  it('alternativa v1: POST /v1/accounts con controller y versión de vista previa', async () => {
    const built = buildFake('v1');
    const v1 = new PayoutsAccountsService(db, built.api, CONFIG, { retryDelayMs: 0 });
    await v1.startOnboarding({
      tenantId: TENANT_A,
      country: 'ES',
      entityType: 'individual',
      prefill: PREFILL,
      urls: URLS,
    });
    const [create] = built.fake.callsTo('POST', '/v1/accounts');
    expect(create!.options.apiVersion).toBe('2026-10-28.preview');
    expect(create!.params).toMatchObject({
      country: 'ES',
      business_type: 'individual',
      controller: {
        stripe_dashboard: { type: 'express' },
        fees: { payer: 'application' },
        losses: { payments: 'stripe' },
        requirement_collection: 'stripe',
      },
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      business_profile: { mcc: '8299' },
    });
  });

  it('syncAccount consulta Stripe SIEMPRE y sella ready_at al llegar a READY (una sola vez)', async () => {
    const { account } = await service.startOnboarding({
      tenantId: TENANT_A,
      country: 'ES',
      entityType: 'individual',
      prefill: PREFILL,
      urls: URLS,
    });
    const acct = account.stripeAccountId!;
    expect(account.readyAt).toBeNull();

    // Stripe la da por lista (respuesta real de una cuenta lista).
    fake.seed({
      ...(recorded['es_lista']!.account as unknown as Record<string, unknown>),
      id: acct,
    });
    const before = fake.callsTo('GET', `/v1/accounts/${acct}`).length;
    const ready = await service.syncAccount(TENANT_A);
    expect(fake.callsTo('GET', `/v1/accounts/${acct}`).length).toBe(before + 1);
    expect(ready.status).toBe('READY');
    expect(ready.readyAt).not.toBeNull();
    expect(ready.payoutSchedule).toMatchObject({
      interval: 'weekly',
      weeklyDay: 'monday',
      delayDays: 7,
      minimumBalance: { eur: 5000 },
    });

    // Luego la restringen: el estado baja, el sello NO se borra ni se mueve.
    fake.patch(acct, {
      requirements: { past_due: ['external_account'], currently_due: ['external_account'] },
    });
    const restricted = await service.syncAccount(TENANT_A);
    expect(restricted.status).toBe('RESTRICTED');
    expect(restricted.pendingRequirement).toBe('bank_account');
    expect(restricted.readyAt).toBe(ready.readyAt);
  });

  it('syncAccount con un acct_ que ya no es la cuenta viva no toca nada', async () => {
    const { account } = await service.startOnboarding({
      tenantId: TENANT_A,
      country: 'ES',
      entityType: 'individual',
      prefill: PREFILL,
      urls: URLS,
    });
    const calls = fake.calls.length;
    const view = await service.syncAccount(TENANT_A, 'acct_OtraCuentaQueNoEs');
    expect(view.stripeAccountId).toBe(account.stripeAccountId);
    expect(fake.calls.length).toBe(calls);
  });

  it('el tenant B no ve ni sincroniza la cuenta de A', async () => {
    await service.startOnboarding({
      tenantId: TENANT_A,
      country: 'ES',
      entityType: 'individual',
      prefill: PREFILL,
      urls: URLS,
    });
    expect(await service.getAccount(TENANT_B)).toBeNull();
    await expect(service.syncAccount(TENANT_B)).rejects.toBeInstanceOf(PayoutsAccountNotFoundError);
    await expect(service.dashboardLink(TENANT_B)).rejects.toBeInstanceOf(
      PayoutsAccountNotFoundError,
    );
    await expect(service.refreshLink(TENANT_B, URLS)).rejects.toBeInstanceOf(
      PayoutsAccountNotFoundError,
    );
  });

  it('un acct_ ya registrado a nombre de otro tenant no se reasigna', async () => {
    const { account } = await service.startOnboarding({
      tenantId: TENANT_A,
      country: 'ES',
      entityType: 'individual',
      prefill: PREFILL,
      urls: URLS,
    });
    // Un doble de Stripe que devolviera la MISMA cuenta a B (imposible en
    // Stripe con claves distintas, pero el registro debe resistirlo).
    fake.on('POST', '/v2/core/accounts', () => ({ id: account.stripeAccountId!, livemode: false }));
    await expect(
      service.startOnboarding({
        tenantId: TENANT_B,
        country: 'ES',
        entityType: 'individual',
        prefill: PREFILL,
        urls: URLS,
      }),
    ).rejects.toBeInstanceOf(PayoutsObjectRefConflictError);
  });

  it('enlace al panel antes de terminar el alta → 409 de dominio, no un 502', async () => {
    await service.startOnboarding({
      tenantId: TENANT_A,
      country: 'ES',
      entityType: 'individual',
      prefill: PREFILL,
      urls: URLS,
    });
    fake.failNext(/login_links$/, {
      message: accountsFixture.links.loginLinkSinAlta.message,
      status: 400,
    });
    await expect(service.dashboardLink(TENANT_A)).rejects.toBeInstanceOf(
      PayoutsAccountOnboardingIncompleteError,
    );
  });

  it('días de retención distintos: se intentan y, si Stripe los rechaza, se aplica el resto', async () => {
    const warnings: string[] = [];
    const built = buildFake();
    const svc = new PayoutsAccountsService(
      db,
      built.api,
      { ...CONFIG, payout: { ...CONFIG.payout, delayDays: 14 } },
      { retryDelayMs: 0, logger: { warn: (_o, msg) => warnings.push(msg) } },
    );
    const { account } = await svc.startOnboarding({
      tenantId: TENANT_A,
      country: 'ES',
      entityType: 'individual',
      prefill: PREFILL,
      urls: URLS,
    });
    const posts = built.fake.callsTo('POST', '/v1/balance_settings');
    expect(posts).toHaveLength(2);
    expect(posts[0]!.params).toMatchObject({
      payments: { settlement_timing: { delay_days_override: 14 } },
    });
    expect(posts[1]!.params['payments']).not.toHaveProperty('settlement_timing');
    expect(account.payoutSchedule).toMatchObject({ interval: 'weekly' });
    expect(warnings.some((w) => w.includes('días de retención'))).toBe(true);
  });

  it('si Stripe falla al fijar el calendario, el alta sigue y la siguiente sincronización lo reintenta', async () => {
    fake.failNext('/v1/balance_settings', { message: 'boom', status: 500, method: 'GET' });
    const { account, onboardingUrl } = await service.startOnboarding({
      tenantId: TENANT_A,
      country: 'ES',
      entityType: 'individual',
      prefill: PREFILL,
      urls: URLS,
    });
    expect(onboardingUrl).not.toBeNull();
    expect(account.payoutSchedule).toBeNull();
    const pending = await service.listAccountsToSync({ ready: false });
    expect(pending).toEqual([
      expect.objectContaining({ tenantId: TENANT_A, hasSchedule: false, status: 'ONBOARDING' }),
    ]);
    expect(await service.listAccountsToSync({ ready: true })).toEqual([]);

    // Vuelta del alta / evento / worker: syncAccount lo reintenta y ya entra.
    const synced = await service.syncAccount(TENANT_A);
    expect(synced.payoutSchedule).toMatchObject({ interval: 'weekly', weeklyDay: 'monday' });
    expect(fake.callsTo('POST', '/v1/balance_settings')).toHaveLength(1);
  });
});
