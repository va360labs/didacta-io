import { describe, expect, it, vi } from 'vitest';
import { IntegrationsService } from './integrations.service';
import { listSubscriptionsQuerySchema } from './integrations.dto';

/**
 * `GET /integrations/subscriptions`: la tabla de suscriptores de
 * mod.payment-connections, para que un CRM la sincronice.
 *
 * Lo que se fija aquí:
 *  1. **Siempre por tenant.** La consulta lleva el `tenantId` de la clave, y
 *     `updatedSince` se suma a él, no lo sustituye.
 *  2. **`updatedSince` mira también `lastSeenAt`.** Una suscripción que el sync
 *     vuelve a ver sin cambios no toca `updatedAt`, pero sí dice que sigue viva.
 *  3. **Orden estable** para que paginar con `offset` no salte filas.
 *  4. **Fechas en ISO y el email con el nombre que espera quien integra.**
 */

const TENANT = '11111111-1111-1111-1111-111111111111';

function setup(filas: Record<string, unknown>[] = []) {
  const prisma = {
    modPaymentConnectionsSubscriber: {
      findMany: vi.fn().mockResolvedValue(filas),
      count: vi.fn().mockResolvedValue(filas.length),
      aggregate: vi.fn().mockResolvedValue({ _max: { lastSeenAt: new Date('2026-10-19T08:15:00Z') } }),
    },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new IntegrationsService(prisma as never, {} as never, logger as never);
  return { prisma, service };
}

const fila = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  provider: 'stripe',
  subscriptionId: 'sub_123',
  userEmail: 'ana@ejemplo.com',
  userId: null,
  status: 'active',
  statusCategory: 'active',
  entitled: true,
  productName: 'Comunidad anual',
  unitAmount: 32700,
  currency: 'eur',
  interval: 'year',
  currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
  lastSeenAt: new Date('2026-10-19T08:15:00Z'),
  updatedAt: new Date('2026-10-18T10:00:00Z'),
};

describe('GET /integrations/subscriptions', () => {
  it('filtra por tenant, ordena de forma estable y pagina con lo pedido', async () => {
    const { prisma, service } = setup([fila]);
    const query = listSubscriptionsQuerySchema.parse({ limit: '100', offset: '200' });
    await service.listSubscriptions(TENANT, query);

    const args = prisma.modPaymentConnectionsSubscriber.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({ tenantId: TENANT });
    expect(args.orderBy).toEqual([{ updatedAt: 'asc' }, { id: 'asc' }]);
    expect(args.take).toBe(100);
    expect(args.skip).toBe(200);
  });

  it('con updatedSince trae lo que cambió o se volvió a ver, sin salir del tenant', async () => {
    const { prisma, service } = setup();
    const query = listSubscriptionsQuerySchema.parse({ updatedSince: '2026-10-19T00:00:00.000Z' });
    await service.listSubscriptions(TENANT, query);

    const desde = new Date('2026-10-19T00:00:00.000Z');
    expect(prisma.modPaymentConnectionsSubscriber.findMany.mock.calls[0]![0].where).toEqual({
      tenantId: TENANT,
      OR: [{ updatedAt: { gte: desde } }, { lastSeenAt: { gte: desde } }],
    });
  });

  it('devuelve las fechas en ISO, el email como `email` y la frescura del sync', async () => {
    const { service } = setup([fila]);
    const r = await service.listSubscriptions(TENANT, listSubscriptionsQuerySchema.parse({}));

    expect(r.total).toBe(1);
    expect(r.limit).toBe(200);
    expect(r.offset).toBe(0);
    expect(r.lastSyncAt).toBe('2026-10-19T08:15:00.000Z');
    expect(r.items[0]).toMatchObject({
      email: 'ana@ejemplo.com',
      statusCategory: 'active',
      entitled: true,
      unitAmount: 32700,
      currentPeriodEnd: '2026-11-01T00:00:00.000Z',
      lastSeenAt: '2026-10-19T08:15:00.000Z',
    });
  });

  it('rechaza páginas de más de 500 y fechas que no son ISO', () => {
    expect(() => listSubscriptionsQuerySchema.parse({ limit: '501' })).toThrow();
    expect(() => listSubscriptionsQuerySchema.parse({ updatedSince: 'ayer' })).toThrow();
  });
});
