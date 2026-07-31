import { describe, expect, it, vi } from 'vitest';
import { OrderMirrorService } from '../src/order-mirror.service.js';
import type { EntitlementRuleset } from '../src/entitlement-rules.js';
import type { ExternalOrderRecord } from '../src/woocommerce-reader.client.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CONN = '22222222-2222-2222-2222-222222222222';

const DEMO: EntitlementRuleset = {
  rules: [
    { match: /^vps\b/i, kind: 'INFRA' },
    { match: /lifetime/i, kind: 'LIFETIME' },
    { match: /acceso\s+anual\s+a\s+demo/i, kind: 'TIMED', durationMonths: 12 },
    { match: /demo\s*pro/i, kind: 'SUBSCRIPTION' },
  ],
  fallback: 'ONE_OFF',
};

function order(over: Partial<ExternalOrderRecord> = {}): ExternalOrderRecord {
  return {
    externalId: '15809',
    orderNumber: '15809',
    status: 'completed',
    total: 29700,
    currency: 'eur',
    customerEmail: 'cliente@example.com',
    customerName: 'cliente ejemplo',
    placedAt: '2026-07-17T10:00:00.000Z',
    paidAt: '2026-07-17T10:01:00.000Z',
    refundedAt: null,
    items: [
      {
        name: 'Master en Automatizaciones y Agentes IA',
        productId: '12023',
        total: 29700,
        quantity: 1,
      },
    ],
    ...over,
  };
}

function setup(orders: ExternalOrderRecord[], usuarios: Array<{ id: string; email: string }> = []) {
  const creados: Record<string, unknown>[] = [];
  const actualizados: Record<string, unknown>[] = [];
  const existentes = new Map<string, string>();

  const prisma = {
    modPaymentConnectionsOrder: {
      findFirst: vi.fn(({ where }: { where: { externalId: string } }) =>
        Promise.resolve(
          existentes.has(where.externalId) ? { id: existentes.get(where.externalId) } : null,
        ),
      ),
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        creados.push(data);
        return Promise.resolve(data);
      }),
      update: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        actualizados.push(data);
        return Promise.resolve(data);
      }),
      updateMany: vi.fn(() => Promise.resolve({ count: 3 })),
      findMany: vi.fn(() => Promise.resolve([])),
    },
    user: { findMany: vi.fn(() => Promise.resolve(usuarios)) },
  };

  const adapter = {
    listAllOrders: vi.fn(() => Promise.resolve(orders)),
    productTypesById: vi.fn(() => Promise.resolve(new Map([['7941', 'simple']]))),
  };

  const service = new OrderMirrorService(prisma as never);
  return { service, prisma, adapter, creados, actualizados, existentes };
}

describe('OrderMirrorService · un pedido real de la tienda', () => {
  it('lo guarda con importe, fecha y clasificación de compra suelta', async () => {
    const { service, adapter, creados } = setup(
      [order()],
      [{ id: 'u-cliente', email: 'cliente@example.com' }],
    );

    const r = await service.mirrorWooCommerce(TENANT, CONN, adapter as never, { ruleset: DEMO });

    expect(r.leidos).toBe(1);
    expect(r.creados).toBe(1);
    expect(r.pagados).toBe(1);
    expect(r.totalCobrado).toBe(29700);
    expect(r.porTipo.ONE_OFF).toBe(1);

    const fila = creados[0]!;
    expect(fila.userId).toBe('u-cliente');
    expect(fila.totalAmount).toBe(29700);
    expect(fila.entitlementKind).toBe('ONE_OFF');
    expect(fila.paid).toBe(true);
    // Una compra suelta no caduca jamás.
    expect(fila.accessEndsAt).toBeNull();
  });
});

describe('OrderMirrorService · clasificación al reflejar', () => {
  it('un lifetime no recibe fecha de caducidad', async () => {
    const { service, adapter, creados } = setup([
      order({
        externalId: '900',
        items: [{ name: 'DEMO PRO LIFETIME', productId: '11921', total: 99797, quantity: 1 }],
      }),
    ]);
    await service.mirrorWooCommerce(TENANT, CONN, adapter as never, { ruleset: DEMO });
    expect(creados[0]!.entitlementKind).toBe('LIFETIME');
    expect(creados[0]!.accessEndsAt).toBeNull();
  });

  it('«Acceso ANUAL a DEMO» caduca al año de haberse pagado', async () => {
    const { service, adapter, creados } = setup([
      order({
        externalId: '901',
        paidAt: '2026-03-10T09:00:00.000Z',
        items: [{ name: 'Acceso ANUAL a DEMO', productId: '7941', total: 19797, quantity: 1 }],
      }),
    ]);
    await service.mirrorWooCommerce(TENANT, CONN, adapter as never, { ruleset: DEMO });
    expect(creados[0]!.entitlementKind).toBe('TIMED');
    expect((creados[0]!.accessEndsAt as Date).toISOString().slice(0, 10)).toBe('2027-03-10');
  });

  it('si no hay fecha de pago, la vigencia cuenta desde la fecha del pedido', async () => {
    const { service, adapter, creados } = setup([
      order({
        externalId: '902',
        paidAt: null,
        placedAt: '2026-05-01T00:00:00.000Z',
        items: [{ name: 'Acceso ANUAL a DEMO', productId: '7941', total: 19797, quantity: 1 }],
      }),
    ]);
    await service.mirrorWooCommerce(TENANT, CONN, adapter as never, { ruleset: DEMO });
    expect((creados[0]!.accessEndsAt as Date).toISOString().slice(0, 10)).toBe('2027-05-01');
  });

  it('una suscripción no lleva accessEndsAt: la mantiene la pasarela, no nosotros', async () => {
    const { service, adapter, creados } = setup([
      order({
        externalId: '903',
        items: [{ name: 'DEMO PRO ANUAL', productId: '11551', total: 19797, quantity: 1 }],
      }),
    ]);
    await service.mirrorWooCommerce(TENANT, CONN, adapter as never, { ruleset: DEMO });
    expect(creados[0]!.entitlementKind).toBe('SUBSCRIPTION');
    expect(creados[0]!.accessEndsAt).toBeNull();
  });

  it('un pedido con VPS y un curso se clasifica por el curso, no por el VPS', async () => {
    const { service, adapter, creados } = setup([
      order({
        externalId: '904',
        items: [
          { name: 'VPS Iniciación', productId: '13185', total: 899, quantity: 1 },
          { name: 'Curso de N8N', productId: '5000', total: 9700, quantity: 1 },
        ],
      }),
    ]);
    await service.mirrorWooCommerce(TENANT, CONN, adapter as never, { ruleset: DEMO });
    expect(creados[0]!.entitlementKind).toBe('ONE_OFF');
  });

  it('guarda la clasificación de cada línea para poder auditarla', async () => {
    const { service, adapter, creados } = setup([
      order({
        externalId: '905',
        items: [
          { name: 'VPS Plus', productId: '13315', total: 1199, quantity: 1 },
          { name: 'DEMO PRO LIFETIME', productId: '11921', total: 99797, quantity: 1 },
        ],
      }),
    ]);
    await service.mirrorWooCommerce(TENANT, CONN, adapter as never, { ruleset: DEMO });
    const items = creados[0]!.items as Array<{ name: string; kind: string; reason: string }>;
    expect(items).toHaveLength(2);
    expect(items[0]!.kind).toBe('INFRA');
    expect(items[1]!.kind).toBe('LIFETIME');
    expect(items[0]!.reason).toBeTruthy();
  });
});

describe('OrderMirrorService · dinero y estados', () => {
  it('un pedido fallido no cuenta como cobrado', async () => {
    const { service, adapter } = setup([order({ externalId: '906', status: 'failed' })]);
    const r = await service.mirrorWooCommerce(TENANT, CONN, adapter as never, { ruleset: DEMO });
    expect(r.pagados).toBe(0);
    expect(r.totalCobrado).toBe(0);
  });

  it('un pedido devuelto no cuenta como cobrado', async () => {
    const { service, adapter, creados } = setup([
      order({ externalId: '907', status: 'refunded', refundedAt: '2026-07-20T00:00:00.000Z' }),
    ]);
    const r = await service.mirrorWooCommerce(TENANT, CONN, adapter as never, { ruleset: DEMO });
    expect(r.pagados).toBe(0);
    expect(creados[0]!.paid).toBe(false);
    expect(creados[0]!.refundedAt).toBeInstanceOf(Date);
  });

  it('`processing` sí cuenta: el dinero está cobrado aunque el pedido siga abierto', async () => {
    const { service, adapter } = setup([order({ externalId: '908', status: 'processing' })]);
    const r = await service.mirrorWooCommerce(TENANT, CONN, adapter as never, { ruleset: DEMO });
    expect(r.pagados).toBe(1);
    expect(r.totalCobrado).toBe(29700);
  });
});

describe('OrderMirrorService · cruce con las cuentas', () => {
  it('guarda el pedido aunque el email no sea de ninguna cuenta', async () => {
    // El email de facturación puede ser el de la pasarela de pago. Perder el
    // pedido por eso sería peor que guardarlo huérfano.
    const { service, adapter, creados } = setup([order({ externalId: '909' })], []);
    const r = await service.mirrorWooCommerce(TENANT, CONN, adapter as never, { ruleset: DEMO });
    expect(r.sinCuenta).toBe(1);
    expect(r.creados).toBe(1);
    expect(creados[0]!.userId).toBeNull();
  });

  it('cruza el email sin distinguir mayúsculas', async () => {
    const { service, adapter, creados } = setup(
      [order({ externalId: '910', customerEmail: 'cliente@example.com' })],
      [{ id: 'u1', email: 'CLIENTE@Example.COM' }],
    );
    await service.mirrorWooCommerce(TENANT, CONN, adapter as never, { ruleset: DEMO });
    expect(creados[0]!.userId).toBe('u1');
  });

  it('descarta los pedidos sin email en vez de inventarse un dueño', async () => {
    const { service, adapter } = setup([order({ externalId: '911', customerEmail: '' })]);
    const r = await service.mirrorWooCommerce(TENANT, CONN, adapter as never, { ruleset: DEMO });
    expect(r.descartadosSinEmail).toBe(1);
    expect(r.creados).toBe(0);
  });
});

describe('OrderMirrorService · idempotencia', () => {
  it('reimportar actualiza, no duplica', async () => {
    const { service, adapter, existentes, creados, actualizados } = setup([order()]);
    existentes.set('15809', 'fila-ya-existente');

    const r = await service.mirrorWooCommerce(TENANT, CONN, adapter as never, { ruleset: DEMO });
    expect(r.creados).toBe(0);
    expect(r.actualizados).toBe(1);
    expect(creados).toHaveLength(0);
    expect(actualizados).toHaveLength(1);
  });

  it('el sync incremental pide solo lo modificado', async () => {
    const { service, adapter } = setup([]);
    const desde = new Date('2026-07-01T00:00:00.000Z');
    await service.mirrorWooCommerce(TENANT, CONN, adapter as never, { modifiedAfter: desde });
    expect(adapter.listAllOrders).toHaveBeenCalledWith(
      expect.objectContaining({ modifiedAfter: desde }),
    );
  });

  it('sigue adelante si el catálogo de productos falla', async () => {
    // Sin tipos de producto se clasifica solo por nombre, que es peor pero no
    // rompe el espejo entero.
    const { service, adapter, creados } = setup([order({ externalId: '912' })]);
    adapter.productTypesById = vi.fn(() => Promise.reject(new Error('500')));
    const r = await service.mirrorWooCommerce(TENANT, CONN, adapter as never, { ruleset: DEMO });
    expect(r.creados).toBe(1);
    expect(creados[0]!.entitlementKind).toBe('ONE_OFF');
  });
});

describe('OrderMirrorService · reclamar pedidos huérfanos', () => {
  it('asigna al usuario los pedidos que quedaron sin dueño', async () => {
    const { service, prisma } = setup([]);
    const n = await service.claimOrphanOrders(TENANT, 'u-nuevo', '  CLIENTE@Example.COM ');
    expect(n).toBe(3);
    expect(prisma.modPaymentConnectionsOrder.updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, userId: null, customerEmail: 'cliente@example.com' },
      data: { userId: 'u-nuevo' },
    });
  });
});
