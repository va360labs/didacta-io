import { describe, expect, it } from 'vitest';
import { FundaeService } from '../src/fundae.service.js';
import { buildActionXml } from '../src/xml-export.js';
import {
  ActionNotFoundError,
  BlockHoursExceedActionError,
  BlockNotFoundError,
  BlockOrdinalDuplicadoError,
  CodigoDuplicadoError,
  FechasInvalidasError,
} from '../src/errors.js';

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

interface EnrollmentRow {
  id: string;
  tenantId: string;
  courseId: string;
  userId: string;
  status: string;
  progressPercent: number | null;
  completionThreshold: number;
  completedAt: Date | null;
  enrolledAt: Date;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  documentId?: string | null;
}

interface BlockRow {
  id: string;
  tenantId: string;
  actionId: string;
  ordinal: number;
  title: string;
  hours: number;
  modalidad: string;
  contenidos: string;
  createdAt: Date;
  updatedAt: Date;
}

interface FakePrismaSeed {
  enrollments?: EnrollmentRow[];
  users?: UserRow[];
  /** IDs de cursos que existen en el tenant. Si está vacío, cualquier courseId es rechazado. */
  courses?: { id: string; tenantId: string }[];
}

function makeFakePrisma(seed: FakePrismaSeed = {}) {
  const actions: ActionRow[] = [];
  const enrollments: EnrollmentRow[] = seed.enrollments ?? [];
  const users: UserRow[] = seed.users ?? [];
  const courses = seed.courses ?? [];

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
      async findFirst(args: { where: { id: string; tenantId: string } }) {
        return (
          courses.find((c) => c.id === args.where.id && c.tenantId === args.where.tenantId) ?? null
        );
      },
    },
    modLearningEnrollment: {
      async findMany(args: {
        where: { tenantId: string; courseId: string; status?: { not: string } };
      }) {
        return enrollments
          .filter((e) => e.tenantId === args.where.tenantId && e.courseId === args.where.courseId)
          .filter((e) => (args.where.status?.not ? e.status !== args.where.status.not : true))
          .sort((a, b) => a.enrolledAt.getTime() - b.enrolledAt.getTime());
      },
      async count(args: {
        where: { tenantId: string; courseId: string; status?: { not: string } };
      }) {
        return enrollments
          .filter((e) => e.tenantId === args.where.tenantId && e.courseId === args.where.courseId)
          .filter((e) => (args.where.status?.not ? e.status !== args.where.status.not : true))
          .length;
      },
    },
    user: {
      async findMany(args: { where: { id: { in: string[] } }; select?: unknown }) {
        return users.filter((u) => args.where.id.in.includes(u.id));
      },
    },
    modFundaeBlock: makeBlocksFakeRepo(),
  };
}

function makeBlocksFakeRepo() {
  const blocks: BlockRow[] = [];
  return {
    _blocks: blocks,
    async findMany(args: {
      where: {
        tenantId?: string;
        actionId?: string;
        ordinal?: number;
        NOT?: { id: string };
      };
      orderBy?: unknown;
      select?: unknown;
    }) {
      return blocks
        .filter((b) =>
          args.where.tenantId !== undefined ? b.tenantId === args.where.tenantId : true,
        )
        .filter((b) =>
          args.where.actionId !== undefined ? b.actionId === args.where.actionId : true,
        )
        .filter((b) => (args.where.ordinal !== undefined ? b.ordinal === args.where.ordinal : true))
        .filter((b) => (args.where.NOT?.id ? b.id !== args.where.NOT.id : true))
        .sort((a, b) => a.ordinal - b.ordinal);
    },
    async findFirst(args: {
      where: {
        tenantId?: string;
        actionId?: string;
        id?: string;
        ordinal?: number;
        NOT?: { id: string };
      };
    }) {
      return (
        blocks.find((b) => {
          if (args.where.tenantId !== undefined && b.tenantId !== args.where.tenantId) return false;
          if (args.where.actionId !== undefined && b.actionId !== args.where.actionId) return false;
          if (args.where.id !== undefined && b.id !== args.where.id) return false;
          if (args.where.ordinal !== undefined && b.ordinal !== args.where.ordinal) return false;
          if (args.where.NOT?.id && b.id === args.where.NOT.id) return false;
          return true;
        }) ?? null
      );
    },
    async create(args: { data: Omit<BlockRow, 'createdAt' | 'updatedAt'> }) {
      const row: BlockRow = { ...args.data, createdAt: new Date(), updatedAt: new Date() };
      blocks.push(row);
      return row;
    },
    async update(args: { where: { id: string }; data: Partial<BlockRow> }) {
      const idx = blocks.findIndex((b) => b.id === args.where.id);
      if (idx === -1) throw new Error('block not found');
      blocks[idx] = { ...blocks[idx]!, ...args.data, updatedAt: new Date() };
      return blocks[idx]!;
    },
    async delete(args: { where: { id: string } }) {
      const idx = blocks.findIndex((b) => b.id === args.where.id);
      if (idx === -1) throw new Error('block not found');
      blocks.splice(idx, 1);
      return undefined;
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

  it('renderiza bloque <participantes> cuando se pasan', () => {
    const xml = buildActionXml(
      {
        id: 'a',
        tenantId: 't',
        courseId: 'c',
        codigoAccion: 'A1',
        nombre: 'N',
        modalidad: 'TELEFORMACION',
        horasFormacion: 10,
        fechaInicio: '2026-01-01',
        fechaFin: '2026-01-10',
        lugar: null,
        cifCentro: null,
        notas: null,
        status: 'ACTIVE',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      [
        {
          userId: 'u1',
          nombre: 'Alice',
          email: 'alice@test.dev',
          dni: '11111111H',
          horasAsistidas: 10,
          resultado: 'APTO',
          enrolledAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-09T00:00:00.000Z',
        },
        {
          userId: 'u2',
          nombre: null,
          email: 'bob@test.dev',
          dni: null,
          horasAsistidas: 5,
          resultado: 'EN_CURSO',
          enrolledAt: '2026-01-02T00:00:00.000Z',
          completedAt: null,
        },
      ],
    );
    expect(xml).toContain('<participantes total="2">');
    expect(xml).toContain('<userId>u1</userId>');
    expect(xml).toContain('<dni>11111111H</dni>');
    expect(xml).toContain('<email>alice@test.dev</email>');
    expect(xml).toContain('<resultado>APTO</resultado>');
    expect(xml).toContain('<resultado>EN_CURSO</resultado>');
    expect(xml).toContain('<horasAsistidas>10</horasAsistidas>');
    // Bob no tiene nombre ni dni → no debe aparecer esos tags vacíos.
    expect(xml).not.toContain('<dni></dni>');
  });
});

describe('FundaeService participantes', () => {
  it('countParticipants devuelve 0 si la acción no tiene curso vinculado', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const svc = new FundaeService(prisma as never, ctx as never);
    const a = await svc.create(TENANT, 'u', {
      codigoAccion: 'NOC',
      nombre: 'Sin curso',
      modalidad: 'PRESENCIAL',
      horasFormacion: 5,
      fechaInicio: '2026-01-01',
      fechaFin: '2026-01-10',
    });
    expect(await svc.countParticipants(TENANT, a.id)).toBe(0);
  });

  it('countParticipants cuenta enrollments no cancelados', async () => {
    const courseId = 'course-1';
    const prisma = makeFakePrisma({
      courses: [{ id: courseId, tenantId: TENANT }],
      enrollments: [
        {
          id: 'e1',
          tenantId: TENANT,
          courseId,
          userId: 'u1',
          status: 'IN_PROGRESS',
          progressPercent: 50,
          completionThreshold: 80,
          completedAt: null,
          enrolledAt: new Date('2026-01-01'),
        },
        {
          id: 'e2',
          tenantId: TENANT,
          courseId,
          userId: 'u2',
          status: 'COMPLETED',
          progressPercent: 100,
          completionThreshold: 80,
          completedAt: new Date('2026-01-09'),
          enrolledAt: new Date('2026-01-02'),
        },
        {
          id: 'e3',
          tenantId: TENANT,
          courseId,
          userId: 'u3',
          status: 'CANCELLED',
          progressPercent: 0,
          completionThreshold: 80,
          completedAt: null,
          enrolledAt: new Date('2026-01-03'),
        },
      ],
    });
    const ctx = makeCtx();
    const svc = new FundaeService(prisma as never, ctx as never);
    const a = await svc.create(TENANT, 'u', {
      codigoAccion: 'CONC',
      nombre: 'Con curso',
      modalidad: 'TELEFORMACION',
      horasFormacion: 10,
      fechaInicio: '2026-01-01',
      fechaFin: '2026-01-10',
      courseId,
    });
    expect(await svc.countParticipants(TENANT, a.id)).toBe(2);
  });

  it('generateXml incluye participantes desde enrollments del curso vinculado', async () => {
    const courseId = 'course-2';
    const prisma = makeFakePrisma({
      courses: [{ id: courseId, tenantId: TENANT }],
      enrollments: [
        {
          id: 'e1',
          tenantId: TENANT,
          courseId,
          userId: 'u1',
          status: 'COMPLETED',
          progressPercent: 100,
          completionThreshold: 80,
          completedAt: new Date('2026-01-09'),
          enrolledAt: new Date('2026-01-01'),
        },
        {
          id: 'e2',
          tenantId: TENANT,
          courseId,
          userId: 'u2',
          status: 'IN_PROGRESS',
          progressPercent: 50,
          completionThreshold: 80,
          completedAt: null,
          enrolledAt: new Date('2026-01-02'),
        },
      ],
      users: [
        { id: 'u1', email: 'alice@test.dev', name: 'Alice' },
        { id: 'u2', email: 'bob@test.dev', name: 'Bob' },
      ],
    });
    const ctx = makeCtx();
    const svc = new FundaeService(prisma as never, ctx as never);
    const a = await svc.create(TENANT, 'u', {
      codigoAccion: 'XML-PART',
      nombre: 'Curso con participantes',
      modalidad: 'TELEFORMACION',
      horasFormacion: 10,
      fechaInicio: '2026-01-01',
      fechaFin: '2026-01-10',
      courseId,
    });
    const xml = await svc.generateXml(TENANT, 'u', a.id);
    expect(xml).toContain('<participantes total="2">');
    expect(xml).toContain('<email>alice@test.dev</email>');
    expect(xml).toContain('<email>bob@test.dev</email>');
    // Alice completó al 100% → APTO. Bob al 50% sin completedAt → EN_CURSO.
    expect(xml).toContain('<resultado>APTO</resultado>');
    expect(xml).toContain('<resultado>EN_CURSO</resultado>');
    // Horas asistidas estimadas: Alice 10h, Bob 5h.
    expect(xml).toContain('<horasAsistidas>10</horasAsistidas>');
    expect(xml).toContain('<horasAsistidas>5</horasAsistidas>');
  });

  it('generateXml omite bloque participantes cuando la acción no tiene curso', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const svc = new FundaeService(prisma as never, ctx as never);
    const a = await svc.create(TENANT, 'u', {
      codigoAccion: 'XML-NOC',
      nombre: 'Sin curso',
      modalidad: 'PRESENCIAL',
      horasFormacion: 5,
      fechaInicio: '2026-01-01',
      fechaFin: '2026-01-10',
    });
    const xml = await svc.generateXml(TENANT, 'u', a.id);
    expect(xml).not.toContain('<participantes');
  });

  it('crea bloques y los serializa en el XML como <modulosFormativos>', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const svc = new FundaeService(prisma as never, ctx as never);
    const a = await svc.create(TENANT, 'u', {
      codigoAccion: 'BLK-1',
      nombre: 'Acción con bloques',
      modalidad: 'MIXTA',
      horasFormacion: 10,
      fechaInicio: '2026-01-01',
      fechaFin: '2026-01-10',
    });
    const b1 = await svc.createBlock(TENANT, 'u', a.id, {
      title: 'Introducción',
      hours: 4,
      modalidad: 'PRESENCIAL',
      contenidos: 'Bloque 1\nÍtem A\nÍtem B',
    });
    const b2 = await svc.createBlock(TENANT, 'u', a.id, {
      title: 'Práctica',
      hours: 6,
      modalidad: 'TELEFORMACION',
    });
    expect(b1.ordinal).toBe(1);
    expect(b2.ordinal).toBe(2);

    const list = await svc.listBlocks(TENANT, a.id);
    expect(list).toHaveLength(2);
    expect(list[0]!.ordinal).toBe(1);
    expect(list[1]!.modalidad).toBe('TELEFORMACION');

    const xml = await svc.generateXml(TENANT, 'u', a.id);
    expect(xml).toContain('<modulosFormativos total="2">');
    expect(xml).toContain('<title>Introducción</title>');
    expect(xml).toContain('<title>Práctica</title>');
    expect(xml).toContain('<modalidad>PRESENCIAL</modalidad>');
    expect(xml).toContain('<modalidad>TELEFORMACION</modalidad>');
    // Contenidos del b1 debe escaparse por XML pero preservarse.
    expect(xml).toContain('<contenidos>Bloque 1\nÍtem A\nÍtem B</contenidos>');
    // El bloque sin contenidos no genera <contenidos> vacío.
    expect(xml).not.toContain('<contenidos></contenidos>');
  });

  it('rechaza bloques cuando la suma de horas supera la acción', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const svc = new FundaeService(prisma as never, ctx as never);
    const a = await svc.create(TENANT, 'u', {
      codigoAccion: 'BLK-CAP',
      nombre: 'Acción con tope 10h',
      modalidad: 'PRESENCIAL',
      horasFormacion: 10,
      fechaInicio: '2026-01-01',
      fechaFin: '2026-01-10',
    });
    await svc.createBlock(TENANT, 'u', a.id, {
      title: 'A',
      hours: 8,
      modalidad: 'PRESENCIAL',
    });
    await expect(
      svc.createBlock(TENANT, 'u', a.id, {
        title: 'B',
        hours: 5, // 8 + 5 = 13 > 10
        modalidad: 'PRESENCIAL',
      }),
    ).rejects.toBeInstanceOf(BlockHoursExceedActionError);
  });

  it('rechaza ordinal duplicado al crear', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const svc = new FundaeService(prisma as never, ctx as never);
    const a = await svc.create(TENANT, 'u', {
      codigoAccion: 'BLK-ORD',
      nombre: 'X',
      modalidad: 'PRESENCIAL',
      horasFormacion: 10,
      fechaInicio: '2026-01-01',
      fechaFin: '2026-01-10',
    });
    await svc.createBlock(TENANT, 'u', a.id, {
      ordinal: 1,
      title: 'A',
      hours: 1,
      modalidad: 'PRESENCIAL',
    });
    await expect(
      svc.createBlock(TENANT, 'u', a.id, {
        ordinal: 1,
        title: 'B',
        hours: 1,
        modalidad: 'PRESENCIAL',
      }),
    ).rejects.toBeInstanceOf(BlockOrdinalDuplicadoError);
  });

  it('updateBlock cambia título y hours respetando el cap', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const svc = new FundaeService(prisma as never, ctx as never);
    const a = await svc.create(TENANT, 'u', {
      codigoAccion: 'BLK-UPD',
      nombre: 'X',
      modalidad: 'PRESENCIAL',
      horasFormacion: 10,
      fechaInicio: '2026-01-01',
      fechaFin: '2026-01-10',
    });
    const b = await svc.createBlock(TENANT, 'u', a.id, {
      title: 'A',
      hours: 4,
      modalidad: 'PRESENCIAL',
    });
    const updated = await svc.updateBlock(TENANT, 'u', a.id, b.id, {
      title: 'A renombrado',
      hours: 6,
    });
    expect(updated.title).toBe('A renombrado');
    expect(updated.hours).toBe(6);

    // Excede el cap.
    await expect(svc.updateBlock(TENANT, 'u', a.id, b.id, { hours: 11 })).rejects.toBeInstanceOf(
      BlockHoursExceedActionError,
    );
  });

  it('deleteBlock elimina y permite reciclar el ordinal', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const svc = new FundaeService(prisma as never, ctx as never);
    const a = await svc.create(TENANT, 'u', {
      codigoAccion: 'BLK-DEL',
      nombre: 'X',
      modalidad: 'PRESENCIAL',
      horasFormacion: 10,
      fechaInicio: '2026-01-01',
      fechaFin: '2026-01-10',
    });
    const b1 = await svc.createBlock(TENANT, 'u', a.id, {
      title: 'A',
      hours: 4,
      modalidad: 'PRESENCIAL',
    });
    await svc.deleteBlock(TENANT, 'u', a.id, b1.id);
    const after = await svc.listBlocks(TENANT, a.id);
    expect(after).toHaveLength(0);
    // Reusar ordinal=1 sin choque.
    await svc.createBlock(TENANT, 'u', a.id, {
      ordinal: 1,
      title: 'A2',
      hours: 4,
      modalidad: 'PRESENCIAL',
    });
    expect((await svc.listBlocks(TENANT, a.id))[0]!.ordinal).toBe(1);
  });

  it('deleteBlock rechaza id inexistente', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const svc = new FundaeService(prisma as never, ctx as never);
    const a = await svc.create(TENANT, 'u', {
      codigoAccion: 'BLK-NF',
      nombre: 'X',
      modalidad: 'PRESENCIAL',
      horasFormacion: 10,
      fechaInicio: '2026-01-01',
      fechaFin: '2026-01-10',
    });
    await expect(svc.deleteBlock(TENANT, 'u', a.id, 'no-existe')).rejects.toBeInstanceOf(
      BlockNotFoundError,
    );
  });

  it('generateXml propaga el documentId del User como <dni> en el XML', async () => {
    const courseId = 'course-dni';
    const prisma = makeFakePrisma({
      courses: [{ id: courseId, tenantId: TENANT }],
      enrollments: [
        {
          id: 'e1',
          tenantId: TENANT,
          courseId,
          userId: 'u-dni',
          status: 'COMPLETED',
          progressPercent: 100,
          completionThreshold: 80,
          completedAt: new Date('2026-01-09'),
          enrolledAt: new Date('2026-01-01'),
        },
        {
          id: 'e2',
          tenantId: TENANT,
          courseId,
          userId: 'u-sin',
          status: 'IN_PROGRESS',
          progressPercent: 50,
          completionThreshold: 80,
          completedAt: null,
          enrolledAt: new Date('2026-01-02'),
        },
      ],
      users: [
        { id: 'u-dni', email: 'dni@test.dev', name: 'Con DNI', documentId: '12345678Z' },
        { id: 'u-sin', email: 'sin@test.dev', name: 'Sin DNI', documentId: null },
      ],
    });
    const ctx = makeCtx();
    const svc = new FundaeService(prisma as never, ctx as never);
    const a = await svc.create(TENANT, 'u', {
      codigoAccion: 'XML-DNI',
      nombre: 'Curso con DNI',
      modalidad: 'TELEFORMACION',
      horasFormacion: 10,
      fechaInicio: '2026-01-01',
      fechaFin: '2026-01-10',
      courseId,
    });
    const xml = await svc.generateXml(TENANT, 'u', a.id);
    expect(xml).toContain('<dni>12345678Z</dni>');
    // El usuario sin DNI no debe aparecer con tag dni vacío.
    expect(xml).not.toContain('<dni></dni>');
  });
});
