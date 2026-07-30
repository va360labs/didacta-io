import { describe, expect, it, vi } from 'vitest';
import { AiTutorReviewService, rangoDelMes } from '../src/review.service.js';
import type { EmbedFn } from '../src/review.service.js';
import { MessageNotFoundError } from '../src/errors.js';
import { listAnswersSchema } from '../src/dto.js';

/**
 * Tests del panel de calidad del tutor.
 *
 * Lo que se protege aquí es la promesa que le hacemos al admin: si corriges una
 * respuesta, esa corrección queda guardada como conocimiento y el tutor la usa.
 * Y que el informe mensual agrupe de verdad, en vez de listar 400 preguntas.
 */

function makeContext() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
    eventBus: { publish: vi.fn(async () => {}) },
  } as never;
}

const embedFake: EmbedFn = async ({ texts }) => ({
  embeddings: texts.map(() => new Array(4).fill(0.5)),
  totalTokens: texts.length * 4,
  dimension: 4,
});

interface FilaPregunta {
  id: string;
  question: string;
  embedding: string | null;
  user_id: string;
  course_id: string;
  created_at: Date;
  answer_id: string | null;
  review_status: string | null;
  sin_respaldo: boolean | null;
}

function makeFakePrisma(opts: {
  mensaje?: { id: string; conversationId: string; createdAt: Date } | null;
  conversacion?: { courseId: string } | null;
  preguntaPrevia?: { content: string } | null;
  correcciones?: Array<Record<string, unknown>>;
  respuestas?: Array<Record<string, unknown>>;
  preguntasDelMes?: FilaPregunta[];
  usuarios?: Array<{ id: string; name: string | null; email: string | null }>;
  cursos?: Array<{ id: string; title: string }>;
}) {
  const ejecutados: Array<{ sql: string; params: unknown[] }> = [];
  const actualizados: Array<{ where: unknown; data: unknown }> = [];
  return {
    ejecutados,
    actualizados,
    modAiTutorMessage: {
      findFirst: vi.fn(async ({ where }: { where: { role?: string } }) =>
        where.role === 'user' ? (opts.preguntaPrevia ?? null) : (opts.mensaje ?? null),
      ),
      update: vi.fn(async (args: { where: unknown; data: unknown }) => {
        actualizados.push(args);
        return {};
      }),
    },
    modAiTutorConversation: {
      findFirst: vi.fn(async () => opts.conversacion ?? null),
    },
    modAiTutorCorrection: {
      findMany: vi.fn(async () => opts.correcciones ?? []),
    },
    user: {
      findMany: vi.fn(async () => opts.usuarios ?? []),
    },
    modCoursesCourse: {
      findMany: vi.fn(async () => opts.cursos ?? []),
    },
    modCoursesLesson: {
      findMany: vi.fn(async () => []),
    },
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes('COUNT(*)')) return [{ n: 0 }];
      if (sql.includes('u."role" = \'user\'')) return opts.preguntasDelMes ?? [];
      return opts.respuestas ?? [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      ejecutados.push({ sql, params });
      return 1;
    }),
  } as never;
}

const AHORA = new Date('2026-07-15T10:00:00.000Z');

describe('AiTutorReviewService.review', () => {
  const mensaje = { id: 'msg-1', conversationId: 'conv-1', createdAt: AHORA };

  it('marcar como correcta no crea conocimiento validado', async () => {
    const prisma = makeFakePrisma({
      mensaje,
      conversacion: { courseId: 'curso-1' },
      preguntaPrevia: { content: '¿cómo instalo el nodo?' },
      respuestas: [
        {
          id: 'msg-1',
          conversation_id: 'conv-1',
          answer: 'Se instala así',
          citations: [],
          created_at: AHORA,
          review_status: 'OK',
          reviewed_by_id: 'admin-1',
          reviewed_at: AHORA,
          review_note: null,
          question: '¿cómo instalo el nodo?',
          user_id: 'alumno-1',
          course_id: 'curso-1',
        },
      ],
    });
    const svc = new AiTutorReviewService(prisma, makeContext(), embedFake);

    const vista = await svc.review('t1', 'msg-1', { status: 'OK' }, 'admin-1');

    expect(vista.reviewStatus).toBe('OK');
    expect(
      prisma.ejecutados.some((e) => e.sql.includes('INSERT INTO "mod_ai_tutor_correction"')),
    ).toBe(false);
  });

  it('corregir guarda la respuesta buena como conocimiento validado', async () => {
    const prisma = makeFakePrisma({
      mensaje,
      conversacion: { courseId: 'curso-1' },
      preguntaPrevia: { content: 'oye no me va la instalación esa' },
      respuestas: [
        {
          id: 'msg-1',
          conversation_id: 'conv-1',
          answer: 'respuesta mala',
          citations: [],
          created_at: AHORA,
          review_status: 'CORRECTED',
          reviewed_by_id: 'admin-1',
          reviewed_at: AHORA,
          review_note: 'faltaba el paso 2',
          question: 'oye no me va la instalación esa',
          user_id: 'alumno-1',
          course_id: 'curso-1',
        },
      ],
    });
    const svc = new AiTutorReviewService(prisma, makeContext(), embedFake);

    await svc.review(
      't1',
      'msg-1',
      {
        status: 'CORRECTED',
        respuestaCorregida: 'Primero instala Node 22, luego npm i -g n8n.',
        preguntaCanonica: '¿cómo instalo el nodo?',
        nota: 'faltaba el paso 2',
      },
      'admin-1',
    );

    const insert = prisma.ejecutados.find((e) =>
      e.sql.includes('INSERT INTO "mod_ai_tutor_correction"'),
    );
    expect(insert).toBeDefined();
    // La pregunta canónica manda sobre la que escribió el alumno: es la que se
    // embebe, y por tanto la que decide cuándo se dispara la corrección.
    expect(insert!.params).toContain('¿cómo instalo el nodo?');
    expect(insert!.params).toContain('Primero instala Node 22, luego npm i -g n8n.');
    // Curso concreto, no global.
    expect(insert!.params).toContain('curso-1');
  });

  it('corregir dos veces el mismo mensaje desactiva la corrección anterior', async () => {
    const prisma = makeFakePrisma({
      mensaje,
      conversacion: { courseId: 'curso-1' },
      preguntaPrevia: { content: 'p' },
      respuestas: [
        {
          id: 'msg-1',
          conversation_id: 'conv-1',
          answer: 'a',
          citations: [],
          created_at: AHORA,
          review_status: 'CORRECTED',
          reviewed_by_id: 'admin-1',
          reviewed_at: AHORA,
          review_note: null,
          question: 'p',
          user_id: 'alumno-1',
          course_id: 'curso-1',
        },
      ],
    });
    const svc = new AiTutorReviewService(prisma, makeContext(), embedFake);

    await svc.review(
      't1',
      'msg-1',
      { status: 'CORRECTED', respuestaCorregida: 'la segunda versión, mejor' },
      'admin-1',
    );

    const desactiva = prisma.ejecutados.find(
      (e) =>
        e.sql.includes('UPDATE "mod_ai_tutor_correction"') && e.sql.includes('"active" = false'),
    );
    expect(desactiva).toBeDefined();
  });

  it('marcar como global guarda la corrección sin curso', async () => {
    const prisma = makeFakePrisma({
      mensaje,
      conversacion: { courseId: 'curso-1' },
      preguntaPrevia: { content: '¿dónde está mi factura?' },
      respuestas: [
        {
          id: 'msg-1',
          conversation_id: 'conv-1',
          answer: 'a',
          citations: [],
          created_at: AHORA,
          review_status: 'CORRECTED',
          reviewed_by_id: 'admin-1',
          reviewed_at: AHORA,
          review_note: null,
          question: '¿dónde está mi factura?',
          user_id: 'alumno-1',
          course_id: 'curso-1',
        },
      ],
    });
    const svc = new AiTutorReviewService(prisma, makeContext(), embedFake);

    await svc.review(
      't1',
      'msg-1',
      {
        status: 'CORRECTED',
        respuestaCorregida: 'En /cuenta → Facturación.',
        aplicaATodosLosCursos: true,
      },
      'admin-1',
    );

    const insert = prisma.ejecutados.find((e) =>
      e.sql.includes('INSERT INTO "mod_ai_tutor_correction"'),
    );
    // course_id null = vale para cualquier curso del tenant.
    expect(insert!.params[2]).toBeNull();
  });

  it('revisar un mensaje que no existe da MessageNotFoundError', async () => {
    const prisma = makeFakePrisma({ mensaje: null });
    const svc = new AiTutorReviewService(prisma, makeContext(), embedFake);
    await expect(svc.review('t1', 'no-existe', { status: 'OK' }, 'admin-1')).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
  });
});

describe('AiTutorReviewService.monthlyReport', () => {
  /** Vector unitario en 4D usando solo dos ejes, para controlar el ángulo. */
  function dir(grados: number): string {
    const r = (grados * Math.PI) / 180;
    return `[${Math.cos(r)},${Math.sin(r)},0,0]`;
  }

  function pregunta(over: Partial<FilaPregunta> & { id: string }): FilaPregunta {
    return {
      question: 'una pregunta',
      embedding: dir(0),
      user_id: 'alumno-1',
      course_id: 'curso-1',
      created_at: new Date('2026-07-05T12:00:00.000Z'),
      answer_id: `resp-${over.id}`,
      review_status: 'PENDING',
      sin_respaldo: false,
      ...over,
    };
  }

  it('agrupa las formulaciones de la misma duda y cuenta alumnos distintos', async () => {
    const prisma = makeFakePrisma({
      preguntasDelMes: [
        pregunta({ id: '1', question: 'no me instala el nodo', embedding: dir(0) }),
        pregunta({
          id: '2',
          question: 'error al instalar el nodo',
          embedding: dir(3),
          user_id: 'alumno-2',
        }),
        pregunta({ id: '3', question: 'cómo saco el certificado', embedding: dir(90) }),
      ],
      usuarios: [
        { id: 'alumno-1', name: 'Ana', email: 'ana@x.com' },
        { id: 'alumno-2', name: 'Beto', email: 'beto@x.com' },
      ],
      cursos: [{ id: 'curso-1', title: 'n8n desde cero' }],
    });
    const svc = new AiTutorReviewService(prisma, makeContext(), embedFake);

    const informe = await svc.monthlyReport('t1', { mes: '2026-07' });

    expect(informe.mes).toBe('2026-07');
    expect(informe.totalPreguntas).toBe(3);
    expect(informe.alumnosActivos).toBe(2);
    expect(informe.temas).toHaveLength(2);

    const [principal] = informe.temas;
    expect(principal!.veces).toBe(2);
    expect(principal!.alumnos).toBe(2);
    expect(principal!.quienes.map((q) => q.name).sort()).toEqual(['Ana', 'Beto']);
    expect(principal!.cursos[0]!.title).toBe('n8n desde cero');
  });

  it('cuenta las respuestas que salieron sin poder citar el material', async () => {
    const prisma = makeFakePrisma({
      preguntasDelMes: [
        pregunta({ id: '1', sin_respaldo: true }),
        pregunta({ id: '2', sin_respaldo: true, embedding: dir(2) }),
        pregunta({ id: '3', sin_respaldo: false, embedding: dir(90) }),
      ],
    });
    const svc = new AiTutorReviewService(prisma, makeContext(), embedFake);

    const informe = await svc.monthlyReport('t1', { mes: '2026-07' });

    expect(informe.sinRespaldo).toBe(2);
    expect(informe.temas[0]!.sinRespaldo).toBe(2);
  });

  it('embebe y persiste las preguntas antiguas que no traen vector', async () => {
    // Todo lo anterior a la columna question_embedding llega con null. Dejarlas
    // fuera sería dejar fuera el histórico entero justo el primer mes.
    const prisma = makeFakePrisma({
      preguntasDelMes: [
        pregunta({ id: '1', embedding: null, question: 'vieja sin vector' }),
        pregunta({ id: '2', embedding: null, question: 'otra vieja' }),
      ],
    });
    const svc = new AiTutorReviewService(prisma, makeContext(), embedFake);

    const informe = await svc.monthlyReport('t1', { mes: '2026-07' });

    // El fake embebe todo al mismo vector, así que las dos caen en un tema.
    expect(informe.temas).toHaveLength(1);
    expect(informe.temas[0]!.veces).toBe(2);
    const guardados = prisma.ejecutados.filter((e) => e.sql.includes('SET "question_embedding"'));
    expect(guardados).toHaveLength(2);
  });

  it('si el proveedor de embeddings falla, devuelve informe con lo que haya', async () => {
    const prisma = makeFakePrisma({
      preguntasDelMes: [
        pregunta({ id: '1', embedding: null }),
        pregunta({ id: '2', embedding: dir(0), question: 'esta sí tiene vector' }),
      ],
    });
    const embedRoto: EmbedFn = async () => {
      throw new Error('provider caído');
    };
    const svc = new AiTutorReviewService(prisma, makeContext(), embedRoto);

    const informe = await svc.monthlyReport('t1', { mes: '2026-07' });

    expect(informe.totalPreguntas).toBe(2);
    // Solo entra en los temas la que sí tenía vector.
    expect(informe.temas).toHaveLength(1);
    expect(informe.temas[0]!.pregunta).toBe('esta sí tiene vector');
  });

  it('sin preguntas devuelve un informe vacío, no un error', async () => {
    const prisma = makeFakePrisma({ preguntasDelMes: [] });
    const svc = new AiTutorReviewService(prisma, makeContext(), embedFake);
    const informe = await svc.monthlyReport('t1', { mes: '2026-01' });
    expect(informe.totalPreguntas).toBe(0);
    expect(informe.temas).toEqual([]);
    expect(informe.truncado).toBe(false);
  });
});

describe('rangoDelMes', () => {
  it('devuelve el mes completo con el límite superior exclusivo', () => {
    const { desde, hasta, mes } = rangoDelMes('2026-07');
    expect(mes).toBe('2026-07');
    expect(desde.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(hasta.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('cruza el fin de año sin romperse', () => {
    const { desde, hasta } = rangoDelMes('2026-12');
    expect(desde.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(hasta.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('sin argumento usa el mes en curso', () => {
    const { mes } = rangoDelMes();
    expect(mes).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });
});

describe('listAnswersSchema · el filtro "sin respaldo"', () => {
  it("solo se activa con 'true'", () => {
    // Viene de la query string. Con z.coerce.boolean(), '?soloSinCitas=false'
    // activaría el filtro y el admin vería una lista recortada sin haberlo
    // pedido — el bug clásico de coerce sobre strings.
    expect(listAnswersSchema.parse({ soloSinCitas: 'true' }).soloSinCitas).toBe(true);
    expect(listAnswersSchema.parse({ soloSinCitas: 'false' }).soloSinCitas).toBe(false);
    expect(listAnswersSchema.parse({}).soloSinCitas).toBe(false);
  });

  it('rechaza cualquier otra cosa en vez de adivinar', () => {
    expect(() => listAnswersSchema.parse({ soloSinCitas: 'banana' })).toThrow();
  });

  it('pagina por defecto en la página 1 con 20 por página', () => {
    const parsed = listAnswersSchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(20);
  });
});
