/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { z, type ZodIssue } from 'zod';
import type { StorageService } from '@didacta/core-kernel';
import {
  AlreadyEnrolledError,
  CourseNotPublishedError,
  EnrollmentNotFoundError,
  LearningError,
  type LearningService,
} from '@didacta/mod-learning';
import {
  CourseAlreadyPublishedError,
  CourseHasNoLessonsError,
  CourseNotFoundError,
  CourseSlugAlreadyExistsError,
  CoursesError,
  type CoursesService,
} from '@didacta/mod-courses';
import {
  AssessmentsError,
  QuizNotFoundError,
  type AssessmentsService,
} from '@didacta/mod-assessments';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AdminUsersService } from '../admin/admin-users.service';
import {
  DIDACTA_CAPS,
  DIDACTA_EXTERNAL_ID_REGEX,
  DIDACTA_EXTERNAL_SOURCE_REGEX,
  DidactaError,
  type DidactaApi,
  type DidactaCourse,
  type DidactaCourseModule,
  type DidactaCourseModules,
  type DidactaCourses,
  type DidactaDeleteResult,
  type DidactaEnrollment,
  type DidactaEnrollments,
  type DidactaExternalRef,
  type DidactaLesson,
  type DidactaLessons,
  type DidactaMedia,
  type DidactaMediaUpload,
  type DidactaPermission,
  type DidactaQuiz,
  type DidactaQuizzes,
  type DidactaUploadFromBytesInput,
  type DidactaUploadFromUrlInput,
  type DidactaUpsertCourseInput,
  type DidactaUpsertCourseModuleInput,
  type DidactaUpsertEnrollmentInput,
  type DidactaUpsertLessonInput,
  type DidactaUpsertQuestionsInput,
  type DidactaQuestionsResult,
  type DidactaUpsertQuizInput,
  type DidactaUpsertUserInput,
  type DidactaUser,
  type DidactaUsers,
  type DidactaCreateCourseInput,
} from './sandboxed-didacta.types';
import type { ModuleDidactaConfig } from './module-manifest.schema';

/**
 * Implementación real del cliente `ctx.didacta` que el host expone a los
 * módulos third-party del marketplace (alpha.52 — task DD-002 del plan
 * Sprint 2).
 *
 * Antes de alpha.52 los módulos podían tocar Postgres scoped vía `ctx.db`
 * (mod_<slug>_*) y hacer requests salientes vía `ctx.http`, pero NO podían
 * crear/upsertear entidades del core (User, ModCoursesCourse, ModLearningEnrollment).
 * Resultado: `mod.migrator-learndash` aterrizaba bien sus stg pero la fase
 * "extract → core" no podía cerrarse — el job se quedaba con notice
 * `EXTRACT_PIPELINE_NOT_READY`. El contrato `DidactaApi` (DD-001) cierra
 * ese gap exponiendo una API pública del core con permission matrix
 * declarada en manifest, idempotencia por externalRef y tenant scope
 * automático desde el ALS.
 *
 * Esta clase NO es un servicio inyectable singleton para los módulos:
 * cada (módulo, request | onInstall) recibe una instancia scoped via
 * `build()` que memoriza el `moduleId` declarado en el manifest + el
 * `manifest.didacta` que declaró (externalSource + permissions). El
 * dispatcher (DD-004 del plan ctx.didacta) cablea el wiring; aquí solo
 * vive la lógica de permission/validación/delegación.
 *
 * Capas defensivas (en orden, fail-fast):
 *  1. Permission check → `DIDACTA_PERMISSION_DENIED` si el método no está
 *     en `manifest.didacta.permissions` con mensaje accionable.
 *  2. Tenant scope → resolver `(tenantId, userId)` del ALS via
 *     TenantContextService.require(). Falla con `DIDACTA_NO_TENANT_CONTEXT`
 *     si el módulo invoca fuera de un request HTTP.
 *  3. Validación Zod del input — schemas locales chequean shape antes de
 *     llamar al service del core. Falla con `DIDACTA_VALIDATION_ERROR`
 *     conservando el path del issue para que el dev del módulo pueda
 *     localizar el campo problemático.
 *  4. Lookup de externalRef (cuando aplica) → Prisma directo. Si existe →
 *     update; si no → create. Tras crear: patch externalSource/externalId
 *     en la fila resultante (los services del core NO conocen externalRef
 *     y no debería tocarse su firma para añadirlo).
 *  5. Cualquier excepción del service del core pasa por `mapCoreError()`
 *     que la normaliza a un `DidactaError` tipado. Esto desacopla al
 *     módulo de las clases internas del core (CourseSlugAlreadyExistsError,
 *     etc.) y le da un set estable de DidactaErrorCode con los que
 *     discriminar (retry, dlq, reportar al user).
 *
 * NO transacciones cross-recurso: cada método es atómico, pero crear
 * curso + sección + lessons + enrollments NO se envuelve en una sola
 * transacción. Roll-forward → el módulo persiste mappings en su stg y
 * reintenta lo que faltó. Roll-back → `deleteByExternalRef` (DD-005).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Schemas Zod (input validation)
// ─────────────────────────────────────────────────────────────────────────────

/// ExternalRef: la clave de idempotencia (externalSource + externalId).
/// Aplicamos los regex que ya viven en sandboxed-didacta.types.ts para que
/// el contrato sea coherente. Definimos como ZodObject sin `.strict()`
/// para poder extenderlo en los schemas hijos; cada schema final aplica
/// `.strict()` al cierre — un módulo que envía campos extra está usando
/// una versión vieja del SDK.
const externalRefShape = {
  externalSource: z
    .string()
    .min(1)
    .max(40)
    .regex(
      DIDACTA_EXTERNAL_SOURCE_REGEX,
      'externalSource debe ser lower-snake-case (a-z 0-9 _ -), max 40 chars',
    ),
  externalId: z
    .string()
    .min(1)
    .max(200)
    .regex(DIDACTA_EXTERNAL_ID_REGEX, 'externalId debe matchear /^[a-zA-Z0-9_.:-]{1,200}$/'),
} as const;

const externalRefSchema = z.object(externalRefShape).strict();

const upsertUserSchema = z
  .object({
    ...externalRefShape,
    email: z.string().email().max(254),
    name: z.string().min(1).max(160).optional(),
    role: z.enum(['tenant_admin', 'formador', 'alumno', 'auditor', 'empresa_manager']).optional(),
    locale: z.string().min(2).max(10).optional(),
    documentId: z.string().min(1).max(20).optional(),
    // alpha.81: si true, el user se crea SIN enviar email de invitación. El
    // migrador lo usa siempre; el operador notifica después de forma explícita.
    suppressInvite: z.boolean().optional(),
  })
  .strict();

const createCourseShape = {
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'slug debe ser kebab-case sin acentos ni espacios'),
  title: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  language: z.string().min(2).max(10).optional(),
  estimatedMinutes: z.number().int().positive().optional(),
  category: z.string().max(60).optional(),
} as const;

const createCourseSchema = z.object(createCourseShape).strict();

const upsertCourseSchema = z
  .object({
    ...externalRefShape,
    ...createCourseShape,
  })
  .strict();

const upsertCourseModuleSchema = z
  .object({
    ...externalRefShape,
    courseExternalRef: externalRefSchema,
    title: z.string().min(1).max(160),
    description: z.string().max(2000).optional(),
    position: z.number().int().min(0),
  })
  .strict();

const lessonTypeSchema = z.enum(['VIDEO', 'HTML', 'PDF', 'TEXT', 'QUIZ', 'SCORM']);

const upsertLessonSchema = z
  .object({
    ...externalRefShape,
    moduleExternalRef: externalRefSchema,
    type: lessonTypeSchema,
    title: z.string().min(1).max(160),
    position: z.number().int().min(0),
    content: z.record(z.string(), z.unknown()),
    durationMinutes: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    // Cap del content body — si llega más grande que 256 KB es un asset y
    // debería ir por `media.uploadFromBytes` con storageKey en content.
    const size = Buffer.byteLength(JSON.stringify(val.content), 'utf8');
    if (size > DIDACTA_CAPS.MAX_LESSON_CONTENT_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `lesson.content excede ${DIDACTA_CAPS.MAX_LESSON_CONTENT_BYTES} bytes (${size} bytes). Subí el asset con media.uploadFromBytes y referencialo por storageKey.`,
        path: ['content'],
      });
    }
  });

const upsertQuizSchema = z
  .object({
    ...externalRefShape,
    lessonExternalRef: externalRefSchema.optional(),
    title: z.string().min(3).max(200),
    description: z.string().max(2000).optional(),
    passThreshold: z.number().int().min(0).max(100).optional(),
    maxAttempts: z.number().int().positive().optional(),
    timeLimitMinutes: z.number().int().positive().optional(),
    questions: z.array(z.unknown()).max(DIDACTA_CAPS.MAX_QUESTIONS_PER_QUIZ).optional(),
  })
  .strict();

const upsertEnrollmentSchema = z
  .object({
    ...externalRefShape,
    userExternalRef: externalRefSchema,
    courseExternalRef: externalRefSchema,
    status: z.enum(['ACTIVE', 'COMPLETED', 'CANCELLED', 'PAUSED']).optional(),
    enrolledAt: z.string().datetime({ offset: true }).optional(),
    completedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

const uploadFromBytesSchema = z
  .object({
    bytes: z.instanceof(Uint8Array),
    contentType: z.string().min(1).max(200),
    filename: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.bytes.byteLength === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'bytes vacío — nada para subir.',
        path: ['bytes'],
      });
      return;
    }
    if (val.bytes.byteLength > DIDACTA_CAPS.MAX_INLINE_UPLOAD_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `bytes (${val.bytes.byteLength}B) excede el cap inline de ${DIDACTA_CAPS.MAX_INLINE_UPLOAD_BYTES}B. Para assets más grandes usá media.uploadFromUrl o subilo previamente al storage del módulo.`,
        path: ['bytes'],
      });
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Helpers puros (exportados para tests)
// ─────────────────────────────────────────────────────────────────────────────

/// Mapea cualquier excepción del service del core a un DidactaError tipado.
/// Estrategia: instanceof de las errors clases conocidas → fallback a
/// inspección de mensajes / códigos. Preservamos el original como `cause`
/// para que el módulo pueda inspeccionarlo si necesita más detalle.
export function mapCoreError(err: unknown): DidactaError {
  if (err instanceof DidactaError) return err;

  if (err instanceof CourseSlugAlreadyExistsError) {
    return new DidactaError('DIDACTA_CONFLICT', err.message, err);
  }
  if (err instanceof CourseAlreadyPublishedError) {
    // Idempotencia: re-publicar es no-op OK desde la perspectiva del módulo,
    // pero el core lo trata como conflict. Exponemos como CONFLICT para que
    // el módulo decida (típicamente: ignorar y seguir).
    return new DidactaError('DIDACTA_CONFLICT', err.message, err);
  }
  if (err instanceof CourseHasNoLessonsError) {
    return new DidactaError('DIDACTA_VALIDATION_ERROR', err.message, err);
  }
  if (err instanceof CourseNotFoundError) {
    return new DidactaError('DIDACTA_NOT_FOUND', err.message, err);
  }
  if (err instanceof QuizNotFoundError) {
    return new DidactaError('DIDACTA_NOT_FOUND', err.message, err);
  }
  if (err instanceof AlreadyEnrolledError) {
    return new DidactaError('DIDACTA_CONFLICT', err.message, err);
  }
  if (err instanceof EnrollmentNotFoundError) {
    return new DidactaError('DIDACTA_NOT_FOUND', err.message, err);
  }
  if (err instanceof CourseNotPublishedError) {
    return new DidactaError('DIDACTA_VALIDATION_ERROR', err.message, err);
  }

  // Familia genérica del módulo — error con `code` pero no clase específica.
  if (
    err instanceof CoursesError ||
    err instanceof LearningError ||
    err instanceof AssessmentsError
  ) {
    const code = (err as { code?: string }).code ?? '';
    if (code.endsWith('_NOT_FOUND')) {
      return new DidactaError('DIDACTA_NOT_FOUND', err.message, err);
    }
    if (
      code.endsWith('_EXISTS') ||
      code.endsWith('_ALREADY_PUBLISHED') ||
      code === 'ALREADY_ENROLLED'
    ) {
      return new DidactaError('DIDACTA_CONFLICT', err.message, err);
    }
    return new DidactaError('DIDACTA_VALIDATION_ERROR', err.message, err);
  }

  // Excepciones de Nest (BadRequestException, ConflictException, NotFoundException)
  // del AdminUsersService.invite. Aprovechamos `status` o `name` para clasificar.
  const e = err as {
    status?: number;
    response?: { statusCode?: number };
    message?: string;
    name?: string;
  };
  const status = e?.status ?? e?.response?.statusCode;
  const message = e?.message ?? String(err);
  if (status === 409 || /conflict|ya existe/i.test(message)) {
    return new DidactaError('DIDACTA_CONFLICT', message, err);
  }
  if (status === 404 || /not.?found|no encontrado/i.test(message)) {
    return new DidactaError('DIDACTA_NOT_FOUND', message, err);
  }
  if (status === 400 || /bad request|inválid|invalid/i.test(message)) {
    return new DidactaError('DIDACTA_VALIDATION_ERROR', message, err);
  }

  // Zod del core (validation interna) — ZodError tiene `issues`.
  if ((err as { issues?: ZodIssue[] }).issues) {
    return new DidactaError('DIDACTA_VALIDATION_ERROR', message, err);
  }

  // Fallback: bug del core o panic inesperado. El módulo debe fallar el job
  // y reintentar tras cooldown. `cause` preserva el original para diagnóstico.
  return new DidactaError('DIDACTA_INTERNAL_ERROR', `Error inesperado del core: ${message}`, err);
}

/// Convierte ZodError en DidactaError con mensaje legible que mencione el
/// path del primer issue. Mantenemos UN solo mensaje (no array) para que el
/// catch del módulo sea trivial — el dev mira el cause si necesita el resto.
function failValidation(zodError: z.ZodError): never {
  const first = zodError.issues[0];
  if (!first) {
    throw new DidactaError('DIDACTA_VALIDATION_ERROR', 'Input rechazado por validación.', zodError);
  }
  const path = first.path.length > 0 ? first.path.join('.') : '<root>';
  throw new DidactaError(
    'DIDACTA_VALIDATION_ERROR',
    `Input inválido en "${path}": ${first.message}`,
    zodError,
  );
}

/// Calcula SHA-256 hex del contenido — el módulo lo usa como cache key
/// para no resubir el mismo asset dos veces.
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/// Genera la storageKey opaca con la que el módulo referencia el asset.
/// Forma: `mod-uploads/<moduleId>/<tenantId>/<sha256>`. Predecible
/// (idempotencia) sin exponer datos del módulo.
export function buildStorageKey(moduleId: string, tenantId: string, checksum: string): string {
  // Slugificamos moduleId (ej. "mod.foo-bar" → "mod-foo-bar") porque el
  // sanitizer del S3StorageService rechaza puntos y slashes en la key.
  // Reemplazamos cualquier char fuera de [A-Za-z0-9_-] con un guión.
  const moduleSlug = moduleId.replace(/[^A-Za-z0-9_-]/g, '-');
  const tenantSlug = tenantId.replace(/[^A-Za-z0-9_-]/g, '-');
  return `mod-uploads/${moduleSlug}/${tenantSlug}/${checksum}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory NestJS
// ─────────────────────────────────────────────────────────────────────────────

/// Resolver de los services del core. Inyectamos el resolver en lugar de
/// los services directos para esquivar el ciclo de import: ModuleRegistryService
/// importa el marketplace module (para leer manifests instalados), y este
/// service necesita los services del core que ModuleRegistryService instancia
/// en `onModuleInit`. Pasando un resolver lazy, la primera invocación
/// (que ocurre tras OnModuleInit) ya tiene los services listos.
export interface CoreServicesResolver {
  getCoursesService(): CoursesService;
  getLearningService(): LearningService;
  getAssessmentsService(): AssessmentsService;
  /// Default web base url para invitations. Lee de env en runtime.
  getWebBaseUrl(): string;
  /// Storage backend (S3 o local). Para media.uploadFromBytes.
  getStorage(): StorageService;
}

@Injectable()
export class ScopedDidactaApiFactory {
  private readonly logger = new Logger(ScopedDidactaApiFactory.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly adminUsers: AdminUsersService,
  ) {}

  /// Construye un cliente didacta scoped a un módulo. El dispatcher invoca
  /// esto por cada (módulo, request) o `onInstall`. Los permisos quedan
  /// memoizados en el wrapper — chequeo O(1) por método.
  build(
    moduleId: string,
    didactaConfig: ModuleDidactaConfig,
    coreServices: CoreServicesResolver,
  ): DidactaApi {
    return new ScopedDidactaApi(
      this.logger,
      this.prisma,
      this.tenantContext,
      this.adminUsers,
      coreServices,
      moduleId,
      didactaConfig,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementación principal
// ─────────────────────────────────────────────────────────────────────────────

class ScopedDidactaApi implements DidactaApi {
  private readonly permissions: ReadonlySet<DidactaPermission>;
  /// Bloque "users" expuesto al módulo. Cada método ejecuta permission +
  /// tenant + zod + delega a AdminUsersService o Prisma directo.
  readonly users: DidactaUsers;
  readonly courses: DidactaCourses;
  readonly courseModules: DidactaCourseModules;
  readonly lessons: DidactaLessons;
  readonly quizzes: DidactaQuizzes;
  readonly enrollments: DidactaEnrollments;
  readonly media: DidactaMedia;

  constructor(
    private readonly logger: Logger,
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly adminUsers: AdminUsersService,
    private readonly coreServices: CoreServicesResolver,
    private readonly moduleId: string,
    private readonly didactaConfig: ModuleDidactaConfig,
  ) {
    this.permissions = new Set(didactaConfig.permissions);

    // Bind métodos a `this` para que el módulo pueda hacer destructuring si
    // quiere (`const { users } = ctx.didacta; users.upsertByExternalRef(...)`)
    // sin perder contexto. Cada método es un arrow que delega a la version
    // privada `do<X>` con permission ya resuelto.
    this.users = {
      upsertByExternalRef: (input) =>
        this.gate('users.upsertByExternalRef', () => this.usersUpsert(input)),
      findByExternalRef: (ref) => this.gate('users.findByExternalRef', () => this.usersFind(ref)),
      deleteByExternalRef: (ref) =>
        this.gate('users.deleteByExternalRef', () => this.usersDelete(ref)),
    };
    this.courses = {
      create: (input) => this.gate('courses.create', () => this.coursesCreate(input)),
      upsertByExternalRef: (input) =>
        this.gate('courses.upsertByExternalRef', () => this.coursesUpsert(input)),
      findByExternalRef: (ref) =>
        this.gate('courses.findByExternalRef', () => this.coursesFind(ref)),
      publish: (courseId) => this.gate('courses.publish', () => this.coursesPublish(courseId)),
      deleteByExternalRef: (ref) =>
        this.gate('courses.deleteByExternalRef', () => this.coursesDelete(ref)),
    };
    this.courseModules = {
      upsertByExternalRef: (input) =>
        this.gate('modules.upsertByExternalRef', () => this.courseModulesUpsert(input)),
      findByExternalRef: (ref) =>
        this.gate('modules.findByExternalRef', () => this.courseModulesFind(ref)),
      deleteByExternalRef: (ref) =>
        this.gate('modules.deleteByExternalRef', () => this.courseModulesDelete(ref)),
    };
    this.lessons = {
      upsertByExternalRef: (input) =>
        this.gate('lessons.upsertByExternalRef', () => this.lessonsUpsert(input)),
      findByExternalRef: (ref) =>
        this.gate('lessons.findByExternalRef', () => this.lessonsFind(ref)),
      deleteByExternalRef: (ref) =>
        this.gate('lessons.deleteByExternalRef', () => this.lessonsDelete(ref)),
    };
    this.quizzes = {
      upsertByExternalRef: (input) =>
        this.gate('quizzes.upsertByExternalRef', () => this.quizzesUpsert(input)),
      findByExternalRef: (ref) =>
        this.gate('quizzes.findByExternalRef', () => this.quizzesFind(ref)),
      deleteByExternalRef: (ref) =>
        this.gate('quizzes.deleteByExternalRef', () => this.quizzesDelete(ref)),
      upsertQuestions: (input) =>
        this.gate('quizzes.upsertQuestions', () => this.quizzesUpsertQuestions(input)),
    };
    this.enrollments = {
      upsertByExternalRef: (input) =>
        this.gate('enrollments.upsertByExternalRef', () => this.enrollmentsUpsert(input)),
      findByExternalRef: (ref) =>
        this.gate('enrollments.findByExternalRef', () => this.enrollmentsFind(ref)),
      deleteByExternalRef: (ref) =>
        this.gate('enrollments.deleteByExternalRef', () => this.enrollmentsDelete(ref)),
    };
    this.media = {
      uploadFromUrl: (input) =>
        this.gate('media.uploadFromUrl', () => this.mediaUploadFromUrl(input)),
      uploadFromBytes: (input) =>
        this.gate('media.uploadFromBytes', () => this.mediaUploadFromBytes(input)),
    };
  }

  // ────────────────── infra: gate (permission + tenant) ──────────────────

  /// Wrapper común: chequea permiso, resuelve tenant context, ejecuta `fn`.
  /// Mapea cualquier error inesperado del core a DidactaError tipado.
  /// Errores ya tipados (DidactaError) pasan a través sin doble wrap.
  private async gate<T>(method: DidactaPermission, fn: () => Promise<T>): Promise<T> {
    if (!this.permissions.has(method)) {
      throw new DidactaError(
        'DIDACTA_PERMISSION_DENIED',
        `Módulo "${this.moduleId}" intentó usar ctx.didacta.${method} pero ese permiso NO está en su manifest.didacta.permissions. Añadí "${method}" a la lista permissions del bloque didacta de tu module.json y reinstalá el módulo. Permisos ya declarados: ${JSON.stringify(this.didactaConfig.permissions)}.`,
      );
    }
    try {
      return await fn();
    } catch (err) {
      if (err instanceof DidactaError) throw err;
      throw mapCoreError(err);
    }
  }

  /// Resuelve `(tenantId, userId)` del ALS. Si no hay tenant context (ej.
  /// invocación fuera de request HTTP), lanza DIDACTA_NO_TENANT_CONTEXT
  /// para que el módulo entienda que tiene que correr dentro de un job
  /// con tenant scope (BullMQ + TenantContextService.run()).
  private requireTenant(): { tenantId: string; userId: string | null; traceId: string } {
    let ctx;
    try {
      ctx = this.tenantContext.require();
    } catch (err) {
      throw new DidactaError(
        'DIDACTA_NO_TENANT_CONTEXT',
        `Módulo "${this.moduleId}" invocó ctx.didacta sin TenantContext. Asegurate de envolver tu job con TenantContextService.run({ tenantId, userId, traceId }, () => ...).`,
        err,
      );
    }
    return {
      tenantId: ctx.tenantId,
      userId: ctx.userId ?? null,
      traceId: ctx.traceId,
    };
  }

  /// El externalSource de TODA operación debe coincidir con el declarado
  /// en manifest.didacta.externalSource. Esto evita que un módulo
  /// (intencionalmente o por bug) sobrescriba mappings de OTRO módulo
  /// (ej. mod.migrator-learndash escribe con `externalSource: "moodle"`).
  /// Defense-in-depth — el manifest schema ya valida que existe; aquí
  /// chequeamos que el módulo lo respete por método.
  private assertExternalSourceMatches(externalSource: string): void {
    if (externalSource !== this.didactaConfig.externalSource) {
      throw new DidactaError(
        'DIDACTA_VALIDATION_ERROR',
        `externalSource "${externalSource}" no coincide con el declarado en manifest.didacta.externalSource ("${this.didactaConfig.externalSource}"). Cada módulo solo puede gestionar entidades de SU propio externalSource.`,
      );
    }
  }

  // ────────────────── users ──────────────────

  private async usersUpsert(rawInput: DidactaUpsertUserInput): Promise<DidactaUser> {
    const parsed = upsertUserSchema.safeParse(rawInput);
    if (!parsed.success) failValidation(parsed.error);
    const input = parsed.data;
    this.assertExternalSourceMatches(input.externalSource);
    const { tenantId, userId } = this.requireTenant();

    // Lookup por externalRef. Si existe → no-op (return el user mapeado).
    // El user ya invitado puede haber cambiado email/role manualmente
    // desde el admin — NO sobrescribimos esos campos para no pisar
    // intención del operador humano. (Sprint 4 podrá añadir un
    // `policy: 'overwrite' | 'skip'` si surge el caso.)
    const existing = await this.prisma.user.findFirst({
      where: {
        tenantId,
        externalSource: input.externalSource,
        externalId: input.externalId,
        deletedAt: null,
      },
    });
    if (existing) {
      return toDidactaUser(existing);
    }

    // No existe → invitamos. AdminUsersService.invite crea el User ACTIVE +
    // asigna rol + envía email de welcome (idempotente: si el email ya
    // existe en el tenant lanza ConflictException). Mapeamos esa error a
    // DIDACTA_CONFLICT así el módulo discrimina vs. otro tipo de error.
    //
    // alpha.81: si el módulo pasó `suppressInvite: true` (caso del migrador),
    // creamos el user igual pero SIN disparar el email de
    // invitación/activación — pasamos `sendInvite: false` al service del
    // admin. El default (flag ausente/false) mantiene el envío del email,
    // idéntico al invite manual de un admin.
    const role = input.role ?? 'alumno';
    const webBaseUrl = this.coreServices.getWebBaseUrl();
    const actorId = userId ?? '00000000-0000-0000-0000-000000000000'; // system actor
    const list = await this.adminUsers.invite(
      tenantId,
      actorId,
      { email: input.email, name: input.name, role },
      webBaseUrl,
      undefined,
      { sendInvite: input.suppressInvite !== true },
    );

    // Patch externalRef en la fila recién creada. AdminUsersService NO
    // conoce externalRef — preferimos no tocar su firma para que el código
    // de admin siga simple.
    await this.prisma.user.update({
      where: { id: list.id },
      data: {
        externalSource: input.externalSource,
        externalId: input.externalId,
        ...(input.locale ? { locale: input.locale } : {}),
        ...(input.documentId ? { documentId: input.documentId } : {}),
      },
    });

    const fresh = await this.prisma.user.findUniqueOrThrow({ where: { id: list.id } });
    return toDidactaUser(fresh);
  }

  private async usersFind(rawRef: DidactaExternalRef): Promise<DidactaUser | null> {
    const parsed = externalRefSchema.safeParse(rawRef);
    if (!parsed.success) failValidation(parsed.error);
    this.assertExternalSourceMatches(parsed.data.externalSource);
    const { tenantId } = this.requireTenant();

    const row = await this.prisma.user.findFirst({
      where: {
        tenantId,
        externalSource: parsed.data.externalSource,
        externalId: parsed.data.externalId,
        deletedAt: null,
      },
    });
    return row ? toDidactaUser(row) : null;
  }

  private async usersDelete(rawRef: DidactaExternalRef): Promise<DidactaDeleteResult> {
    // STUB intencional. DELETE de users del core requiere coordinar:
    //  - soft-delete vs hard-delete (ADR pendiente)
    //  - cascade de enrollments / progress (riesgo de perder evidencia
    //    formativa Fundae que tiene retención obligatoria)
    //  - notificación al user (GDPR — opcional)
    // Por eso lo deferimos a DD-005 (Sprint 4). Hoy: log de advertencia
    // + no-op idempotente. El módulo puede catchear el log y reintentar
    // cuando el método esté implementado.
    const parsed = externalRefSchema.safeParse(rawRef);
    if (!parsed.success) failValidation(parsed.error);
    this.assertExternalSourceMatches(parsed.data.externalSource);
    this.requireTenant();
    this.logger.warn(
      `[mod:${this.moduleId}] users.deleteByExternalRef es STUB (DD-005 pendiente). Llamada con externalRef ${parsed.data.externalSource}/${parsed.data.externalId} fue no-op.`,
    );
    return { deleted: false, resourceId: null };
  }

  // ────────────────── courses ──────────────────

  private async coursesCreate(rawInput: DidactaCreateCourseInput): Promise<DidactaCourse> {
    const parsed = createCourseSchema.safeParse(rawInput);
    if (!parsed.success) failValidation(parsed.error);
    const input = parsed.data;
    const { tenantId, userId } = this.requireTenant();

    const created = await this.coreServices.getCoursesService().createCourse(tenantId, userId, {
      slug: input.slug,
      title: input.title,
      description: input.description,
      language: input.language ?? 'es-ES',
      estimatedMinutes: input.estimatedMinutes,
      category: input.category,
    });

    return toDidactaCourse(created);
  }

  private async coursesUpsert(rawInput: DidactaUpsertCourseInput): Promise<DidactaCourse> {
    const parsed = upsertCourseSchema.safeParse(rawInput);
    if (!parsed.success) failValidation(parsed.error);
    const input = parsed.data;
    this.assertExternalSourceMatches(input.externalSource);
    const { tenantId, userId } = this.requireTenant();

    const existing = await this.prisma.modCoursesCourse.findFirst({
      where: {
        tenantId,
        externalSource: input.externalSource,
        externalId: input.externalId,
        deletedAt: null,
      },
    });

    if (existing) {
      // Update path: el slug NO se cambia (el core lo prohíbe en
      // updateCourseSchema). Si el módulo lo cambió en origen, el slug
      // en Didacta queda desincronizado — eso es decisión del operador
      // (slug sirve como identificador estable en URL, no debería rotarse).
      const updated = await this.coreServices
        .getCoursesService()
        .updateCourse(tenantId, userId, existing.id, {
          title: input.title,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.estimatedMinutes !== undefined
            ? { estimatedMinutes: input.estimatedMinutes }
            : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
        });
      return toDidactaCourse(updated);
    }

    // Create path: createCourse + patch externalRef.
    const created = await this.coreServices.getCoursesService().createCourse(tenantId, userId, {
      slug: input.slug,
      title: input.title,
      description: input.description,
      language: input.language ?? 'es-ES',
      estimatedMinutes: input.estimatedMinutes,
      category: input.category,
    });
    const patched = await this.prisma.modCoursesCourse.update({
      where: { id: created.id },
      data: {
        externalSource: input.externalSource,
        externalId: input.externalId,
      },
    });
    return toDidactaCourse(patched);
  }

  private async coursesFind(rawRef: DidactaExternalRef): Promise<DidactaCourse | null> {
    const parsed = externalRefSchema.safeParse(rawRef);
    if (!parsed.success) failValidation(parsed.error);
    this.assertExternalSourceMatches(parsed.data.externalSource);
    const { tenantId } = this.requireTenant();

    const row = await this.prisma.modCoursesCourse.findFirst({
      where: {
        tenantId,
        externalSource: parsed.data.externalSource,
        externalId: parsed.data.externalId,
        deletedAt: null,
      },
    });
    return row ? toDidactaCourse(row) : null;
  }

  private async coursesPublish(courseId: string): Promise<DidactaCourse> {
    if (typeof courseId !== 'string' || !/^[0-9a-f-]{36}$/i.test(courseId)) {
      throw new DidactaError(
        'DIDACTA_VALIDATION_ERROR',
        `courses.publish requiere un UUID válido (recibido: ${courseId}).`,
      );
    }
    const { tenantId, userId } = this.requireTenant();
    try {
      const published = await this.coreServices
        .getCoursesService()
        .publishCourse(tenantId, userId, courseId);
      return toDidactaCourse(published);
    } catch (err) {
      // Idempotencia: si el curso ya está publicado, devolvemos el row
      // actual en vez de fallar — el módulo re-corriendo el job no debería
      // ver el curso como problemático.
      if (err instanceof CourseAlreadyPublishedError) {
        const current = await this.prisma.modCoursesCourse.findFirst({
          where: { tenantId, id: courseId, deletedAt: null },
        });
        if (current) return toDidactaCourse(current);
      }
      throw err;
    }
  }

  private async coursesDelete(rawRef: DidactaExternalRef): Promise<DidactaDeleteResult> {
    const parsed = externalRefSchema.safeParse(rawRef);
    if (!parsed.success) failValidation(parsed.error);
    this.assertExternalSourceMatches(parsed.data.externalSource);
    this.requireTenant();
    // STUB: ver justificación en `usersDelete` — DD-005 lo termina.
    this.logger.warn(
      `[mod:${this.moduleId}] courses.deleteByExternalRef es STUB (DD-005 pendiente). Llamada no-op.`,
    );
    return { deleted: false, resourceId: null };
  }

  // ────────────────── courseModules (secciones) ──────────────────

  private async courseModulesUpsert(
    rawInput: DidactaUpsertCourseModuleInput,
  ): Promise<DidactaCourseModule> {
    const parsed = upsertCourseModuleSchema.safeParse(rawInput);
    if (!parsed.success) failValidation(parsed.error);
    const input = parsed.data;
    this.assertExternalSourceMatches(input.externalSource);
    const { tenantId, userId } = this.requireTenant();

    // Resolver courseExternalRef → courseId.
    const course = await this.prisma.modCoursesCourse.findFirst({
      where: {
        tenantId,
        externalSource: input.courseExternalRef.externalSource,
        externalId: input.courseExternalRef.externalId,
        deletedAt: null,
      },
    });
    if (!course) {
      throw new DidactaError(
        'DIDACTA_FOREIGN_REFERENCE',
        `Course con externalRef ${input.courseExternalRef.externalSource}/${input.courseExternalRef.externalId} no existe en el tenant. Crealo primero con courses.upsertByExternalRef.`,
      );
    }

    const existing = await this.prisma.modCoursesModule.findFirst({
      where: {
        tenantId,
        externalSource: input.externalSource,
        externalId: input.externalId,
        deletedAt: null,
      },
    });

    if (existing) {
      // Update section. CoursesService no expone updateModule público —
      // hacemos update directo de los campos editables.
      const updated = await this.prisma.modCoursesModule.update({
        where: { id: existing.id },
        data: {
          title: input.title,
          ...(input.description !== undefined ? { description: input.description } : {}),
          position: input.position,
        },
      });
      return toDidactaCourseModule(updated);
    }

    // Create section via CoursesService.createModule. Position se respeta
    // (el core la usa tal cual, NO la auto-incrementa si viene set).
    const created = await this.coreServices
      .getCoursesService()
      .createModule(tenantId, userId, course.id, {
        title: input.title,
        description: input.description,
        position: input.position,
      });
    const patched = await this.prisma.modCoursesModule.update({
      where: { id: created.id },
      data: {
        externalSource: input.externalSource,
        externalId: input.externalId,
      },
    });
    return toDidactaCourseModule(patched);
  }

  private async courseModulesFind(rawRef: DidactaExternalRef): Promise<DidactaCourseModule | null> {
    const parsed = externalRefSchema.safeParse(rawRef);
    if (!parsed.success) failValidation(parsed.error);
    this.assertExternalSourceMatches(parsed.data.externalSource);
    const { tenantId } = this.requireTenant();

    const row = await this.prisma.modCoursesModule.findFirst({
      where: {
        tenantId,
        externalSource: parsed.data.externalSource,
        externalId: parsed.data.externalId,
        deletedAt: null,
      },
    });
    return row ? toDidactaCourseModule(row) : null;
  }

  private async courseModulesDelete(rawRef: DidactaExternalRef): Promise<DidactaDeleteResult> {
    const parsed = externalRefSchema.safeParse(rawRef);
    if (!parsed.success) failValidation(parsed.error);
    this.assertExternalSourceMatches(parsed.data.externalSource);
    this.requireTenant();
    this.logger.warn(
      `[mod:${this.moduleId}] modules.deleteByExternalRef es STUB (DD-005 pendiente). Llamada no-op.`,
    );
    return { deleted: false, resourceId: null };
  }

  // ────────────────── lessons ──────────────────

  private async lessonsUpsert(rawInput: DidactaUpsertLessonInput): Promise<DidactaLesson> {
    const parsed = upsertLessonSchema.safeParse(rawInput);
    if (!parsed.success) failValidation(parsed.error);
    const input = parsed.data;
    this.assertExternalSourceMatches(input.externalSource);
    const { tenantId, userId } = this.requireTenant();

    // Resolver moduleExternalRef → moduleId.
    const section = await this.prisma.modCoursesModule.findFirst({
      where: {
        tenantId,
        externalSource: input.moduleExternalRef.externalSource,
        externalId: input.moduleExternalRef.externalId,
        deletedAt: null,
      },
    });
    if (!section) {
      throw new DidactaError(
        'DIDACTA_FOREIGN_REFERENCE',
        `CourseModule con externalRef ${input.moduleExternalRef.externalSource}/${input.moduleExternalRef.externalId} no existe en el tenant. Crealo primero con courseModules.upsertByExternalRef.`,
      );
    }

    const existing = await this.prisma.modCoursesLesson.findFirst({
      where: {
        tenantId,
        externalSource: input.externalSource,
        externalId: input.externalId,
        deletedAt: null,
      },
      include: { module: { select: { courseId: true } } },
    });

    if (existing) {
      // Si el moduleExternalRef apunta a un module distinto del actual, hay
      // que mover la lesson. NO podemos hacerlo con un UPDATE crudo de
      // `moduleId` porque colisionaría con `@@unique([moduleId, position])`.
      // Delegamos a CoursesService.moveLessonToModule, que ya implementa la
      // transacción de 2 pasadas (posiciones temporales negativas) y emite
      // el evento `courses.lesson.moved-to-module` al outbox. Ver CORE-FIX-01.
      if (existing.moduleId !== section.id) {
        // Pre-check: mover entre cursos no está soportado por moveLessonToModule.
        // Validamos acá explícitamente en vez de capturar el error del core,
        // para no acoplarnos al mensaje interno.
        if (existing.module.courseId !== section.courseId) {
          throw new DidactaError(
            'DIDACTA_VALIDATION_ERROR',
            'No se puede mover una lesson entre cursos. Borrá la versión anterior con lessons.deleteByExternalRef antes de re-importarla en otro curso.',
          );
        }
        await this.coreServices
          .getCoursesService()
          .moveLessonToModule(tenantId, userId, existing.id, section.id, input.position);
      }

      const updated = await this.prisma.modCoursesLesson.update({
        where: { id: existing.id },
        data: {
          title: input.title,
          // type NO se actualiza — cambiar el tipo de una lesson rompe
          // el contrato de `content`. Si el módulo necesita cambiar el
          // tipo, debe borrar y recrear.
          // position: solo se setea acá si NO hubo move (el move ya la
          // posicionó en el target module).
          ...(existing.moduleId === section.id ? { position: input.position } : {}),
          content: input.content as never,
          ...(input.durationMinutes !== undefined
            ? { durationMinutes: input.durationMinutes }
            : {}),
        },
      });
      return toDidactaLesson(updated);
    }

    const created = await this.coreServices
      .getCoursesService()
      .createLesson(tenantId, userId, section.id, {
        type: input.type,
        title: input.title,
        position: input.position,
        content: input.content,
        durationMinutes: input.durationMinutes,
      });
    const patched = await this.prisma.modCoursesLesson.update({
      where: { id: created.id },
      data: {
        externalSource: input.externalSource,
        externalId: input.externalId,
      },
    });
    return toDidactaLesson(patched);
  }

  private async lessonsFind(rawRef: DidactaExternalRef): Promise<DidactaLesson | null> {
    const parsed = externalRefSchema.safeParse(rawRef);
    if (!parsed.success) failValidation(parsed.error);
    this.assertExternalSourceMatches(parsed.data.externalSource);
    const { tenantId } = this.requireTenant();

    const row = await this.prisma.modCoursesLesson.findFirst({
      where: {
        tenantId,
        externalSource: parsed.data.externalSource,
        externalId: parsed.data.externalId,
        deletedAt: null,
      },
    });
    return row ? toDidactaLesson(row) : null;
  }

  private async lessonsDelete(rawRef: DidactaExternalRef): Promise<DidactaDeleteResult> {
    const parsed = externalRefSchema.safeParse(rawRef);
    if (!parsed.success) failValidation(parsed.error);
    this.assertExternalSourceMatches(parsed.data.externalSource);
    this.requireTenant();
    this.logger.warn(
      `[mod:${this.moduleId}] lessons.deleteByExternalRef es STUB (DD-005 pendiente). Llamada no-op.`,
    );
    return { deleted: false, resourceId: null };
  }

  // ────────────────── quizzes ──────────────────

  private async quizzesUpsert(rawInput: DidactaUpsertQuizInput): Promise<DidactaQuiz> {
    const parsed = upsertQuizSchema.safeParse(rawInput);
    if (!parsed.success) failValidation(parsed.error);
    const input = parsed.data;
    this.assertExternalSourceMatches(input.externalSource);
    const { tenantId, userId } = this.requireTenant();

    // Si el módulo asocia el quiz a una lesson, resolver el externalRef
    // → lessonId. Si no existe → FOREIGN_REFERENCE (mismo patrón que lessons).
    let lessonId: string | null = null;
    if (input.lessonExternalRef) {
      const lesson = await this.prisma.modCoursesLesson.findFirst({
        where: {
          tenantId,
          externalSource: input.lessonExternalRef.externalSource,
          externalId: input.lessonExternalRef.externalId,
          deletedAt: null,
        },
      });
      if (!lesson) {
        throw new DidactaError(
          'DIDACTA_FOREIGN_REFERENCE',
          `Lesson con externalRef ${input.lessonExternalRef.externalSource}/${input.lessonExternalRef.externalId} no existe en el tenant. Crealo primero con lessons.upsertByExternalRef.`,
        );
      }
      lessonId = lesson.id;
    }

    const existing = await this.prisma.modAssessmentsQuiz.findFirst({
      where: {
        tenantId,
        externalSource: input.externalSource,
        externalId: input.externalId,
        deletedAt: null,
      },
    });

    if (existing) {
      // updateQuiz no recibe actorId (sólo tenantId + quizId + dto).
      const updated = await this.coreServices
        .getAssessmentsService()
        .updateQuiz(tenantId, existing.id, {
          ...(lessonId !== null ? { lessonId } : {}),
          title: input.title,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.passThreshold !== undefined ? { passThreshold: input.passThreshold } : {}),
          ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
          ...(input.timeLimitMinutes !== undefined
            ? { timeLimitMinutes: input.timeLimitMinutes }
            : {}),
        });
      return toDidactaQuiz(updated);
    }

    const created = await this.coreServices.getAssessmentsService().createQuiz(tenantId, userId, {
      ...(lessonId !== null ? { lessonId } : {}),
      title: input.title,
      description: input.description,
      passThreshold: input.passThreshold,
      maxAttempts: input.maxAttempts,
      timeLimitMinutes: input.timeLimitMinutes,
    });

    // NOTA: el bulk create de questions del input.questions queda diferido
    // a Sprint 4 (DD-006). El shape detallado lo valida AssessmentsService
    // y soportar todas las formas (SINGLE/MULTI/FILL_IN/etc.) requiere su
    // propio mapeo. Hoy se crea el quiz y el módulo puede llamar a un
    // método separado por question — pendiente.
    if (input.questions && input.questions.length > 0) {
      this.logger.warn(
        `[mod:${this.moduleId}] quizzes.upsertByExternalRef recibió ${input.questions.length} questions inline — desde alpha.56 (DD-006) los questions se cargan vía ctx.didacta.quizzes.upsertQuestions(...) que tiene semántica REPLACE explícita. Las questions del input.questions NO se persistieron desde esta call.`,
      );
    }

    const patched = await this.prisma.modAssessmentsQuiz.update({
      where: { id: created.id },
      data: {
        externalSource: input.externalSource,
        externalId: input.externalId,
      },
    });
    return toDidactaQuiz(patched);
  }

  private async quizzesFind(rawRef: DidactaExternalRef): Promise<DidactaQuiz | null> {
    const parsed = externalRefSchema.safeParse(rawRef);
    if (!parsed.success) failValidation(parsed.error);
    this.assertExternalSourceMatches(parsed.data.externalSource);
    const { tenantId } = this.requireTenant();

    const row = await this.prisma.modAssessmentsQuiz.findFirst({
      where: {
        tenantId,
        externalSource: parsed.data.externalSource,
        externalId: parsed.data.externalId,
        deletedAt: null,
      },
    });
    return row ? toDidactaQuiz(row) : null;
  }

  /// DD-006 (alpha.56) — bulk-create/replace de questions del quiz.
  /// Semántica REPLACE: borra todas las questions existentes del quiz y
  /// crea las nuevas. Idempotente (re-llamar con el mismo input produce
  /// el mismo estado final). El módulo es responsable de mappear su tipo
  /// de pregunta nativo al `DidactaQuestionType` antes de invocar.
  private async quizzesUpsertQuestions(
    input: DidactaUpsertQuestionsInput,
  ): Promise<DidactaQuestionsResult> {
    const refParsed = externalRefSchema.safeParse(input.quizExternalRef);
    if (!refParsed.success) failValidation(refParsed.error);
    this.assertExternalSourceMatches(refParsed.data.externalSource);
    const { tenantId } = this.requireTenant();

    // Resolver quizId via externalRef.
    const quiz = await this.prisma.modAssessmentsQuiz.findFirst({
      where: {
        tenantId,
        externalSource: refParsed.data.externalSource,
        externalId: refParsed.data.externalId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!quiz) {
      throw new DidactaError(
        'DIDACTA_FOREIGN_REFERENCE',
        `Quiz con externalRef ${refParsed.data.externalSource}/${refParsed.data.externalId} no existe en el tenant. Crealo primero con quizzes.upsertByExternalRef antes de cargar questions.`,
      );
    }

    // 1. Borrar todas las questions existentes (soft delete por consistencia
    // con AssessmentsService.deleteQuestion). updateMany porque addQuestion
    // pone deletedAt=null al crear y filtramos por deletedAt=null al leer.
    const deletedRes = await this.prisma.modAssessmentsQuestion.updateMany({
      where: { tenantId, quizId: quiz.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    // 2. Crear las nuevas via AssessmentsService.addQuestion para reusar la
    // lógica de position auto-increment + options nested create + audit
    // (lo que sea que el service emita). Una a una porque addQuestion no
    // soporta bulk — para N=10..50 preguntas/quiz es aceptable, si crece
    // mucho refactor a bulk SQL directo.
    const assessmentsSvc = this.coreServices.getAssessmentsService();
    let createdCount = 0;
    for (const q of input.questions) {
      // Mapeo del tipo Didacta → CreateQuestionDto. Validation extra del
      // schema interno del service hará el resto.
      await assessmentsSvc.addQuestion(tenantId, quiz.id, {
        type: q.type,
        prompt: q.prompt,
        feedback: q.feedback,
        points: q.points,
        acceptedAnswers: q.acceptedAnswers,
        options: q.options?.map((o) => ({ label: o.label, isCorrect: o.isCorrect })),
      } as Parameters<typeof assessmentsSvc.addQuestion>[2]);
      createdCount += 1;
    }

    return {
      quizId: quiz.id,
      createdCount,
      deletedCount: deletedRes.count,
    };
  }

  private async quizzesDelete(rawRef: DidactaExternalRef): Promise<DidactaDeleteResult> {
    const parsed = externalRefSchema.safeParse(rawRef);
    if (!parsed.success) failValidation(parsed.error);
    this.assertExternalSourceMatches(parsed.data.externalSource);
    this.requireTenant();
    this.logger.warn(
      `[mod:${this.moduleId}] quizzes.deleteByExternalRef es STUB (DD-005 pendiente). Llamada no-op.`,
    );
    return { deleted: false, resourceId: null };
  }

  // ────────────────── enrollments ──────────────────

  private async enrollmentsUpsert(
    rawInput: DidactaUpsertEnrollmentInput,
  ): Promise<DidactaEnrollment> {
    const parsed = upsertEnrollmentSchema.safeParse(rawInput);
    if (!parsed.success) failValidation(parsed.error);
    const input = parsed.data;
    this.assertExternalSourceMatches(input.externalSource);
    const { tenantId, userId } = this.requireTenant();

    // Resolver userExternalRef + courseExternalRef antes de delegar al
    // service del core (que recibe IDs lógicos del core, no externalRefs).
    const user = await this.prisma.user.findFirst({
      where: {
        tenantId,
        externalSource: input.userExternalRef.externalSource,
        externalId: input.userExternalRef.externalId,
        deletedAt: null,
      },
    });
    if (!user) {
      throw new DidactaError(
        'DIDACTA_FOREIGN_REFERENCE',
        `User con externalRef ${input.userExternalRef.externalSource}/${input.userExternalRef.externalId} no existe en el tenant. Crealo primero con users.upsertByExternalRef.`,
      );
    }
    const course = await this.prisma.modCoursesCourse.findFirst({
      where: {
        tenantId,
        externalSource: input.courseExternalRef.externalSource,
        externalId: input.courseExternalRef.externalId,
        deletedAt: null,
      },
    });
    if (!course) {
      throw new DidactaError(
        'DIDACTA_FOREIGN_REFERENCE',
        `Course con externalRef ${input.courseExternalRef.externalSource}/${input.courseExternalRef.externalId} no existe en el tenant. Crealo primero con courses.upsertByExternalRef.`,
      );
    }

    // Idempotencia: lookup por externalRef del enrollment. Si existe →
    // no-op (devolvemos como está). Si no, llamamos a enrollByAdmin que
    // hace la idempotencia interna por (user, course, status=ACTIVE).
    const existing = await this.prisma.modLearningEnrollment.findFirst({
      where: {
        tenantId,
        externalSource: input.externalSource,
        externalId: input.externalId,
      },
    });
    if (existing) {
      return toDidactaEnrollment(existing);
    }

    let enrollment;
    try {
      enrollment = await this.coreServices.getLearningService().enrollByAdmin(tenantId, userId, {
        userId: user.id,
        courseId: course.id,
      });
    } catch (err) {
      // Si ya estaba enrolled (otro path lo creó sin externalRef), buscar
      // el enrollment existente y patchearlo con el externalRef provisto.
      // De lo contrario seguir el mapeo de errores normal.
      if (err instanceof AlreadyEnrolledError) {
        const found = await this.prisma.modLearningEnrollment.findFirst({
          where: { tenantId, userId: user.id, courseId: course.id, status: 'ACTIVE' },
        });
        if (found) {
          enrollment = found;
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    const patchData: {
      externalSource: string;
      externalId: string;
      status?: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'PAUSED';
      completedAt?: Date;
      progressPercent?: number;
    } = {
      externalSource: input.externalSource,
      externalId: input.externalId,
    };
    if (input.status === 'COMPLETED' || input.completedAt) {
      patchData.status = 'COMPLETED';
      patchData.completedAt = input.completedAt ? new Date(input.completedAt) : new Date();
      patchData.progressPercent = 100;
    } else if (input.status) {
      patchData.status = input.status;
    }
    const patched = await this.prisma.modLearningEnrollment.update({
      where: { id: enrollment.id },
      data: patchData,
    });
    return toDidactaEnrollment(patched);
  }

  private async enrollmentsFind(rawRef: DidactaExternalRef): Promise<DidactaEnrollment | null> {
    const parsed = externalRefSchema.safeParse(rawRef);
    if (!parsed.success) failValidation(parsed.error);
    this.assertExternalSourceMatches(parsed.data.externalSource);
    const { tenantId } = this.requireTenant();

    const row = await this.prisma.modLearningEnrollment.findFirst({
      where: {
        tenantId,
        externalSource: parsed.data.externalSource,
        externalId: parsed.data.externalId,
      },
    });
    return row ? toDidactaEnrollment(row) : null;
  }

  private async enrollmentsDelete(rawRef: DidactaExternalRef): Promise<DidactaDeleteResult> {
    const parsed = externalRefSchema.safeParse(rawRef);
    if (!parsed.success) failValidation(parsed.error);
    this.assertExternalSourceMatches(parsed.data.externalSource);
    this.requireTenant();
    this.logger.warn(
      `[mod:${this.moduleId}] enrollments.deleteByExternalRef es STUB (DD-005 pendiente). Llamada no-op.`,
    );
    return { deleted: false, resourceId: null };
  }

  // ────────────────── media ──────────────────

  private async mediaUploadFromBytes(
    rawInput: DidactaUploadFromBytesInput,
  ): Promise<DidactaMediaUpload> {
    const parsed = uploadFromBytesSchema.safeParse(rawInput);
    if (!parsed.success) failValidation(parsed.error);
    const input = parsed.data;
    const { tenantId } = this.requireTenant();

    const checksum = sha256Hex(input.bytes);
    const requestedKey = buildStorageKey(this.moduleId, tenantId, checksum);
    const storage = this.coreServices.getStorage();

    // Las imágenes van por `uploadImage` para que se optimicen como las del
    // host: por aquí entra todo lo que suben los módulos (el migrador importa
    // miles de portadas de un LMS de origen), y antes se guardaban en crudo.
    // El resto de ficheros (PDF, ZIP, vídeo) se escriben byte a byte.
    const stored = await storage.uploadImage(requestedKey, input.bytes, input.contentType);

    return {
      // La key devuelta es la REAL: al recomprimir cambia la extensión, y el
      // módulo persistirá esta para poder recuperar el blob después.
      storageKey: stored.key,
      contentType: stored.contentType,
      sizeBytes: stored.size,
      checksum,
      uploadedAt: new Date().toISOString(),
    };
  }

  private async mediaUploadFromUrl(
    _rawInput: DidactaUploadFromUrlInput,
  ): Promise<DidactaMediaUpload> {
    // STUB intencional. uploadFromUrl requiere reutilizar el `ctx.http`
    // del módulo (allowlist + rate limit + SSRF guard) para descargar el
    // asset de origen. Eso significa cablear el cliente HTTP scoped al
    // mismo binding del módulo desde aquí — un trabajo de plumbing
    // significativo que no es bloqueante para Sprint 2 (el migrator
    // puede usar `ctx.http.get(url)` directamente y luego llamar a
    // `media.uploadFromBytes(bytes)`). Lo dejamos para Sprint 4.
    this.requireTenant();
    throw new DidactaError(
      'DIDACTA_INTERNAL_ERROR',
      `media.uploadFromUrl no está implementado todavía (Sprint 4 — DD-007). Por ahora descargá el asset con ctx.http.get(url) y subilo con media.uploadFromBytes({ bytes, contentType }).`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mappers Prisma → Didacta DTO (subset estable)
// ─────────────────────────────────────────────────────────────────────────────
//
// Estos mappers cumplen la regla del contrato: el módulo ve SOLO los campos
// estables documentados en sandboxed-didacta.types.ts. Si el modelo Prisma
// gana un campo nuevo internamente (passwordHash, audit info), NO se filtra.
// Si el módulo necesita un campo nuevo, se discute y se añade explícitamente.

interface PrismaUserRow {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  status: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'DEACTIVATED';
  locale: string;
  externalSource: string | null;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
function toDidactaUser(row: PrismaUserRow): DidactaUser {
  return {
    id: row.id,
    tenantId: row.tenantId,
    email: row.email,
    name: row.name,
    status: row.status,
    locale: row.locale,
    externalSource: row.externalSource,
    externalId: row.externalId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface PrismaCourseRow {
  id: string;
  tenantId: string;
  slug: string;
  title: string;
  description: string | null;
  language: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  externalSource: string | null;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
}
function toDidactaCourse(row: PrismaCourseRow): DidactaCourse {
  return {
    id: row.id,
    tenantId: row.tenantId,
    slug: row.slug,
    title: row.title,
    description: row.description,
    language: row.language,
    status: row.status,
    externalSource: row.externalSource,
    externalId: row.externalId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
  };
}

interface PrismaCourseModuleRow {
  id: string;
  tenantId: string;
  courseId: string;
  title: string;
  description: string | null;
  position: number;
  externalSource: string | null;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
function toDidactaCourseModule(row: PrismaCourseModuleRow): DidactaCourseModule {
  return {
    id: row.id,
    tenantId: row.tenantId,
    courseId: row.courseId,
    title: row.title,
    description: row.description,
    position: row.position,
    externalSource: row.externalSource,
    externalId: row.externalId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface PrismaLessonRow {
  id: string;
  tenantId: string;
  moduleId: string;
  type: 'VIDEO' | 'HTML' | 'PDF' | 'TEXT' | 'QUIZ' | 'SCORM';
  title: string;
  position: number;
  content: unknown;
  durationMinutes: number | null;
  externalSource: string | null;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
function toDidactaLesson(row: PrismaLessonRow): DidactaLesson {
  return {
    id: row.id,
    tenantId: row.tenantId,
    moduleId: row.moduleId,
    type: row.type,
    title: row.title,
    position: row.position,
    content: (row.content ?? {}) as Record<string, unknown>,
    durationMinutes: row.durationMinutes,
    externalSource: row.externalSource,
    externalId: row.externalId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface PrismaQuizRow {
  id: string;
  tenantId: string;
  lessonId: string | null;
  title: string;
  description: string | null;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  passThreshold: number;
  maxAttempts: number | null;
  timeLimitMinutes: number | null;
  externalSource: string | null;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
function toDidactaQuiz(row: PrismaQuizRow): DidactaQuiz {
  return {
    id: row.id,
    tenantId: row.tenantId,
    lessonId: row.lessonId,
    title: row.title,
    description: row.description,
    status: row.status,
    passThreshold: row.passThreshold,
    maxAttempts: row.maxAttempts,
    timeLimitMinutes: row.timeLimitMinutes,
    externalSource: row.externalSource,
    externalId: row.externalId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface PrismaEnrollmentRow {
  id: string;
  tenantId: string;
  userId: string;
  courseId: string;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'PAUSED';
  source:
    | 'ADMIN'
    | 'CODE'
    | 'INVITATION_LINK'
    | 'PURCHASE'
    | 'IMPORT'
    | 'SUBSCRIPTION'
    | 'API'
    | 'GROUP';
  progressPercent: number;
  externalSource: string | null;
  externalId: string | null;
  enrolledAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}
function toDidactaEnrollment(row: PrismaEnrollmentRow): DidactaEnrollment {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    courseId: row.courseId,
    status: row.status,
    source: row.source,
    progressPercent: row.progressPercent,
    externalSource: row.externalSource,
    externalId: row.externalId,
    enrolledAt: row.enrolledAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}
