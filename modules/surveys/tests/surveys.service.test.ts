import { beforeEach, describe, expect, it } from 'vitest';
import {
  POST_CLASS_QUESTIONS,
  SurveysService,
  type SurveysEventPublisher,
} from '../src/surveys.service.js';
import {
  SurveysAlreadyRespondedError,
  SurveysInvalidAnswerError,
  SurveysSurveyClosedError,
  SurveysSurveyNotFoundError,
} from '../src/errors.js';

// ============================================================================
// Tests del dominio mod.surveys con un MockPrisma in-memory (sin BD ni red),
// mismo patrón que referrals.service.test.ts. Cubren: creación idempotente
// post-clase, hash anónimo, validación de respuestas (rangos, obligatorias,
// duplicadas), dedupe de envíos, agregados (NPS, medias, textos) y cierre.
// ============================================================================

interface Row {
  [key: string]: unknown;
}

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

function uniqueViolation(): Error & { code: string } {
  const err = new Error('Unique constraint failed') as Error & { code: string };
  err.code = 'P2002';
  return err;
}

class MockPrisma {
  surveys: Row[] = [];
  questions: Row[] = [];
  responses: Row[] = [];
  answers: Row[] = [];

  private surveyView(s: Row, include?: Row): Row {
    const out: Row = { ...s };
    if (include?.['questions']) {
      const qs = this.questions
        .filter((q) => q['surveyId'] === s['id'])
        .sort((a, b) => (a['position'] as number) - (b['position'] as number));
      out['questions'] = qs.map((q) => {
        const qOut: Row = { ...q };
        const inc = include['questions'] as Row;
        if (typeof inc === 'object' && inc !== null && (inc as Row)['include']) {
          qOut['answers'] = this.answers.filter((a) => a['questionId'] === q['id']);
        }
        return qOut;
      });
    }
    if (include?.['_count']) {
      out['_count'] = {
        responses: this.responses.filter((r) => r['surveyId'] === s['id']).length,
      };
    }
    return out;
  }

  modSurveysSurvey = {
    findUnique: async ({ where, include }: never) => {
      const w = where as Row;
      const byAnchor = w['tenantId_zoomSessionId'] as Row | undefined;
      const s = byAnchor
        ? this.surveys.find(
            (x) =>
              x['tenantId'] === byAnchor['tenantId'] &&
              x['zoomSessionId'] === byAnchor['zoomSessionId'],
          )
        : this.surveys.find((x) => x['id'] === w['id']);
      return s ? this.surveyView(s, include as Row | undefined) : null;
    },
    findFirst: async ({ where, include }: never) => {
      const w = where as Row;
      const s = this.surveys.find(
        (x) =>
          x['id'] === w['id'] &&
          x['tenantId'] === w['tenantId'] &&
          (w['status'] === undefined || x['status'] === w['status']),
      );
      return s ? this.surveyView(s, include as Row | undefined) : null;
    },
    findMany: async ({ where, include }: never) => {
      const w = (where ?? {}) as Row;
      return this.surveys
        .filter((x) => {
          if (w['tenantId'] !== undefined && x['tenantId'] !== w['tenantId']) return false;
          if (w['kind'] !== undefined && x['kind'] !== w['kind']) return false;
          if (w['status'] !== undefined && x['status'] !== w['status']) return false;
          if ('reminderSentAt' in w && w['reminderSentAt'] === null && x['reminderSentAt'] != null)
            return false;
          const zs = w['zoomSessionId'] as Row | undefined;
          if (zs && typeof zs === 'object' && 'not' in zs && x['zoomSessionId'] === zs['not'])
            return false;
          const ca = w['createdAt'] as Row | undefined;
          if (ca && typeof ca === 'object') {
            const t = (x['createdAt'] as Date).getTime();
            if (ca['gte'] !== undefined && t < (ca['gte'] as Date).getTime()) return false;
            if (ca['lte'] !== undefined && t > (ca['lte'] as Date).getTime()) return false;
          }
          return true;
        })
        .sort((a, b) => (b['createdAt'] as Date).getTime() - (a['createdAt'] as Date).getTime())
        .map((s) => this.surveyView(s, include as Row | undefined));
    },
    create: async ({ data }: never) => {
      const d = data as Row;
      if (
        this.surveys.some(
          (x) => x['tenantId'] === d['tenantId'] && x['zoomSessionId'] === d['zoomSessionId'],
        )
      ) {
        throw uniqueViolation();
      }
      const row: Row = {
        id: nextId('survey'),
        status: 'OPEN',
        createdAt: new Date(),
        closedAt: null,
        courseId: null,
        reminderSentAt: null,
        ...d,
      };
      delete row['questions'];
      this.surveys.push(row);
      const nested = (d['questions'] as Row | undefined)?.['create'] as Row[] | undefined;
      for (const q of nested ?? []) {
        this.questions.push({ id: nextId('q'), surveyId: row['id'], ...q });
      }
      return { ...row };
    },
    updateMany: async ({ where, data }: never) => {
      const w = where as Row;
      const matched = this.surveys.filter(
        (x) =>
          x['id'] === w['id'] &&
          x['tenantId'] === w['tenantId'] &&
          (w['status'] === undefined || x['status'] === w['status']) &&
          (!('reminderSentAt' in w) ||
            (w['reminderSentAt'] === null && x['reminderSentAt'] == null)),
      );
      for (const m of matched) Object.assign(m, data as Row);
      return { count: matched.length };
    },
  };

  modSurveysResponse = {
    findMany: async ({ where }: never) => {
      const w = where as Row;
      const inList = ((w['respondentHash'] as Row | undefined)?.['in'] as string[]) ?? [];
      return this.responses.filter(
        (r) =>
          r['tenantId'] === w['tenantId'] &&
          r['surveyId'] === w['surveyId'] &&
          inList.includes(r['respondentHash'] as string),
      );
    },
    findUnique: async ({ where }: never) => {
      const w = (where as Row)['surveyId_respondentHash'] as Row;
      return (
        this.responses.find(
          (r) => r['surveyId'] === w['surveyId'] && r['respondentHash'] === w['respondentHash'],
        ) ?? null
      );
    },
    create: async ({ data }: never) => {
      const d = data as Row;
      if (
        this.responses.some(
          (r) => r['surveyId'] === d['surveyId'] && r['respondentHash'] === d['respondentHash'],
        )
      ) {
        throw uniqueViolation();
      }
      const row: Row = { id: nextId('resp'), submittedAt: new Date(), ...d };
      delete row['answers'];
      this.responses.push(row);
      const nested = (d['answers'] as Row | undefined)?.['create'] as Row[] | undefined;
      for (const a of nested ?? []) {
        this.answers.push({ id: nextId('ans'), responseId: row['id'], ...a });
      }
      return { ...row };
    },
  };
}

const TENANT = 'tenant-1';
const SECRET = 'secreto-de-pruebas-largo';

function makeService(mock: MockPrisma) {
  const published: Array<{ tenantId: string; actorId: string | null; name: string; payload: Row }> =
    [];
  const publisher: SurveysEventPublisher = {
    publish: async (tenantId, actorId, name, payload) => {
      published.push({ tenantId, actorId, name, payload });
    },
  };
  const service = new SurveysService(mock as never, publisher, SECRET);
  return { service, published };
}

async function createSurvey(service: SurveysService): Promise<string> {
  const { surveyId } = await service.createForZoomSession({
    tenantId: TENANT,
    sessionId: 'sess-1',
    topic: 'Clase de agentes',
  });
  return surveyId;
}

function validAnswersFor(mock: MockPrisma, surveyId: string) {
  const qs = mock.questions
    .filter((q) => q['surveyId'] === surveyId)
    .sort((a, b) => (a['position'] as number) - (b['position'] as number));
  return {
    nps: (v: number) => ({ questionId: qs[0]!['id'] as string, valueInt: v }),
    scale1: (v: number) => ({ questionId: qs[1]!['id'] as string, valueInt: v }),
    scale2: (v: number) => ({ questionId: qs[2]!['id'] as string, valueInt: v }),
    text: (t: string) => ({ questionId: qs[3]!['id'] as string, valueText: t }),
  };
}

describe('SurveysService', () => {
  let mock: MockPrisma;

  beforeEach(() => {
    mock = new MockPrisma();
    idSeq = 0;
  });

  it('exige un hashSecret mínimo', () => {
    expect(() => new SurveysService({} as never, { publish: async () => {} }, 'corto')).toThrow(
      /hashSecret/,
    );
  });

  it('crea la encuesta post-clase con las preguntas fijas y emite el evento', async () => {
    const { service, published } = makeService(mock);
    const { surveyId, created } = await service.createForZoomSession({
      tenantId: TENANT,
      sessionId: 'sess-1',
      topic: 'Clase de agentes',
    });
    expect(created).toBe(true);
    expect(mock.questions.filter((q) => q['surveyId'] === surveyId)).toHaveLength(
      POST_CLASS_QUESTIONS.length,
    );
    expect(published).toHaveLength(1);
    expect(published[0]!.name).toBe('surveys.survey.created');
    expect(published[0]!.actorId).toBeNull();
  });

  it('es idempotente por sesión: la segunda llamada no crea ni re-emite', async () => {
    const { service, published } = makeService(mock);
    const first = await service.createForZoomSession({
      tenantId: TENANT,
      sessionId: 'sess-1',
      topic: 'Clase',
    });
    const second = await service.createForZoomSession({
      tenantId: TENANT,
      sessionId: 'sess-1',
      topic: 'Clase',
    });
    expect(second.created).toBe(false);
    expect(second.surveyId).toBe(first.surveyId);
    expect(published).toHaveLength(1);
  });

  it('el hash es determinista y distinto por usuario y por encuesta', () => {
    const { service } = makeService(mock);
    expect(service.respondentHash('s1', 'u1')).toBe(service.respondentHash('s1', 'u1'));
    expect(service.respondentHash('s1', 'u1')).not.toBe(service.respondentHash('s1', 'u2'));
    expect(service.respondentHash('s1', 'u1')).not.toBe(service.respondentHash('s2', 'u1'));
  });

  it('registra una respuesta válida sin userId (anónima) y emite sin actor', async () => {
    const { service, published } = makeService(mock);
    const surveyId = await createSurvey(service);
    const a = validAnswersFor(mock, surveyId);
    await service.submitResponse({
      tenantId: TENANT,
      surveyId,
      userId: 'user-1',
      answers: [a.nps(9), a.scale1(5), a.scale2(4), a.text('Más ejemplos en directo')],
    });
    expect(mock.responses).toHaveLength(1);
    expect(mock.responses[0]!['respondentHash']).toBe(service.respondentHash(surveyId, 'user-1'));
    expect(Object.keys(mock.responses[0]!)).not.toContain('userId');
    expect(mock.answers).toHaveLength(4);
    const submitted = published.find((p) => p.name === 'surveys.response.submitted');
    expect(submitted?.actorId).toBeNull();
    expect(submitted?.payload).toEqual({ surveyId });
  });

  it('el texto vacío no se guarda (pregunta TEXT opcional)', async () => {
    const { service } = makeService(mock);
    const surveyId = await createSurvey(service);
    const a = validAnswersFor(mock, surveyId);
    await service.submitResponse({
      tenantId: TENANT,
      surveyId,
      userId: 'user-1',
      answers: [a.nps(8), a.scale1(3), a.scale2(3), a.text('   ')],
    });
    expect(mock.answers).toHaveLength(3);
  });

  it.each([
    [-1, 'NPS bajo'],
    [11, 'NPS alto'],
    [7.5, 'NPS decimal'],
  ])('rechaza NPS fuera de rango (%s)', async (v) => {
    const { service } = makeService(mock);
    const surveyId = await createSurvey(service);
    const a = validAnswersFor(mock, surveyId);
    await expect(
      service.submitResponse({
        tenantId: TENANT,
        surveyId,
        userId: 'user-1',
        answers: [a.nps(v as number), a.scale1(3), a.scale2(3)],
      }),
    ).rejects.toBeInstanceOf(SurveysInvalidAnswerError);
  });

  it('rechaza SCALE fuera de 1-5, preguntas desconocidas, duplicadas y faltantes', async () => {
    const { service } = makeService(mock);
    const surveyId = await createSurvey(service);
    const a = validAnswersFor(mock, surveyId);

    await expect(
      service.submitResponse({
        tenantId: TENANT,
        surveyId,
        userId: 'u',
        answers: [a.nps(5), a.scale1(0), a.scale2(3)],
      }),
    ).rejects.toBeInstanceOf(SurveysInvalidAnswerError);

    await expect(
      service.submitResponse({
        tenantId: TENANT,
        surveyId,
        userId: 'u',
        answers: [a.nps(5), a.scale1(3), a.scale2(3), { questionId: 'q-ajena', valueInt: 3 }],
      }),
    ).rejects.toBeInstanceOf(SurveysInvalidAnswerError);

    await expect(
      service.submitResponse({
        tenantId: TENANT,
        surveyId,
        userId: 'u',
        answers: [a.nps(5), a.nps(6), a.scale1(3), a.scale2(3)],
      }),
    ).rejects.toBeInstanceOf(SurveysInvalidAnswerError);

    await expect(
      service.submitResponse({ tenantId: TENANT, surveyId, userId: 'u', answers: [a.nps(5)] }),
    ).rejects.toBeInstanceOf(SurveysInvalidAnswerError);
  });

  it('el segundo envío del mismo usuario devuelve SurveysAlreadyRespondedError', async () => {
    const { service } = makeService(mock);
    const surveyId = await createSurvey(service);
    const a = validAnswersFor(mock, surveyId);
    const answers = [a.nps(9), a.scale1(5), a.scale2(5)];
    await service.submitResponse({ tenantId: TENANT, surveyId, userId: 'user-1', answers });
    await expect(
      service.submitResponse({ tenantId: TENANT, surveyId, userId: 'user-1', answers }),
    ).rejects.toBeInstanceOf(SurveysAlreadyRespondedError);
    expect(mock.responses).toHaveLength(1);
  });

  it('una encuesta cerrada no acepta respuestas', async () => {
    const { service } = makeService(mock);
    const surveyId = await createSurvey(service);
    const a = validAnswersFor(mock, surveyId);
    await service.closeSurvey(TENANT, surveyId);
    await expect(
      service.submitResponse({
        tenantId: TENANT,
        surveyId,
        userId: 'u',
        answers: [a.nps(9), a.scale1(5), a.scale2(5)],
      }),
    ).rejects.toBeInstanceOf(SurveysSurveyClosedError);
  });

  it('getForZoomSession refleja alreadyAnswered por usuario', async () => {
    const { service } = makeService(mock);
    const surveyId = await createSurvey(service);
    const a = validAnswersFor(mock, surveyId);
    expect(await service.getForZoomSession(TENANT, 'sess-x', 'u1')).toBeNull();

    const before = await service.getForZoomSession(TENANT, 'sess-1', 'u1');
    expect(before?.alreadyAnswered).toBe(false);
    expect(before?.questions).toHaveLength(4);

    await service.submitResponse({
      tenantId: TENANT,
      surveyId,
      userId: 'u1',
      answers: [a.nps(9), a.scale1(5), a.scale2(5)],
    });
    expect((await service.getForZoomSession(TENANT, 'sess-1', 'u1'))?.alreadyAnswered).toBe(true);
    expect((await service.getForZoomSession(TENANT, 'sess-1', 'u2'))?.alreadyAnswered).toBe(false);
  });

  it('agrega resultados: NPS (promotores − detractores), medias y textos', async () => {
    const { service } = makeService(mock);
    const surveyId = await createSurvey(service);
    const a = validAnswersFor(mock, surveyId);
    // 4 respuestas: NPS 10 (prom), 9 (prom), 7 (pasivo), 2 (detractor) → 25.
    const cases: Array<[string, number, number, number, string]> = [
      ['u1', 10, 5, 5, 'Genial'],
      ['u2', 9, 4, 4, ''],
      ['u3', 7, 3, 4, 'Más práctica'],
      ['u4', 2, 1, 2, ''],
    ];
    for (const [user, nps, s1, s2, text] of cases) {
      await service.submitResponse({
        tenantId: TENANT,
        surveyId,
        userId: user,
        answers: [a.nps(nps), a.scale1(s1), a.scale2(s2), a.text(text)],
      });
    }

    const results = await service.getResults(TENANT, surveyId);
    expect(results.responseCount).toBe(4);

    const npsQ = results.questions[0]!;
    expect(npsQ.nps).toEqual({ promoters: 2, passives: 1, detractors: 1, score: 25 });

    const scaleQ = results.questions[1]!;
    expect(scaleQ.average).toBe(3.3); // (5+4+3+1)/4 = 3.25 → 3.3

    const textQ = results.questions[3]!;
    expect(textQ.texts).toEqual(['Genial', 'Más práctica']);
    expect(textQ.answerCount).toBe(2);
  });

  it('findDueReminders respeta la ventana 24-72h y los estados', async () => {
    const { service } = makeService(mock);
    const now = new Date('2026-07-29T12:00:00Z');
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

    await service.createForZoomSession({ tenantId: TENANT, sessionId: 's-due', topic: 'Debida' });
    await service.createForZoomSession({ tenantId: TENANT, sessionId: 's-nueva', topic: 'Nueva' });
    await service.createForZoomSession({ tenantId: TENANT, sessionId: 's-vieja', topic: 'Vieja' });
    await service.createForZoomSession({
      tenantId: TENANT,
      sessionId: 's-cerrada',
      topic: 'Cerrada',
    });
    const bySession = (sid: string) => mock.surveys.find((s) => s['zoomSessionId'] === sid)!;
    bySession('s-due')['createdAt'] = hoursAgo(25);
    bySession('s-nueva')['createdAt'] = hoursAgo(2);
    bySession('s-vieja')['createdAt'] = hoursAgo(100);
    bySession('s-cerrada')['createdAt'] = hoursAgo(30);
    await service.closeSurvey(TENANT, bySession('s-cerrada')['id'] as string);

    const due = await service.findDueReminders(now);
    expect(due.map((d) => d.zoomSessionId)).toEqual(['s-due']);

    // Tras reclamar, deja de estar pendiente.
    expect(await service.claimReminder(TENANT, due[0]!.id)).toBe(true);
    expect(await service.findDueReminders(now)).toEqual([]);
  });

  it('claimReminder solo gana la primera vez (carrera entre instancias)', async () => {
    const { service } = makeService(mock);
    const surveyId = await createSurvey(service);
    expect(await service.claimReminder(TENANT, surveyId)).toBe(true);
    expect(await service.claimReminder(TENANT, surveyId)).toBe(false);
  });

  it('filterPendingRespondents separa pendientes sin identificar respuestas', async () => {
    const { service } = makeService(mock);
    const surveyId = await createSurvey(service);
    const a = validAnswersFor(mock, surveyId);
    await service.submitResponse({
      tenantId: TENANT,
      surveyId,
      userId: 'u2',
      answers: [a.nps(9), a.scale1(5), a.scale2(5)],
    });

    expect(await service.filterPendingRespondents(TENANT, surveyId, [])).toEqual([]);
    expect(await service.filterPendingRespondents(TENANT, surveyId, ['u1', 'u2', 'u3'])).toEqual([
      'u1',
      'u3',
    ]);
  });

  it('getResults y closeSurvey lanzan not-found para encuestas ajenas', async () => {
    const { service } = makeService(mock);
    await expect(service.getResults(TENANT, 'no-existe')).rejects.toBeInstanceOf(
      SurveysSurveyNotFoundError,
    );
    await expect(service.closeSurvey(TENANT, 'no-existe')).rejects.toBeInstanceOf(
      SurveysSurveyNotFoundError,
    );
  });
});
