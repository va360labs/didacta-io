import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import type {
  CreateQuestionDto,
  CreateQuizDto,
  GradeAttemptDto,
  StartAttemptDto,
  SubmitAttemptDto,
  UpdateQuizDto,
} from './dto.js';
import {
  AttemptAlreadySubmittedError,
  AttemptExpiredError,
  AttemptNotFoundError,
  AttemptNotPendingReviewError,
  GradeExceedsQuestionPointsError,
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
    // Lookup en 2 pasos para distinguir "no existe / no es del tenant"
    // de "existe pero todavía está en DRAFT". El error genérico (mismo
    // mensaje "no existe o no pertenece al tenant" en ambos casos)
    // confundía al profesor cuando el quiz simplemente no había sido
    // publicado tras crearlo.
    const meta = await this.prisma.modAssessmentsQuiz.findFirst({
      where: { id: quizId, tenantId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!meta) throw new QuizNotFoundError();
    if (meta.status !== 'PUBLISHED') throw new QuizNotPublishedError();

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
      const nextStatus = result.needsReview ? 'PENDING_REVIEW' : 'SUBMITTED';
      return tx.modAssessmentsAttempt.update({
        where: { id: attempt.id },
        data: {
          status: nextStatus,
          // Para PENDING_REVIEW guardamos el score parcial (solo lo objetivo)
          // pero passed queda null hasta el grading.
          scoreEarned: result.scoreEarned,
          scoreMax: result.scoreMax,
          scorePercent: result.needsReview ? null : result.scorePercent,
          passed: result.needsReview ? null : result.passed,
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
      needsReview: result.needsReview,
    };
    await this.publish(tenantId, userId, 'assessments.attempt.submitted', eventPayload);

    if (result.needsReview) {
      // No emitimos passed/failed todavía: la decisión depende del formador.
      await this.publish(tenantId, userId, 'assessments.attempt.pending_review', eventPayload);
    } else {
      await this.publish(
        tenantId,
        userId,
        result.passed ? 'assessments.attempt.passed' : 'assessments.attempt.failed',
        eventPayload,
      );
    }

    return persisted;
  }

  /**
   * Vista del attempt para el formador: incluye TODAS las respuestas (incluso
   * de otros usuarios) con el detalle del quiz para que pueda calificar.
   * Distinto de getAttempt(tenantId, userId) que filtra por userId.
   */
  async getAttemptForFormador(tenantId: string, attemptId: string) {
    const attempt = await this.prisma.modAssessmentsAttempt.findFirst({
      where: { id: attemptId, tenantId },
      include: {
        answers: { orderBy: { createdAt: 'asc' } },
        quiz: {
          include: {
            questions: {
              where: { deletedAt: null },
              orderBy: { position: 'asc' },
              include: { options: { orderBy: { position: 'asc' } } },
            },
          },
        },
      },
    });
    if (!attempt) throw new AttemptNotFoundError();
    return attempt;
  }

  /**
   * Lista intentos PENDING_REVIEW del tenant. Pensado para el panel del
   * formador / tenant_admin.
   */
  async listPendingReview(tenantId: string) {
    return this.prisma.modAssessmentsAttempt.findMany({
      where: { tenantId, status: 'PENDING_REVIEW' },
      orderBy: { submittedAt: 'asc' },
      include: {
        quiz: { select: { id: true, title: true, lessonId: true } },
        answers: { select: { id: true, questionId: true } },
      },
    });
  }

  /**
   * Corrección manual del attempt: el formador asigna `scoreEarned` por
   * cada respuesta abierta. Recalcula totales y emite passed/failed +
   * assessments.attempt.graded para que el bridge a mod.learning pueda
   * marcar la lección como completada si corresponde.
   */
  async gradeAttempt(
    tenantId: string,
    formadorId: string,
    attemptId: string,
    dto: GradeAttemptDto,
  ) {
    const attempt = await this.prisma.modAssessmentsAttempt.findFirst({
      where: { id: attemptId, tenantId },
      include: { answers: true },
    });
    if (!attempt) throw new AttemptNotFoundError();
    if (attempt.status !== 'PENDING_REVIEW') throw new AttemptNotPendingReviewError();

    const quiz = await this.requireQuiz(tenantId, attempt.quizId);
    const questions = await this.prisma.modAssessmentsQuestion.findMany({
      where: { tenantId, quizId: attempt.quizId, deletedAt: null },
      select: { id: true, points: true },
    });
    const pointsByQuestion = new Map(questions.map((q) => [q.id, q.points]));
    const gradeByQuestion = new Map(dto.grades.map((g) => [g.questionId, g]));

    // Validar que ninguna nota excede el máximo de puntos de su pregunta.
    for (const grade of dto.grades) {
      const max = pointsByQuestion.get(grade.questionId);
      if (max !== undefined && grade.scoreEarned > max) {
        throw new GradeExceedsQuestionPointsError(grade.questionId, grade.scoreEarned, max);
      }
    }

    const gradedAt = new Date();

    const updated = await this.prisma.$transaction(async (tx) => {
      // Aplicar la nota a cada answer correspondiente.
      for (const answer of attempt.answers) {
        const grade = gradeByQuestion.get(answer.questionId);
        if (!grade) continue;
        await tx.modAssessmentsAnswer.update({
          where: { id: answer.id },
          data: {
            scoreEarned: grade.scoreEarned,
            isCorrect:
              (pointsByQuestion.get(answer.questionId) ?? 0) > 0
                ? grade.scoreEarned === pointsByQuestion.get(answer.questionId)
                : false,
            gradedFeedback: grade.feedback ?? null,
          },
        });
      }

      // Recomputar totales sumando todas las respuestas (las objetivas ya
      // tenían scoreEarned correcto desde submitAttempt).
      const allAnswers = await tx.modAssessmentsAnswer.findMany({
        where: { attemptId: attempt.id },
        select: { scoreEarned: true },
      });
      const scoreEarned = allAnswers.reduce((acc, a) => acc + a.scoreEarned, 0);
      const scoreMax = attempt.scoreMax ?? 0;
      const scorePercent = scoreMax === 0 ? 0 : Math.round((scoreEarned / scoreMax) * 100);
      const passed = scorePercent >= quiz.passThreshold;

      return tx.modAssessmentsAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'GRADED',
          scoreEarned,
          scorePercent,
          passed,
          gradedAt,
          gradedById: formadorId,
        },
      });
    });

    const eventPayload = {
      attemptId: attempt.id,
      quizId: attempt.quizId,
      userId: attempt.userId,
      enrollmentId: attempt.enrollmentId,
      lessonId: attempt.lessonId,
      scoreEarned: updated.scoreEarned,
      scoreMax: updated.scoreMax,
      scorePercent: updated.scorePercent,
      passed: updated.passed,
    };
    await this.publish(tenantId, formadorId, 'assessments.attempt.graded', eventPayload);
    await this.publish(
      tenantId,
      attempt.userId,
      updated.passed ? 'assessments.attempt.passed' : 'assessments.attempt.failed',
      eventPayload,
    );

    return updated;
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
