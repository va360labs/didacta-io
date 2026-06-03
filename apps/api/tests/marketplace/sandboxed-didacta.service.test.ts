import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AlreadyEnrolledError,
  CourseNotPublishedError,
  EnrollmentNotFoundError,
} from '@didacta/mod-learning';
import {
  CourseAlreadyPublishedError,
  CourseNotFoundError,
  CourseSlugAlreadyExistsError,
} from '@didacta/mod-courses';
import { QuizNotFoundError } from '@didacta/mod-assessments';
import {
  buildStorageKey,
  mapCoreError,
  ScopedDidactaApiFactory,
  sha256Hex,
  type CoreServicesResolver,
} from '../../src/marketplace/sandboxed-didacta.service';
import { DidactaError } from '../../src/marketplace/sandboxed-didacta.types';
import type { ModuleDidactaConfig } from '../../src/marketplace/module-manifest.schema';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { TenantContextService } from '../../src/tenancy/tenant-context.service';
import type { AdminUsersService } from '../../src/admin/admin-users.service';
import type { CoursesService } from '@didacta/mod-courses';
import type { LearningService } from '@didacta/mod-learning';
import type { AssessmentsService } from '@didacta/mod-assessments';

/// Tests del ScopedDidactaApiFactory + ScopedDidactaApi (DD-002).
///
/// Estrategia: mocks puros (sin Postgres real). Para cada caso construimos
/// el cliente vía `factory.build(moduleId, manifestDidactaConfig, resolver)`
/// donde `resolver` devuelve los services del core mockeados. Los lookups
/// directos a Prisma (lookup por externalRef antes de delegar) se interceptan
/// con un `prisma.<entidad>.findFirst.mockResolvedValueOnce(...)`.
///
/// Capas defensivas (en orden, fail-fast):
///  1. Permission check → DIDACTA_PERMISSION_DENIED
///  2. Tenant context → DIDACTA_NO_TENANT_CONTEXT
///  3. Validación Zod → DIDACTA_VALIDATION_ERROR
///  4. Lookup externalRef + delegación al service del core
///  5. Error mapping → DIDACTA_NOT_FOUND / CONFLICT / FOREIGN_REFERENCE / etc.

const MODULE_ID = 'mod.test-migrator';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const TRACE_ID = 'trace-1';

const FULL_PERMISSIONS_CONFIG: ModuleDidactaConfig = {
  externalSource: 'learndash',
  permissions: [
    'users.upsertByExternalRef',
    'users.findByExternalRef',
    'users.deleteByExternalRef',
    'courses.create',
    'courses.upsertByExternalRef',
    'courses.findByExternalRef',
    'courses.publish',
    'courses.deleteByExternalRef',
    'modules.upsertByExternalRef',
    'modules.findByExternalRef',
    'modules.deleteByExternalRef',
    'lessons.upsertByExternalRef',
    'lessons.findByExternalRef',
    'lessons.deleteByExternalRef',
    'quizzes.upsertByExternalRef',
    'quizzes.findByExternalRef',
    'quizzes.deleteByExternalRef',
    'enrollments.upsertByExternalRef',
    'enrollments.findByExternalRef',
    'enrollments.deleteByExternalRef',
    'media.uploadFromUrl',
    'media.uploadFromBytes',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Mocks de servicios y Prisma
// ─────────────────────────────────────────────────────────────────────────────

interface PrismaMock {
  user: {
    findFirst: ReturnType<typeof vi.fn>;
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  modCoursesCourse: {
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  modCoursesModule: {
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  modCoursesLesson: {
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  modAssessmentsQuiz: {
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  modLearningEnrollment: {
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

function makePrismaMock(): PrismaMock {
  return {
    user: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    modCoursesCourse: {
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
    },
    modCoursesModule: {
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
    },
    modCoursesLesson: {
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
    },
    modAssessmentsQuiz: {
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
    },
    modLearningEnrollment: {
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
    },
  };
}

function makeTenantContextMock(
  ctx: { tenantId?: string; userId?: string; traceId?: string } | null = {},
): TenantContextService {
  return {
    require: vi.fn(() => {
      if (ctx === null) {
        throw new Error('TenantContext no disponible.');
      }
      return {
        tenantId: ctx.tenantId ?? TENANT_ID,
        userId: ctx.userId ?? USER_ID,
        traceId: ctx.traceId ?? TRACE_ID,
      };
    }),
    get: vi.fn(),
    run: vi.fn(),
  } as unknown as TenantContextService;
}

interface MockServices {
  courses: {
    createCourse: ReturnType<typeof vi.fn>;
    updateCourse: ReturnType<typeof vi.fn>;
    publishCourse: ReturnType<typeof vi.fn>;
    createModule: ReturnType<typeof vi.fn>;
    createLesson: ReturnType<typeof vi.fn>;
    moveLessonToModule: ReturnType<typeof vi.fn>;
  };
  learning: {
    enrollByAdmin: ReturnType<typeof vi.fn>;
  };
  assessments: {
    createQuiz: ReturnType<typeof vi.fn>;
    updateQuiz: ReturnType<typeof vi.fn>;
  };
  adminUsers: {
    invite: ReturnType<typeof vi.fn>;
  };
  storage: {
    upload: ReturnType<typeof vi.fn>;
    download: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getSignedUrl: ReturnType<typeof vi.fn>;
  };
}

function makeServiceMocks(): MockServices {
  return {
    courses: {
      createCourse: vi.fn(),
      updateCourse: vi.fn(),
      publishCourse: vi.fn(),
      createModule: vi.fn(),
      createLesson: vi.fn(),
      moveLessonToModule: vi.fn().mockResolvedValue(undefined),
    },
    learning: {
      enrollByAdmin: vi.fn(),
    },
    assessments: {
      createQuiz: vi.fn(),
      updateQuiz: vi.fn(),
    },
    adminUsers: {
      invite: vi.fn(),
    },
    storage: {
      upload: vi.fn().mockResolvedValue({ key: 'ok' }),
      download: vi.fn(),
      delete: vi.fn(),
      getSignedUrl: vi.fn(),
    },
  };
}

function makeResolver(services: MockServices): CoreServicesResolver {
  return {
    getCoursesService: () => services.courses as unknown as CoursesService,
    getLearningService: () => services.learning as unknown as LearningService,
    getAssessmentsService: () => services.assessments as unknown as AssessmentsService,
    getWebBaseUrl: () => 'http://test.local',
    getStorage: () => services.storage,
  };
}

// Construye un curso "fila Prisma" listo para los mocks. Las dates son Date,
// no string — el toDidactaCourse() las pasa a ISO.
function fakeCourseRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'course-uuid',
    tenantId: TENANT_ID,
    slug: 'curso',
    title: 'Curso',
    description: null,
    language: 'es-ES',
    status: 'DRAFT',
    externalSource: null,
    externalId: null,
    createdAt: new Date('2026-05-06T10:00:00Z'),
    updatedAt: new Date('2026-05-06T10:00:00Z'),
    publishedAt: null,
    ...over,
  };
}

function fakeUserRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'user-uuid',
    tenantId: TENANT_ID,
    email: 'a@b.com',
    name: 'A',
    status: 'PENDING',
    locale: 'es-ES',
    externalSource: null,
    externalId: null,
    createdAt: new Date('2026-05-06T10:00:00Z'),
    updatedAt: new Date('2026-05-06T10:00:00Z'),
    ...over,
  };
}

function fakeCourseModuleRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'cm-uuid',
    tenantId: TENANT_ID,
    courseId: 'course-uuid',
    title: 'Sec',
    description: null,
    position: 0,
    externalSource: null,
    externalId: null,
    createdAt: new Date('2026-05-06T10:00:00Z'),
    updatedAt: new Date('2026-05-06T10:00:00Z'),
    ...over,
  };
}

function fakeLessonRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'lesson-uuid',
    tenantId: TENANT_ID,
    moduleId: 'cm-uuid',
    type: 'TEXT',
    title: 'Lec',
    position: 0,
    content: { text: 'hola' },
    durationMinutes: null,
    externalSource: null,
    externalId: null,
    createdAt: new Date('2026-05-06T10:00:00Z'),
    updatedAt: new Date('2026-05-06T10:00:00Z'),
    ...over,
  };
}

function fakeQuizRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'quiz-uuid',
    tenantId: TENANT_ID,
    lessonId: null,
    title: 'Quiz',
    description: null,
    status: 'DRAFT',
    passThreshold: 60,
    maxAttempts: null,
    timeLimitMinutes: null,
    externalSource: null,
    externalId: null,
    createdAt: new Date('2026-05-06T10:00:00Z'),
    updatedAt: new Date('2026-05-06T10:00:00Z'),
    ...over,
  };
}

function fakeEnrollmentRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'enr-uuid',
    tenantId: TENANT_ID,
    userId: 'user-uuid',
    courseId: 'course-uuid',
    status: 'ACTIVE',
    source: 'ADMIN',
    progressPercent: 0,
    externalSource: null,
    externalId: null,
    enrolledAt: new Date('2026-05-06T10:00:00Z'),
    startedAt: null,
    completedAt: null,
    ...over,
  };
}

interface SetupOpts {
  permissions?: ModuleDidactaConfig['permissions'];
  externalSource?: string;
  noTenantContext?: boolean;
}

function setup(opts: SetupOpts = {}) {
  const prisma = makePrismaMock();
  const services = makeServiceMocks();
  const tenantContext = opts.noTenantContext
    ? makeTenantContextMock(null)
    : makeTenantContextMock();
  const factory = new ScopedDidactaApiFactory(
    prisma as unknown as PrismaService,
    tenantContext,
    services.adminUsers as unknown as AdminUsersService,
  );
  const config: ModuleDidactaConfig = {
    externalSource: opts.externalSource ?? FULL_PERMISSIONS_CONFIG.externalSource,
    permissions: opts.permissions ?? FULL_PERMISSIONS_CONFIG.permissions,
  };
  const api = factory.build(MODULE_ID, config, makeResolver(services));
  return { api, prisma, services, tenantContext, factory };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers puros
// ─────────────────────────────────────────────────────────────────────────────

describe('sha256Hex', () => {
  it('produce digest hex estable de 64 chars', () => {
    const a = sha256Hex(new Uint8Array([1, 2, 3]));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('mismas bytes → mismo hash', () => {
    const a = sha256Hex(new Uint8Array([5, 6, 7]));
    const b = sha256Hex(new Uint8Array([5, 6, 7]));
    expect(a).toBe(b);
  });
  it('bytes diferentes → hash distinto', () => {
    expect(sha256Hex(new Uint8Array([1]))).not.toBe(sha256Hex(new Uint8Array([2])));
  });
});

describe('buildStorageKey', () => {
  it('compone path con el moduleId, tenantId y checksum', () => {
    const key = buildStorageKey('mod.foo', 'tnt-1', 'abc123');
    expect(key).toBe('mod-uploads/mod-foo/tnt-1/abc123');
  });
  it('sanitiza chars no permitidos en moduleId', () => {
    const key = buildStorageKey('mod.foo/bar', 'tnt-1', 'abc');
    expect(key).not.toContain('/bar');
    // Slash interno se reemplaza por guión.
    expect(key.split('/').slice(0, 1)[0]).toBe('mod-uploads');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapCoreError
// ─────────────────────────────────────────────────────────────────────────────

describe('mapCoreError', () => {
  it('CourseSlugAlreadyExistsError → DIDACTA_CONFLICT', () => {
    const err = mapCoreError(new CourseSlugAlreadyExistsError('foo'));
    expect(err.code).toBe('DIDACTA_CONFLICT');
  });
  it('CourseNotFoundError → DIDACTA_NOT_FOUND', () => {
    const err = mapCoreError(new CourseNotFoundError('uuid'));
    expect(err.code).toBe('DIDACTA_NOT_FOUND');
  });
  it('AlreadyEnrolledError → DIDACTA_CONFLICT', () => {
    const err = mapCoreError(new AlreadyEnrolledError());
    expect(err.code).toBe('DIDACTA_CONFLICT');
  });
  it('EnrollmentNotFoundError → DIDACTA_NOT_FOUND', () => {
    const err = mapCoreError(new EnrollmentNotFoundError());
    expect(err.code).toBe('DIDACTA_NOT_FOUND');
  });
  it('QuizNotFoundError → DIDACTA_NOT_FOUND', () => {
    const err = mapCoreError(new QuizNotFoundError());
    expect(err.code).toBe('DIDACTA_NOT_FOUND');
  });
  it('CourseAlreadyPublishedError → DIDACTA_CONFLICT', () => {
    const err = mapCoreError(new CourseAlreadyPublishedError('uuid'));
    expect(err.code).toBe('DIDACTA_CONFLICT');
  });
  it('CourseNotPublishedError → DIDACTA_VALIDATION_ERROR', () => {
    const err = mapCoreError(new CourseNotPublishedError());
    expect(err.code).toBe('DIDACTA_VALIDATION_ERROR');
  });
  it('Nest ConflictException-like (status 409) → DIDACTA_CONFLICT', () => {
    const err = mapCoreError({ status: 409, message: 'Ya existe X' });
    expect(err.code).toBe('DIDACTA_CONFLICT');
  });
  it('Nest NotFoundException-like (status 404) → DIDACTA_NOT_FOUND', () => {
    const err = mapCoreError({ status: 404, message: 'No encontrado' });
    expect(err.code).toBe('DIDACTA_NOT_FOUND');
  });
  it('Nest BadRequestException-like (status 400) → DIDACTA_VALIDATION_ERROR', () => {
    const err = mapCoreError({ status: 400, message: 'Bad request' });
    expect(err.code).toBe('DIDACTA_VALIDATION_ERROR');
  });
  it('Error inesperado genérico → DIDACTA_INTERNAL_ERROR con cause preservado', () => {
    const orig = new Error('boom inesperado');
    const err = mapCoreError(orig);
    expect(err.code).toBe('DIDACTA_INTERNAL_ERROR');
    expect(err.cause).toBe(orig);
  });
  it('preserva DidactaError ya tipado (no doble wrap)', () => {
    const orig = new DidactaError('DIDACTA_QUOTA_EXCEEDED', 'tope');
    const err = mapCoreError(orig);
    expect(err).toBe(orig);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Permission denied
// ─────────────────────────────────────────────────────────────────────────────

describe('permission denied (gate)', () => {
  it('rechaza users.upsertByExternalRef si solo tiene courses.create', async () => {
    const { api } = setup({ permissions: ['courses.create'] });
    await expect(
      api.users.upsertByExternalRef({
        externalSource: 'learndash',
        externalId: '1',
        email: 'a@b.com',
      }),
    ).rejects.toMatchObject({
      name: 'DidactaError',
      code: 'DIDACTA_PERMISSION_DENIED',
    });
  });

  it('mensaje de permission denied es accionable y menciona el método y el moduleId', async () => {
    const { api } = setup({ permissions: ['courses.create'] });
    try {
      await api.users.upsertByExternalRef({
        externalSource: 'learndash',
        externalId: '1',
        email: 'a@b.com',
      });
      expect.fail('esperaba rechazo');
    } catch (err) {
      const msg = (err as DidactaError).message;
      expect(msg).toContain(MODULE_ID);
      expect(msg).toContain('users.upsertByExternalRef');
      expect(msg).toContain('manifest');
      expect(msg).toContain('permissions');
    }
  });

  it('rechaza media.uploadFromBytes si solo tiene courses.create', async () => {
    const { api } = setup({ permissions: ['courses.create'] });
    await expect(
      api.media.uploadFromBytes({
        bytes: new Uint8Array([1]),
        contentType: 'image/png',
      }),
    ).rejects.toMatchObject({ code: 'DIDACTA_PERMISSION_DENIED' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No tenant context
// ─────────────────────────────────────────────────────────────────────────────

describe('no tenant context', () => {
  it('rechaza con DIDACTA_NO_TENANT_CONTEXT cuando ALS no tiene tenant', async () => {
    const { api } = setup({ noTenantContext: true });
    await expect(
      api.users.upsertByExternalRef({
        externalSource: 'learndash',
        externalId: '1',
        email: 'a@b.com',
      }),
    ).rejects.toMatchObject({
      code: 'DIDACTA_NO_TENANT_CONTEXT',
    });
  });

  it('mensaje sugiere envolver con TenantContextService.run', async () => {
    const { api } = setup({ noTenantContext: true });
    try {
      await api.courses.create({ slug: 'foo', title: 'Foo' });
      expect.fail();
    } catch (err) {
      const msg = (err as DidactaError).message;
      expect(msg).toContain('TenantContext');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// External source mismatch (defense-in-depth)
// ─────────────────────────────────────────────────────────────────────────────

describe('externalSource mismatch', () => {
  it('rechaza con DIDACTA_VALIDATION_ERROR si el módulo intenta upsertear con otro source', async () => {
    const { api } = setup({ externalSource: 'learndash' });
    await expect(
      api.users.upsertByExternalRef({
        externalSource: 'moodle', // distinto del declarado
        externalId: '1',
        email: 'a@b.com',
      }),
    ).rejects.toMatchObject({
      code: 'DIDACTA_VALIDATION_ERROR',
      message: expect.stringContaining('externalSource'),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validación Zod
// ─────────────────────────────────────────────────────────────────────────────

describe('validación Zod', () => {
  it('rechaza email inválido con DIDACTA_VALIDATION_ERROR y path en mensaje', async () => {
    const { api } = setup();
    try {
      await api.users.upsertByExternalRef({
        externalSource: 'learndash',
        externalId: '1',
        email: 'no-email',
      });
      expect.fail();
    } catch (err) {
      expect((err as DidactaError).code).toBe('DIDACTA_VALIDATION_ERROR');
      expect((err as DidactaError).message).toContain('email');
    }
  });

  it('rechaza slug inválido en courses.create', async () => {
    const { api } = setup();
    await expect(api.courses.create({ slug: 'NO-SLUG-VALIDO!', title: 'X' })).rejects.toMatchObject(
      { code: 'DIDACTA_VALIDATION_ERROR' },
    );
  });

  it('rechaza externalId fuera de regex', async () => {
    const { api } = setup();
    await expect(
      api.users.findByExternalRef({
        externalSource: 'learndash',
        externalId: 'has space!',
      }),
    ).rejects.toMatchObject({ code: 'DIDACTA_VALIDATION_ERROR' });
  });

  it('rechaza upsertCourseModule sin position', async () => {
    const { api } = setup();
    await expect(
      // @ts-expect-error position falta a propósito
      api.courseModules.upsertByExternalRef({
        externalSource: 'learndash',
        externalId: '1',
        courseExternalRef: { externalSource: 'learndash', externalId: '10' },
        title: 'Sec',
      }),
    ).rejects.toMatchObject({ code: 'DIDACTA_VALIDATION_ERROR' });
  });

  it('rechaza lesson.content > MAX_LESSON_CONTENT_BYTES', async () => {
    const { api } = setup();
    const big = 'x'.repeat(300_000);
    await expect(
      api.lessons.upsertByExternalRef({
        externalSource: 'learndash',
        externalId: '1',
        moduleExternalRef: { externalSource: 'learndash', externalId: '10' },
        type: 'HTML',
        title: 'L',
        position: 0,
        content: { html: big },
      }),
    ).rejects.toMatchObject({
      code: 'DIDACTA_VALIDATION_ERROR',
      message: expect.stringContaining('content'),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// users
// ─────────────────────────────────────────────────────────────────────────────

describe('users.upsertByExternalRef', () => {
  it('happy path: no existe → invite → patch externalRef → devuelve user', async () => {
    const { api, prisma, services } = setup();
    prisma.user.findFirst.mockResolvedValueOnce(null); // lookup inicial
    services.adminUsers.invite.mockResolvedValue({
      id: 'user-uuid',
      email: 'a@b.com',
      name: 'Ana',
      status: 'PENDING',
      roles: ['alumno'],
      mfaEnabled: false,
      emailVerified: false,
      createdAt: '2026-05-06T10:00:00Z',
      lastLoginAt: null,
    });
    prisma.user.findUniqueOrThrow.mockResolvedValue(
      fakeUserRow({
        id: 'user-uuid',
        email: 'a@b.com',
        name: 'Ana',
        externalSource: 'learndash',
        externalId: '99',
      }),
    );

    const result = await api.users.upsertByExternalRef({
      externalSource: 'learndash',
      externalId: '99',
      email: 'a@b.com',
      name: 'Ana',
      role: 'alumno',
    });

    expect(services.adminUsers.invite).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      { email: 'a@b.com', name: 'Ana', role: 'alumno' },
      'http://test.local',
      undefined,
      { sendInvite: true },
    );
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-uuid' },
        data: expect.objectContaining({
          externalSource: 'learndash',
          externalId: '99',
        }),
      }),
    );
    expect(result.email).toBe('a@b.com');
    expect(result.externalSource).toBe('learndash');
    expect(result.externalId).toBe('99');
    expect(result).not.toHaveProperty('passwordHash'); // subset estable
  });

  // ── alpha.81: suppressInvite ──
  it('suppressInvite=true → invita con sendInvite:false (NO envía email)', async () => {
    const { api, prisma, services } = setup();
    prisma.user.findFirst.mockResolvedValueOnce(null); // lookup inicial: no existe
    services.adminUsers.invite.mockResolvedValue({
      id: 'user-uuid',
      email: 'a@b.com',
      name: 'Ana',
      status: 'PENDING',
      roles: ['alumno'],
      mfaEnabled: false,
      emailVerified: false,
      createdAt: '2026-05-06T10:00:00Z',
      lastLoginAt: null,
    });
    prisma.user.findUniqueOrThrow.mockResolvedValue(
      fakeUserRow({
        id: 'user-uuid',
        status: 'PENDING',
        externalSource: 'learndash',
        externalId: '99',
      }),
    );

    const result = await api.users.upsertByExternalRef({
      externalSource: 'learndash',
      externalId: '99',
      email: 'a@b.com',
      name: 'Ana',
      role: 'alumno',
      suppressInvite: true,
    });

    // El migrador delega en invite() pero con sendInvite:false — el service
    // crea el user en PENDING sin disparar passwordReset.requestAndSendEmail.
    expect(services.adminUsers.invite).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      { email: 'a@b.com', name: 'Ana', role: 'alumno' },
      'http://test.local',
      undefined,
      { sendInvite: false },
    );
    // El user igualmente queda creado (PENDING) y con el externalRef parcheado.
    expect(result.status).toBe('PENDING');
    expect(result.externalId).toBe('99');
  });

  it('suppressInvite=false explícito → invita con sendInvite:true (envía email)', async () => {
    const { api, prisma, services } = setup();
    prisma.user.findFirst.mockResolvedValueOnce(null);
    services.adminUsers.invite.mockResolvedValue({
      id: 'user-uuid',
      email: 'a@b.com',
      name: 'Ana',
      status: 'PENDING',
      roles: ['alumno'],
      mfaEnabled: false,
      emailVerified: false,
      createdAt: '2026-05-06T10:00:00Z',
      lastLoginAt: null,
    });
    prisma.user.findUniqueOrThrow.mockResolvedValue(
      fakeUserRow({ id: 'user-uuid', externalSource: 'learndash', externalId: '99' }),
    );

    await api.users.upsertByExternalRef({
      externalSource: 'learndash',
      externalId: '99',
      email: 'a@b.com',
      name: 'Ana',
      suppressInvite: false,
    });

    expect(services.adminUsers.invite).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      expect.objectContaining({ email: 'a@b.com' }),
      'http://test.local',
      undefined,
      { sendInvite: true },
    );
  });

  it('idempotente con suppressInvite: si ya existe por externalRef → NO re-invita ni reenvía', async () => {
    const { api, prisma, services } = setup();
    prisma.user.findFirst.mockResolvedValueOnce(
      fakeUserRow({ externalSource: 'learndash', externalId: '99', email: 'old@b.com' }),
    );

    const result = await api.users.upsertByExternalRef({
      externalSource: 'learndash',
      externalId: '99',
      email: 'new@b.com',
      suppressInvite: true,
    });

    expect(services.adminUsers.invite).not.toHaveBeenCalled();
    expect(result.email).toBe('old@b.com');
  });

  it('idempotente: si ya existe por externalRef → no se invita, devuelve mapeado', async () => {
    const { api, prisma, services } = setup();
    prisma.user.findFirst.mockResolvedValueOnce(
      fakeUserRow({
        externalSource: 'learndash',
        externalId: '99',
        email: 'old@b.com',
      }),
    );

    const result = await api.users.upsertByExternalRef({
      externalSource: 'learndash',
      externalId: '99',
      email: 'new@b.com', // distinto a propósito — NO debería sobrescribir
      role: 'alumno',
    });

    expect(services.adminUsers.invite).not.toHaveBeenCalled();
    expect(result.email).toBe('old@b.com');
  });

  it('error 409 del invite → DIDACTA_CONFLICT', async () => {
    const { api, prisma, services } = setup();
    prisma.user.findFirst.mockResolvedValueOnce(null);
    services.adminUsers.invite.mockRejectedValue({
      status: 409,
      message: 'Ya existe un usuario con ese email en esta organización.',
    });
    await expect(
      api.users.upsertByExternalRef({
        externalSource: 'learndash',
        externalId: '99',
        email: 'a@b.com',
      }),
    ).rejects.toMatchObject({ code: 'DIDACTA_CONFLICT' });
  });
});

describe('users.findByExternalRef', () => {
  it('encontrado → devuelve mapeado', async () => {
    const { api, prisma } = setup();
    prisma.user.findFirst.mockResolvedValueOnce(
      fakeUserRow({ externalSource: 'learndash', externalId: '99' }),
    );
    const result = await api.users.findByExternalRef({
      externalSource: 'learndash',
      externalId: '99',
    });
    expect(result).not.toBeNull();
    expect(result?.email).toBe('a@b.com');
  });

  it('no encontrado → devuelve null', async () => {
    const { api, prisma } = setup();
    prisma.user.findFirst.mockResolvedValueOnce(null);
    const result = await api.users.findByExternalRef({
      externalSource: 'learndash',
      externalId: '999',
    });
    expect(result).toBeNull();
  });
});

describe('users.deleteByExternalRef (STUB DD-005)', () => {
  it('devuelve { deleted: false, resourceId: null } y NO toca prisma de borrado', async () => {
    const { api } = setup();
    const result = await api.users.deleteByExternalRef({
      externalSource: 'learndash',
      externalId: '99',
    });
    expect(result).toEqual({ deleted: false, resourceId: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// courses
// ─────────────────────────────────────────────────────────────────────────────

describe('courses.create', () => {
  it('happy path → invoca CoursesService.createCourse y mapea row', async () => {
    const { api, services } = setup();
    services.courses.createCourse.mockResolvedValue(
      fakeCourseRow({ slug: 'curso-1', title: 'Curso 1' }),
    );

    const result = await api.courses.create({ slug: 'curso-1', title: 'Curso 1' });

    expect(services.courses.createCourse).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      expect.objectContaining({ slug: 'curso-1', title: 'Curso 1', language: 'es-ES' }),
    );
    expect(result.slug).toBe('curso-1');
    expect(result.status).toBe('DRAFT');
  });

  it('CourseSlugAlreadyExistsError del core → DIDACTA_CONFLICT', async () => {
    const { api, services } = setup();
    services.courses.createCourse.mockRejectedValue(new CourseSlugAlreadyExistsError('curso-1'));
    await expect(api.courses.create({ slug: 'curso-1', title: 'X' })).rejects.toMatchObject({
      code: 'DIDACTA_CONFLICT',
    });
  });

  it('error inesperado del core → DIDACTA_INTERNAL_ERROR con cause', async () => {
    const { api, services } = setup();
    const orig = new Error('panic en BD');
    services.courses.createCourse.mockRejectedValue(orig);
    try {
      await api.courses.create({ slug: 'curso-1', title: 'X' });
      expect.fail();
    } catch (err) {
      expect((err as DidactaError).code).toBe('DIDACTA_INTERNAL_ERROR');
      expect((err as DidactaError).cause).toBe(orig);
    }
  });
});

describe('courses.upsertByExternalRef', () => {
  it('no existe → createCourse + patch externalRef', async () => {
    const { api, prisma, services } = setup();
    prisma.modCoursesCourse.findFirst.mockResolvedValueOnce(null);
    services.courses.createCourse.mockResolvedValue(fakeCourseRow({ id: 'course-uuid' }));
    prisma.modCoursesCourse.update.mockResolvedValue(
      fakeCourseRow({
        id: 'course-uuid',
        externalSource: 'learndash',
        externalId: '101',
      }),
    );

    const result = await api.courses.upsertByExternalRef({
      externalSource: 'learndash',
      externalId: '101',
      slug: 'curso-x',
      title: 'Curso X',
    });

    expect(services.courses.createCourse).toHaveBeenCalled();
    expect(services.courses.updateCourse).not.toHaveBeenCalled();
    expect(prisma.modCoursesCourse.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          externalSource: 'learndash',
          externalId: '101',
        }),
      }),
    );
    expect(result.externalId).toBe('101');
  });

  it('ya existe → updateCourse con existing.id (no recrea)', async () => {
    const { api, prisma, services } = setup();
    prisma.modCoursesCourse.findFirst.mockResolvedValueOnce(
      fakeCourseRow({ id: 'existing-course', title: 'Old', externalId: '101' }),
    );
    services.courses.updateCourse.mockResolvedValue(
      fakeCourseRow({ id: 'existing-course', title: 'New', externalId: '101' }),
    );

    const result = await api.courses.upsertByExternalRef({
      externalSource: 'learndash',
      externalId: '101',
      slug: 'curso-x', // slug ignorado en update
      title: 'New',
    });

    expect(services.courses.updateCourse).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      'existing-course',
      expect.objectContaining({ title: 'New' }),
    );
    expect(services.courses.createCourse).not.toHaveBeenCalled();
    expect(result.title).toBe('New');
  });
});

describe('courses.publish', () => {
  it('happy path → publishCourse del core', async () => {
    const { api, services } = setup();
    services.courses.publishCourse.mockResolvedValue(
      fakeCourseRow({
        id: 'course-uuid',
        status: 'PUBLISHED',
        publishedAt: new Date('2026-05-06T11:00:00Z'),
      }),
    );

    const result = await api.courses.publish('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    expect(services.courses.publishCourse).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
    expect(result.status).toBe('PUBLISHED');
    expect(result.publishedAt).toBeTruthy();
  });

  it('idempotencia: ya publicado → devuelve el row actual sin tirar error', async () => {
    const { api, prisma, services } = setup();
    services.courses.publishCourse.mockRejectedValue(
      new CourseAlreadyPublishedError('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    );
    prisma.modCoursesCourse.findFirst.mockResolvedValueOnce(
      fakeCourseRow({
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'PUBLISHED',
        publishedAt: new Date('2026-05-01T00:00:00Z'),
      }),
    );

    const result = await api.courses.publish('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(result.status).toBe('PUBLISHED');
  });

  it('rechaza UUID inválido con DIDACTA_VALIDATION_ERROR', async () => {
    const { api } = setup();
    await expect(api.courses.publish('not-a-uuid')).rejects.toMatchObject({
      code: 'DIDACTA_VALIDATION_ERROR',
    });
  });

  it('CourseNotFoundError → DIDACTA_NOT_FOUND', async () => {
    const { api, services } = setup();
    services.courses.publishCourse.mockRejectedValue(new CourseNotFoundError('any'));
    await expect(api.courses.publish('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).rejects.toMatchObject(
      { code: 'DIDACTA_NOT_FOUND' },
    );
  });
});

describe('courses.findByExternalRef', () => {
  it('encontrado', async () => {
    const { api, prisma } = setup();
    prisma.modCoursesCourse.findFirst.mockResolvedValueOnce(
      fakeCourseRow({ externalSource: 'learndash', externalId: '101' }),
    );
    const result = await api.courses.findByExternalRef({
      externalSource: 'learndash',
      externalId: '101',
    });
    expect(result?.externalId).toBe('101');
  });
  it('no encontrado → null', async () => {
    const { api, prisma } = setup();
    prisma.modCoursesCourse.findFirst.mockResolvedValueOnce(null);
    const result = await api.courses.findByExternalRef({
      externalSource: 'learndash',
      externalId: '999',
    });
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// courseModules
// ─────────────────────────────────────────────────────────────────────────────

describe('courseModules.upsertByExternalRef', () => {
  it('foreign reference: course parent no existe → DIDACTA_FOREIGN_REFERENCE', async () => {
    const { api, prisma } = setup();
    prisma.modCoursesCourse.findFirst.mockResolvedValueOnce(null); // course no existe

    await expect(
      api.courseModules.upsertByExternalRef({
        externalSource: 'learndash',
        externalId: '1',
        courseExternalRef: { externalSource: 'learndash', externalId: '999' },
        title: 'Sección',
        position: 0,
      }),
    ).rejects.toMatchObject({
      code: 'DIDACTA_FOREIGN_REFERENCE',
      message: expect.stringContaining('Course'),
    });
  });

  it('happy path: courseRef existe y section no existe → createModule + patch', async () => {
    const { api, prisma, services } = setup();
    prisma.modCoursesCourse.findFirst.mockResolvedValueOnce(fakeCourseRow({ id: 'course-uuid' }));
    prisma.modCoursesModule.findFirst.mockResolvedValueOnce(null);
    services.courses.createModule.mockResolvedValue(fakeCourseModuleRow({ id: 'cm-uuid' }));
    prisma.modCoursesModule.update.mockResolvedValue(
      fakeCourseModuleRow({
        id: 'cm-uuid',
        externalSource: 'learndash',
        externalId: '1',
      }),
    );

    const result = await api.courseModules.upsertByExternalRef({
      externalSource: 'learndash',
      externalId: '1',
      courseExternalRef: { externalSource: 'learndash', externalId: '101' },
      title: 'Sec',
      position: 0,
    });

    expect(services.courses.createModule).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      'course-uuid',
      expect.objectContaining({ title: 'Sec', position: 0 }),
    );
    expect(result.externalId).toBe('1');
  });

  it('ya existe → update directo, NO invoca createModule', async () => {
    const { api, prisma, services } = setup();
    prisma.modCoursesCourse.findFirst.mockResolvedValueOnce(fakeCourseRow({ id: 'course-uuid' }));
    prisma.modCoursesModule.findFirst.mockResolvedValueOnce(
      fakeCourseModuleRow({ id: 'cm-uuid', title: 'Old', externalId: '1' }),
    );
    prisma.modCoursesModule.update.mockResolvedValue(
      fakeCourseModuleRow({ id: 'cm-uuid', title: 'New', externalId: '1' }),
    );

    const result = await api.courseModules.upsertByExternalRef({
      externalSource: 'learndash',
      externalId: '1',
      courseExternalRef: { externalSource: 'learndash', externalId: '101' },
      title: 'New',
      position: 0,
    });

    expect(services.courses.createModule).not.toHaveBeenCalled();
    expect(result.title).toBe('New');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lessons
// ─────────────────────────────────────────────────────────────────────────────

describe('lessons.upsertByExternalRef', () => {
  it('foreign reference: section parent no existe → DIDACTA_FOREIGN_REFERENCE', async () => {
    const { api, prisma } = setup();
    prisma.modCoursesModule.findFirst.mockResolvedValueOnce(null);

    await expect(
      api.lessons.upsertByExternalRef({
        externalSource: 'learndash',
        externalId: '1',
        moduleExternalRef: { externalSource: 'learndash', externalId: '999' },
        type: 'TEXT',
        title: 'Lección',
        position: 0,
        content: { text: 'hola' },
      }),
    ).rejects.toMatchObject({
      code: 'DIDACTA_FOREIGN_REFERENCE',
      message: expect.stringContaining('CourseModule'),
    });
  });

  it('happy path: section existe → createLesson + patch externalRef', async () => {
    const { api, prisma, services } = setup();
    prisma.modCoursesModule.findFirst.mockResolvedValueOnce(fakeCourseModuleRow({ id: 'cm-uuid' }));
    prisma.modCoursesLesson.findFirst.mockResolvedValueOnce(null);
    services.courses.createLesson.mockResolvedValue(fakeLessonRow({ id: 'lesson-uuid' }));
    prisma.modCoursesLesson.update.mockResolvedValue(
      fakeLessonRow({
        id: 'lesson-uuid',
        externalSource: 'learndash',
        externalId: '1',
      }),
    );

    const result = await api.lessons.upsertByExternalRef({
      externalSource: 'learndash',
      externalId: '1',
      moduleExternalRef: { externalSource: 'learndash', externalId: '10' },
      type: 'TEXT',
      title: 'Lec',
      position: 0,
      content: { text: 'hola' },
    });

    expect(services.courses.createLesson).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      'cm-uuid',
      expect.objectContaining({ title: 'Lec', type: 'TEXT' }),
    );
    expect(result.externalId).toBe('1');
  });

  // ── AC-1: UPDATE sin cambio de module (CORE-FIX-01) ──
  it('update: lesson existe, mismo module → actualiza campos sin invocar moveLessonToModule', async () => {
    const { api, prisma, services } = setup();
    prisma.modCoursesModule.findFirst.mockResolvedValueOnce(
      fakeCourseModuleRow({ id: 'cm-uuid', courseId: 'course-uuid' }),
    );
    prisma.modCoursesLesson.findFirst.mockResolvedValueOnce({
      ...fakeLessonRow({ id: 'lesson-uuid', moduleId: 'cm-uuid' }),
      module: { courseId: 'course-uuid' },
    });
    prisma.modCoursesLesson.update.mockResolvedValue(
      fakeLessonRow({ id: 'lesson-uuid', title: 'Updated' }),
    );

    await api.lessons.upsertByExternalRef({
      externalSource: 'learndash',
      externalId: '1',
      moduleExternalRef: { externalSource: 'learndash', externalId: '10' },
      type: 'TEXT',
      title: 'Updated',
      position: 3,
      content: { text: 'nuevo' },
    });

    expect(services.courses.moveLessonToModule).not.toHaveBeenCalled();
    expect(prisma.modCoursesLesson.update).toHaveBeenCalledWith({
      where: { id: 'lesson-uuid' },
      data: expect.objectContaining({
        title: 'Updated',
        position: 3,
        content: { text: 'nuevo' },
      }),
    });
  });

  // ── AC-2: UPDATE con cambio de module dentro del mismo course ──
  it('update: lesson existe, module distinto mismo course → llama moveLessonToModule y omite position en el update final', async () => {
    const { api, prisma, services } = setup();
    prisma.modCoursesModule.findFirst.mockResolvedValueOnce(
      fakeCourseModuleRow({ id: 'cm-target', courseId: 'course-uuid' }),
    );
    prisma.modCoursesLesson.findFirst.mockResolvedValueOnce({
      ...fakeLessonRow({ id: 'lesson-uuid', moduleId: 'cm-source' }),
      module: { courseId: 'course-uuid' },
    });
    prisma.modCoursesLesson.update.mockResolvedValue(
      fakeLessonRow({ id: 'lesson-uuid', moduleId: 'cm-target' }),
    );

    await api.lessons.upsertByExternalRef({
      externalSource: 'learndash',
      externalId: '1',
      moduleExternalRef: { externalSource: 'learndash', externalId: '20' },
      type: 'TEXT',
      title: 'Lec',
      position: 2,
      content: { text: 'hola' },
    });

    expect(services.courses.moveLessonToModule).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      'lesson-uuid',
      'cm-target',
      2,
    );
    // position NO se incluye en el update final porque ya quedó set por moveLessonToModule.
    const updateCall = prisma.modCoursesLesson.update.mock.calls.at(-1);
    expect(updateCall).toBeDefined();
    expect(updateCall![0].data).not.toHaveProperty('position');
    expect(updateCall![0].data).toMatchObject({
      title: 'Lec',
      content: { text: 'hola' },
    });
  });

  // ── AC-3: UPDATE con cambio de module cruzando courses → error tipado ──
  it('update: lesson existe, module destino en otro course → DIDACTA_VALIDATION_ERROR sin tocar nada', async () => {
    const { api, prisma, services } = setup();
    prisma.modCoursesModule.findFirst.mockResolvedValueOnce(
      fakeCourseModuleRow({ id: 'cm-target', courseId: 'course-OTHER' }),
    );
    prisma.modCoursesLesson.findFirst.mockResolvedValueOnce({
      ...fakeLessonRow({ id: 'lesson-uuid', moduleId: 'cm-source' }),
      module: { courseId: 'course-uuid' },
    });

    await expect(
      api.lessons.upsertByExternalRef({
        externalSource: 'learndash',
        externalId: '1',
        moduleExternalRef: { externalSource: 'learndash', externalId: '30' },
        type: 'TEXT',
        title: 'Lec',
        position: 0,
        content: { text: 'hola' },
      }),
    ).rejects.toMatchObject({
      code: 'DIDACTA_VALIDATION_ERROR',
      message: expect.stringContaining('entre cursos'),
    });

    expect(services.courses.moveLessonToModule).not.toHaveBeenCalled();
    expect(prisma.modCoursesLesson.update).not.toHaveBeenCalled();
  });

  // ── AC-4: idempotencia — moveLessonToModule resuelve la colisión de constraint ──
  it('update: el move se delega antes del UPDATE final (orden de llamadas correcto)', async () => {
    const { api, prisma, services } = setup();
    prisma.modCoursesModule.findFirst.mockResolvedValueOnce(
      fakeCourseModuleRow({ id: 'cm-target', courseId: 'course-uuid' }),
    );
    prisma.modCoursesLesson.findFirst.mockResolvedValueOnce({
      ...fakeLessonRow({ id: 'lesson-uuid', moduleId: 'cm-source' }),
      module: { courseId: 'course-uuid' },
    });
    prisma.modCoursesLesson.update.mockResolvedValue(
      fakeLessonRow({ id: 'lesson-uuid', moduleId: 'cm-target' }),
    );

    const callOrder: string[] = [];
    services.courses.moveLessonToModule.mockImplementation(async () => {
      callOrder.push('move');
    });
    prisma.modCoursesLesson.update.mockImplementation(async () => {
      callOrder.push('update');
      return fakeLessonRow({ id: 'lesson-uuid', moduleId: 'cm-target' });
    });

    await api.lessons.upsertByExternalRef({
      externalSource: 'learndash',
      externalId: '1',
      moduleExternalRef: { externalSource: 'learndash', externalId: '20' },
      type: 'TEXT',
      title: 'Lec',
      position: 0,
      content: { text: 'hola' },
    });

    expect(callOrder).toEqual(['move', 'update']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// quizzes
// ─────────────────────────────────────────────────────────────────────────────

describe('quizzes.upsertByExternalRef', () => {
  it('happy path: standalone (sin lessonExternalRef) → createQuiz', async () => {
    const { api, prisma, services } = setup();
    prisma.modAssessmentsQuiz.findFirst.mockResolvedValueOnce(null);
    services.assessments.createQuiz.mockResolvedValue(fakeQuizRow({ id: 'quiz-uuid' }));
    prisma.modAssessmentsQuiz.update.mockResolvedValue(
      fakeQuizRow({
        id: 'quiz-uuid',
        externalSource: 'learndash',
        externalId: '500',
      }),
    );

    const result = await api.quizzes.upsertByExternalRef({
      externalSource: 'learndash',
      externalId: '500',
      title: 'Quiz 1',
      passThreshold: 70,
    });

    expect(services.assessments.createQuiz).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      expect.objectContaining({ title: 'Quiz 1', passThreshold: 70 }),
    );
    expect(result.externalId).toBe('500');
  });

  it('lessonExternalRef ausente en BD → DIDACTA_FOREIGN_REFERENCE', async () => {
    const { api, prisma } = setup();
    prisma.modCoursesLesson.findFirst.mockResolvedValueOnce(null);

    await expect(
      api.quizzes.upsertByExternalRef({
        externalSource: 'learndash',
        externalId: '500',
        lessonExternalRef: { externalSource: 'learndash', externalId: '404' },
        title: 'Quiz',
      }),
    ).rejects.toMatchObject({ code: 'DIDACTA_FOREIGN_REFERENCE' });
  });

  it('ya existe → updateQuiz', async () => {
    const { api, prisma, services } = setup();
    prisma.modAssessmentsQuiz.findFirst.mockResolvedValueOnce(
      fakeQuizRow({ id: 'quiz-uuid', title: 'Old', externalId: '500' }),
    );
    services.assessments.updateQuiz.mockResolvedValue(
      fakeQuizRow({ id: 'quiz-uuid', title: 'New', externalId: '500' }),
    );

    const result = await api.quizzes.upsertByExternalRef({
      externalSource: 'learndash',
      externalId: '500',
      title: 'New',
    });

    expect(services.assessments.updateQuiz).toHaveBeenCalledWith(
      TENANT_ID,
      'quiz-uuid',
      expect.objectContaining({ title: 'New' }),
    );
    expect(services.assessments.createQuiz).not.toHaveBeenCalled();
    expect(result.title).toBe('New');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// enrollments
// ─────────────────────────────────────────────────────────────────────────────

describe('enrollments.upsertByExternalRef', () => {
  it('foreign reference: user no existe', async () => {
    const { api, prisma } = setup();
    prisma.user.findFirst.mockResolvedValueOnce(null);

    await expect(
      api.enrollments.upsertByExternalRef({
        externalSource: 'learndash',
        externalId: '1',
        userExternalRef: { externalSource: 'learndash', externalId: '999' },
        courseExternalRef: { externalSource: 'learndash', externalId: '101' },
      }),
    ).rejects.toMatchObject({
      code: 'DIDACTA_FOREIGN_REFERENCE',
      message: expect.stringContaining('User'),
    });
  });

  it('foreign reference: course no existe', async () => {
    const { api, prisma } = setup();
    prisma.user.findFirst.mockResolvedValueOnce(fakeUserRow({ id: 'user-uuid' }));
    prisma.modCoursesCourse.findFirst.mockResolvedValueOnce(null);

    await expect(
      api.enrollments.upsertByExternalRef({
        externalSource: 'learndash',
        externalId: '1',
        userExternalRef: { externalSource: 'learndash', externalId: '99' },
        courseExternalRef: { externalSource: 'learndash', externalId: '999' },
      }),
    ).rejects.toMatchObject({
      code: 'DIDACTA_FOREIGN_REFERENCE',
      message: expect.stringContaining('Course'),
    });
  });

  it('happy path: enrollByAdmin + patch externalRef', async () => {
    const { api, prisma, services } = setup();
    prisma.user.findFirst.mockResolvedValueOnce(fakeUserRow({ id: 'user-uuid' }));
    prisma.modCoursesCourse.findFirst.mockResolvedValueOnce(fakeCourseRow({ id: 'course-uuid' }));
    prisma.modLearningEnrollment.findFirst.mockResolvedValueOnce(null);
    services.learning.enrollByAdmin.mockResolvedValue(fakeEnrollmentRow({ id: 'enr-uuid' }));
    prisma.modLearningEnrollment.update.mockResolvedValue(
      fakeEnrollmentRow({
        id: 'enr-uuid',
        externalSource: 'learndash',
        externalId: '300',
      }),
    );

    const result = await api.enrollments.upsertByExternalRef({
      externalSource: 'learndash',
      externalId: '300',
      userExternalRef: { externalSource: 'learndash', externalId: '99' },
      courseExternalRef: { externalSource: 'learndash', externalId: '101' },
    });

    expect(services.learning.enrollByAdmin).toHaveBeenCalledWith(TENANT_ID, USER_ID, {
      userId: 'user-uuid',
      courseId: 'course-uuid',
    });
    expect(result.externalId).toBe('300');
  });

  it('AlreadyEnrolledError sin externalRef previo → recupera y patchea', async () => {
    const { api, prisma, services } = setup();
    prisma.user.findFirst.mockResolvedValueOnce(fakeUserRow({ id: 'user-uuid' }));
    prisma.modCoursesCourse.findFirst.mockResolvedValueOnce(fakeCourseRow({ id: 'course-uuid' }));
    // primero por externalRef (no encontrado), luego por (user, course, ACTIVE)
    prisma.modLearningEnrollment.findFirst
      .mockResolvedValueOnce(null) // lookup por externalRef
      .mockResolvedValueOnce(fakeEnrollmentRow({ id: 'pre-existing' })); // lookup post-error
    services.learning.enrollByAdmin.mockRejectedValue(new AlreadyEnrolledError());
    prisma.modLearningEnrollment.update.mockResolvedValue(
      fakeEnrollmentRow({
        id: 'pre-existing',
        externalSource: 'learndash',
        externalId: '300',
      }),
    );

    const result = await api.enrollments.upsertByExternalRef({
      externalSource: 'learndash',
      externalId: '300',
      userExternalRef: { externalSource: 'learndash', externalId: '99' },
      courseExternalRef: { externalSource: 'learndash', externalId: '101' },
    });

    expect(result.id).toBe('pre-existing');
    expect(result.externalId).toBe('300');
  });

  it('idempotencia: ya existe por externalRef → no-op (no enrollByAdmin)', async () => {
    const { api, prisma, services } = setup();
    prisma.user.findFirst.mockResolvedValueOnce(fakeUserRow({ id: 'user-uuid' }));
    prisma.modCoursesCourse.findFirst.mockResolvedValueOnce(fakeCourseRow({ id: 'course-uuid' }));
    prisma.modLearningEnrollment.findFirst.mockResolvedValueOnce(
      fakeEnrollmentRow({
        id: 'enr-uuid',
        externalSource: 'learndash',
        externalId: '300',
      }),
    );

    const result = await api.enrollments.upsertByExternalRef({
      externalSource: 'learndash',
      externalId: '300',
      userExternalRef: { externalSource: 'learndash', externalId: '99' },
      courseExternalRef: { externalSource: 'learndash', externalId: '101' },
    });

    expect(services.learning.enrollByAdmin).not.toHaveBeenCalled();
    expect(result.externalId).toBe('300');
  });

  it('status=COMPLETED → patch progressPercent=100 y completedAt', async () => {
    const { api, prisma, services } = setup();
    prisma.user.findFirst.mockResolvedValueOnce(fakeUserRow({ id: 'user-uuid' }));
    prisma.modCoursesCourse.findFirst.mockResolvedValueOnce(fakeCourseRow({ id: 'course-uuid' }));
    prisma.modLearningEnrollment.findFirst.mockResolvedValueOnce(null);
    services.learning.enrollByAdmin.mockResolvedValue(fakeEnrollmentRow({ id: 'enr-uuid' }));
    prisma.modLearningEnrollment.update.mockResolvedValue(
      fakeEnrollmentRow({
        id: 'enr-uuid',
        status: 'COMPLETED',
        progressPercent: 100,
        completedAt: new Date('2026-04-30T00:00:00Z'),
        externalSource: 'learndash',
        externalId: '300',
      }),
    );

    const result = await api.enrollments.upsertByExternalRef({
      externalSource: 'learndash',
      externalId: '300',
      userExternalRef: { externalSource: 'learndash', externalId: '99' },
      courseExternalRef: { externalSource: 'learndash', externalId: '101' },
      status: 'COMPLETED',
      completedAt: '2026-04-30T00:00:00Z',
    });

    expect(prisma.modLearningEnrollment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'COMPLETED',
          progressPercent: 100,
        }),
      }),
    );
    expect(result.status).toBe('COMPLETED');
    expect(result.progressPercent).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// media
// ─────────────────────────────────────────────────────────────────────────────

describe('media.uploadFromBytes', () => {
  it('happy path: produce storageKey + checksum SHA-256 verificable', async () => {
    const { api, services } = setup();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const expectedChecksum = sha256Hex(bytes);

    const result = await api.media.uploadFromBytes({
      bytes,
      contentType: 'image/png',
      filename: 'photo.png',
    });

    expect(result.checksum).toBe(expectedChecksum);
    expect(result.contentType).toBe('image/png');
    expect(result.sizeBytes).toBe(5);
    expect(result.storageKey).toContain(expectedChecksum);
    expect(services.storage.upload).toHaveBeenCalledWith(result.storageKey, bytes, 'image/png');
  });

  it('rechaza bytes vacío con DIDACTA_VALIDATION_ERROR', async () => {
    const { api } = setup();
    await expect(
      api.media.uploadFromBytes({ bytes: new Uint8Array(0), contentType: 'image/png' }),
    ).rejects.toMatchObject({ code: 'DIDACTA_VALIDATION_ERROR' });
  });

  it('rechaza bytes > MAX_INLINE_UPLOAD_BYTES con DIDACTA_VALIDATION_ERROR', async () => {
    const { api } = setup();
    const huge = new Uint8Array(11 * 1024 * 1024); // 11 MB
    await expect(
      api.media.uploadFromBytes({ bytes: huge, contentType: 'application/octet-stream' }),
    ).rejects.toMatchObject({ code: 'DIDACTA_VALIDATION_ERROR' });
  });
});

describe('media.uploadFromUrl (STUB DD-007)', () => {
  it('lanza DIDACTA_INTERNAL_ERROR explicativo', async () => {
    const { api } = setup();
    await expect(
      api.media.uploadFromUrl({
        url: 'https://example.com/img.png',
        contentType: 'image/png',
      }),
    ).rejects.toMatchObject({
      code: 'DIDACTA_INTERNAL_ERROR',
      message: expect.stringContaining('uploadFromBytes'),
    });
  });
});
