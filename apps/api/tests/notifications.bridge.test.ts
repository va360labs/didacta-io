import { describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '@didacta/core-kernel';
import { NotificationsBridge } from '../src/modules/notifications.bridge';

const noopLogger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as never;

function setup() {
  const subs = new Map<string, (event: DomainEvent<unknown>) => Promise<void>>();
  const sendCalls: Array<Record<string, unknown>> = [];

  const eventBus = {
    subscribe: vi.fn((name: string, handler: (event: DomainEvent<unknown>) => Promise<void>) => {
      subs.set(name, handler);
      return () => subs.delete(name);
    }),
    publish: vi.fn(),
  };

  const hub = {
    send: vi.fn(async (notification: Record<string, unknown>) => {
      sendCalls.push(notification);
    }),
  };

  const factory = {
    getEventBus: () => eventBus,
    getNotificationHub: () => hub,
  } as never;

  // Stub de PrismaService: devolvemos un título reconocible para que los
  // tests verifiquen el lookup curso → título sin tocar la DB real.
  const prismaStub = {
    modCoursesCourse: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
        title: `Curso de prueba (${where.id})`,
      })),
    },
  } as never;

  const bridge = new NotificationsBridge(factory, prismaStub, noopLogger);
  bridge.onModuleInit();

  return { bridge, eventBus, hub, sendCalls, subs };
}

const event = <T>(name: string, data: T, tenantId = 't1'): DomainEvent<T> => ({
  name,
  version: 1,
  data,
  metadata: {
    tenantId,
    timestamp: new Date().toISOString(),
    traceId: 'trace-1',
    idempotencyKey: 'idem-1',
  },
});

describe('NotificationsBridge.onModuleInit', () => {
  it('registra subscribers para los 6 eventos clave', () => {
    const { eventBus } = setup();
    expect(eventBus.subscribe).toHaveBeenCalledTimes(6);
    const names = eventBus.subscribe.mock.calls.map((c) => c[0]);
    expect(names).toEqual(
      expect.arrayContaining([
        'learning.enrollment.created',
        'learning.course.completed',
        'certificates.issued',
        'assessments.attempt.passed',
        'assessments.attempt.failed',
        'assessments.attempt.graded',
      ]),
    );
  });
});

describe('NotificationsBridge handlers', () => {
  it('learning.enrollment.created → hub.send con templateKey enrollment.created y to=userId', async () => {
    const { subs, sendCalls } = setup();
    await subs.get('learning.enrollment.created')!(
      event('learning.enrollment.created', {
        userId: 'u1',
        courseId: 'c1',
        enrollmentId: 'e1',
      }),
    );
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toMatchObject({
      tenantId: 't1',
      channel: 'in-app',
      templateKey: 'enrollment.created',
      to: 'u1',
    });
  });

  it('certificates.issued → templateKey certificate.issued con number en variables', async () => {
    const { subs, sendCalls } = setup();
    await subs.get('certificates.issued')!(
      event('certificates.issued', { userId: 'u1', courseId: 'c1', number: 'LS-2026-000042' }),
    );
    expect(sendCalls[0]).toMatchObject({
      templateKey: 'certificate.issued',
      variables: expect.objectContaining({ number: 'LS-2026-000042' }),
    });
  });

  it('assessments.attempt.passed → templateKey attempt.passed con scorePercent', async () => {
    const { subs, sendCalls } = setup();
    await subs.get('assessments.attempt.passed')!(
      event('assessments.attempt.passed', {
        userId: 'u1',
        quizId: 'q1',
        scorePercent: 80,
        passed: true,
      }),
    );
    expect(sendCalls[0]).toMatchObject({
      templateKey: 'attempt.passed',
      variables: expect.objectContaining({ scorePercent: 80 }),
    });
  });

  it('assessments.attempt.failed → templateKey attempt.failed', async () => {
    const { subs, sendCalls } = setup();
    await subs.get('assessments.attempt.failed')!(
      event('assessments.attempt.failed', {
        userId: 'u1',
        quizId: 'q1',
        scorePercent: 30,
        passed: false,
      }),
    );
    expect(sendCalls[0]?.templateKey).toBe('attempt.failed');
  });

  it('assessments.attempt.graded → templateKey attempt.graded con result derivado de passed', async () => {
    const { subs, sendCalls } = setup();
    await subs.get('assessments.attempt.graded')!(
      event('assessments.attempt.graded', {
        userId: 'u1',
        quizId: 'q1',
        scorePercent: 75,
        passed: true,
      }),
    );
    expect(sendCalls[0]).toMatchObject({
      templateKey: 'attempt.graded',
      variables: expect.objectContaining({ result: 'aprobado' }),
    });

    await subs.get('assessments.attempt.graded')!(
      event('assessments.attempt.graded', {
        userId: 'u1',
        quizId: 'q1',
        scorePercent: 30,
        passed: false,
      }),
    );
    expect(sendCalls[1]?.variables).toMatchObject({ result: 'no aprobado' });
  });

  it('respeta el tenantId del metadata del evento', async () => {
    const { subs, sendCalls } = setup();
    await subs.get('learning.course.completed')!(
      event(
        'learning.course.completed',
        { userId: 'u1', courseId: 'c1', enrollmentId: 'e1' },
        'tenant-otro',
      ),
    );
    expect(sendCalls[0]?.tenantId).toBe('tenant-otro');
  });
});
