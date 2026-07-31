import { describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '@didacta/core-kernel';
import { AssessmentsLearningBridge } from '../src/modules/assessments/assessments-learning.bridge';

interface AttemptPassedPayload {
  attemptId: string;
  quizId: string;
  userId: string;
  enrollmentId: string | null;
  lessonId: string | null;
  scoreEarned: number;
  scoreMax: number;
  scorePercent: number;
  passed: boolean;
}

const event = (
  overrides: Partial<AttemptPassedPayload> = {},
): DomainEvent<AttemptPassedPayload> => ({
  name: 'assessments.attempt.passed',
  version: 1,
  data: {
    attemptId: 'att-1',
    quizId: 'quiz-1',
    userId: 'user-1',
    enrollmentId: 'enr-1',
    lessonId: 'lesson-1',
    scoreEarned: 10,
    scoreMax: 10,
    scorePercent: 100,
    passed: true,
    ...overrides,
  },
  metadata: {
    tenantId: 'tenant-1',
    timestamp: new Date().toISOString(),
    traceId: 'trace-1',
    idempotencyKey: 'idem-1',
  },
});

const noopLogger = {
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as never;

function makeRegistry(trackProgress: ReturnType<typeof vi.fn>) {
  return {
    getLearningService: () => ({ trackProgress }),
  } as never;
}

const noopFactory = {
  getEventBus: () => ({ subscribe: () => () => {} }),
} as never;

describe('AssessmentsLearningBridge.handleAttemptPassed', () => {
  it('llama a trackProgress con completed=true cuando hay enrollmentId+lessonId', async () => {
    const trackProgress = vi.fn().mockResolvedValue({});
    const bridge = new AssessmentsLearningBridge(
      makeRegistry(trackProgress),
      noopFactory,
      noopLogger,
    );

    await bridge.handleAttemptPassed(event());

    expect(trackProgress).toHaveBeenCalledTimes(1);
    expect(trackProgress).toHaveBeenCalledWith('tenant-1', 'user-1', {
      enrollmentId: 'enr-1',
      lessonId: 'lesson-1',
      watchedSeconds: 0,
      completed: true,
    });
  });

  it('no hace nada si falta enrollmentId', async () => {
    const trackProgress = vi.fn();
    const bridge = new AssessmentsLearningBridge(
      makeRegistry(trackProgress),
      noopFactory,
      noopLogger,
    );

    await bridge.handleAttemptPassed(event({ enrollmentId: null }));

    expect(trackProgress).not.toHaveBeenCalled();
  });

  it('no hace nada si falta lessonId', async () => {
    const trackProgress = vi.fn();
    const bridge = new AssessmentsLearningBridge(
      makeRegistry(trackProgress),
      noopFactory,
      noopLogger,
    );

    await bridge.handleAttemptPassed(event({ lessonId: null }));

    expect(trackProgress).not.toHaveBeenCalled();
  });

  it('idempotente: dos llamadas con el mismo evento → dos llamadas a trackProgress (que es upsert)', async () => {
    const trackProgress = vi.fn().mockResolvedValue({});
    const bridge = new AssessmentsLearningBridge(
      makeRegistry(trackProgress),
      noopFactory,
      noopLogger,
    );

    const e = event();
    await bridge.handleAttemptPassed(e);
    await bridge.handleAttemptPassed(e);

    expect(trackProgress).toHaveBeenCalledTimes(2);
    expect(trackProgress.mock.calls[0]).toEqual(trackProgress.mock.calls[1]);
  });

  it('rethrows si trackProgress falla (para que el outbox reintente)', async () => {
    const trackProgress = vi.fn().mockRejectedValue(new Error('db down'));
    const bridge = new AssessmentsLearningBridge(
      makeRegistry(trackProgress),
      noopFactory,
      noopLogger,
    );

    await expect(bridge.handleAttemptPassed(event())).rejects.toThrow('db down');
  });

  it('respeta el tenantId del metadata del evento (no del data)', async () => {
    const trackProgress = vi.fn().mockResolvedValue({});
    const bridge = new AssessmentsLearningBridge(
      makeRegistry(trackProgress),
      noopFactory,
      noopLogger,
    );

    const e = event();
    e.metadata.tenantId = 'tenant-otro';
    await bridge.handleAttemptPassed(e);

    expect(trackProgress).toHaveBeenCalledWith(
      'tenant-otro',
      expect.any(String),
      expect.any(Object),
    );
  });
});

describe('AssessmentsLearningBridge.onModuleInit', () => {
  it('se suscribe a assessments.attempt.passed exactamente una vez', () => {
    const subscribe = vi.fn().mockReturnValue(() => {});
    const factory = { getEventBus: () => ({ subscribe }) } as never;
    const bridge = new AssessmentsLearningBridge(makeRegistry(vi.fn()), factory, noopLogger);

    bridge.onModuleInit();

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith('assessments.attempt.passed', expect.any(Function));
  });
});
