import { describe, expect, it, vi } from 'vitest';
import { IntegrationsService } from './integrations.service';
import { upsertExternalOrderSchema } from './integrations.dto';

/**
 * Las compras hechas fuera: el historial del alumno cuando la tienda no es esta.
 *
 * Lo que se fija aquí no es que Prisma sepa escribir —eso lo sabe—, sino las
 * cuatro decisiones que hacen que esto no se rompa en producción, que son las
 * que se pierden cuando alguien toque el servicio dentro de seis meses:
 *
 *  1. **La idempotencia es la clave `(tenant, source, reference)`.** Quien llama
 *     es un webhook de cobro, y un webhook se reintenta.
 *  2. **Lo que se omite no se borra.** La factura llega en una segunda llamada,
 *     media hora después; esa llamada no puede vaciar lo que ya había, y la
 *     primera no puede tirar una factura que ya estuviera puesta.
 *  3. **La lectura busca por cuenta Y por email.** Solo por la cuenta se
 *     perderían los pedidos anteriores a que existiera.
 *  4. **`/me/purchases` no acepta a quién mirar.** El sujeto es el token.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

function setup(over: { user?: { id: string; name?: string | null; email?: string } | null } = {}) {
  const usuario =
    over.user === undefined ? { id: USER, name: 'Ana', email: 'ana@ejemplo.com' } : over.user;
  const prisma = {
    user: {
      findFirst: vi.fn().mockResolvedValue(usuario),
    },
    externalOrder: {
      upsert: vi.fn().mockImplementation(({ create }: { create: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          source: 'va360.academy',
          reference: 'VA-260818-2PQ9TU',
          status: 'PAID',
          amountCents: 4770,
          currency: 'eur',
          lines: [],
          invoiceNumber: null,
          invoiceIssuedAt: null,
          invoiceUrl: null,
          orderUrl: null,
          placedAt: new Date('2026-08-18T09:12:00.000Z'),
          refundedAt: null,
          userId: (create.userId as string | null) ?? null,
        }),
      ),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  const logger = { log: vi.fn(), warn: vi.fn() };
  const service = new IntegrationsService(prisma as never, {} as never, logger as never);
  return { service, prisma };
}

const PEDIDO = {
  email: 'Ana@Ejemplo.com',
  source: 'va360.academy',
  reference: 'VA-260818-2PQ9TU',
  amountCents: 4770,
  placedAt: '2026-08-18T09:12:00.000Z',
};

describe('compras hechas fuera — escritura', () => {
  it('escribe con la clave de idempotencia (tenant, source, reference)', async () => {
    const { service, prisma } = setup();
    await service.upsertExternalOrder(TENANT, upsertExternalOrderSchema.parse(PEDIDO));

    const args = prisma.externalOrder.upsert.mock.calls[0]![0] as {
      where: { tenantId_source_reference: Record<string, string> };
    };
    expect(args.where.tenantId_source_reference).toEqual({
      tenantId: TENANT,
      source: 'va360.academy',
      reference: 'VA-260818-2PQ9TU',
    });
  });

  it('guarda el correo en minúsculas: es la clave con la que se vuelve a preguntar', async () => {
    const { service, prisma } = setup();
    await service.upsertExternalOrder(TENANT, upsertExternalOrderSchema.parse(PEDIDO));

    const args = prisma.externalOrder.upsert.mock.calls[0]![0] as {
      create: { email: string };
    };
    expect(args.create.email).toBe('ana@ejemplo.com');
  });

  it('ata el pedido a la cuenta cuando el email ya existe en el aula', async () => {
    const { service, prisma } = setup();
    await service.upsertExternalOrder(TENANT, upsertExternalOrderSchema.parse(PEDIDO));

    const args = prisma.externalOrder.upsert.mock.calls[0]![0] as {
      create: { userId: string | null };
    };
    expect(args.create.userId).toBe(USER);
  });

  it('acepta el pedido aunque esa persona todavía no exista en el aula', async () => {
    const { service } = setup({ user: null });
    const guardado = await service.upsertExternalOrder(
      TENANT,
      upsertExternalOrderSchema.parse(PEDIDO),
    );
    // Es el caso normal: la tienda cobra y manda el pedido ANTES de llamar a
    // `/inscribe`. Rechazarlo aquí obligaría a la tienda a ordenar sus llamadas.
    expect(guardado.linkedToUser).toBe(false);
  });

  it('NO desata un pedido ya enlazado si hoy el email no resuelve', async () => {
    const { service, prisma } = setup({ user: null });
    await service.upsertExternalOrder(TENANT, upsertExternalOrderSchema.parse(PEDIDO));

    const args = prisma.externalOrder.upsert.mock.calls[0]![0] as {
      update: Record<string, unknown>;
    };
    expect(args.update).not.toHaveProperty('userId');
  });

  it('sin `invoice`, la actualización NO toca la factura que ya hubiera', async () => {
    const { service, prisma } = setup();
    await service.upsertExternalOrder(TENANT, upsertExternalOrderSchema.parse(PEDIDO));

    const args = prisma.externalOrder.upsert.mock.calls[0]![0] as {
      update: Record<string, unknown>;
    };
    expect(args.update).not.toHaveProperty('invoiceNumber');
    expect(args.update).not.toHaveProperty('invoiceUrl');
  });

  it('con `invoice`, la escribe — y ese es el segundo viaje de la tienda', async () => {
    const { service, prisma } = setup();
    await service.upsertExternalOrder(
      TENANT,
      upsertExternalOrderSchema.parse({
        ...PEDIDO,
        invoice: {
          number: 'F-2026-0412',
          issuedAt: '2026-08-18T10:00:00.000Z',
          url: 'https://va360.academy/cuenta/factura/1234',
        },
      }),
    );

    const args = prisma.externalOrder.upsert.mock.calls[0]![0] as {
      update: { invoiceNumber: string; invoiceUrl: string };
    };
    expect(args.update.invoiceNumber).toBe('F-2026-0412');
    expect(args.update.invoiceUrl).toBe('https://va360.academy/cuenta/factura/1234');
  });
});

describe('compras hechas fuera — lectura', () => {
  it('busca por cuenta Y por email cuando el alumno existe', async () => {
    const { service, prisma } = setup();
    await service.listLearnerOrders(TENANT, { email: 'Ana@Ejemplo.com', limit: 50 });

    const args = prisma.externalOrder.findMany.mock.calls[0]![0] as {
      where: { OR: Record<string, string>[] };
    };
    expect(args.where.OR).toEqual([{ userId: USER }, { email: 'ana@ejemplo.com' }]);
  });

  it('busca solo por email cuando ese correo no es de nadie todavía', async () => {
    const { service, prisma } = setup({ user: null });
    const salida = await service.listLearnerOrders(TENANT, {
      email: 'ana@ejemplo.com',
      limit: 50,
    });

    const args = prisma.externalOrder.findMany.mock.calls[0]![0] as {
      where: { OR: Record<string, string>[] };
    };
    expect(args.where.OR).toEqual([{ email: 'ana@ejemplo.com' }]);
    // `known: false` NO implica lista vacía: la tienda pudo mandar el pedido
    // antes de que la cuenta existiera.
    expect(salida.known).toBe(false);
  });

  it('el perfil del alumno mira SU cuenta, no un email que le pasen', async () => {
    const { service, prisma } = setup();
    await service.listOwnOrders(TENANT, USER);

    const busca = prisma.user.findFirst.mock.calls[0]![0] as { where: Record<string, string> };
    expect(busca.where).toEqual({ id: USER, tenantId: TENANT });
  });
});

describe('compras hechas fuera — el contrato de entrada', () => {
  it('rechaza un importe con decimales: el dinero va en céntimos', () => {
    expect(() => upsertExternalOrderSchema.parse({ ...PEDIDO, amountCents: 47.7 })).toThrow();
  });

  it('rechaza una fecha que no sea ISO', () => {
    expect(() => upsertExternalOrderSchema.parse({ ...PEDIDO, placedAt: '18/08/2026' })).toThrow();
  });

  it('normaliza la moneda a minúsculas, como los price de Stripe', () => {
    expect(upsertExternalOrderSchema.parse({ ...PEDIDO, currency: 'EUR' }).currency).toBe('eur');
  });

  it('da `PAID` por defecto: aquí solo llegan ventas ya cobradas', () => {
    expect(upsertExternalOrderSchema.parse(PEDIDO).status).toBe('PAID');
  });
});
