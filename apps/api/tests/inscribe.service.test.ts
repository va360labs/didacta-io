/**
 * Tests de `InscribeService` (inscripción externa por API).
 *
 * Cubre:
 *  - Alta: usuario nuevo ACTIVO + rol alumno, SIN contraseña temporal — recibe
 *    un email con enlace mágico "define tu contraseña" (TTL largo) para entrar
 *    una sola vez y caer en el onboarding.
 *  - Usuario existente: no se recrea ni se envía email; solo se matricula.
 *  - Idempotencia y multi-curso tolerante a fallos.
 *  - Baja (reembolso/cancelación): revoca solo matrículas de origen API,
 *    idempotente y tolerante a email inexistente.
 *  - Listado de cursos con estado, para mapear producto externo → curso.
 */

import { describe, expect, it, vi } from 'vitest';
import { AlreadyEnrolledError, CourseNotPublishedError } from '@didacta/mod-learning';
import { InscribeService } from '../src/enrollment/inscribe.service';

const TENANT_ID = 't1';
const ACTOR_ID = 'apikey-user';
const WEB_BASE_URL = 'http://test.local';
const COURSE_A = '11111111-1111-1111-1111-111111111111';
const COURSE_B = '22222222-2222-2222-2222-222222222222';
/** 7 días en minutos: TTL del enlace "define tu contraseña". */
const SET_PASSWORD_TTL = 7 * 24 * 60;

function makeHarness(opts: {
  existingUser?: { id: string } | null;
  enrollImpl?: (tenantId: string, userId: string, courseId: string) => Promise<{ id: string }>;
  existingEnrollment?: { id: string } | null;
  smtpResolved?: boolean;
  unenrollCount?: number;
  courses?: Array<Record<string, unknown>>;
  resetToken?: string | null;
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
    modThemingTenantTheme: {
      findUnique: vi.fn().mockResolvedValue({ logoUrl: null, brandHue: 213, brandSaturation: 70 }),
    },
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
    unenrollFromApi: vi.fn(async () => opts.unenrollCount ?? 1),
  };
  const coursesService = {
    listCourses: vi.fn(async () => opts.courses ?? []),
  };
  const registry = {
    getLearningService: () => learning,
    getCoursesService: () => coursesService,
  } as never;

  const smtp = { send: vi.fn().mockResolvedValue({ ok: true }) };
  const smtpResolver = {
    resolve: vi.fn().mockResolvedValue(
      opts.smtpResolved === false
        ? null
        : {
            config: { host: 'h', port: 587, user: 'u', password: 'p', from: 'f@x' },
            source: 'global',
            verified: false,
          },
    ),
  } as never;
  const passwordReset = {
    request: vi.fn(async () =>
      opts.resetToken === null
        ? null
        : {
            rawToken: opts.resetToken ?? 'tok-123',
            userId: 'new-user',
            userName: 'Ana',
            tenantId: TENANT_ID,
            tenantName: 'VA360 Academy',
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
    passwordReset,
    logger,
  );
  return {
    service,
    prisma,
    passwords,
    learning,
    coursesService,
    smtp,
    passwordReset,
    txUser,
    txUserRole,
  };
}

describe('InscribeService.inscribe', () => {
  it('crea el usuario ACTIVO con rol alumno y le manda el enlace mágico (sin contraseña temporal)', async () => {
    const h = makeHarness({ existingUser: null });

    const result = await h.service.inscribe(
      TENANT_ID,
      ACTOR_ID,
      { email: 'ana@x.com', name: 'Ana', courseIds: [COURSE_A] },
      WEB_BASE_URL,
    );

    expect(result.userCreated).toBe(true);
    expect(result.userId).toBe('new-user');
    const createArg = h.txUser.create.mock.calls[0][0].data;
    expect(createArg.status).toBe('ACTIVE');
    // Ya NO se fuerza el cambio: el comprador elige su contraseña en el enlace,
    // así entra una sola vez y va directo al onboarding.
    expect(createArg.mustChangePassword).toBe(false);
    expect(createArg.passwordHash).toBe('argon2-hash');
    expect(h.txUserRole.create).toHaveBeenCalledTimes(1);
    expect(result.enrollments[0]).toMatchObject({
      courseId: COURSE_A,
      status: 'ACTIVE',
      alreadyEnrolled: false,
    });
    expect(h.smtp.send).toHaveBeenCalledTimes(1);
  });

  it('el email lleva el enlace de define-contraseña con TTL largo y sin contraseña en claro', async () => {
    const h = makeHarness({ existingUser: null, resetToken: 'tok-abc' });

    await h.service.inscribe(
      TENANT_ID,
      ACTOR_ID,
      { email: 'ana@x.com', name: 'Ana', courseIds: [COURSE_A] },
      WEB_BASE_URL,
    );

    // Token emitido para ESE tenant y con TTL de 7 días.
    expect(h.passwordReset.request).toHaveBeenCalledWith(
      { email: 'ana@x.com', resolvedTenantId: TENANT_ID },
      expect.anything(),
      { ttlMinutes: SET_PASSWORD_TTL },
    );
    const message = h.smtp.send.mock.calls[0][1] as { html: string; text: string };
    expect(message.html).toContain(`${WEB_BASE_URL}/reset-password?token=tok-abc`);
    expect(message.html).toContain('Define tu contraseña');
    // No se filtra ninguna contraseña generada.
    expect(message.text).not.toContain('argon2-hash');
    expect(message.text).not.toMatch(/Contraseña temporal/i);
  });

  it('si no se puede emitir el token, no manda email pero la matrícula queda hecha', async () => {
    const h = makeHarness({ existingUser: null, resetToken: null });

    const result = await h.service.inscribe(
      TENANT_ID,
      ACTOR_ID,
      { email: 'ana@x.com', courseIds: [COURSE_A] },
      WEB_BASE_URL,
    );

    expect(result.enrollments[0]).toMatchObject({ courseId: COURSE_A, status: 'ACTIVE' });
    expect(h.smtp.send).not.toHaveBeenCalled();
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

describe('InscribeService.revoke (reembolso / cancelación)', () => {
  it('revoca la matrícula del comprador en los cursos indicados', async () => {
    const h = makeHarness({ existingUser: { id: 'u-1' }, unenrollCount: 1 });

    const res = await h.service.revoke(TENANT_ID, ACTOR_ID, {
      email: 'ana@x.com',
      courseIds: [COURSE_A, COURSE_B],
      externalRef: 'wc_refund_1',
      reason: 'refund',
    });

    expect(res).toMatchObject({ userFound: true, userId: 'u-1' });
    expect(res.revoked).toEqual([
      { courseId: COURSE_A, status: 'REVOKED' },
      { courseId: COURSE_B, status: 'REVOKED' },
    ]);
    // Solo toca matrículas de origen API (lo garantiza unenrollFromApi).
    expect(h.learning.unenrollFromApi).toHaveBeenCalledTimes(2);
    expect(h.learning.unenrollFromApi).toHaveBeenCalledWith(TENANT_ID, 'u-1', COURSE_A);
  });

  it('idempotente: sin matrícula viva por API reporta NOT_ENROLLED (reintento del webhook)', async () => {
    const h = makeHarness({ existingUser: { id: 'u-1' }, unenrollCount: 0 });

    const res = await h.service.revoke(TENANT_ID, ACTOR_ID, {
      email: 'ana@x.com',
      courseIds: [COURSE_A],
    });

    expect(res.revoked).toEqual([{ courseId: COURSE_A, status: 'NOT_ENROLLED' }]);
  });

  it('email inexistente: userFound=false sin lanzar (no 404) y sin tocar matrículas', async () => {
    const h = makeHarness({ existingUser: null });

    const res = await h.service.revoke(TENANT_ID, ACTOR_ID, {
      email: 'nadie@x.com',
      courseIds: [COURSE_A],
    });

    expect(res).toMatchObject({ userFound: false, userId: null });
    expect(res.revoked).toEqual([{ courseId: COURSE_A, status: 'NOT_ENROLLED' }]);
    expect(h.learning.unenrollFromApi).not.toHaveBeenCalled();
  });
});

describe('InscribeService.listCourses', () => {
  it('devuelve los cursos con su estado (incluye no publicados) para mapear productos', async () => {
    const publishedAt = new Date('2026-05-01T10:00:00.000Z');
    const h = makeHarness({
      courses: [
        {
          id: COURSE_A,
          title: 'Curso A',
          slug: 'curso-a',
          status: 'PUBLISHED',
          category: 'Marketing',
          publishedAt,
        },
        {
          id: COURSE_B,
          title: 'Curso B',
          slug: 'curso-b',
          status: 'DRAFT',
          category: null,
          publishedAt: null,
        },
      ],
    });

    const courses = await h.service.listCourses(TENANT_ID);

    expect(courses).toEqual([
      {
        id: COURSE_A,
        title: 'Curso A',
        slug: 'curso-a',
        status: 'PUBLISHED',
        category: 'Marketing',
        publishedAt: publishedAt.toISOString(),
      },
      {
        id: COURSE_B,
        title: 'Curso B',
        slug: 'curso-b',
        status: 'DRAFT',
        category: null,
        publishedAt: null,
      },
    ]);
    expect(h.coursesService.listCourses).toHaveBeenCalledWith(TENANT_ID);
  });
});
