import { describe, expect, it } from 'vitest';
import { AssessmentsService } from '../src/assessments.service.js';

/**
 * Borrar preguntas no puede impedir añadir otras (feedback de un creador,
 * 26-nov-2026: tras borrar preguntas de un cuestionario, no le dejaba añadir
 * más y acabó creando otro cuestionario).
 *
 * La pregunta borrada sigue en la tabla (borrado lógico) con su posición, y
 * `(quizId, position)` es única. El falso de Prisma aplica esa unicidad igual
 * que la BD.
 */

interface QuestionRow {
  id: string;
  tenantId: string;
  quizId: string;
  position: number;
  prompt: string;
  deletedAt: Date | null;
}

type Where = { id?: string; tenantId?: string; quizId?: string; deletedAt?: null };

function matches(row: QuestionRow, where: Where): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.tenantId !== undefined && row.tenantId !== where.tenantId) return false;
  if (where.quizId !== undefined && row.quizId !== where.quizId) return false;
  if ('deletedAt' in where && row.deletedAt !== null) return false;
  return true;
}

function makeFakePrisma() {
  const questions: QuestionRow[] = [];
  let seq = 0;
  return {
    questions,
    modAssessmentsQuiz: {
      async findFirst() {
        return { id: 'quiz-1', tenantId: 't1', deletedAt: null };
      },
    },
    modAssessmentsQuestion: {
      async findFirst(args: { where: Where; orderBy?: { position: 'desc' } }) {
        const rows = questions.filter((q) => matches(q, args.where));
        if (args.orderBy) rows.sort((a, b) => b.position - a.position);
        return rows[0] ?? null;
      },
      async create(args: {
        data: { tenantId: string; quizId: string; position: number; prompt: string };
      }) {
        const { tenantId, quizId, position, prompt } = args.data;
        if (questions.some((q) => q.quizId === quizId && q.position === position)) {
          throw new Error('Unique constraint failed on the fields: (`quiz_id`,`position`)');
        }
        const row: QuestionRow = {
          id: `question-${++seq}`,
          tenantId,
          quizId,
          position,
          prompt,
          deletedAt: null,
        };
        questions.push(row);
        return { ...row, options: [] };
      },
      async update(args: { where: { id: string }; data: Partial<QuestionRow> }) {
        const row = questions.find((q) => q.id === args.where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, args.data);
        return row;
      },
    },
  };
}

const ctx = { eventBus: { publish: async () => {} } } as never;

function question(prompt: string) {
  return { type: 'SHORT_ANSWER' as const, prompt };
}

describe('AssessmentsService: añadir preguntas tras borrar', () => {
  it('borrar la última y añadir otra no choca con su posición', async () => {
    const prisma = makeFakePrisma();
    const svc = new AssessmentsService(prisma as never, ctx);

    await svc.addQuestion('t1', 'quiz-1', question('Uno'));
    const dos = await svc.addQuestion('t1', 'quiz-1', question('Dos'));
    await svc.deleteQuestion('t1', 'quiz-1', dos.id);

    const tres = await svc.addQuestion('t1', 'quiz-1', question('Tres'));
    expect(tres.position).toBe(3);
  });

  it('borrar todas y empezar de nuevo funciona', async () => {
    const prisma = makeFakePrisma();
    const svc = new AssessmentsService(prisma as never, ctx);

    const a = await svc.addQuestion('t1', 'quiz-1', question('A'));
    const b = await svc.addQuestion('t1', 'quiz-1', question('B'));
    await svc.deleteQuestion('t1', 'quiz-1', a.id);
    await svc.deleteQuestion('t1', 'quiz-1', b.id);

    await svc.addQuestion('t1', 'quiz-1', question('C'));
    await svc.addQuestion('t1', 'quiz-1', question('D'));

    const vivas = prisma.questions
      .filter((q) => q.deletedAt === null)
      .sort((x, y) => x.position - y.position)
      .map((q) => q.prompt);
    expect(vivas).toEqual(['C', 'D']);
  });

  it('la nueva va siempre detrás de las que quedan', async () => {
    const prisma = makeFakePrisma();
    const svc = new AssessmentsService(prisma as never, ctx);

    const uno = await svc.addQuestion('t1', 'quiz-1', question('Uno'));
    await svc.addQuestion('t1', 'quiz-1', question('Dos'));
    await svc.deleteQuestion('t1', 'quiz-1', uno.id);
    await svc.addQuestion('t1', 'quiz-1', question('Tres'));

    const vivas = prisma.questions
      .filter((q) => q.deletedAt === null)
      .sort((x, y) => x.position - y.position)
      .map((q) => q.prompt);
    expect(vivas).toEqual(['Dos', 'Tres']);
  });
});
