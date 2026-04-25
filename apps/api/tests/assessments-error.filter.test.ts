import { describe, expect, it, vi } from 'vitest';
import {
  AttemptAlreadySubmittedError,
  AttemptExpiredError,
  AttemptNotFoundError,
  MaxAttemptsReachedError,
  QuestionNotFoundError,
  QuizHasNoQuestionsError,
  QuizNotFoundError,
  QuizNotPublishedError,
} from '@learnship/mod-assessments';
import { AssessmentsErrorFilter } from '../src/modules/assessments-error.filter';

function makeHost(captured: { status?: number; body?: unknown }) {
  const reply = {
    status(s: number) {
      captured.status = s;
      return this;
    },
    send(b: unknown) {
      captured.body = b;
      return this;
    },
  };
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getResponse: () => reply,
    }),
  } as never;
}

describe('AssessmentsErrorFilter', () => {
  const filter = new AssessmentsErrorFilter();

  it.each([
    [new QuizNotFoundError(), 404, 'QUIZ_NOT_FOUND'],
    [new QuestionNotFoundError(), 404, 'QUESTION_NOT_FOUND'],
    [new AttemptNotFoundError(), 404, 'ATTEMPT_NOT_FOUND'],
    [new QuizNotPublishedError(), 422, 'QUIZ_NOT_PUBLISHED'],
    [new QuizHasNoQuestionsError(), 422, 'QUIZ_HAS_NO_QUESTIONS'],
    [new AttemptAlreadySubmittedError(), 409, 'ATTEMPT_ALREADY_SUBMITTED'],
    [new AttemptExpiredError(), 410, 'ATTEMPT_EXPIRED'],
    [new MaxAttemptsReachedError(3), 409, 'MAX_ATTEMPTS_REACHED'],
  ])('mapea %s al status HTTP correcto', (err, expectedStatus, expectedCode) => {
    const captured: { status?: number; body?: unknown } = {};
    filter.catch(err, makeHost(captured));
    expect(captured.status).toBe(expectedStatus);
    expect(captured.body).toMatchObject({
      statusCode: expectedStatus,
      code: expectedCode,
      message: expect.any(String),
    });
  });

  it('código desconocido → 400', () => {
    const captured: { status?: number; body?: unknown } = {};
    const fakeError = new (class extends Error {
      code = 'SOMETHING_WEIRD';
      constructor() {
        super('mensaje raro');
      }
    })() as never;
    // bypass instanceof check by calling catch directly
    filter.catch(fakeError, makeHost(captured));
    expect(captured.status).toBe(400);
  });

  it('contexto no-http: lanza HttpException', () => {
    const host = {
      getType: () => 'rpc',
      switchToHttp: () => ({
        getResponse: vi.fn(),
      }),
    } as never;
    expect(() => filter.catch(new QuizNotFoundError(), host)).toThrowError();
  });
});
