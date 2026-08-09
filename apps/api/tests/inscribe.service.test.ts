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
  groupAdded?: number;
  groupRevoked?: boolean;
  groupThrows?: boolean;
  groups?: Array<Record<string, unknown>>;
}) {
  const txUser = { create: vi.fn().mockResolvedValue({ id: 'new-user' }) };
  const txUserRole = { create: vi.fn().mockResolvedValue({}) };
  const tx = { user: txUser, userRole: txUserRole };

  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue(opts.existingUser ?? null),
    },
    role: { findUnique: vi.fn().mockResolvedValue({ id: 'role-alumno', name: 'alumno' }) },
    tenant: { findUnique: vi.fn().mockResolvedValue({ name: 'Academia Demo' }) },
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
            tenantName: 'Academia Demo',
          },
    ),
  } as never;
  const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

  const accessGroupsSvc = {
    assignMembers: vi.fn(async () => {
      if (opts.groupThrows) throw new Error('Grupo de acceso no encontrado');
      return { assigned: 1, added: opts.groupAdded ?? 1 };
    }),
    revokeMember: vi.fn(async () => {
      if (opts.groupThrows) throw new Error('Grupo de acceso no encontrado');
      return { revoked: opts.groupRevoked ?? true };
    }),
    listGroups: vi.fn(async () => ({
      groups: opts.groups ?? [],
      total: (opts.groups ?? []).length,
    })),
  };

  const service = new InscribeService(
    prisma,
    passwords,
    auditLog,
    registry,
    smtpResolver,
    smtp as never,
    passwordReset,
    accessGroupsSvc as never,
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
    accessGroupsSvc,
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

  // ── Idioma del comprador ───────────────────────────────────────────────────
  // El bug: el cuerpo del correo se traducía pero el botón «Define tu
  // contraseña» seguía en español porque es una parte estructural del email.

  it('locale=en-US: asunto, cuerpo y BOTÓN del email de alta en inglés', async () => {
    const h = makeHarness({ existingUser: null, resetToken: 'tok-abc' });

    await h.service.inscribe(
      TENANT_ID,
      ACTOR_ID,
      { email: 'john@x.com', name: 'John', courseIds: [COURSE_A], locale: 'en-US' },
      WEB_BASE_URL,
    );

    const message = h.smtp.send.mock.calls[0][1] as {
      subject: string;
      html: string;
      text: string;
    };
    expect(message.subject).toBe('Your access to Academia Demo');
    expect(message.text).toContain('Hi John,');
    expect(message.text).toContain('Your account at Academia Demo has been created');
    expect(message.text).toContain(`Set your password: ${WEB_BASE_URL}/reset-password?token=`);
    expect(message.html).toContain('Set your password');
    for (const spanish of ['Define tu contraseña', 'Hola John', 'Se ha creado tu cuenta']) {
      expect(message.text, `«${spanish}» se coló en el email inglés`).not.toContain(spanish);
      expect(message.html, `«${spanish}» se coló en el HTML inglés`).not.toContain(spanish);
    }
  });

  it('CAMINO DEGRADADO: sin locale en el alta, o con uno sin traducir, sale español', async () => {
    for (const locale of [undefined, 'pt-BR', 'es-AR']) {
      const h = makeHarness({ existingUser: null, resetToken: 'tok-abc' });
      await h.service.inscribe(
        TENANT_ID,
        ACTOR_ID,
        { email: 'ana@x.com', name: 'Ana', courseIds: [COURSE_A], ...(locale ? { locale } : {}) },
        WEB_BASE_URL,
      );
      const message = h.smtp.send.mock.calls[0][1] as { subject: string; text: string };
      expect(message.subject, String(locale)).toBe('Tu acceso a Academia Demo');
      expect(message.text, String(locale)).toContain('Hola Ana,');
      expect(message.text, String(locale)).toContain('Define tu contraseña:');
    }
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

describe('InscribeService — grupos de acceso (permisos que dan visibilidad a los cursos)', () => {
  const GROUP_A = '33333333-3333-3333-3333-333333333333';

  it('el alta asigna el grupo de acceso (que otorga sus cursos) además de matricular', async () => {
    const h = makeHarness({ existingUser: { id: 'u-1' }, groupAdded: 1 });

    const res = await h.service.inscribe(
      TENANT_ID,
      ACTOR_ID,
      { email: 'ana@x.com', courseIds: [COURSE_A], accessGroupIds: [GROUP_A] },
      WEB_BASE_URL,
    );

    expect(h.accessGroupsSvc.assignMembers).toHaveBeenCalledWith(TENANT_ID, GROUP_A, ['u-1']);
    expect(res.accessGroups).toEqual([{ groupId: GROUP_A, status: 'ASSIGNED' }]);
    expect(res.enrollments[0]).toMatchObject({ courseId: COURSE_A, status: 'ACTIVE' });
  });

  it('alta SOLO con grupo (sin courseIds): el grupo es quien da el acceso', async () => {
    const h = makeHarness({ existingUser: { id: 'u-1' } });

    const res = await h.service.inscribe(
      TENANT_ID,
      ACTOR_ID,
      { email: 'ana@x.com', accessGroupIds: [GROUP_A] },
      WEB_BASE_URL,
    );

    expect(res.enrollments).toEqual([]);
    expect(res.accessGroups).toEqual([{ groupId: GROUP_A, status: 'ASSIGNED' }]);
  });

  it('si ya era miembro del grupo lo reporta como ALREADY_MEMBER (idempotente)', async () => {
    const h = makeHarness({ existingUser: { id: 'u-1' }, groupAdded: 0 });

    const res = await h.service.inscribe(
      TENANT_ID,
      ACTOR_ID,
      { email: 'ana@x.com', accessGroupIds: [GROUP_A] },
      WEB_BASE_URL,
    );

    expect(res.accessGroups).toEqual([{ groupId: GROUP_A, status: 'ALREADY_MEMBER' }]);
  });

  it('un grupo inválido se reporta FAILED sin romper la matrícula de los cursos', async () => {
    const h = makeHarness({ existingUser: { id: 'u-1' }, groupThrows: true });

    const res = await h.service.inscribe(
      TENANT_ID,
      ACTOR_ID,
      { email: 'ana@x.com', courseIds: [COURSE_A], accessGroupIds: [GROUP_A] },
      WEB_BASE_URL,
    );

    expect(res.enrollments[0]).toMatchObject({ courseId: COURSE_A, status: 'ACTIVE' });
    expect(res.accessGroups[0]).toMatchObject({ groupId: GROUP_A, status: 'FAILED' });
    expect(res.accessGroups[0]?.error).toContain('no encontrado');
  });

  it('la baja retira el grupo (revoca grants y desmatricula por refcount)', async () => {
    const h = makeHarness({ existingUser: { id: 'u-1' }, groupRevoked: true });

    const res = await h.service.revoke(TENANT_ID, ACTOR_ID, {
      email: 'ana@x.com',
      accessGroupIds: [GROUP_A],
      reason: 'refund',
    });

    expect(h.accessGroupsSvc.revokeMember).toHaveBeenCalledWith(TENANT_ID, GROUP_A, 'u-1');
    expect(res.accessGroups).toEqual([{ groupId: GROUP_A, status: 'REVOKED' }]);
  });

  it('baja idempotente: si ya no era miembro → NOT_MEMBER', async () => {
    const h = makeHarness({ existingUser: { id: 'u-1' }, groupRevoked: false });

    const res = await h.service.revoke(TENANT_ID, ACTOR_ID, {
      email: 'ana@x.com',
      accessGroupIds: [GROUP_A],
    });

    expect(res.accessGroups).toEqual([{ groupId: GROUP_A, status: 'NOT_MEMBER' }]);
  });

  it('listAccessGroups mapea id, nombre, kind y nº de cursos que otorga', async () => {
    const h = makeHarness({
      groups: [
        { id: GROUP_A, name: 'Pack Marketing', kind: 'MULTI_COURSE', courseCount: 3 },
        { id: 'g2', name: 'Todo el catálogo', kind: 'ALL_COURSES', courseCount: null },
      ],
    });

    const groups = await h.service.listAccessGroups(TENANT_ID);

    expect(groups).toEqual([
      { id: GROUP_A, name: 'Pack Marketing', kind: 'MULTI_COURSE', courseCount: 3 },
      { id: 'g2', name: 'Todo el catálogo', kind: 'ALL_COURSES', courseCount: 0 },
    ]);
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
