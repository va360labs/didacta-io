/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Panel del creador de Didacta Cloud (ADR-007 y ADR-008): las rutas de cobros
 * por aula que abre la credencial de provisioning. Sin base de datos: aquí se
 * fija quién puede llamar, de qué aula se lee y la forma exacta de la
 * respuesta, cada vez con un caso de CONTROL al lado (un 200 no prueba nada si
 * no hay un 404 que demuestre que la comprobación discrimina).
 *
 * La idempotencia REAL del crédito (libro + Stripe) está en
 * `modules/payouts/tests/credits.service.test.ts` y, contra Postgres con RLS,
 * en `tests/integration/payouts-panel-creador.integration.test.ts`.
 */

import { ForbiddenException, Logger, UnauthorizedException } from '@nestjs/common';
import {
  PayoutsCreditIdempotencyConflictError,
  PayoutsCreditInsufficientPlatformBalanceError,
  PayoutsError,
  PayoutsInvoiceNotFoundError,
} from '@didacta/mod-payouts';
import { describe, expect, it, vi } from 'vitest';
import { AdminTenantsPayoutsController } from '../src/admin/admin-tenants.controller';
import { tenantContextStorage } from '../src/tenancy/tenant-context.storage';

const TENANT = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';
const INVOICE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const machineReq = { provisioningActor: { credentialId: 'cred-1' }, headers: {}, ip: '127.0.0.1' };
const noActorReq = { headers: {} };
const tenantAdmin = { sub: 'u', tenantId: TENANT, roles: ['tenant_admin'] };

const currentTenantId = () => tenantContextStorage.getStore()?.tenantId ?? null;

const CREDIT = {
  amount: 1250,
  currency: 'eur',
  idempotencyKey: 'aff:af0001:eur:2026-W47',
  reason: 'Afiliación 2026-W47',
};

function build(
  options: {
    tenantExists?: boolean;
    invoicing?: boolean;
    mode?: 'platform' | 'own' | 'none';
    credit?: (input: Record<string, unknown>) => Promise<unknown>;
    auditFails?: boolean;
  } = {},
) {
  const contexts: Array<{ op: string; tenantId: string; contextTenant: string | null }> = [];
  const seen = (op: string) => (tenantId: string) =>
    contexts.push({ op, tenantId, contextTenant: currentTenantId() });
  const invoiceView = { id: INVOICE, fullNumber: 'DC-2026-000001', currency: 'eur', total: 605 };
  const runtime = {
    config: { displayName: 'Didacta' },
    reports: {
      fees: vi.fn(async (from: Date, to: Date) => [
        {
          tenantId: TENANT,
          day: from.toISOString().slice(0, 10),
          currency: 'eur',
          feeCollected: 500,
          feeReturned: 100,
          _to: to.toISOString(),
        },
      ]),
      summary: vi.fn(async (tenantId: string) => {
        seen('summary')(tenantId);
        return {
          currencies: [{ currency: 'eur', salesCount: 1, gross: 10000 }],
          awaitingFeeCount: 0,
          debts: [],
          disputes: [],
        };
      }),
    },
    settings: {
      get: vi.fn(async (tenantId: string) => {
        seen('settings')(tenantId);
        return { tenantId, feeBps: 500, updatedAt: null };
      }),
    },
    invoices:
      options.invoicing === false
        ? null
        : {
            list: vi.fn(async (tenantId: string) => {
              seen('invoices.list')(tenantId);
              return [invoiceView];
            }),
            pdf: vi.fn(async (tenantId: string, invoiceId: string) => {
              seen('invoices.pdf')(tenantId);
              // Como el servicio real: una factura que no es de ESTA aula no existe.
              if (tenantId !== TENANT || invoiceId !== INVOICE) {
                throw new PayoutsInvoiceNotFoundError();
              }
              return { fileName: 'DC-2026-000001.pdf', pdf: Buffer.from('%PDF-1.4 falso') };
            }),
          },
    mode: {
      resolve: vi.fn(async () => ({ mode: options.mode ?? 'platform', ready: true })),
    },
    credits: {
      credit: vi.fn(
        options.credit ??
          (async (input: Record<string, unknown>) => ({
            transferId: 'tr_fake_1',
            amount: input['amount'],
            currency: input['currency'],
            created: true,
          })),
      ),
    },
    prisma: {
      tenant: {
        findFirst: vi.fn(async (args: { where: { id: string } }) =>
          options.tenantExists === false || args.where.id !== TENANT ? null : { id: TENANT },
        ),
      },
    },
  };
  const audit = {
    record: vi.fn(async () => {
      if (options.auditFails) throw new Error('audit caído');
    }),
  };
  const controller = new AdminTenantsPayoutsController(
    runtime as unknown as ConstructorParameters<typeof AdminTenantsPayoutsController>[0],
    audit as unknown as ConstructorParameters<typeof AdminTenantsPayoutsController>[1],
  );
  return { controller, runtime, audit, contexts };
}

async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    if (err instanceof PayoutsError) return err.code;
    const response = (err as { response?: { code?: string } }).response;
    return response?.code ?? `OTRO:${(err as Error).constructor.name}`;
  }
}

function fakeReply() {
  const headers: Record<string, string> = {};
  let body: unknown;
  const reply = {
    header(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return reply;
    },
    send(payload: unknown) {
      body = payload;
      return reply;
    },
  };
  return { reply, headers, body: () => body };
}

// ── Quién puede llamar: lo mismo en las cinco rutas nuevas ────────────────

type Call = (
  c: AdminTenantsPayoutsController,
  req: unknown,
  user: unknown,
  id: string,
) => Promise<unknown>;

const ROUTES: Array<[string, Call]> = [
  ['getPayoutsSummary', (c, req, user, id) => c.getPayoutsSummary(req as never, user as never, id)],
  [
    'getPayoutsInvoices',
    (c, req, user, id) => c.getPayoutsInvoices(req as never, user as never, id),
  ],
  [
    'getPayoutsInvoicePdf',
    (c, req, user, id) =>
      c.getPayoutsInvoicePdf(req as never, user as never, id, INVOICE, fakeReply().reply as never),
  ],
  [
    'createPayoutsCredit',
    (c, req, user, id) => c.createPayoutsCredit(req as never, user as never, id, CREDIT),
  ],
];

describe.each(ROUTES)('%s · acceso y aula', (_name, call) => {
  it('sin credencial ni sesión → 401, y no toca nada', async () => {
    const { controller, runtime } = build();
    await expect(call(controller, noActorReq, undefined, TENANT)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(runtime.prisma.tenant.findFirst).not.toHaveBeenCalled();
    expect(runtime.credits.credit).not.toHaveBeenCalled();
  });

  it('un tenant_admin (sesión de aula, sin ser super_admin) → 403, y no toca nada', async () => {
    const { controller, runtime } = build();
    await expect(call(controller, noActorReq, tenantAdmin, TENANT)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(runtime.prisma.tenant.findFirst).not.toHaveBeenCalled();
    expect(runtime.credits.credit).not.toHaveBeenCalled();
  });

  it('CONTROL: un super_admin sí pasa', async () => {
    const { controller } = build();
    await expect(
      codeOf(() =>
        call(
          controller,
          noActorReq,
          { sub: 'root', tenantId: TENANT, roles: ['super_admin'] },
          TENANT,
        ),
      ),
    ).resolves.toBeNull();
  });

  it('aula inexistente o id que no es un UUID → 404 ADMIN_TENANT_NOT_FOUND', async () => {
    const { controller, runtime } = build();
    await expect(codeOf(() => call(controller, machineReq, undefined, OTHER))).resolves.toBe(
      'ADMIN_TENANT_NOT_FOUND',
    );
    await expect(codeOf(() => call(controller, machineReq, undefined, 'no-es-uuid'))).resolves.toBe(
      'ADMIN_TENANT_NOT_FOUND',
    );
    expect(runtime.credits.credit).not.toHaveBeenCalled();
    // CONTROL: con el id bueno, la misma llamada responde.
    await expect(codeOf(() => call(controller, machineReq, undefined, TENANT))).resolves.toBeNull();
  });
});

// ── GET payouts/fees ──────────────────────────────────────────────────────

describe('getPayoutsFees', () => {
  it('pasa el rango con el final EXCLUSIVO del día siguiente y devuelve las filas del libro', async () => {
    const { controller, runtime } = build();
    const rows = await controller.getPayoutsFees(machineReq as never, undefined, {
      from: '2026-11-03',
      to: '2026-11-16',
    });
    expect(runtime.reports.fees).toHaveBeenCalledWith(
      new Date('2026-11-03T00:00:00.000Z'),
      new Date('2026-11-17T00:00:00.000Z'),
    );
    const { _to: _ignored, ...row } = rows[0] as unknown as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      ['currency', 'day', 'feeCollected', 'feeReturned', 'tenantId'].sort(),
    );
    expect(row).toEqual({
      tenantId: TENANT,
      day: '2026-11-03',
      currency: 'eur',
      feeCollected: 500,
      feeReturned: 100,
    });
  });

  it('sin credencial → 401; tenant_admin → 403 (CONTROL: super_admin pasa)', async () => {
    const { controller, runtime } = build();
    const query = { from: '2026-11-03', to: '2026-11-16' };
    await expect(
      controller.getPayoutsFees(noActorReq as never, undefined, query),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      codeOf(() => controller.getPayoutsFees(noActorReq as never, tenantAdmin as never, query)),
    ).resolves.toBe('ADMIN_FORBIDDEN_SUPER_ADMIN_REQUIRED');
    expect(runtime.reports.fees).not.toHaveBeenCalled();
    await expect(
      controller.getPayoutsFees(
        noActorReq as never,
        { sub: 'root', tenantId: TENANT, roles: ['super_admin'] } as never,
        query,
      ),
    ).resolves.toHaveLength(1);
  });
});

// ── GET :id/payouts/summary ───────────────────────────────────────────────

describe('getPayoutsSummary', () => {
  it('es la respuesta de «Tus ventas»: el resumen por divisa más operatorName y feeBps, leída bajo el contexto del aula', async () => {
    const { controller, contexts } = build();
    const res = await controller.getPayoutsSummary(machineReq as never, undefined, TENANT);
    expect(Object.keys(res).sort()).toEqual(
      ['awaitingFeeCount', 'currencies', 'debts', 'disputes', 'feeBps', 'operatorName'].sort(),
    );
    expect(res.operatorName).toBe('Didacta');
    expect(res.feeBps).toBe(500);
    expect(res.currencies[0]).toMatchObject({ currency: 'eur', gross: 10000 });
    // Cada lectura corrió con el contexto de ESA aula (RLS), no con el del que llama.
    expect(contexts.length).toBeGreaterThan(0);
    for (const c of contexts) expect(c).toMatchObject({ tenantId: TENANT, contextTenant: TENANT });
  });
});

// ── GET :id/payouts/invoices ──────────────────────────────────────────────

describe('getPayoutsInvoices', () => {
  it('con facturación: { enabled: true, items } leídos bajo el contexto del aula', async () => {
    const { controller, contexts } = build();
    const res = await controller.getPayoutsInvoices(machineReq as never, undefined, TENANT);
    expect(res).toEqual({
      enabled: true,
      items: [{ id: INVOICE, fullNumber: 'DC-2026-000001', currency: 'eur', total: 605 }],
    });
    expect(contexts).toEqual([{ op: 'invoices.list', tenantId: TENANT, contextTenant: TENANT }]);
  });

  it('sin datos del emisor: { enabled: false, items: [] }, no un error', async () => {
    const { controller } = build({ invoicing: false });
    await expect(
      controller.getPayoutsInvoices(machineReq as never, undefined, TENANT),
    ).resolves.toEqual({ enabled: false, items: [] });
  });
});

// ── GET :id/payouts/invoices/:invoiceId/pdf ───────────────────────────────

describe('getPayoutsInvoicePdf', () => {
  it('sirve el PDF como binario, sin guardar y como descarga', async () => {
    const { controller, contexts } = build();
    const out = fakeReply();
    await controller.getPayoutsInvoicePdf(
      machineReq as never,
      undefined,
      TENANT,
      INVOICE,
      out.reply as never,
    );
    expect(out.headers['content-type']).toBe('application/pdf');
    expect(out.headers['cache-control']).toBe('private, no-store');
    expect(out.headers['content-disposition']).toBe('attachment; filename="DC-2026-000001.pdf"');
    expect(Buffer.isBuffer(out.body())).toBe(true);
    expect((out.body() as Buffer).toString()).toBe('%PDF-1.4 falso');
    expect(contexts).toEqual([{ op: 'invoices.pdf', tenantId: TENANT, contextTenant: TENANT }]);
  });

  it('CONTROL: una factura que no es de esa aula → 404 PAYOUTS_INVOICE_NOT_FOUND y no se envía nada', async () => {
    const { controller } = build();
    const out = fakeReply();
    await expect(
      codeOf(() =>
        controller.getPayoutsInvoicePdf(
          machineReq as never,
          undefined,
          TENANT,
          'ffffffff-ffff-4fff-8fff-ffffffffffff',
          out.reply as never,
        ),
      ),
    ).resolves.toBe('PAYOUTS_INVOICE_NOT_FOUND');
    expect(out.body()).toBeUndefined();
    expect(out.headers['content-type']).toBeUndefined();
  });

  it('sin facturación → 404 PAYOUTS_INVOICING_DISABLED', async () => {
    const { controller } = build({ invoicing: false });
    await expect(
      codeOf(() =>
        controller.getPayoutsInvoicePdf(
          machineReq as never,
          undefined,
          TENANT,
          INVOICE,
          fakeReply().reply as never,
        ),
      ),
    ).resolves.toBe('PAYOUTS_INVOICING_DISABLED');
  });

  it('el nombre del fichero no puede romper la cabecera', async () => {
    const { controller, runtime } = build();
    (runtime.invoices!.pdf as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      fileName: 'a"b\r\nSet-Cookie: x.pdf',
      pdf: Buffer.from('x'),
    });
    const out = fakeReply();
    await controller.getPayoutsInvoicePdf(
      machineReq as never,
      undefined,
      TENANT,
      INVOICE,
      out.reply as never,
    );
    expect(out.headers['content-disposition']).toBe(
      'attachment; filename="a_b__Set-Cookie__x.pdf"',
    );
  });
});

// ── POST :id/payouts/credits ──────────────────────────────────────────────

describe('createPayoutsCredit', () => {
  it('mueve el crédito del aula de la URL y responde exactamente { status, transferId, amount, currency }', async () => {
    const { controller, runtime, audit } = build();
    const res = await controller.createPayoutsCredit(
      machineReq as never,
      undefined,
      TENANT,
      CREDIT,
    );
    expect(res).toEqual({
      status: 'transferred',
      transferId: 'tr_fake_1',
      amount: 1250,
      currency: 'eur',
    });
    expect(Object.keys(res).sort()).toEqual(['amount', 'currency', 'status', 'transferId']);
    expect(runtime.credits.credit).toHaveBeenCalledTimes(1);
    expect(runtime.credits.credit).toHaveBeenCalledWith({
      tenantId: TENANT,
      ...CREDIT,
      initiatedBy: 'cred-1',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        actorId: 'cred-1',
        action: 'payouts.credit.transferred',
        resourceId: 'tr_fake_1',
        metadata: expect.objectContaining({
          transferId: 'tr_fake_1',
          amount: 1250,
          currency: 'eur',
          idempotencyKey: CREDIT.idempotencyKey,
          reason: CREDIT.reason,
          actorKind: 'provisioning',
        }),
      }),
    );
  });

  it('un reintento (el servicio dice created:false) devuelve lo mismo y NO deja otra fila en el audit log', async () => {
    const { controller, audit } = build({
      credit: async (input) => ({
        transferId: 'tr_fake_1',
        amount: input['amount'],
        currency: input['currency'],
        created: false,
      }),
    });
    const res = await controller.createPayoutsCredit(
      machineReq as never,
      undefined,
      TENANT,
      CREDIT,
    );
    expect(res).toEqual({
      status: 'transferred',
      transferId: 'tr_fake_1',
      amount: 1250,
      currency: 'eur',
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('el cuerpo no válido es PAYOUTS_CREDIT_INVALID (400) con el campo, y no llega al servicio', async () => {
    const { controller, runtime } = build();
    const bad: Array<[string, unknown, string]> = [
      ['sin cuerpo', undefined, 'body'],
      ['cuerpo no objeto', 'amount=1', 'body'],
      ['amount 0', { ...CREDIT, amount: 0 }, 'amount'],
      ['amount como texto', { ...CREDIT, amount: '1250' }, 'amount'],
      ['currency en mayúsculas', { ...CREDIT, currency: 'EUR' }, 'currency'],
      ['clave corta', { ...CREDIT, idempotencyKey: 'corta' }, 'idempotencyKey'],
      ['sin motivo', { ...CREDIT, reason: '' }, 'reason'],
    ];
    for (const [name, body, field] of bad) {
      const err = await controller
        .createPayoutsCredit(machineReq as never, undefined, TENANT, body)
        .catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(PayoutsError);
      expect((err as PayoutsError).code, name).toBe('PAYOUTS_CREDIT_INVALID');
      expect((err as PayoutsError).detail, name).toBe(field);
    }
    expect(runtime.credits.credit).not.toHaveBeenCalled();
    // CONTROL: el cuerpo bueno sí llega.
    await controller.createPayoutsCredit(machineReq as never, undefined, TENANT, CREDIT);
    expect(runtime.credits.credit).toHaveBeenCalledTimes(1);
  });

  it.each(['own', 'none'] as const)(
    'un aula en modo «%s» (sin cuenta del operador) → 409 PAYOUTS_CREDIT_NO_ACCOUNT, sin mover nada',
    async (mode) => {
      const { controller, runtime, audit } = build({ mode });
      await expect(
        codeOf(() =>
          controller.createPayoutsCredit(machineReq as never, undefined, TENANT, CREDIT),
        ),
      ).resolves.toBe('PAYOUTS_CREDIT_NO_ACCOUNT');
      expect(runtime.credits.credit).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('los errores del servicio se propagan con su código (saldo insuficiente, clave reutilizada) y sin audit', async () => {
    for (const make of [
      () => new PayoutsCreditInsufficientPlatformBalanceError('eur'),
      () => new PayoutsCreditIdempotencyConflictError('ledger'),
    ]) {
      const error = make();
      const { controller, audit } = build({
        credit: async () => {
          throw error;
        },
      });
      await expect(
        codeOf(() =>
          controller.createPayoutsCredit(machineReq as never, undefined, TENANT, CREDIT),
        ),
      ).resolves.toBe(error.code);
      expect(audit.record).not.toHaveBeenCalled();
    }
  });

  it('si el audit log falla DESPUÉS de mover el dinero, no se devuelve un error que invite a reintentar', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { controller } = build({ auditFails: true });
    await expect(
      controller.createPayoutsCredit(machineReq as never, undefined, TENANT, CREDIT),
    ).resolves.toMatchObject({ status: 'transferred', transferId: 'tr_fake_1' });
    // Queda dicho en el log del servidor, no se traga en silencio.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('tr_fake_1'));
    logged.mockRestore();
  });

  it('el aula sale de la URL, nunca del cuerpo: un tenantId en el cuerpo se ignora', async () => {
    const { controller, runtime } = build();
    await controller.createPayoutsCredit(machineReq as never, undefined, TENANT, {
      ...CREDIT,
      tenantId: OTHER,
    });
    expect((runtime.credits.credit as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      tenantId: TENANT,
    });
  });
});
