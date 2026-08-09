import { describe, expect, it, vi } from 'vitest';
import { FundaeCompanyService } from '../src/company.service.js';
import {
  CompanyNifDuplicadoError,
  CompanyNotFoundError,
  CompanyTieneGruposActivosError,
} from '../src/errors.js';

interface CompanyRow {
  id: string;
  tenantId: string;
  nif: string;
  razonSocial: string;
  cccPrincipal: string | null;
  plantilla: number | null;
  creditoTotalCents: number | null;
  creditoUsadoCents: number;
  datosContacto: unknown;
  notas: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

function makeFakePrisma(opts: { groupCount?: number } = {}) {
  const rows: CompanyRow[] = [];

  return {
    rows,
    modFundaeCompany: {
      async findMany(args: {
        where: {
          tenantId: string;
          deletedAt?: null;
          OR?: Array<{ nif?: { contains: string }; razonSocial?: { contains: string } }>;
        };
      }): Promise<CompanyRow[]> {
        return rows.filter((r) => {
          if (r.tenantId !== args.where.tenantId) return false;
          if (args.where.deletedAt === null && r.deletedAt !== null) return false;
          if (args.where.OR) {
            const matches = args.where.OR.some((cond) => {
              if (cond.nif && r.nif.includes(cond.nif.contains)) return true;
              if (
                cond.razonSocial &&
                r.razonSocial.toLowerCase().includes(cond.razonSocial.contains.toLowerCase())
              ) {
                return true;
              }
              return false;
            });
            if (!matches) return false;
          }
          return true;
        });
      },
      async findFirst(args: {
        where: { tenantId?: string; id?: string; nif?: string };
      }): Promise<CompanyRow | null> {
        return (
          rows.find((r) => {
            if (args.where.tenantId && r.tenantId !== args.where.tenantId) return false;
            if (args.where.id && r.id !== args.where.id) return false;
            if (args.where.nif && r.nif !== args.where.nif) return false;
            return true;
          }) ?? null
        );
      },
      async create(args: { data: Partial<CompanyRow> }): Promise<CompanyRow> {
        const now = new Date();
        const row: CompanyRow = {
          id: '',
          tenantId: '',
          nif: '',
          razonSocial: '',
          cccPrincipal: null,
          plantilla: null,
          creditoTotalCents: null,
          creditoUsadoCents: 0,
          datosContacto: {},
          notas: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          ...args.data,
        };
        rows.push(row);
        return row;
      },
      async update(args: {
        where: { id: string };
        data: Partial<CompanyRow>;
      }): Promise<CompanyRow> {
        const row = rows.find((r) => r.id === args.where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, args.data, { updatedAt: new Date() });
        return row;
      },
    },
    // LMS-81: la tabla `mod_fundae_group` ya existe; `softDelete` la
    // consulta directamente para validar que no quedan grupos activos.
    modFundaeGroup: {
      async count() {
        return opts.groupCount ?? 0;
      },
    },
  };
}

const ctx = {
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
};

describe('FundaeCompanyService', () => {
  describe('create', () => {
    it('persiste empresa con NIF normalizado y publica evento', async () => {
      const prisma = makeFakePrisma();
      const svc = new FundaeCompanyService(prisma as never, ctx as never);

      const created = await svc.create('t-1', 'admin-1', {
        nif: 'A58818501',
        razonSocial: 'Telefónica de España S.A.',
        cccPrincipal: '28010001234',
        plantilla: 25000,
        creditoTotalCents: 1_000_000_00,
        datosContacto: { ciudad: 'Madrid', codigoPostal: '28013' },
      });

      expect(created.nif).toBe('A58818501');
      expect(created.razonSocial).toBe('Telefónica de España S.A.');
      expect(created.creditoUsadoCents).toBe(0);
      expect(created.creditoDisponibleCents).toBe(1_000_000_00);
      expect(prisma.rows).toHaveLength(1);
      expect(ctx.eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'fundae.company.created' }),
      );
    });

    it('rechaza NIF duplicado dentro del mismo tenant', async () => {
      const prisma = makeFakePrisma();
      const svc = new FundaeCompanyService(prisma as never, ctx as never);
      await svc.create('t-1', null, { nif: 'A58818501', razonSocial: 'Empresa A' });

      await expect(
        svc.create('t-1', null, { nif: 'A58818501', razonSocial: 'Empresa duplicada' }),
      ).rejects.toBeInstanceOf(CompanyNifDuplicadoError);
    });

    it('NIF duplicado en OTRO tenant es OK (aislamiento por tenant)', async () => {
      const prisma = makeFakePrisma();
      const svc = new FundaeCompanyService(prisma as never, ctx as never);
      await svc.create('t-A', null, { nif: 'A58818501', razonSocial: 'Empresa A' });

      const created = await svc.create('t-B', null, {
        nif: 'A58818501',
        razonSocial: 'Misma NIF, otro tenant',
      });
      expect(created.tenantId).toBe('t-B');
      expect(prisma.rows).toHaveLength(2);
    });

    it('crédito disponible es null cuando no se fija total', async () => {
      const prisma = makeFakePrisma();
      const svc = new FundaeCompanyService(prisma as never, ctx as never);
      const created = await svc.create('t-1', null, {
        nif: 'A58818501',
        razonSocial: 'Empresa sin crédito declarado',
      });
      expect(created.creditoTotalCents).toBeNull();
      expect(created.creditoDisponibleCents).toBeNull();
    });
  });

  describe('list', () => {
    it('list filtra por tenant y excluye soft-deleted por defecto', async () => {
      const prisma = makeFakePrisma();
      const svc = new FundaeCompanyService(prisma as never, ctx as never);
      await svc.create('t-1', null, { nif: 'A58818501', razonSocial: 'Empresa Alpha' });
      const beta = await svc.create('t-1', null, {
        nif: 'P1234567D',
        razonSocial: 'Empresa Beta',
      });
      await svc.create('t-2', null, { nif: 'X1234567L', razonSocial: 'Otra Tenant' });
      await svc.softDelete('t-1', null, beta.id);

      const list = await svc.list('t-1');
      expect(list).toHaveLength(1);
      expect(list[0]?.razonSocial).toBe('Empresa Alpha');
    });

    it('list con includeDeleted=true devuelve también soft-deleted', async () => {
      const prisma = makeFakePrisma();
      const svc = new FundaeCompanyService(prisma as never, ctx as never);
      const alpha = await svc.create('t-1', null, {
        nif: 'A58818501',
        razonSocial: 'Empresa Alpha',
      });
      await svc.softDelete('t-1', null, alpha.id);

      const list = await svc.list('t-1', { includeDeleted: true });
      expect(list).toHaveLength(1);
      expect(list[0]?.deletedAt).toBeTruthy();
    });

    it('search filtra por NIF (normalizado) o razón social (case-insensitive)', async () => {
      const prisma = makeFakePrisma();
      const svc = new FundaeCompanyService(prisma as never, ctx as never);
      await svc.create('t-1', null, { nif: 'A58818501', razonSocial: 'Telefónica' });
      await svc.create('t-1', null, { nif: 'P1234567D', razonSocial: 'Mercadona' });

      const byNif = await svc.list('t-1', { search: 'a-58.81-8501' });
      expect(byNif.some((c) => c.razonSocial === 'Telefónica')).toBe(true);

      const byRazon = await svc.list('t-1', { search: 'mercadona' });
      expect(byRazon.some((c) => c.razonSocial === 'Mercadona')).toBe(true);
    });
  });

  describe('get', () => {
    it('get devuelve la empresa o lanza CompanyNotFoundError', async () => {
      const prisma = makeFakePrisma();
      const svc = new FundaeCompanyService(prisma as never, ctx as never);
      const created = await svc.create('t-1', null, {
        nif: 'A58818501',
        razonSocial: 'Empresa',
      });

      const found = await svc.get('t-1', created.id);
      expect(found.id).toBe(created.id);

      await expect(svc.get('t-1', 'no-existe')).rejects.toBeInstanceOf(CompanyNotFoundError);
    });

    it('get aislamiento por tenant — empresa de otro tenant es como si no existiera', async () => {
      const prisma = makeFakePrisma();
      const svc = new FundaeCompanyService(prisma as never, ctx as never);
      const created = await svc.create('t-A', null, {
        nif: 'A58818501',
        razonSocial: 'Empresa Alpha',
      });
      await expect(svc.get('t-B', created.id)).rejects.toBeInstanceOf(CompanyNotFoundError);
    });
  });

  describe('update', () => {
    it('update edita razón social y plantilla; mantiene NIF original', async () => {
      const prisma = makeFakePrisma();
      const svc = new FundaeCompanyService(prisma as never, ctx as never);
      const created = await svc.create('t-1', null, {
        nif: 'A58818501',
        razonSocial: 'Empresa Original',
      });
      const updated = await svc.update('t-1', null, created.id, {
        razonSocial: 'Empresa Editada',
        plantilla: 100,
      });
      expect(updated.razonSocial).toBe('Empresa Editada');
      expect(updated.plantilla).toBe(100);
      expect(updated.nif).toBe('A58818501'); // No cambia.
    });

    it('update lanza CompanyNotFoundError si id desconocido', async () => {
      const prisma = makeFakePrisma();
      const svc = new FundaeCompanyService(prisma as never, ctx as never);
      await expect(
        svc.update('t-1', null, 'fantasma', { razonSocial: 'X' }),
      ).rejects.toBeInstanceOf(CompanyNotFoundError);
    });
  });

  describe('softDelete', () => {
    it('softDelete marca deletedAt y publica evento', async () => {
      const prisma = makeFakePrisma();
      const svc = new FundaeCompanyService(prisma as never, ctx as never);
      const created = await svc.create('t-1', null, {
        nif: 'A58818501',
        razonSocial: 'Empresa',
      });

      const deleted = await svc.softDelete('t-1', 'admin-1', created.id);
      expect(deleted.deletedAt).toBeTruthy();
      expect(ctx.eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'fundae.company.deleted' }),
      );
    });

    it('softDelete es idempotente sobre empresa ya borrada', async () => {
      const prisma = makeFakePrisma();
      const svc = new FundaeCompanyService(prisma as never, ctx as never);
      const created = await svc.create('t-1', null, {
        nif: 'A58818501',
        razonSocial: 'Empresa',
      });
      await svc.softDelete('t-1', null, created.id);
      const second = await svc.softDelete('t-1', null, created.id);
      expect(second.deletedAt).toBeTruthy();
    });

    it('softDelete rechaza si hay grupos activos vinculados (forward-compat con LMS-81)', async () => {
      const prisma = makeFakePrisma({ groupCount: 2 });
      const svc = new FundaeCompanyService(prisma as never, ctx as never);
      const created = await svc.create('t-1', null, {
        nif: 'A58818501',
        razonSocial: 'Empresa',
      });
      await expect(svc.softDelete('t-1', null, created.id)).rejects.toBeInstanceOf(
        CompanyTieneGruposActivosError,
      );
    });
  });
});
