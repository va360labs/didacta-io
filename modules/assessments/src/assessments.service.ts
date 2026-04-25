import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '@learnship/core-kernel';
import type { PrismaClient } from '@learnship/database';
import type {
  CreateQuestionDto,
  CreateQuizDto,
  StartAttemptDto,
  SubmitAttemptDto,
  UpdateQuizDto,
} from './dto.js';
import {
  AttemptAlreadySubmittedError,
  AttemptExpiredError,
  AttemptNotFoundError,
  MaxAttemptsReachedError,
  QuestionNotFoundError,
  QuizHasNoQuestionsError,
  QuizNotFoundError,
  QuizNotPublishedError,
} from './errors.js';
import { scoreAttempt, type ScoringQuestion } from './scoring.js';

export class AssessmentsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
  ) {}

  // -------------------- CRUD del formador --------------------

  async createQuiz(tenantId: string, actorId: string | null, dto: CreateQuizDto) {
    return this.prisma.modAssessmentsQuiz.create({
      data: {
        tenantId,
        lessonId: dto.lessonId ?? null,
        title: dto.title,
        description: dto.description ?? null,
        passThreshold: dto.passThreshold ?? 60,
        maxAttempts: dto.maxAttempts ?? null,
        timeLimitMinutes: dto.timeLimitMinutes ?? null,
        shuffleQuestions: dto.shuffleQuestions ?? false,
        showFeedback: dto.showFeedback ?? true,
        createdById: actorId,
      },
    });
  }

  async updateQuiz(tenantId: string, quizId: string, dto: UpdateQuizDto) {
    await this.requireQuiz(tenantId, quizId);
    return this.prisma.modAssessmentsQuiz.update({
      where: { id: quizId },
      data: {
        ...(dto.lessonId !== undefined ? { lessonId: dto.lessonId } : {}),
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.passThreshold !== undefined ? { passThreshold: dto.passThreshold } : {}),
        ...(dto.maxAttempts !== undefined ? { maxAttempts: dto.maxAttempts } : {}),
        ...(dto.timeLimitMinutes !== undefined ? { timeLimitMinutes: dto.timeLimitMinutes } : {}),
        ...(dto.shuffleQuestions !== undefined ? { shuffleQuestions: dto.shuffleQuestions } : {}),
        ...(dto.showFeedback !== undefined ? { showFeedback: dto.showFeedback } : {}),
      },
    });
  }

  async addQuestion(tenantId: string, quizId: string, dto: CreateQuestionDto) {
    await this.requireQuiz(tenantId, quizId);
    const lastPosition = await this.prisma.modAssessmentsQuestion.findFirst({
      where: { tenantId, quizId, deletedAt: null },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const position = (lastPosition?.position ?? 0) + 1;
    const options = dto.options ?? [];

    return this.prisma.modAssessmentsQuestion.create({
      data: {
        tenantId,
        quizId,
        type: dto.type,
        prompt: dto.prompt,
        feedback: dto.feedback ?? null,
        points: dto.points ?? 1,
        position,
        acceptedAnswers: dto.acceptedAnswers ?? [],
        options: {
          create: options.map((opt, idx) => ({
            tenantId,
            label: opt.label,
            isCorrect: opt.isCorrect,
            position: idx + 1,
          })),
        },
      },
      include: { options: { orderBy: { position: 'asc' } } },
    });
  }

  async deleteQuestion(tenantId: string, quizId: string, questionId: string) {
    const question = await this.prisma.modAssessmentsQuestion.findFirst({
      where: { id: questionId, tenantId, quizId, deletedAt: null },
    });
    if (!question) throw new QuestionNotFoundError();
    await this.prisma.modAssessmentsQuestion.update({
      where: { id: questionId },
      data: { deletedAt: new Date() },
    });
  }

  async publishQuiz(tenantId: string, actorId: string | null, quizId: string) {
    const quiz = await this.requireQuiz(tenantId, quizId);
    const questionCount = await this.prisma.modAssessmentsQuestion.count({
      where: { tenantId, quizId, deletedAt: null },
    });
    if (questionCount === 0) throw new QuizHasNoQuestionsError();

    const updated = await this.prisma.modAssessmentsQuiz.update({
      where: { id: quizId },
      data: { status: 'PUBLISHED', publishedAt: quiz.publishedAt ?? new Date() },
    });
    await this.publish(tenantId, actorId, 'assessments.quiz.published', {
      quizId,
      lessonId: updated.lessonId,
    });
    return updated;
  }

  async getQuizForFormador(tenantId: string, quizId: string) {
    const quiz = await this.prisma.modAssessmentsQuiz.findFirst({
      where: { id: quizId, tenantId, deletedAt: null },
      include: {
        questions: {
          where: { deletedAt: null },
          orderBy: { position: 'asc' },
          include: { options: { orderBy: { position: 'asc' } } },
        },
      },
    });
    if (!quiz) throw new QuizNotFoundError();
    return quiz;
  }

  /**
   * Vista del quiz pensada para el alumno: solo se exponen los datos
   * necesarios para responder. Las opciones NO incluyen `isCorrect` ni
   * el `feedback` por pregunta — esos llegan al alumno solo tras enviar
   * el intento (y solo si `quiz.showFeedback` es true).
   */
  async getQuizForAlumno(tenantId: string, quizId: string) {
    const quiz = await this.prisma.modAssessmentsQuiz.findFirst({
      where: { id: quizId, tenantId, deletedAt: null, status: 'PUBLISHED' },
      select: {
        id: true,
        title: true,
        description: true,
        passThreshold: true,
        maxAttempts: true,
        timeLimitMinutes: true,
        shuffleQuestions: true,
        questions: {
          where: { deletedAt: null },
          orderBy: { position: 'asc' },
          select: {
            id: true,
            type: true,
            prompt: true,
            position: true,
            points: true,
            options: {
              orderBy: { position: 'asc' },
              select: { id: true, label: true, position: true },
            },
          },
        },
      },
    });
    if (!quiz) throw new QuizNotFoundError();
    return quiz;
  }

  // -------------------- Flujo del alumno --------------------

  async startAttempt(tenantId: string, userId: string, dto: StartAttemptDto) {
    const quiz = await this.requireQuiz(tenantId, dto.quizId);
    if (quiz.status !== 'PUBLISHED') throw new QuizNotPublishedError();

    if (quiz.maxAttempts !== null) {
      const submittedCount = await this.prisma.modAssessmentsAttempt.count({
        where: {
          tenantId,
          quizId: dto.quizId,
          userId,
          status: { in: ['SUBMITTED', 'EXPIRED'] },
        },
      });
      if (submittedCount >= quiz.maxAttempts) {
        throw new MaxAttemptsReachedError(quiz.maxAttempts);
      }
    }

    const startedAt = new Date();
    const expiresAt = quiz.timeLimitMinutes
      ? new Date(startedAt.getTime() + quiz.timeLimitMinutes * 60_000)
      : null;

    const attempt = await this.prisma.modAssessmentsAttempt.create({
      data: {
        tenantId,
        quizId: dto.quizId,
        userId,
        enrollmentId: dto.enrollmentId ?? null,
        lessonId: dto.lessonId ?? null,
        status: 'IN_PROGRESS',
        startedAt,
        expiresAt,
      },
    });

    await this.publish(tenantId, userId, 'assessments.attempt.started', {
      attemptId: attempt.id,
      quizId: dto.quizId,
      userId,
    });
    return attempt;
  }

  async submitAttempt(tenantId: string, userId: string, dto: SubmitAttemptDto) {
    const attempt = await this.prisma.modAssessmentsAttempt.findFirst({
      where: { id: dto.attemptId, tenantId, userId },
    });
    if (!attempt) throw new AttemptNotFoundError();
    if (attempt.status !== 'IN_PROGRESS') throw new AttemptAlreadySubmittedError();
    if (attempt.expiresAt && attempt.expiresAt.getTime() < Date.now()) {
      await this.prisma.modAssessmentsAttempt.update({
        where: { id: attempt.id },
        data: { status: 'EXPIRED' },
      });
      throw new AttemptExpiredError();
    }

    const quiz = await this.requireQuiz(tenantId, attempt.quizId);
    const questions = await this.prisma.modAssessmentsQuestion.findMany({
      where: { tenantId, quizId: attempt.quizId, deletedAt: null },
      include: { options: true },
    });

    const scoringQuestions: ScoringQuestion[] = questions.map((q) => ({
      id: q.id,
      type: q.type,
      points: q.points,
      options: q.options.map((o) => ({ id: o.id, isCorrect: o.isCorrect })),
      acceptedAnswers: q.acceptedAnswers,
    }));

    const result = scoreAttempt(scoringQuestions, dto.answers, quiz.passThreshold);
    const submittedAt = new Date();

    const persisted = await this.prisma.$transaction(async (tx) => {
      await tx.modAssessmentsAnswer.deleteMany({ where: { attemptId: attempt.id } });
      const scoredById = new Map(result.perAnswer.map((s) => [s.questionId, s]));
      for (const a of dto.answers) {
        const scored = scoredById.get(a.questionId);
        if (!scored) continue;
        await tx.modAssessmentsAnswer.create({
          data: {
            tenantId,
            attemptId: attempt.id,
            questionId: a.questionId,
            selectedOptionIds: a.selectedOptionIds ?? [],
            textAnswer: a.textAnswer ?? null,
            isCorrect: scored.isCorrect,
            scoreEarned: scored.scoreEarned,
          },
        });
      }
      return tx.modAssessmentsAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'SUBMITTED',
          scoreEarned: result.scoreEarned,
          scoreMax: result.scoreMax,
          scorePercent: result.scorePercent,
          passed: result.passed,
          submittedAt,
        },
      });
    });

    const eventPayload = {
      attemptId: attempt.id,
      quizId: attempt.quizId,
      userId,
      enrollmentId: attempt.enrollmentId,
      lessonId: attempt.lessonId,
      scoreEarned: result.scoreEarned,
      scoreMax: result.scoreMax,
      scorePercent: result.scorePercent,
      passed: result.passed,
    };
    await this.publish(tenantId, userId, 'assessments.attempt.submitted', eventPayload);
    await this.publish(
      tenantId,
      userId,
      result.passed ? 'assessments.attempt.passed' : 'assessments.attempt.failed',
      eventPayload,
    );

    return persisted;
  }

  async getAttempt(tenantId: string, userId: string, attemptId: string) {
    const attempt = await this.prisma.modAssessmentsAttempt.findFirst({
      where: { id: attemptId, tenantId, userId },
      include: { answers: true },
    });
    if (!attempt) throw new AttemptNotFoundError();
    return attempt;
  }

  async listAttemptsForUser(tenantId: string, userId: string, quizId: string) {
    return this.prisma.modAssessmentsAttempt.findMany({
      where: { tenantId, userId, quizId },
      orderBy: { startedAt: 'desc' },
    });
  }

  // -------------------- helpers --------------------

  private async requireQuiz(tenantId: string, quizId: string) {
    const quiz = await this.prisma.modAssessmentsQuiz.findFirst({
      where: { id: quizId, tenantId, deletedAt: null },
    });
    if (!quiz) throw new QuizNotFoundError();
    return quiz;
  }

  private async publish(
    tenantId: string,
    actorId: string | null,
    name: string,
    data: Record<string, unknown>,
  ) {
    await this.ctx.eventBus.publish({
      name,
      version: 1,
      data,
      metadata: {
        tenantId,
        userId: actorId ?? undefined,
        timestamp: new Date().toISOString(),
        traceId: randomUUID(),
        idempotencyKey: `${name}:${JSON.stringify(data)}:${Date.now()}`,
      },
    });
  }
}
