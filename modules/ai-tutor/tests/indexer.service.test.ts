import { describe, expect, it, vi } from 'vitest';
import { CourseNotPublishedError, EmbeddingsProviderError } from '../src/errors.js';
import { AiTutorIndexerService, type EmbedFn } from '../src/indexer.service.js';

// Los dobles NO se castean a `never` al declararse: con `never` no se les
// puede leer ninguna propiedad y las aserciones sobre sus espías dejan de
// typechequearse. El cast va donde se inyectan, que es donde hace falta.
function makeContext() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
    eventBus: { publish: vi.fn(async () => {}) },
  };
}

interface FakeRows {
  course?: { id: string; tenantId: string; status: string } | null;
  modules?: Array<{ id: string; title: string; position: number }>;
  lessons?: Array<{
    id: string;
    moduleId: string;
    type: string;
    title: string;
    content: Record<string, unknown>;
    position: number;
  }>;
}

function makeFakePrisma(opts: FakeRows) {
  const inserts: unknown[][] = [];
  const deletes: unknown[][] = [];
  const ejecutar = vi.fn(async (sql: string, ...params: unknown[]) => {
    if (sql.startsWith('DELETE')) {
      deletes.push(params);
      return 0;
    }
    if (sql.startsWith('INSERT')) {
      inserts.push(params);
      return 1;
    }
    return 0;
  });
  const cliente = {
    inserts,
    deletes,
    modCoursesCourse: { findFirst: vi.fn(async () => opts.course ?? null) },
    modCoursesModule: { findMany: vi.fn(async () => opts.modules ?? []) },
    modCoursesLesson: { findMany: vi.fn(async () => opts.lessons ?? []) },
    $executeRawUnsafe: ejecutar,
    // El borrado del indice viejo y el alta del nuevo van en la MISMA
    // transaccion: si los embeddings fallan, el indice anterior sigue en pie.
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(cliente)),
  };
  return cliente;
}

const fakeEmbed =
  (dimension = 1536): EmbedFn =>
  async ({ texts }) => ({
    embeddings: texts.map((_, i) =>
      new Array(dimension).fill(0).map((__, j) => (i + 1) * 0.001 + j * 0.0001),
    ),
    totalTokens: texts.reduce((acc, t) => acc + Math.ceil(t.length / 4), 0),
    dimension,
  });

describe('AiTutorIndexerService (LMS-90.C)', () => {
  it('lanza si curso no existe', async () => {
    const prisma = makeFakePrisma({ course: null });
    const svc = new AiTutorIndexerService(prisma as never, makeContext() as never, fakeEmbed());
    await expect(svc.indexCourse('t1', 'c-missing')).rejects.toThrow(/not found/);
  });

  it('lanza CourseNotPublishedError si curso DRAFT y no allowDraft', async () => {
    const prisma = makeFakePrisma({
      course: { id: 'c1', tenantId: 't1', status: 'DRAFT' },
    });
    const svc = new AiTutorIndexerService(prisma as never, makeContext() as never, fakeEmbed());
    await expect(svc.indexCourse('t1', 'c1')).rejects.toBeInstanceOf(CourseNotPublishedError);
  });

  it('allowDraft=true permite indexar curso DRAFT', async () => {
    const prisma = makeFakePrisma({
      course: { id: 'c1', tenantId: 't1', status: 'DRAFT' },
      modules: [],
    });
    const svc = new AiTutorIndexerService(prisma as never, makeContext() as never, fakeEmbed());
    const result = await svc.indexCourse('t1', 'c1', { allowDraft: true });
    expect(result.lessonsProcessed).toBe(0);
    expect(result.chunksGenerated).toBe(0);
  });

  it('curso publicado sin lecciones → result vacío + evento emitido', async () => {
    const ctx = makeContext();
    const prisma = makeFakePrisma({
      course: { id: 'c1', tenantId: 't1', status: 'PUBLISHED' },
      modules: [],
    });
    const svc = new AiTutorIndexerService(prisma as never, ctx as never, fakeEmbed());
    const result = await svc.indexCourse('t1', 'c1');
    expect(result.chunksGenerated).toBe(0);
    expect(result.lessonsProcessed).toBe(0);
    expect(ctx.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ai-tutor.course.indexed' }),
    );
  });

  it('extrae texto de TEXT lessons, chunkea, embed y persiste con INSERT raw', async () => {
    const ctx = makeContext();
    const prisma = makeFakePrisma({
      course: { id: 'c1', tenantId: 't1', status: 'PUBLISHED' },
      modules: [{ id: 'm1', title: 'Módulo 1', position: 0 }],
      lessons: [
        {
          id: 'l1',
          moduleId: 'm1',
          type: 'TEXT',
          title: 'Lección 1',
          content: { text: 'Contenido formativo de la lección uno.' },
          position: 0,
        },
        {
          id: 'l2',
          moduleId: 'm1',
          type: 'TEXT',
          title: 'Lección 2',
          content: { text: 'Otra lección distinta sobre Excel.' },
          position: 1,
        },
      ],
    });
    const svc = new AiTutorIndexerService(prisma as never, ctx as never, fakeEmbed());
    const result = await svc.indexCourse('t1', 'c1');

    expect(result.lessonsProcessed).toBe(2);
    expect(result.chunksGenerated).toBeGreaterThan(0);
    expect(result.tokensUsed).toBeGreaterThan(0);

    // Borrado previo + N inserts
    expect(prisma.deletes).toHaveLength(1);
    expect(prisma.inserts).toHaveLength(result.chunksGenerated);

    // Cada INSERT lleva embedding como string '[v1,v2,...]'
    for (const params of prisma.inserts) {
      const embStr = params[6] as string;
      expect(embStr.startsWith('[')).toBe(true);
      expect(embStr.endsWith(']')).toBe(true);
    }

    // Evento de éxito emitido
    expect(ctx.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'ai-tutor.course.indexed',
        data: expect.objectContaining({ courseId: 'c1', chunksGenerated: result.chunksGenerated }),
      }),
    );
  });

  it('omite lecciones sin texto indexable (QUIZ, SCORM, VIDEO sin transcript)', async () => {
    const prisma = makeFakePrisma({
      course: { id: 'c1', tenantId: 't1', status: 'PUBLISHED' },
      modules: [{ id: 'm1', title: 'M', position: 0 }],
      lessons: [
        { id: 'l1', moduleId: 'm1', type: 'QUIZ', title: 'Q', content: {}, position: 0 },
        { id: 'l2', moduleId: 'm1', type: 'SCORM', title: 'S', content: {}, position: 1 },
        {
          id: 'l3',
          moduleId: 'm1',
          type: 'VIDEO',
          title: 'V',
          content: { videoUrl: 'x' }, // sin transcript
          position: 2,
        },
        {
          id: 'l4',
          moduleId: 'm1',
          type: 'TEXT',
          title: 'T',
          content: { text: 'sí indexable' },
          position: 3,
        },
      ],
    });
    const svc = new AiTutorIndexerService(prisma as never, makeContext() as never, fakeEmbed());
    const result = await svc.indexCourse('t1', 'c1');
    // Solo cuenta TEXT
    expect(result.lessonsProcessed).toBe(1);
    expect(result.chunksGenerated).toBeGreaterThan(0);
  });

  it('falla si dimensión del provider ≠ 1536 (schema vector(1536) fijo)', async () => {
    const ctx = makeContext();
    const prisma = makeFakePrisma({
      course: { id: 'c1', tenantId: 't1', status: 'PUBLISHED' },
      modules: [{ id: 'm1', title: 'M', position: 0 }],
      lessons: [
        {
          id: 'l1',
          moduleId: 'm1',
          type: 'TEXT',
          title: 'T',
          content: { text: 'algo' },
          position: 0,
        },
      ],
    });
    const svc = new AiTutorIndexerService(prisma as never, ctx as never, fakeEmbed(768));
    await expect(svc.indexCourse('t1', 'c1')).rejects.toBeInstanceOf(EmbeddingsProviderError);
  });

  it('si embedFn falla, emite ai-tutor.course.index-failed y propaga', async () => {
    const ctx = makeContext();
    const prisma = makeFakePrisma({
      course: { id: 'c1', tenantId: 't1', status: 'PUBLISHED' },
      modules: [{ id: 'm1', title: 'M', position: 0 }],
      lessons: [
        {
          id: 'l1',
          moduleId: 'm1',
          type: 'TEXT',
          title: 'T',
          content: { text: 'algo' },
          position: 0,
        },
      ],
    });
    const failingEmbed: EmbedFn = async () => {
      throw new Error('rate limit');
    };
    const svc = new AiTutorIndexerService(prisma as never, ctx as never, failingEmbed);
    await expect(svc.indexCourse('t1', 'c1')).rejects.toBeInstanceOf(EmbeddingsProviderError);
    expect(ctx.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ai-tutor.course.index-failed' }),
    );
  });

  it('re-indexar borra chunks previos antes de insertar (idempotente)', async () => {
    const prisma = makeFakePrisma({
      course: { id: 'c1', tenantId: 't1', status: 'PUBLISHED' },
      modules: [{ id: 'm1', title: 'M', position: 0 }],
      lessons: [
        {
          id: 'l1',
          moduleId: 'm1',
          type: 'TEXT',
          title: 'T',
          content: { text: 'contenido' },
          position: 0,
        },
      ],
    });
    const svc = new AiTutorIndexerService(prisma as never, makeContext() as never, fakeEmbed());
    await svc.indexCourse('t1', 'c1');
    expect(prisma.deletes).toHaveLength(1);
    expect(prisma.inserts.length).toBeGreaterThan(0);

    // Segunda invocación: nuevo delete + nuevo insert
    await svc.indexCourse('t1', 'c1');
    expect(prisma.deletes).toHaveLength(2);
  });

  it('si los embeddings fallan, el índice VIEJO no se borra (M9)', async () => {
    // El borrado estaba antes de pedir los embeddings: un fallo del proveedor
    // a mitad dejaba el curso sin índice y el tutor devolvía
    // CourseNotIndexedError a todos sus alumnos hasta que alguien re-lanzara
    // la indexación a mano.
    const prisma = makeFakePrisma({
      course: { id: 'c1', tenantId: 't1', status: 'PUBLISHED' },
      modules: [{ id: 'm1', title: 'M', position: 0 }],
      lessons: [
        {
          id: 'l1',
          moduleId: 'm1',
          type: 'TEXT',
          title: 'T',
          content: { text: 'contenido' },
          position: 0,
        },
      ],
    });
    const embedRoto: EmbedFn = async () => {
      throw new Error('el proveedor de embeddings esta caido');
    };
    const svc = new AiTutorIndexerService(prisma as never, makeContext() as never, embedRoto);

    await expect(svc.indexCourse('t1', 'c1')).rejects.toBeTruthy();

    expect(prisma.deletes).toHaveLength(0);
    expect(prisma.inserts).toHaveLength(0);
  });

  it('unindexCourse() borra chunks y emite evento', async () => {
    const ctx = makeContext();
    const prisma = makeFakePrisma({
      course: { id: 'c1', tenantId: 't1', status: 'PUBLISHED' },
    });
    const svc = new AiTutorIndexerService(prisma as never, ctx as never, fakeEmbed());
    await svc.unindexCourse('t1', 'c1');
    expect(prisma.deletes).toHaveLength(1);
    expect(ctx.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ unindexed: true }),
      }),
    );
  });

  it('agrupa lecciones por módulo con cabecera contextual', async () => {
    const prisma = makeFakePrisma({
      course: { id: 'c1', tenantId: 't1', status: 'PUBLISHED' },
      modules: [
        { id: 'm1', title: 'Módulo Uno', position: 0 },
        { id: 'm2', title: 'Módulo Dos', position: 1 },
      ],
      lessons: [
        {
          id: 'l1',
          moduleId: 'm1',
          type: 'TEXT',
          title: 'Lec1',
          content: { text: 'Contenido en módulo uno.' },
          position: 0,
        },
        {
          id: 'l2',
          moduleId: 'm2',
          type: 'TEXT',
          title: 'Lec2',
          content: { text: 'Contenido en módulo dos.' },
          position: 0,
        },
      ],
    });
    const svc = new AiTutorIndexerService(prisma as never, makeContext() as never, fakeEmbed());
    await svc.indexCourse('t1', 'c1');

    // Cada chunk content (param 5) debe incluir cabecera de módulo
    const chunkContents = prisma.inserts.map((p) => p[5] as string);
    expect(chunkContents.some((c) => c.includes('Módulo Uno'))).toBe(true);
    expect(chunkContents.some((c) => c.includes('Módulo Dos'))).toBe(true);
  });
});
