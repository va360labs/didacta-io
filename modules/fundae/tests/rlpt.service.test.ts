import { describe, expect, it, vi } from 'vitest';
import { FundaeRlptService } from '../src/rlpt.service.js';
import {
  CompanyNotFoundError,
  RlptNotFoundError,
  RlptNotificacionInicialMissingError,
  RlptPlazoNoCumplidoError,
} from '../src/errors.js';
import { RLPT_ANTELACION_MINIMA_DIAS } from '../src/rlpt.dto.js';

interface CompanyRow {
  id: string;
  tenantId: string;
  deletedAt: Date | null;
}

interface RlptRow {
  id: string;
  tenantId: string;
  companyId: string;
  tipo: string;
  fechaNotificacionAt: Date;
  plazoVencimientoAt: Date;
  evidenceEntryId: string;
  observaciones: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  evidence?: { hash: string; size: bigint } | null;
}

function makeFakePrisma(opts: { companies?: CompanyRow[] } = {}) {
  const rlptRows: RlptRow[] = [];
  const companyRows: CompanyRow[] = opts.companies ?? [];

  return {
    rlptRows,
    modFundaeCompany: {
      async findFirst(args: {
        where: { tenantId?: string; id?: string; deletedAt?: null };
        select?: unknown;
      }): Promise<CompanyRow | null> {
        return (
          companyRows.find((c) => {
            if (args.where.tenantId && c.tenantId !== args.where.tenantId) return false;
            if (args.where.id && c.id !== args.where.id) return false;
            if (args.where.deletedAt === null && c.deletedAt !== null) return false;
            return true;
          }) ?? null
        );
      },
    },
    modFundaeRlptNotice: {
      async findFirst(args: {
        where: { tenantId?: string; id?: string };
        include?: unknown;
      }): Promise<RlptRow | null> {
        return (
          rlptRows.find((r) => {
            if (args.where.tenantId && r.tenantId !== args.where.tenantId) return false;
            if (args.where.id && r.id !== args.where.id) return false;
            return true;
          }) ?? null
        );
      },
      async findMany(args: {
        where: { tenantId: string; companyId?: string; deletedAt?: null };
        include?: unknown;
        orderBy?: unknown;
      }): Promise<RlptRow[]> {
        return rlptRows
          .filter((r) => r.tenantId === args.where.tenantId)
          .filter((r) => (args.where.companyId ? r.companyId === args.where.companyId : true))
          .filter((r) => (args.where.deletedAt === null ? r.deletedAt === null : true))
          .sort((a, b) => b.fechaNotificacionAt.getTime() - a.fechaNotificacionAt.getTime());
      },
      async create(args: { data: Partial<RlptRow> }): Promise<RlptRow> {
        const now = new Date();
        const row: RlptRow = {
          id: '',
          tenantId: '',
          companyId: '',
          tipo: 'NOTIFICACION_INICIAL',
          fechaNotificacionAt: now,
          plazoVencimientoAt: now,
          evidenceEntryId: '',
          observaciones: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          evidence: { hash: 'hash-placeholder', size: BigInt(0) },
          ...args.data,
        };
        rlptRows.push(row);
        return row;
      },
      async update(args: {
        where: { id: string };
        data: Partial<RlptRow>;
        include?: unknown;
      }): Promise<RlptRow> {
        const row = rlptRows.find((r) => r.id === args.where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, args.data, { updatedAt: new Date() });
        return row;
      },
    },
  };
}

function makeCtx() {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    },
    eventBus: {
      publish: vi.fn(async () => {}),
    },
    evidenceVault: {
      store: vi.fn(async (a: { data: Buffer }) => ({
        id: 'evidence-1',
        hash: 'sha256-of-blob',
        storageKey: 'evidence/x',
      })),
    },
  };
}

describe('FundaeRlptService.upload', () => {
  it('persiste notificación con plazo +15 días para NOTIFICACION_INICIAL si no se provee', async () => {
    const prisma = makeFakePrisma({
      companies: [{ id: 'c-1', tenantId: 't-1', deletedAt: null }],
    });
    const ctx = makeCtx();
    const svc = new FundaeRlptService(prisma as never, ctx as never);

    const fecha = new Date('2026-04-01T10:00:00.000Z');
    const view = await svc.upload({
      tenantId: 't-1',
      companyId: 'c-1',
      actorId: 'admin-1',
      dto: { tipo: 'NOTIFICACION_INICIAL', fechaNotificacionAt: fecha.toISOString() },
      blob: Buffer.from('PDF dummy'),
    });

    expect(view.tipo).toBe('NOTIFICACION_INICIAL');
    expect(view.evidenceEntryId).toBe('evidence-1');
    expect(view.evidenceHash).toBe('sha256-of-blob');
    const expectedPlazo = new Date(fecha);
    expectedPlazo.setDate(expectedPlazo.getDate() + RLPT_ANTELACION_MINIMA_DIAS);
    expect(new Date(view.plazoVencimientoAt).toISOString()).toBe(expectedPlazo.toISOString());
  });

  it('para ACUSE_RECIBO el plazo por defecto coincide con la fecha (no aplica antelación)', async () => {
    const prisma = makeFakePrisma({
      companies: [{ id: 'c-1', tenantId: 't-1', deletedAt: null }],
    });
    const svc = new FundaeRlptService(prisma as never, makeCtx() as never);
    const fecha = '2026-04-15T10:00:00.000Z';
    const view = await svc.upload({
      tenantId: 't-1',
      companyId: 'c-1',
      actorId: null,
      dto: { tipo: 'ACUSE_RECIBO', fechaNotificacionAt: fecha },
      blob: Buffer.from('Acuse PDF'),
    });
    expect(view.fechaNotificacionAt).toBe(view.plazoVencimientoAt);
  });

  it('rechaza con CompanyNotFoundError si la empresa no existe en el tenant', async () => {
    const prisma = makeFakePrisma({ companies: [] });
    const svc = new FundaeRlptService(prisma as never, makeCtx() as never);
    await expect(
      svc.upload({
        tenantId: 't-1',
        companyId: 'fantasma',
        actorId: null,
        dto: { tipo: 'NOTIFICACION_INICIAL' },
        blob: Buffer.from('x'),
      }),
    ).rejects.toBeInstanceOf(CompanyNotFoundError);
  });

  it('publica evento fundae.rlpt.notice.created al subir', async () => {
    const prisma = makeFakePrisma({
      companies: [{ id: 'c-1', tenantId: 't-1', deletedAt: null }],
    });
    const ctx = makeCtx();
    const svc = new FundaeRlptService(prisma as never, ctx as never);
    await svc.upload({
      tenantId: 't-1',
      companyId: 'c-1',
      actorId: null,
      dto: { tipo: 'NOTIFICACION_INICIAL' },
      blob: Buffer.from('x'),
    });
    expect(ctx.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'fundae.rlpt.notice.created' }),
    );
  });
});

describe('FundaeRlptService.assertGroupCanStart', () => {
  it('rechaza con RlptNotificacionInicialMissingError si no hay notificación inicial', async () => {
    const prisma = makeFakePrisma({
      companies: [{ id: 'c-1', tenantId: 't-1', deletedAt: null }],
    });
    const svc = new FundaeRlptService(prisma as never, makeCtx() as never);
    await expect(
      svc.assertGroupCanStart({ tenantId: 't-1', companyId: 'c-1' }),
    ).rejects.toBeInstanceOf(RlptNotificacionInicialMissingError);
  });

  it('rechaza con RlptPlazoNoCumplidoError si la fecha de referencia es anterior al plazo', async () => {
    const prisma = makeFakePrisma({
      companies: [{ id: 'c-1', tenantId: 't-1', deletedAt: null }],
    });
    const svc = new FundaeRlptService(prisma as never, makeCtx() as never);
    const fechaNotif = new Date('2026-04-29T10:00:00.000Z');
    await svc.upload({
      tenantId: 't-1',
      companyId: 'c-1',
      actorId: null,
      dto: { tipo: 'NOTIFICACION_INICIAL', fechaNotificacionAt: fechaNotif.toISOString() },
      blob: Buffer.from('x'),
    });
    // 5 días después: aún no se cumplen los 15 → rechaza.
    const reference = new Date('2026-05-04T10:00:00.000Z');
    await expect(
      svc.assertGroupCanStart({ tenantId: 't-1', companyId: 'c-1', referenceDate: reference }),
    ).rejects.toBeInstanceOf(RlptPlazoNoCumplidoError);
  });

  it('autoriza si han pasado los 15 días desde la notificación inicial', async () => {
    const prisma = makeFakePrisma({
      companies: [{ id: 'c-1', tenantId: 't-1', deletedAt: null }],
    });
    const svc = new FundaeRlptService(prisma as never, makeCtx() as never);
    const fechaNotif = new Date('2026-04-01T10:00:00.000Z');
    await svc.upload({
      tenantId: 't-1',
      companyId: 'c-1',
      actorId: null,
      dto: { tipo: 'NOTIFICACION_INICIAL', fechaNotificacionAt: fechaNotif.toISOString() },
      blob: Buffer.from('x'),
    });
    const reference = new Date('2026-04-30T10:00:00.000Z');
    await expect(
      svc.assertGroupCanStart({ tenantId: 't-1', companyId: 'c-1', referenceDate: reference }),
    ).resolves.toBeUndefined();
  });

  it('si existe ACTA_DISCREPANCIA, autoriza incluso sin plazo cumplido', async () => {
    const prisma = makeFakePrisma({
      companies: [{ id: 'c-1', tenantId: 't-1', deletedAt: null }],
    });
    const svc = new FundaeRlptService(prisma as never, makeCtx() as never);
    const hoy = new Date('2026-04-29T10:00:00.000Z');
    await svc.upload({
      tenantId: 't-1',
      companyId: 'c-1',
      actorId: null,
      dto: { tipo: 'NOTIFICACION_INICIAL', fechaNotificacionAt: hoy.toISOString() },
      blob: Buffer.from('x'),
    });
    await svc.upload({
      tenantId: 't-1',
      companyId: 'c-1',
      actorId: null,
      dto: { tipo: 'ACTA_DISCREPANCIA', fechaNotificacionAt: hoy.toISOString() },
      blob: Buffer.from('acta'),
    });
    const reference = new Date('2026-04-29T10:00:00.000Z');
    await expect(
      svc.assertGroupCanStart({ tenantId: 't-1', companyId: 'c-1', referenceDate: reference }),
    ).resolves.toBeUndefined();
  });
});

describe('FundaeRlptService.list / get / softDelete', () => {
  it('list ordena por fecha desc y filtra deletedAt', async () => {
    const prisma = makeFakePrisma({
      companies: [{ id: 'c-1', tenantId: 't-1', deletedAt: null }],
    });
    const svc = new FundaeRlptService(prisma as never, makeCtx() as never);
    const a = await svc.upload({
      tenantId: 't-1',
      companyId: 'c-1',
      actorId: null,
      dto: { tipo: 'NOTIFICACION_INICIAL', fechaNotificacionAt: '2026-04-01T10:00:00.000Z' },
      blob: Buffer.from('a'),
    });
    const b = await svc.upload({
      tenantId: 't-1',
      companyId: 'c-1',
      actorId: null,
      dto: { tipo: 'ACUSE_RECIBO', fechaNotificacionAt: '2026-04-02T10:00:00.000Z' },
      blob: Buffer.from('b'),
    });
    const list = await svc.listByCompany('t-1', 'c-1');
    expect(list.map((n) => n.id)).toEqual([b.id, a.id]);

    await svc.softDelete('t-1', null, b.id);
    const after = await svc.listByCompany('t-1', 'c-1');
    expect(after.map((n) => n.id)).toEqual([a.id]);
  });

  it('get rechaza con RlptNotFoundError si la id es desconocida', async () => {
    const prisma = makeFakePrisma();
    const svc = new FundaeRlptService(prisma as never, makeCtx() as never);
    await expect(svc.get('t-1', 'no-existe')).rejects.toBeInstanceOf(RlptNotFoundError);
  });

  it('softDelete es idempotente', async () => {
    const prisma = makeFakePrisma({
      companies: [{ id: 'c-1', tenantId: 't-1', deletedAt: null }],
    });
    const svc = new FundaeRlptService(prisma as never, makeCtx() as never);
    const created = await svc.upload({
      tenantId: 't-1',
      companyId: 'c-1',
      actorId: null,
      dto: { tipo: 'NOTIFICACION_INICIAL' },
      blob: Buffer.from('x'),
    });
    const first = await svc.softDelete('t-1', null, created.id);
    expect(first.deletedAt).toBeTruthy();
    const second = await svc.softDelete('t-1', null, created.id);
    expect(second.deletedAt).toBeTruthy();
  });
});
