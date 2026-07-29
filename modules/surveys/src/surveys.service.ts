import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@didacta/database';
import {
  SurveysAlreadyRespondedError,
  SurveysInvalidAnswerError,
  SurveysSurveyClosedError,
  SurveysSurveyNotFoundError,
} from './errors.js';

/**
 * mod.surveys — dominio puro (sin NestJS). Encuestas anónimas con NPS.
 *
 * Anonimato honesto: las respuestas NUNCA guardan userId. El dedupe de envíos
 * usa `respondentHash` = HMAC-SHA256(secret, `${surveyId}:${userId}`) — el
 * servidor puede saber SI un usuario respondió (para el estado de la UI y la
 * unique), pero no puede listar quién dijo qué sin atacar el HMAC por fuerza
 * bruta sobre el censo. El secreto lo inyecta el host y no vive en la BD.
 */

export interface SurveysEventPublisher {
  publish(
    tenantId: string,
    actorId: string | null,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

export const SURVEYS_EVENT = {
  CREATED: 'surveys.survey.created',
  RESPONSE_SUBMITTED: 'surveys.response.submitted',
} as const;

export type SurveyQuestionTypeValue = 'NPS' | 'SCALE' | 'TEXT';

/**
 * Preguntas fijas de la encuesta post-clase. Siempre las mismas a propósito:
 * respuestas comparables entre clases y en el tiempo (doc/mejoras.md bloque 2).
 */
export const POST_CLASS_QUESTIONS: ReadonlyArray<{
  type: SurveyQuestionTypeValue;
  label: string;
}> = [
  { type: 'NPS', label: 'Del 0 al 10, ¿recomendarías esta clase a otro miembro?' },
  { type: 'SCALE', label: 'El contenido de la clase' },
  { type: 'SCALE', label: 'El ritmo y la claridad' },
  { type: 'TEXT', label: '¿Qué mejorarías? (opcional)' },
];

export interface SubmitAnswerInput {
  questionId: string;
  valueInt?: number | null;
  valueText?: string | null;
}

/** Tope defensivo para la respuesta libre (evita payloads absurdos). */
const TEXT_MAX_LENGTH = 2000;
/** Cuántas respuestas de texto devuelve el agregado de resultados. */
const TEXT_RESULTS_LIMIT = 200;

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

export class SurveysService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly publisher: SurveysEventPublisher,
    /** Secreto del HMAC de `respondentHash`. Obligatorio y estable entre deploys. */
    private readonly hashSecret: string,
  ) {
    if (!hashSecret || hashSecret.length < 16) {
      throw new Error('mod.surveys: hashSecret obligatorio (mínimo 16 caracteres).');
    }
  }

  /** HMAC anónimo y determinista por (encuesta, usuario). */
  respondentHash(surveyId: string, userId: string): string {
    return createHmac('sha256', this.hashSecret).update(`${surveyId}:${userId}`).digest('hex');
  }

  /**
   * Crea la encuesta post-clase de una sesión de mod.zoom-live. Idempotente:
   * la unique (tenantId, zoomSessionId) garantiza una sola encuesta por clase
   * aunque el webhook de Zoom reintente o llegue duplicado.
   */
  async createForZoomSession(args: {
    tenantId: string;
    sessionId: string;
    topic: string;
  }): Promise<{ surveyId: string; created: boolean }> {
    const { tenantId, sessionId, topic } = args;
    const existing = await this.prisma.modSurveysSurvey.findUnique({
      where: { tenantId_zoomSessionId: { tenantId, zoomSessionId: sessionId } },
      select: { id: true },
    });
    if (existing) return { surveyId: existing.id, created: false };

    try {
      const survey = await this.prisma.modSurveysSurvey.create({
        data: {
          tenantId,
          kind: 'POST_CLASS',
          zoomSessionId: sessionId,
          title: topic,
          questions: {
            create: POST_CLASS_QUESTIONS.map((q, i) => ({
              tenantId,
              position: i + 1,
              type: q.type,
              label: q.label,
            })),
          },
        },
        select: { id: true },
      });
      await this.publisher.publish(tenantId, null, SURVEYS_EVENT.CREATED, {
        surveyId: survey.id,
        kind: 'POST_CLASS',
        zoomSessionId: sessionId,
      });
      return { surveyId: survey.id, created: true };
    } catch (e) {
      if (isUniqueViolation(e)) {
        const survey = await this.prisma.modSurveysSurvey.findUnique({
          where: { tenantId_zoomSessionId: { tenantId, zoomSessionId: sessionId } },
          select: { id: true },
        });
        if (survey) return { surveyId: survey.id, created: false };
      }
      throw e;
    }
  }

  /**
   * Encuesta de una sesión para el alumno: preguntas + si este usuario ya
   * respondió. `null` si la clase aún no tiene encuesta (no es un error).
   */
  async getForZoomSession(
    tenantId: string,
    sessionId: string,
    userId: string,
  ): Promise<{
    id: string;
    title: string;
    status: string;
    alreadyAnswered: boolean;
    questions: Array<{ id: string; position: number; type: string; label: string }>;
  } | null> {
    const survey = await this.prisma.modSurveysSurvey.findUnique({
      where: { tenantId_zoomSessionId: { tenantId, zoomSessionId: sessionId } },
      include: { questions: { orderBy: { position: 'asc' } } },
    });
    if (!survey) return null;
    const answered = await this.prisma.modSurveysResponse.findUnique({
      where: {
        surveyId_respondentHash: {
          surveyId: survey.id,
          respondentHash: this.respondentHash(survey.id, userId),
        },
      },
      select: { id: true },
    });
    return {
      id: survey.id,
      title: survey.title,
      status: survey.status,
      alreadyAnswered: answered !== null,
      questions: survey.questions.map((q) => ({
        id: q.id,
        position: q.position,
        type: q.type,
        label: q.label,
      })),
    };
  }

  /**
   * Registra la respuesta anónima de un usuario. Valida rangos (NPS 0-10,
   * SCALE 1-5, TEXT ≤ 2000), exige todas las preguntas no-TEXT, y dedupea por
   * respondentHash (segundo envío → SurveysAlreadyRespondedError).
   */
  async submitResponse(args: {
    tenantId: string;
    surveyId: string;
    userId: string;
    answers: SubmitAnswerInput[];
  }): Promise<void> {
    const { tenantId, surveyId, userId, answers } = args;
    const survey = await this.prisma.modSurveysSurvey.findFirst({
      where: { id: surveyId, tenantId },
      include: { questions: true },
    });
    if (!survey) throw new SurveysSurveyNotFoundError();
    if (survey.status !== 'OPEN') throw new SurveysSurveyClosedError();

    const byId = new Map(survey.questions.map((q) => [q.id, q]));
    const seen = new Set<string>();
    const rows: Array<{ questionId: string; valueInt: number | null; valueText: string | null }> =
      [];

    for (const a of answers) {
      const q = byId.get(a.questionId);
      if (!q) throw new SurveysInvalidAnswerError('Respuesta a una pregunta desconocida.');
      if (seen.has(q.id)) {
        throw new SurveysInvalidAnswerError('Respuesta duplicada para la misma pregunta.');
      }
      seen.add(q.id);

      if (q.type === 'NPS') {
        const v = a.valueInt;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 10) {
          throw new SurveysInvalidAnswerError('La puntuación NPS debe ser un entero de 0 a 10.');
        }
        rows.push({ questionId: q.id, valueInt: v, valueText: null });
      } else if (q.type === 'SCALE') {
        const v = a.valueInt;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 5) {
          throw new SurveysInvalidAnswerError('La valoración debe ser un entero de 1 a 5.');
        }
        rows.push({ questionId: q.id, valueInt: v, valueText: null });
      } else {
        const text = (a.valueText ?? '').trim();
        if (text.length > TEXT_MAX_LENGTH) {
          throw new SurveysInvalidAnswerError(
            `La respuesta libre no puede superar ${TEXT_MAX_LENGTH} caracteres.`,
          );
        }
        // El texto vacío simplemente no se guarda (la pregunta TEXT es opcional).
        if (text) rows.push({ questionId: q.id, valueInt: null, valueText: text });
      }
    }

    for (const q of survey.questions) {
      if (q.type !== 'TEXT' && !seen.has(q.id)) {
        throw new SurveysInvalidAnswerError(`Falta responder: "${q.label}".`);
      }
    }

    try {
      await this.prisma.modSurveysResponse.create({
        data: {
          tenantId,
          surveyId,
          respondentHash: this.respondentHash(surveyId, userId),
          answers: { create: rows.map((r) => ({ tenantId, ...r })) },
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new SurveysAlreadyRespondedError();
      throw e;
    }

    // Sin actorId: el evento tampoco identifica al autor (anonimato).
    await this.publisher.publish(tenantId, null, SURVEYS_EVENT.RESPONSE_SUBMITTED, { surveyId });
  }

  /** Listado admin: encuestas con nº de respuestas, más recientes primero. */
  async listSurveys(tenantId: string): Promise<
    Array<{
      id: string;
      kind: string;
      title: string;
      status: string;
      zoomSessionId: string | null;
      createdAt: Date;
      responseCount: number;
    }>
  > {
    const surveys = await this.prisma.modSurveysSurvey.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { _count: { select: { responses: true } } },
    });
    return surveys.map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
      status: s.status,
      zoomSessionId: s.zoomSessionId,
      createdAt: s.createdAt,
      responseCount: s._count.responses,
    }));
  }

  /**
   * Agregado de resultados (admin). NPS clásico: promotores (9-10) −
   * detractores (0-6) sobre el total, en puntos porcentuales redondeados.
   */
  async getResults(
    tenantId: string,
    surveyId: string,
  ): Promise<{
    id: string;
    title: string;
    kind: string;
    status: string;
    createdAt: Date;
    responseCount: number;
    questions: Array<{
      id: string;
      position: number;
      type: string;
      label: string;
      answerCount: number;
      nps: { promoters: number; passives: number; detractors: number; score: number } | null;
      average: number | null;
      texts: string[];
    }>;
  }> {
    const survey = await this.prisma.modSurveysSurvey.findFirst({
      where: { id: surveyId, tenantId },
      include: {
        questions: { orderBy: { position: 'asc' }, include: { answers: true } },
        _count: { select: { responses: true } },
      },
    });
    if (!survey) throw new SurveysSurveyNotFoundError();

    return {
      id: survey.id,
      title: survey.title,
      kind: survey.kind,
      status: survey.status,
      createdAt: survey.createdAt,
      responseCount: survey._count.responses,
      questions: survey.questions.map((q) => {
        if (q.type === 'TEXT') {
          const texts = q.answers
            .map((a) => a.valueText)
            .filter((t): t is string => Boolean(t))
            .slice(0, TEXT_RESULTS_LIMIT);
          return {
            id: q.id,
            position: q.position,
            type: q.type,
            label: q.label,
            answerCount: texts.length,
            nps: null,
            average: null,
            texts,
          };
        }
        const values = q.answers
          .map((a) => a.valueInt)
          .filter((v): v is number => typeof v === 'number');
        if (q.type === 'NPS') {
          const promoters = values.filter((v) => v >= 9).length;
          const passives = values.filter((v) => v >= 7 && v <= 8).length;
          const detractors = values.filter((v) => v <= 6).length;
          const score =
            values.length === 0 ? 0 : Math.round(((promoters - detractors) / values.length) * 100);
          return {
            id: q.id,
            position: q.position,
            type: q.type,
            label: q.label,
            answerCount: values.length,
            nps: { promoters, passives, detractors, score },
            average: null,
            texts: [],
          };
        }
        const average =
          values.length === 0
            ? null
            : Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10;
        return {
          id: q.id,
          position: q.position,
          type: q.type,
          label: q.label,
          answerCount: values.length,
          nps: null,
          average,
          texts: [],
        };
      }),
    };
  }

  /** Cierra la encuesta (admin): deja de aceptar respuestas. Idempotente. */
  async closeSurvey(tenantId: string, surveyId: string): Promise<void> {
    const { count } = await this.prisma.modSurveysSurvey.updateMany({
      where: { id: surveyId, tenantId, status: 'OPEN' },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    if (count === 0) {
      const exists = await this.prisma.modSurveysSurvey.findFirst({
        where: { id: surveyId, tenantId },
        select: { id: true },
      });
      if (!exists) throw new SurveysSurveyNotFoundError();
      // Ya estaba cerrada: idempotente, no es un error.
    }
  }
}
