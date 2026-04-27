import { describe, expect, it } from 'vitest';
import { FundaeService } from '../src/fundae.service.js';
import { buildActionXml } from '../src/xml-export.js';
import { ActionNotFoundError, CodigoDuplicadoError, FechasInvalidasError } from '../src/errors.js';

interface ActionRow {
  id: string;
  tenantId: string;
  courseId: string | null;
  codigoAccion: string;
  nombre: string;
  modalidad: string;
  horasFormacion: number;
  fechaInicio: string;
  fechaFin: string;
  lugar: string | null;
  cifCentro: string | null;
  notas: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

function makeFakePrisma() {
  const actions: ActionRow[] = [];

  return {
    modFundaeAction: {
      async findMany(args: { where: { tenantId: string; courseId?: string; status?: string } }) {
        return actions
          .filter((a) => a.tenantId === args.where.tenantId)
          .filter((a) => (args.where.courseId ? a.courseId === args.where.courseId : true))
          .filter((a) => (args.where.status ? a.status === args.where.status : true));
      },
      async findFirst(args: {
        where: {
          tenantId?: string;
          id?: string;
          codigoAccion?: string;
          NOT?: { id: string };
        };
        select?: unknown;
      }) {
        return (
          actions.find((a) => {
            if (args.where.tenantId && a.tenantId !== args.where.tenantId) return false;
            if (args.where.id && a.id !== args.where.id) return false;
            if (args.where.codigoAccion && a.codigoAccion !== args.where.codigoAccion) return false;
            if (args.where.NOT && a.id === args.where.NOT.id) return false;
            return true;
          }) ?? null
        );
      },
      async create(args: { data: ActionRow }) {
        const row = { ...args.data, createdAt: new Date(), updatedAt: new Date() };
        actions.push(row);
        return row;
      },
      async update(args: { where: { id: string }; data: Partial<ActionRow> }) {
        const idx = actions.findIndex((a) => a.id === args.where.id);
        if (idx === -1) throw new Error('not found');
        actions[idx] = { ...actions[idx]!, ...args.data, updatedAt: new Date() };
        return actions[idx]!;
      },
    },
    modCoursesCourse: {
      async findFirst() {
        return null;
      },
    },
  };
}

function makeCtx() {
  const events: Array<{ name: string }> = [];
  return {
    eventBus: {
      async publish(evt: { name: string }) {
        events.push({ name: evt.name });
      },
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    events,
  };
}

const TENANT = 'tenant-1';

describe('FundaeService', () => {
  it('crea una acción y emite fundae.action.created', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const svc = new FundaeService(prisma as never, ctx as never);

    const action = await svc.create(TENANT, 'user-1', {
      codigoAccion: 'AF-2026-001',
      nombre: 'Curso de n8n',
      modalidad: 'TELEFORMACION',
      horasFormacion: 12,
      fechaInicio: '2026-05-01',
      fechaFin: '2026-05-15',
    });

    expect(action.codigoAccion).toBe('AF-2026-001');
    expect(action.status).toBe('DRAFT');
    expect(ctx.events).toContainEqual({ name: 'fundae.action.created' });
  });

  it('rechaza fechas invertidas', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const svc = new FundaeService(prisma as never, ctx as never);
    await expect(
      svc.create(TENANT, 'u', {
        codigoAccion: 'X',
        nombre: 'X',
        modalidad: 'PRESENCIAL',
        horasFormacion: 5,
        fechaInicio: '2026-06-01',
        fechaFin: '2026-05-15',
      }),
    ).rejects.toBeInstanceOf(FechasInvalidasError);
  });

  it('rechaza código duplicado en el mismo tenant', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const svc = new FundaeService(prisma as never, ctx as never);
    await svc.create(TENANT, 'u', {
      codigoAccion: 'DUP',
      nombre: 'A',
      modalidad: 'MIXTA',
      horasFormacion: 5,
      fechaInicio: '2026-01-01',
      fechaFin: '2026-01-10',
    });
    await expect(
      svc.create(TENANT, 'u', {
        codigoAccion: 'DUP',
        nombre: 'B',
        modalidad: 'MIXTA',
        horasFormacion: 5,
        fechaInicio: '2026-02-01',
        fechaFin: '2026-02-10',
      }),
    ).rejects.toBeInstanceOf(CodigoDuplicadoError);
  });

  it('get rechaza acción inexistente', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const svc = new FundaeService(prisma as never, ctx as never);
    await expect(svc.get(TENANT, 'no-existe')).rejects.toBeInstanceOf(ActionNotFoundError);
  });

  it('archive idempotente', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const svc = new FundaeService(prisma as never, ctx as never);
    const a = await svc.create(TENANT, 'u', {
      codigoAccion: 'A1',
      nombre: 'A',
      modalidad: 'MIXTA',
      horasFormacion: 5,
      fechaInicio: '2026-01-01',
      fechaFin: '2026-01-10',
    });
    await svc.archive(TENANT, 'u', a.id);
    await svc.archive(TENANT, 'u', a.id); // no debería tirar
    const after = await svc.get(TENANT, a.id);
    expect(after.status).toBe('ARCHIVED');
  });

  it('generateXml emite evento y produce XML válido', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const svc = new FundaeService(prisma as never, ctx as never);
    const a = await svc.create(TENANT, 'u', {
      codigoAccion: 'X<2026>',
      nombre: 'Curso "Especial"',
      modalidad: 'TELEFORMACION',
      horasFormacion: 8,
      fechaInicio: '2026-05-01',
      fechaFin: '2026-05-15',
    });
    const xml = await svc.generateXml(TENANT, 'u', a.id);
    expect(xml).toContain('<?xml version="1.0"');
    // Verifica escape de caracteres especiales.
    expect(xml).toContain('X&lt;2026&gt;');
    expect(xml).toContain('Curso &quot;Especial&quot;');
    expect(ctx.events).toContainEqual({ name: 'fundae.export.generated' });
  });
});

describe('buildActionXml', () => {
  it('escapa caracteres XML peligrosos', () => {
    const xml = buildActionXml({
      id: 'i',
      tenantId: 't',
      courseId: null,
      codigoAccion: 'A<&>"\'B',
      nombre: 'N',
      modalidad: 'PRESENCIAL',
      horasFormacion: 5,
      fechaInicio: '2026-01-01',
      fechaFin: '2026-01-02',
      lugar: null,
      cifCentro: null,
      notas: null,
      status: 'DRAFT',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(xml).toContain('A&lt;&amp;&gt;&quot;&apos;B');
  });
});
