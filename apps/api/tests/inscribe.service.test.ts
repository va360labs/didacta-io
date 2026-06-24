/**
 * Tests de `InscribeService` (POST /api/v1/inscribe — inscripción externa por API).
 *
 * Cubre:
 *  - Usuario nuevo: se crea ACTIVO + mustChangePassword + rol alumno, se matricula
 *    y se envía email de bienvenida con la contraseña temporal.
 *  - Usuario existente: no se recrea ni se envía email; solo se matricula.
 *  - Idempotencia: si ya estaba matriculado (AlreadyEnrolledError), se reporta
 *    alreadyEnrolled=true con el enrollment vigente.
 *  - Multi-curso tolerante a fallos: un curso no publicado falla sin romper el resto.
 */

import { describe, expect, it, vi } from 'vitest';
import { AlreadyEnrolledError, CourseNotPublishedError } from '@didacta/mod-learning';
import { InscribeService } from '../src/enrollment/inscribe.service';

const TENANT_ID = 't1';
const ACTOR_ID = 'apikey-user';
const WEB_BASE_URL = 'http://test.local';
const COURSE_A = '11111111-1111-1111-1111-111111111111';
const COURSE_B = '22222222-2222-2222-2222-222222222222';

function makeHarness(opts: {
  existingUser?: { id: string } | null;
  enrollImpl?: (tenantId: string, userId: string, courseId: string) => Promise<{ id: string }>;
  existingEnrollment?: { id: string } | null;
  smtpResolved?: boolean;
}) {
  const txUser = { create: vi.fn().mockResolvedValue({ id: 'new-user' }) };
  const txUserRole = { create: vi.fn().mockResolvedValue({}) };
  const tx = { user: txUser, userRole: txUserRole };

  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue(opts.existingUser ?? null),
    },
    role: { findUnique: vi.fn().mockResolvedValue({ id: 'role-alumno', name: 'alumno' }) },
    tenant: { findUnique: vi.fn().mockResolvedValue({ name: 'VA360 Academy' }) },
    modLearningEnrollment: {
      findFirst: vi.fn().mockResolvedValue(opts.existingEnrollment ?? { id: 'existing-enr' }),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  } as never;

  const passwords = { hash: vi.fn().mockResolvedValue('argon2-hash') } as never;
  const auditLog = { record: vi.fn().mockResolvedValue(undefined) } as never;

  const learning = {
    enrollFromApi:
      opts.enrollImpl ??
      vi.fn(async (_t: string, _u: string, courseId: string) => ({ id: `enr-${courseId}` })),
  };
  const registry = { getLearningService: () => learning } as never;

  const smtp = { send: vi.fn().mockResolvedValue({ ok: true }) };
  const smtpResolver = {
    resolve: vi
      .fn()
      .mockResolvedValue(
        opts.smtpResolved === false
          ? null
          : {
              config: { host: 'h', port: 587, user: 'u', password: 'p', from: 'f@x' },
              source: 'global',
              verified: false,
            },
      ),
  } as never;
  const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

  const service = new InscribeService(
    prisma,
    passwords,
    auditLog,
    registry,
    smtpResolver,
    smtp as never,
    logger,
  );
  return { service, prisma, passwords, learning, smtp, txUser, txUserRole };
}

describe('InscribeService.inscribe', () => {
  it('crea un usuario nuevo ACTIVO con contraseña temporal, rol alumno y le envía email', async () => {
    const h = makeHarness({ existingUser: null });

    const result = await h.service.inscribe(
      TENANT_ID,
      ACTOR_ID,
      { email: 'ana@x.com', name: 'Ana', courseIds: [COURSE_A] },
      WEB_BASE_URL,
    );

    expect(result.userCreated).toBe(true);
    expect(result.userId).toBe('new-user');
    // user.create con status ACTIVE + mustChangePassword + passwordHash
    const createArg = h.txUser.create.mock.calls[0][0].data;
    expect(createArg.status).toBe('ACTIVE');
    expect(createArg.mustChangePassword).toBe(true);
    expect(createArg.passwordHash).toBe('argon2-hash');
    // rol alumno asignado
    expect(h.txUserRole.create).toHaveBeenCalledTimes(1);
    // matriculado en el curso
    expect(result.enrollments[0]).toMatchObject({
      courseId: COURSE_A,
      status: 'ACTIVE',
      alreadyEnrolled: false,
    });
    // email de bienvenida enviado
    expect(h.smtp.send).toHaveBeenCalledTimes(1);
  });

  it('usuario existente: no lo recrea ni envía email, solo matricula', async () => {
    const h = makeHarness({ existingUser: { id: 'user-existing' } });

    const result = await h.service.inscribe(
      TENANT_ID,
      ACTOR_ID,
      { email: 'ya@x.com', courseIds: [COURSE_A] },
      WEB_BASE_URL,
    );

    expect(result.userCreated).toBe(false);
    expect(result.userId).toBe('user-existing');
    expect(h.txUser.create).not.toHaveBeenCalled();
    expect(h.smtp.send).not.toHaveBeenCalled();
    expect(result.enrollments[0]).toMatchObject({ courseId: COURSE_A, status: 'ACTIVE' });
  });

  it('idempotente: si ya estaba matriculado reporta alreadyEnrolled con el enrollment vigente', async () => {
    const h = makeHarness({
      existingUser: { id: 'u' },
      enrollImpl: vi.fn(async () => {
        throw new AlreadyEnrolledError();
      }),
      existingEnrollment: { id: 'enr-previo' },
    });

    const result = await h.service.inscribe(
      TENANT_ID,
      ACTOR_ID,
      { email: 'ya@x.com', courseIds: [COURSE_A] },
      WEB_BASE_URL,
    );

    expect(result.enrollments[0]).toMatchObject({
      courseId: COURSE_A,
      status: 'ACTIVE',
      alreadyEnrolled: true,
      enrollmentId: 'enr-previo',
    });
  });

  it('multi-curso: un curso no publicado falla sin romper la matrícula del resto', async () => {
    const enrollImpl = vi.fn(async (_t: string, _u: string, courseId: string) => {
      if (courseId === COURSE_B) throw new CourseNotPublishedError();
      return { id: `enr-${courseId}` };
    });
    const h = makeHarness({ existingUser: { id: 'u' }, enrollImpl });

    const result = await h.service.inscribe(
      TENANT_ID,
      ACTOR_ID,
      { email: 'ya@x.com', courseIds: [COURSE_A, COURSE_B] },
      WEB_BASE_URL,
    );

    expect(result.enrollments).toHaveLength(2);
    expect(result.enrollments[0]).toMatchObject({ courseId: COURSE_A, status: 'ACTIVE' });
    expect(result.enrollments[1]).toMatchObject({
      courseId: COURSE_B,
      status: 'FAILED',
      error: 'COURSE_NOT_PUBLISHED',
    });
  });
});
