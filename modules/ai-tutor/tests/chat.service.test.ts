import { describe, expect, it, vi } from 'vitest';
import { AiTutorChatService, type ChatFn, type EmbedFn } from '../src/chat.service.js';
import { ChatProviderError, CourseNotIndexedError } from '../src/errors.js';

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

function makeFakePrisma(opts: {
  chunkCount: number;
  retrieved?: FakeChunkRow[];
  conversation?: { id: string } | null;
  messages?: Array<{ role: string; content: string; createdAt: Date }>;
  course?: { title: string } | null;
  user?: { locale: string } | null;
  hydrationLessons?: Array<{ id: string; title: string }>;
  hydrationChunks?: Array<{ id: string; content: string }>;
  tokenUsageExisting?: { id: string } | null;
}) {
  const created: Array<{ table: string; data: unknown }> = [];
  const updated: Array<{ table: string; id: string; data: unknown }> = [];
  return {
    created,
    updated,
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
    $queryRawUnsafe: vi.fn(async () => opts.retrieved ?? []),
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
    await svc.ask('t1', 'u1', 'c1', { question: 'nueva' });
    const callArgs = (chatSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    // 2 mensajes histórico + 1 actual
    expect(callArgs.messages).toHaveLength(3);
    expect(callArgs.messages[2]!.content).toBe('nueva');
  });
});
