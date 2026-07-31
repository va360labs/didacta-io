import { describe, expect, it, vi } from 'vitest';
import {
  AiTutorChatService,
  DAILY_QUESTION_LIMIT,
  type ChatFn,
  type EmbedFn,
} from '../src/chat.service.js';
import {
  ChatProviderError,
  CourseAccessDeniedError,
  CourseNotIndexedError,
  DailyQuestionQuotaExceededError,
} from '../src/errors.js';

function makeContext() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
    eventBus: { publish: vi.fn(async () => {}) },
  } as never;
}

interface FakeChunkRow {
  id: string;
  lesson_id: string | null;
  content: string;
  distance: number;
}

interface FakeCorrectionRow {
  id: string;
  question: string;
  answer: string;
  distance: number;
}

function makeFakePrisma(opts: {
  chunkCount: number;
  retrieved?: FakeChunkRow[];
  conversation?: { id: string } | null;
  messages?: Array<{ role: string; content: string; createdAt: Date }>;
  course?: { title: string } | null;
  user?: { locale: string } | null;
  hydrationLessons?: Array<{ id: string; title: string }>;
  hydrationChunks?: Array<{ id: string; content: string }>;
  tokenUsageExisting?: { id: string; questions?: number } | null;
  /** Matrícula del alumno. Por defecto existe: los tests viejos asumen acceso. */
  enrollment?: { id: string } | null;
  /** Respuestas ya validadas por el equipo que devuelve la búsqueda vectorial. */
  correcciones?: FakeCorrectionRow[];
}) {
  const created: Array<{ table: string; data: unknown }> = [];
  const updated: Array<{ table: string; id: string; data: unknown }> = [];
  const ejecutados: Array<{ sql: string; params: unknown[] }> = [];
  return {
    created,
    updated,
    modLearningEnrollment: {
      findFirst: vi.fn(async () =>
        opts.enrollment === undefined ? { id: 'e1' } : opts.enrollment,
      ),
    },
    modAiTutorChunk: {
      count: vi.fn(async () => opts.chunkCount),
      findMany: vi.fn(async () => opts.hydrationChunks ?? []),
    },
    modAiTutorConversation: {
      findFirst: vi.fn(async () => opts.conversation ?? null),
      create: vi.fn(async ({ data }: { data: { id: string } }) => {
        created.push({ table: 'conv', data });
        return data;
      }),
    },
    modAiTutorMessage: {
      findMany: vi.fn(async () => opts.messages ?? []),
      create: vi.fn(async ({ data }: { data: { id: string } }) => {
        created.push({ table: 'msg', data });
        return data;
      }),
    },
    modAiTutorTokenUsage: {
      findFirst: vi.fn(async () => opts.tokenUsageExisting ?? null),
      create: vi.fn(async ({ data }: { data: { id: string } }) => {
        created.push({ table: 'usage', data });
        return data;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: unknown }) => {
        updated.push({ table: 'usage', id: where.id, data });
        return { id: where.id };
      }),
    },
    modCoursesCourse: {
      findFirst: vi.fn(async () => opts.course ?? null),
    },
    modCoursesLesson: {
      findMany: vi.fn(async () => opts.hydrationLessons ?? []),
    },
    user: {
      findFirst: vi.fn(async () => opts.user ?? null),
    },
    // El service lanza dos búsquedas vectoriales distintas contra el mismo
    // método: los fragmentos del curso y las correcciones del equipo. Se
    // distinguen por la tabla, no por el orden de llamada — si no, añadir una
    // query nueva desplaza silenciosamente las respuestas de todas las demás.
    $queryRawUnsafe: vi.fn(async (sql: string) =>
      sql.includes('mod_ai_tutor_correction') ? (opts.correcciones ?? []) : (opts.retrieved ?? []),
    ),
    $executeRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      ejecutados.push({ sql, params });
      return 1;
    }),
    ejecutados,
    $transaction: vi.fn(async (queries: Promise<unknown>[]) => Promise.all(queries)),
  } as never;
}

const makeEmbed =
  (dim = 1536): EmbedFn =>
  async ({ texts }) => ({
    embeddings: texts.map(() => new Array(dim).fill(0.1)),
    totalTokens: 8,
    dimension: dim,
  });

const makeChat =
  (content = 'Respuesta basada en [1] y [2].'): ChatFn =>
  async () => ({
    content,
    inputTokens: 120,
    outputTokens: 45,
  });

const sampleRetrieved: FakeChunkRow[] = [
  { id: 'chunk-1', lesson_id: 'l1', content: 'VLOOKUP busca un valor', distance: 0.05 },
  { id: 'chunk-2', lesson_id: 'l2', content: 'INDEX-MATCH es alternativa', distance: 0.12 },
];

describe('AiTutorChatService.ask (LMS-90.D)', () => {
  it('lanza CourseNotIndexedError si no hay chunks', async () => {
    const prisma = makeFakePrisma({ chunkCount: 0 });
    const svc = new AiTutorChatService(prisma, makeContext(), makeEmbed(), makeChat());
    await expect(svc.ask('t1', 'u1', 'c1', { question: 'qué es vlookup' })).rejects.toBeInstanceOf(
      CourseNotIndexedError,
    );
  });

  it('crea conversación nueva si no se pasa conversationId', async () => {
    const prisma = makeFakePrisma({
      chunkCount: 5,
      retrieved: sampleRetrieved,
      course: { title: 'Excel' },
      user: { locale: 'es' },
      hydrationLessons: [
        { id: 'l1', title: 'Lookup' },
        { id: 'l2', title: 'Match' },
      ],
      hydrationChunks: [
        { id: 'chunk-1', content: 'VLOOKUP busca un valor en una columna' },
        { id: 'chunk-2', content: 'INDEX y MATCH combinados son más flexibles' },
      ],
    });
    const svc = new AiTutorChatService(prisma, makeContext(), makeEmbed(), makeChat());
    const result = await svc.ask('t1', 'u1', 'c1', { question: 'qué es vlookup' });

    expect(result.conversationId).toBeTruthy();
    expect(result.answer).toContain('[1]');
    expect(prisma.created.some((c) => c.table === 'conv')).toBe(true);
  });

  it('usa conversación existente si conversationId es válida', async () => {
    const prisma = makeFakePrisma({
      chunkCount: 5,
      retrieved: sampleRetrieved,
      conversation: { id: 'existing-conv' },
      course: { title: 'X' },
      user: { locale: 'es' },
      hydrationLessons: [
        { id: 'l1', title: 'L1' },
        { id: 'l2', title: 'L2' },
      ],
      hydrationChunks: [
        { id: 'chunk-1', content: 'a' },
        { id: 'chunk-2', content: 'b' },
      ],
    });
    const svc = new AiTutorChatService(prisma, makeContext(), makeEmbed(), makeChat());
    const result = await svc.ask('t1', 'u1', 'c1', {
      question: 'q',
      conversationId: 'existing-conv',
    });
    expect(result.conversationId).toBe('existing-conv');
    // No se crea conv nueva
    expect(prisma.created.some((c) => c.table === 'conv')).toBe(false);
  });

  it('persiste 2 mensajes (user + assistant) con citas', async () => {
    const prisma = makeFakePrisma({
      chunkCount: 5,
      retrieved: sampleRetrieved,
      course: { title: 'X' },
      user: { locale: 'es' },
      hydrationLessons: [
        { id: 'l1', title: 'A' },
        { id: 'l2', title: 'B' },
      ],
      hydrationChunks: [
        { id: 'chunk-1', content: 'a' },
        { id: 'chunk-2', content: 'b' },
      ],
    });
    const svc = new AiTutorChatService(prisma, makeContext(), makeEmbed(), makeChat());
    await svc.ask('t1', 'u1', 'c1', { question: 'q' });
    const messageCreates = prisma.created.filter((c) => c.table === 'msg');
    expect(messageCreates).toHaveLength(2);
    const data = messageCreates.map((c) => c.data as { role: string; citations: unknown[] });
    expect(data[0]!.role).toBe('user');
    expect(data[1]!.role).toBe('assistant');
    expect((data[1]!.citations as unknown[]).length).toBeGreaterThan(0);
  });

  it('hidrata citations con título de lección y snippet', async () => {
    const prisma = makeFakePrisma({
      chunkCount: 5,
      retrieved: sampleRetrieved,
      course: { title: 'X' },
      user: { locale: 'es' },
      hydrationLessons: [
        { id: 'l1', title: 'Lección Lookup' },
        { id: 'l2', title: 'Lección Match' },
      ],
      hydrationChunks: [
        { id: 'chunk-1', content: 'VLOOKUP busca un valor en una columna específica del rango' },
        { id: 'chunk-2', content: 'INDEX-MATCH es más flexible que VLOOKUP' },
      ],
    });
    const svc = new AiTutorChatService(prisma, makeContext(), makeEmbed(), makeChat());
    const result = await svc.ask('t1', 'u1', 'c1', { question: 'q' });
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0]!.lessonId).toBe('l1');
    expect(result.citations[0]!.lessonTitle).toBe('Lección Lookup');
    expect(result.citations[0]!.snippet).toContain('VLOOKUP');
  });

  it('agrega tokens en mod_ai_tutor_token_usage si no existe fila → create', async () => {
    const prisma = makeFakePrisma({
      chunkCount: 5,
      retrieved: sampleRetrieved,
      course: { title: 'X' },
      user: { locale: 'es' },
      hydrationLessons: [
        { id: 'l1', title: 'A' },
        { id: 'l2', title: 'B' },
      ],
      hydrationChunks: [
        { id: 'chunk-1', content: 'a' },
        { id: 'chunk-2', content: 'b' },
      ],
      tokenUsageExisting: null,
    });
    const svc = new AiTutorChatService(prisma, makeContext(), makeEmbed(), makeChat());
    await svc.ask('t1', 'u1', 'c1', { question: 'q' });
    const usageCreate = prisma.created.find((c) => c.table === 'usage');
    expect(usageCreate).toBeDefined();
    const data = usageCreate!.data as { tokensInput: number; tokensOutput: number };
    expect(data.tokensInput).toBeGreaterThan(0);
    expect(data.tokensOutput).toBeGreaterThan(0);
  });

  it('agrega tokens incrementando si fila ya existe → update', async () => {
    const prisma = makeFakePrisma({
      chunkCount: 5,
      retrieved: sampleRetrieved,
      course: { title: 'X' },
      user: { locale: 'es' },
      hydrationLessons: [
        { id: 'l1', title: 'A' },
        { id: 'l2', title: 'B' },
      ],
      hydrationChunks: [
        { id: 'chunk-1', content: 'a' },
        { id: 'chunk-2', content: 'b' },
      ],
      tokenUsageExisting: { id: 'usage-existing' },
    });
    const svc = new AiTutorChatService(prisma, makeContext(), makeEmbed(), makeChat());
    await svc.ask('t1', 'u1', 'c1', { question: 'q' });
    const usageUpdate = prisma.updated.find((u) => u.table === 'usage');
    expect(usageUpdate).toBeDefined();
  });

  it('emite evento ai-tutor.chat.message-received al final', async () => {
    const ctx = makeContext();
    const prisma = makeFakePrisma({
      chunkCount: 5,
      retrieved: sampleRetrieved,
      course: { title: 'X' },
      user: { locale: 'es' },
      hydrationLessons: [
        { id: 'l1', title: 'A' },
        { id: 'l2', title: 'B' },
      ],
      hydrationChunks: [
        { id: 'chunk-1', content: 'a' },
        { id: 'chunk-2', content: 'b' },
      ],
    });
    const svc = new AiTutorChatService(prisma, ctx, makeEmbed(), makeChat());
    await svc.ask('t1', 'u1', 'c1', { question: 'q' });
    expect(ctx.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'ai-tutor.chat.message-received',
        data: expect.objectContaining({ retrievedCount: 2, citationsCount: 2 }),
      }),
    );
  });

  it('si chatFn falla → ChatProviderError', async () => {
    const prisma = makeFakePrisma({
      chunkCount: 5,
      retrieved: sampleRetrieved,
      course: { title: 'X' },
      user: { locale: 'es' },
    });
    const failingChat: ChatFn = async () => {
      throw new Error('rate limit');
    };
    const svc = new AiTutorChatService(prisma, makeContext(), makeEmbed(), failingChat);
    await expect(svc.ask('t1', 'u1', 'c1', { question: 'q' })).rejects.toBeInstanceOf(
      ChatProviderError,
    );
  });

  it('topK custom se pasa al cosine search', async () => {
    const prisma = makeFakePrisma({
      chunkCount: 5,
      retrieved: sampleRetrieved,
      course: { title: 'X' },
      user: { locale: 'es' },
      hydrationLessons: [
        { id: 'l1', title: 'A' },
        { id: 'l2', title: 'B' },
      ],
      hydrationChunks: [
        { id: 'chunk-1', content: 'a' },
        { id: 'chunk-2', content: 'b' },
      ],
    });
    const svc = new AiTutorChatService(prisma, makeContext(), makeEmbed(), makeChat());
    await svc.ask('t1', 'u1', 'c1', { question: 'q', topK: 10 });
    // queryRawUnsafe se llamó con LIMIT 10 como parámetro
    const queryCall = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(queryCall[4]).toBe(10);
  });

  it('historico previo se incluye al construir prompt', async () => {
    const prisma = makeFakePrisma({
      chunkCount: 5,
      retrieved: sampleRetrieved,
      course: { title: 'X' },
      user: { locale: 'es' },
      // El histórico sólo se carga en una conversación que ya existe: en una
      // nueva no hay nada que cargar y nos ahorramos la query.
      conversation: { id: '11111111-1111-4111-8111-111111111111' },
      messages: [
        { role: 'user', content: 'pregunta previa', createdAt: new Date() },
        { role: 'assistant', content: 'respuesta previa', createdAt: new Date() },
      ],
      hydrationLessons: [
        { id: 'l1', title: 'A' },
        { id: 'l2', title: 'B' },
      ],
      hydrationChunks: [
        { id: 'chunk-1', content: 'a' },
        { id: 'chunk-2', content: 'b' },
      ],
    });
    const chatSpy: ChatFn = vi.fn(async () => ({
      content: 'ok',
      inputTokens: 1,
      outputTokens: 1,
    }));
    const svc = new AiTutorChatService(prisma, makeContext(), makeEmbed(), chatSpy);
    await svc.ask('t1', 'u1', 'c1', {
      question: 'nueva',
      conversationId: '11111111-1111-4111-8111-111111111111',
    });
    const callArgs = (chatSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    // 2 mensajes histórico + 1 actual
    expect(callArgs.messages).toHaveLength(3);
    expect(callArgs.messages[2]!.content).toBe('nueva');
  });
});

describe('AiTutorChatService.ask · acceso y cuota', () => {
  const base = {
    chunkCount: 5,
    retrieved: sampleRetrieved,
    course: { title: 'X' },
    user: { locale: 'es' },
    hydrationLessons: [{ id: 'l1', title: 'A' }],
    hydrationChunks: [{ id: 'chunk-1', content: '[12:34] a' }],
  };

  it('sin matrícula → CourseAccessDeniedError y no gasta en IA', async () => {
    const prisma = makeFakePrisma({ ...base, enrollment: null });
    const embedSpy = vi.fn(makeEmbed());
    const svc = new AiTutorChatService(
      prisma,
      makeContext(),
      embedSpy as unknown as EmbedFn,
      makeChat(),
    );
    await expect(svc.ask('t1', 'u1', 'c1', { question: 'hola' })).rejects.toBeInstanceOf(
      CourseAccessDeniedError,
    );
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it('staff responde sin matrícula y sin consumir cuota', async () => {
    const prisma = makeFakePrisma({ ...base, enrollment: null });
    const svc = new AiTutorChatService(prisma, makeContext(), makeEmbed(), makeChat());
    const r = await svc.ask('t1', 'u1', 'c1', { question: 'hola' }, { staff: true });
    expect(r.answer).toBeTruthy();
    const usage = prisma.created.find((c) => c.table === 'usage');
    expect((usage?.data as { questions: number }).questions).toBe(0);
  });

  it('al llegar al límite diario → DailyQuestionQuotaExceededError sin llamar a la IA', async () => {
    const prisma = makeFakePrisma({
      ...base,
      tokenUsageExisting: { id: 'usage-1', questions: DAILY_QUESTION_LIMIT },
    });
    const embedSpy = vi.fn(makeEmbed());
    const svc = new AiTutorChatService(
      prisma,
      makeContext(),
      embedSpy as unknown as EmbedFn,
      makeChat(),
    );
    await expect(svc.ask('t1', 'u1', 'c1', { question: 'hola' })).rejects.toBeInstanceOf(
      DailyQuestionQuotaExceededError,
    );
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it('una pregunta por debajo del límite pasa y devuelve lo que queda', async () => {
    const prisma = makeFakePrisma({
      ...base,
      tokenUsageExisting: { id: 'usage-1', questions: DAILY_QUESTION_LIMIT - 1 },
    });
    const svc = new AiTutorChatService(prisma, makeContext(), makeEmbed(), makeChat());
    const r = await svc.ask('t1', 'u1', 'c1', { question: 'hola' });
    expect(r.quota).toEqual({
      used: DAILY_QUESTION_LIMIT,
      limit: DAILY_QUESTION_LIMIT,
      remaining: 0,
    });
  });

  // Regresión: cuando el proveedor fallaba, la conversación ya estaba creada y
  // quedaban filas vacías. Así se acumularon 5 en producción (2026-07-30).
  it('si el proveedor de chat falla NO deja conversación huérfana', async () => {
    const prisma = makeFakePrisma(base);
    const chatRoto: ChatFn = async () => {
      throw new Error('502 del proveedor');
    };
    const svc = new AiTutorChatService(prisma, makeContext(), makeEmbed(), chatRoto);
    await expect(svc.ask('t1', 'u1', 'c1', { question: 'hola' })).rejects.toBeInstanceOf(
      ChatProviderError,
    );
    expect(prisma.created.some((c) => c.table === 'conv')).toBe(false);
  });

  it('con lessonId busca también dentro de la lección y lo dice en el prompt', async () => {
    const prisma = makeFakePrisma({
      ...base,
      hydrationLessons: [{ id: 'l1', title: 'Webhooks en n8n' }],
    });
    const chatSpy: ChatFn = vi.fn(async () => ({
      content: 'ok [1]',
      inputTokens: 1,
      outputTokens: 1,
    }));
    const svc = new AiTutorChatService(prisma, makeContext(), makeEmbed(), chatSpy);
    await svc.ask('t1', 'u1', 'c1', {
      question: 'no me va',
      lessonId: 'l1',
      positionSeconds: 754,
    });
    // Dos búsquedas sobre los fragmentos: el curso entero y la lección que
    // está viendo. La tercera llamada es la de correcciones, que va aparte.
    const sqls = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(sqls.filter((s) => s.includes('mod_ai_tutor_chunk'))).toHaveLength(2);
    const system = (chatSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0].system;
    expect(system).toContain('Webhooks en n8n');
    expect(system).toContain('12:34');
  });

  it('la cita expone el segundo de la marca de tiempo del fragmento', async () => {
    const prisma = makeFakePrisma({
      ...base,
      hydrationChunks: [{ id: 'chunk-1', content: '[12:34] el webhook expone tu workflow' }],
    });
    const svc = new AiTutorChatService(prisma, makeContext(), makeEmbed(), makeChat('Mira [1].'));
    const r = await svc.ask('t1', 'u1', 'c1', { question: 'webhook?' });
    expect(r.citations[0]!.startSeconds).toBe(754);
  });
});

/**
 * Lo que corrige un admin tiene que llegar al prompt de la siguiente pregunta.
 * Si no, la pantalla de revisión es un cementerio de notas y el tutor sigue
 * equivocándose exactamente igual.
 */
describe('AiTutorChatService.ask · conocimiento validado', () => {
  const base = {
    chunkCount: 5,
    retrieved: sampleRetrieved,
    course: { title: 'n8n' },
    user: { locale: 'es' },
    hydrationLessons: [{ id: 'l1', title: 'Webhooks' }],
    hydrationChunks: [{ id: 'chunk-1', content: 'texto' }],
  };

  it('mete la corrección en el system prompt y avisa de que manda sobre el contexto', async () => {
    const prisma = makeFakePrisma({
      ...base,
      correcciones: [
        {
          id: 'corr-1',
          question: '¿cómo descargo la factura?',
          answer: 'Desde /cuenta → Facturación, botón Descargar.',
          distance: 0.12,
        },
      ],
    });
    const chatSpy: ChatFn = vi.fn(async () => ({
      content: 'ok',
      inputTokens: 1,
      outputTokens: 1,
    }));
    const svc = new AiTutorChatService(prisma, makeContext(), makeEmbed(), chatSpy);
    await svc.ask('t1', 'u1', 'c1', { question: 'dónde saco la factura' });

    const system = (chatSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0].system;
    expect(system).toContain('RESPUESTAS YA VALIDADAS POR EL EQUIPO');
    expect(system).toContain('/cuenta → Facturación');
    expect(system).toContain('tienen prioridad sobre el CONTEXTO');
  });

  it('descarta la corrección que no viene a cuento', async () => {
    // 0.9 de distancia coseno es otra duda distinta. Colarla sería peor que no
    // tener correcciones: manda sobre el material y desviaría la respuesta.
    const prisma = makeFakePrisma({
      ...base,
      correcciones: [
        {
          id: 'corr-lejana',
          question: 'algo de facturación',
          answer: 'nada que ver',
          distance: 0.9,
        },
      ],
    });
    const chatSpy: ChatFn = vi.fn(async () => ({
      content: 'ok',
      inputTokens: 1,
      outputTokens: 1,
    }));
    const svc = new AiTutorChatService(prisma, makeContext(), makeEmbed(), chatSpy);
    await svc.ask('t1', 'u1', 'c1', { question: 'qué es un webhook' });

    const system = (chatSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0].system;
    expect(system).not.toContain('RESPUESTAS YA VALIDADAS');
  });

  it('guarda el embedding de la pregunta y suma un uso a la corrección aplicada', async () => {
    const prisma = makeFakePrisma({
      ...base,
      correcciones: [{ id: 'corr-1', question: 'p', answer: 'r', distance: 0.1 }],
    });
    const svc = new AiTutorChatService(prisma, makeContext(), makeEmbed(), makeChat('ok'));
    await svc.ask('t1', 'u1', 'c1', { question: 'una duda' });

    const sqls = prisma.ejecutados.map((e) => e.sql);
    expect(sqls.some((s) => s.includes('"question_embedding" = $1::vector'))).toBe(true);
    expect(sqls.some((s) => s.includes('"times_used" = "times_used" + 1'))).toBe(true);
  });

  it('si la tabla de correcciones falla, el alumno recibe su respuesta igual', async () => {
    const prisma = makeFakePrisma(base);
    // Simula una base sin migrar: la query de correcciones revienta.
    (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (sql.includes('mod_ai_tutor_correction')) throw new Error('relation does not exist');
      return sampleRetrieved;
    });
    const svc = new AiTutorChatService(prisma, makeContext(), makeEmbed(), makeChat('Mira [1].'));
    const r = await svc.ask('t1', 'u1', 'c1', { question: 'q' });
    expect(r.answer).toContain('[1]');
  });
});
