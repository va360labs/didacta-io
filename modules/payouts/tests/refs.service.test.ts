import { beforeEach, describe, expect, it } from 'vitest';
import { PayoutsInvalidObjectRefError, PayoutsObjectRefConflictError } from '../src/errors.js';
import { RefsService, type RegisterObjectRefInput } from '../src/refs.service.js';
import { buildPayoutsModule, manifest } from '../src/index.js';

// ============================================================================
// RefsService — registro `objeto de Stripe → tenant`, con un Prisma en memoria
// que imita la PK global de `stripe_object_id` y la visibilidad por tenant de
// RLS. El comportamiento contra Postgres real lo cubre
// `apps/api/tests/integration/payouts-foundations.integration.test.ts`.
// ============================================================================

interface Row {
  stripeObjectId: string;
  tenantId: string;
  kind: string;
  source: string;
  localRef: string | null;
  parentObjectId: string | null;
  livemode: boolean;
  createdAt: Date;
}

class MockPrisma {
  rows: Row[] = [];
  /** Tenant del contexto (RLS). `null` = acceso global sancionado. */
  visibleTenant: string | null = null;

  private visible(): Row[] {
    return this.visibleTenant === null
      ? this.rows
      : this.rows.filter((r) => r.tenantId === this.visibleTenant);
  }

  modPayoutsObjectRef = {
    createMany: async ({ data, skipDuplicates }: never) => {
      let count = 0;
      for (const item of data as Array<Omit<Row, 'createdAt'>>) {
        if (this.rows.some((r) => r.stripeObjectId === item.stripeObjectId)) {
          if (skipDuplicates) continue;
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        this.rows.push({ ...item, createdAt: new Date() });
        count += 1;
      }
      return { count };
    },
    findUnique: async ({ where }: never) =>
      this.visible().find(
        (r) => r.stripeObjectId === (where as { stripeObjectId: string }).stripeObjectId,
      ) ?? null,
    findMany: async ({ where }: never) =>
      this.visible()
        .filter((r) => matchesWhere(r, where))
        .sort((a, b) => a.stripeObjectId.localeCompare(b.stripeObjectId)),
    findFirst: async ({ where }: never) =>
      this.visible().find((r) => matchesWhere(r, where)) ?? null,
  };
}

/** El subconjunto de `where` de Prisma que usa RefsService. */
function matchesWhere(row: Row, where: unknown): boolean {
  const w = where as {
    OR?: unknown[];
    stripeObjectId?: { in: string[] };
    parentObjectId?: { in: string[] };
    localRef?: { in: string[] };
    kind?: string;
  };
  if (w.OR) return w.OR.some((inner) => matchesWhere(row, inner));
  if (w.stripeObjectId && !w.stripeObjectId.in.includes(row.stripeObjectId)) return false;
  if (w.parentObjectId && !w.parentObjectId.in.includes(row.parentObjectId ?? '')) return false;
  if (w.localRef && !w.localRef.in.includes(row.localRef ?? '')) return false;
  if (w.kind !== undefined && row.kind !== w.kind) return false;
  return true;
}

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function sesion(overrides: Partial<RegisterObjectRefInput> = {}): RegisterObjectRefInput {
  return {
    tenantId: TENANT_A,
    stripeObjectId: 'cs_test_a1B2c3',
    kind: 'checkout_session',
    source: 'billing',
    localRef: 'orden-1',
    livemode: false,
    ...overrides,
  };
}

let prisma: MockPrisma;
let refs: RefsService;

beforeEach(() => {
  prisma = new MockPrisma();
  refs = new RefsService(prisma as never);
});

describe('RefsService.register', () => {
  it('registra el objeto a nombre del tenant', async () => {
    expect(await refs.register(sesion())).toEqual({ created: true });
    expect(prisma.rows).toEqual([
      expect.objectContaining({
        stripeObjectId: 'cs_test_a1B2c3',
        tenantId: TENANT_A,
        kind: 'checkout_session',
        source: 'billing',
        localRef: 'orden-1',
        parentObjectId: null,
        livemode: false,
      }),
    ]);
  });

  it('registrar dos veces lo mismo es un reintento: una fila, sin error', async () => {
    await refs.register(sesion());
    expect(await refs.register(sesion())).toEqual({ created: false });
    expect(prisma.rows).toHaveLength(1);
  });

  it('el mismo objeto con OTRO tenant lanza y no se reasigna', async () => {
    await refs.register(sesion());

    const error = await refs.register(sesion({ tenantId: TENANT_B })).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PayoutsObjectRefConflictError);
    expect((error as PayoutsObjectRefConflictError).code).toBe('PAYOUTS_REF_CONFLICT');
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]!.tenantId).toBe(TENANT_A);
  });

  it('lo mismo bajo RLS: B no ve la fila de A, y aun así no puede quedársela', async () => {
    prisma.visibleTenant = TENANT_A;
    await refs.register(sesion());

    prisma.visibleTenant = TENANT_B;
    await expect(refs.register(sesion({ tenantId: TENANT_B }))).rejects.toBeInstanceOf(
      PayoutsObjectRefConflictError,
    );
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]!.tenantId).toBe(TENANT_A);
  });

  it('el mismo objeto con otra clase o en otro modo también es conflicto', async () => {
    await refs.register(sesion());
    await expect(refs.register(sesion({ kind: 'payment_intent' }))).rejects.toBeInstanceOf(
      PayoutsObjectRefConflictError,
    );
    await expect(refs.register(sesion({ livemode: true }))).rejects.toBeInstanceOf(
      PayoutsObjectRefConflictError,
    );
  });

  it.each([
    ['id vacío', { stripeObjectId: '' }],
    ['id sin prefijo', { stripeObjectId: 'a1B2c3' }],
    ['id con espacios', { stripeObjectId: 'cs_test a1' }],
    ['id que es un uuid', { stripeObjectId: TENANT_A }],
    ['clase desconocida', { kind: 'evento' as never }],
    ['origen desconocido', { source: 'referrals' as never }],
  ])('rechaza %s sin escribir', async (_nombre, cambio) => {
    await expect(refs.register(sesion(cambio))).rejects.toBeInstanceOf(
      PayoutsInvalidObjectRefError,
    );
    expect(prisma.rows).toHaveLength(0);
  });

  it('registerMany registra en orden y cuenta solo los nuevos', async () => {
    await refs.register(sesion());
    const resultado = await refs.registerMany([
      sesion(),
      sesion({
        stripeObjectId: 'pi_3Abc',
        kind: 'payment_intent',
        parentObjectId: 'cs_test_a1B2c3',
      }),
      sesion({ stripeObjectId: 'cus_Xyz', kind: 'customer', parentObjectId: 'cs_test_a1B2c3' }),
    ]);
    expect(resultado).toEqual({ created: 2 });
    expect(prisma.rows.map((r) => r.stripeObjectId)).toEqual([
      'cs_test_a1B2c3',
      'pi_3Abc',
      'cus_Xyz',
    ]);
  });
});

describe('RefsService.resolveTenant', () => {
  beforeEach(async () => {
    await refs.registerMany([
      sesion(),
      sesion({
        stripeObjectId: 'pi_3Abc',
        kind: 'payment_intent',
        parentObjectId: 'cs_test_a1B2c3',
      }),
      sesion({
        tenantId: TENANT_B,
        stripeObjectId: 'sub_1Def',
        kind: 'subscription',
        source: 'membership',
      }),
    ]);
  });

  it('resuelve por el id directo', async () => {
    const r = await refs.resolveTenant(['cs_test_a1B2c3']);
    expect(r).toMatchObject({ status: 'resolved', tenantId: TENANT_A });
  });

  it('resuelve un objeto sin registrar (el cargo) por su padre registrado (el pi)', async () => {
    const r = await refs.resolveTenant(['ch_3NoRegistrado', 'pi_3Abc', null, undefined]);
    expect(r).toMatchObject({ status: 'resolved', tenantId: TENANT_A });
    if (r.status === 'resolved') {
      expect(r.refs.map((ref) => ref.stripeObjectId)).toEqual(['pi_3Abc']);
    }
  });

  it('ningún id registrado → unknown («sin atribuir»)', async () => {
    expect(await refs.resolveTenant(['cs_test_deOtraCuenta', 'pi_3Zzz'])).toEqual({
      status: 'unknown',
    });
    expect(await refs.resolveTenant([])).toEqual({ status: 'unknown' });
    expect(await refs.resolveTenant([null, undefined, ''])).toEqual({ status: 'unknown' });
  });

  it('ids de DOS tenants → ambiguous, sin elegir', async () => {
    const r = await refs.resolveTenant(['pi_3Abc', 'sub_1Def']);
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') {
      expect(r.tenantIds).toEqual([TENANT_A, TENANT_B]);
      expect(r.refs).toHaveLength(2);
    }
  });

  it('dentro del contexto de un tenant no se ven los objetos de otro', async () => {
    prisma.visibleTenant = TENANT_B;
    expect(await refs.resolveTenant(['cs_test_a1B2c3'])).toEqual({ status: 'unknown' });
    expect(await refs.findByIds(['cs_test_a1B2c3', 'sub_1Def'])).toHaveLength(1);
  });
});

describe('RefsService.isPlatformObject', () => {
  it('true si algún id está registrado; false si ninguno', async () => {
    await refs.register(sesion());
    expect(await refs.isPlatformObject(['pi_3NoEsta', 'cs_test_a1B2c3'])).toBe(true);
    expect(await refs.isPlatformObject(['pi_3NoEsta'])).toBe(false);
    expect(await refs.isPlatformObject([null, undefined])).toBe(false);
  });

  it('la orden local también delata: un cs_ inventado que apunta a una orden de plataforma', async () => {
    await refs.register(sesion({ localRef: 'orden-de-plataforma' }));
    expect(
      await refs.isPlatformObject(['cs_test_inventada'], {
        checkoutLocalRefs: ['orden-de-plataforma'],
      }),
    ).toBe(true);
    expect(
      await refs.isPlatformObject(['cs_test_inventada'], { checkoutLocalRefs: ['orden-propia'] }),
    ).toBe(false);
    // Solo cuenta la orden de una SESIÓN de checkout, no el localRef de un hijo.
    await refs.register(
      sesion({
        stripeObjectId: 'pi_3Hijo',
        kind: 'payment_intent',
        localRef: 'orden-del-hijo',
        parentObjectId: 'cs_test_a1B2c3',
      }),
    );
    expect(await refs.isPlatformObject([], { checkoutLocalRefs: ['orden-del-hijo'] })).toBe(false);
  });
});

describe('RefsService.resolveTenantByParents', () => {
  it('atribuye por el hijo registrado que cuelga del id', async () => {
    await refs.register(
      sesion({ stripeObjectId: 'ch_3Cargo', kind: 'charge', parentObjectId: 'pi_3Padre' }),
    );
    const r = await refs.resolveTenantByParents(['pi_3Padre']);
    expect(r).toMatchObject({ status: 'resolved', tenantId: TENANT_A });
    expect(await refs.resolveTenantByParents(['pi_3Otro'])).toEqual({ status: 'unknown' });
    expect(await refs.resolveTenantByParents([])).toEqual({ status: 'unknown' });
  });

  it('dos tenants colgando del mismo padre → ambiguo', async () => {
    await refs.register(
      sesion({ stripeObjectId: 'ch_3A', kind: 'charge', parentObjectId: 'pi_3Comun' }),
    );
    await refs.register(
      sesion({
        tenantId: TENANT_B,
        stripeObjectId: 'ch_3B',
        kind: 'charge',
        parentObjectId: 'pi_3Comun',
      }),
    );
    expect(await refs.resolveTenantByParents(['pi_3Comun'])).toMatchObject({
      status: 'ambiguous',
      tenantIds: [TENANT_A, TENANT_B].sort(),
    });
  });
});

describe('módulo', () => {
  it('buildPayoutsModule expone el manifest de mod.payouts', () => {
    const modulo = buildPayoutsModule();
    expect(modulo.manifest).toBe(manifest);
    expect(manifest.name).toBe('mod.payouts');
    expect(manifest.tablePrefix).toBe('mod_payouts_');
    expect(manifest.apiNamespace).toBe('/modules/payouts');
    expect(manifest.dependencies.modules).toEqual([]);
  });
});
