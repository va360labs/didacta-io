/**
 * Contrato de la API pública del core que el host expone a los módulos
 * third-party del marketplace. Definida en alpha.52 (Sprint 2).
 *
 * Antes de alpha.52 los módulos NO podían tocar entidades del core (users,
 * courses, lessons, enrollments). El sandbox solo daba `ctx.db` (BD scoped
 * a `mod_<slug>_*`) y `ctx.http` (red saliente). Resultado: el migrator
 * LearnDash podía leer de WordPress y aterrizar a sus stg, pero NO podía
 * crear el curso final en `mod_courses_course` — esa fase quedaba colgada
 * con un notice `EXTRACT_PIPELINE_NOT_READY`.
 *
 * La regla del repo (reforzada por el usuario): **al core no se mueve nada
 * de un módulo**. Y el sandbox NO debe abrir acceso directo a Prisma porque
 * el módulo escaparía la regla R2 ("sin acceso a tablas ajenas") y la regla
 * R3 (RLS por tenant). La solución vive como capa intermedia: cliente de
 * API pública con permission checks por (módulo, método) + delegación a
 * services del core que ya enforce auth, audit y eventos.
 *
 * El contrato vive en archivo separado para que tres consumidores lo
 * compartan sin ciclos de import:
 *  1. `module-router.service.ts` — `ModuleRouteRequestContext.didacta`
 *  2. `module-sandbox.service.ts` — `ModuleInstallContext.didacta`
 *  3. `sandboxed-didacta.service.ts` (DD-002) — la implementación real
 *
 * Reglas estructurales del contrato (todas impuestas por el host):
 *  - **Permisos por método**: el manifest declara `didacta.permissions: [...]`.
 *    Cualquier llamada a un método no declarado → `DIDACTA_PERMISSION_DENIED`.
 *    Defense-in-depth: aunque un módulo intente saltarse el guard de TS,
 *    el host valida en runtime antes de delegar al service del core.
 *  - **Idempotencia por externalRef**: cada recurso del core gana dos
 *    columnas (`external_source`, `external_id`) con unique compuesto
 *    `(tenantId, externalSource, externalId)`. El módulo declara su
 *    `externalSource` en el manifest (ej. "learndash") y pasa el ID
 *    del origen como `externalId` (ej. WordPress course ID). Re-correr
 *    el job NUNCA crea duplicados. Cross-job re-import recoge mappings
 *    previos automáticamente.
 *  - **Tenant scope automático**: el host resuelve `tenantId` del ALS
 *    (TenantContextService) — el módulo NO puede inyectarlo. Si el
 *    contexto no tiene tenant (ej. invocación fuera de request HTTP),
 *    la llamada falla con `DIDACTA_NOT_FOUND` (defensa conservadora).
 *  - **Actor tracking**: cada operación queda atribuida al `userId` que
 *    disparó el job (no al moduleId, porque AuditLog necesita actor humano).
 *    Esa info viaja en el ALS junto al tenantId.
 *  - **Output mínimo estable**: las shapes devueltas son subsets curados
 *    de los modelos Prisma. Los módulos NO ven campos internos (passwordHash,
 *    mfaSecret, etc.). Si un módulo necesita un campo que no está, se
 *    discute en el core y se añade explícitamente.
 *  - **Sin transacciones cross-recurso**: cada método es atómico, pero
 *    crear curso + lessons + enrollments NO está envuelto en una
 *    transacción. Para roll-forward, el módulo persiste mappings en su
 *    stg y reintenta lo que faltó. Para roll-back, ver `deleteByExternalRef`.
 */

/// Códigos de error tipados que `ctx.didacta` puede lanzar. El módulo decide
/// qué hacer con cada uno (retry, dlq, propagar al user, etc.). Errores de
/// constraint del motor (unique violation) se mapean a códigos estables
/// para que el módulo no dependa de strings de Postgres ni de excepciones
/// internas del core.
export type DidactaErrorCode =
  | 'DIDACTA_PERMISSION_DENIED' // El método invocado no está en `manifest.didacta.permissions`.
  | 'DIDACTA_NOT_FOUND' // El recurso buscado (por externalRef o id) no existe en el tenant.
  | 'DIDACTA_VALIDATION_ERROR' // Input rechazado por el schema Zod (campos faltantes, formato).
  | 'DIDACTA_CONFLICT' // Violación de constraint del core (slug ya existe, enrollment duplicado).
  | 'DIDACTA_QUOTA_EXCEEDED' // Tope alcanzado (max courses por tenant, max users por plan).
  | 'DIDACTA_NO_TENANT_CONTEXT' // No hay tenantId en el ALS — invocación fuera de request HTTP.
  | 'DIDACTA_FOREIGN_REFERENCE' // Una referencia (courseId, userId) no existe o cruza tenants.
  | 'DIDACTA_INTERNAL_ERROR'; // Error inesperado del core. El módulo debería fallar el job y reintentar.

/// Error tipado que lanza `ctx.didacta` ante condiciones controladas. El
/// módulo puede `catch (e)` y discriminar por `e.code`. Para errores no
/// catalogados (bug del core, panic en el service) se lanza un `Error`
/// genérico — esos NO van con `DidactaError` para que el módulo los propague
/// al worker que los reportará como `DIDACTA_INTERNAL_ERROR` desde fuera.
export class DidactaError extends Error {
  constructor(
    public readonly code: DidactaErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DidactaError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Permisos declarados en manifest.didacta.permissions
// ─────────────────────────────────────────────────────────────────────────────

/// Lista cerrada de permisos que un módulo puede declarar. Cualquier valor
/// fuera de esta lista en el manifest → rechazo del manifest con
/// `MANIFEST_INVALID`. Cuando se añadan recursos nuevos al core (ej. groups,
/// certificates) hay que extender esta lista + bumpar la versión del paquete
/// `@didacta/module-package-spec` (los permisos son contrato público).
export const DIDACTA_PERMISSIONS = [
  // users
  'users.upsertByExternalRef',
  'users.findByExternalRef',
  'users.deleteByExternalRef',
  // courses
  'courses.create',
  'courses.upsertByExternalRef',
  'courses.findByExternalRef',
  'courses.publish',
  'courses.deleteByExternalRef',
  // modules (course sections)
  'modules.upsertByExternalRef',
  'modules.findByExternalRef',
  'modules.deleteByExternalRef',
  // lessons
  'lessons.upsertByExternalRef',
  'lessons.findByExternalRef',
  'lessons.deleteByExternalRef',
  // quizzes (assessments)
  'quizzes.upsertByExternalRef',
  'quizzes.findByExternalRef',
  'quizzes.deleteByExternalRef',
  'quizzes.upsertQuestions',
  // enrollments
  'enrollments.upsertByExternalRef',
  'enrollments.findByExternalRef',
  'enrollments.deleteByExternalRef',
  // media
  'media.uploadFromUrl',
  'media.uploadFromBytes',
] as const;

export type DidactaPermission = (typeof DIDACTA_PERMISSIONS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Identificadores externos (idempotencia)
// ─────────────────────────────────────────────────────────────────────────────

/// Source del módulo origen de la entidad migrada. Lower-snake-case, max 40
/// chars. Ej. "learndash", "moodle", "thinkific". Distinguir múltiples
/// sources permite que un mismo tenant tenga datos importados de varios
/// LMS sin colisiones de externalId. Match con regex en el host.
export const DIDACTA_EXTERNAL_SOURCE_REGEX = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/// External ID del recurso en el sistema origen. Free-form pero acotado.
/// El módulo lo trata como opaque string — el core NO lo parsea. Ej. para
/// LearnDash: el WordPress post_id. Para Moodle: el course ID numérico.
/// Para sistemas con UUIDs: el UUID stringificado.
export const DIDACTA_EXTERNAL_ID_REGEX = /^[a-zA-Z0-9_.:-]{1,200}$/;

/// Referencia opaca a un recurso en el sistema origen. Sirve como clave
/// de idempotencia: dos invocaciones de `upsertByExternalRef` con la misma
/// `(externalSource, externalId)` apuntan al mismo recurso del core.
export interface DidactaExternalRef {
  externalSource: string;
  externalId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Outputs estables (subsets curados de modelos Prisma)
// ─────────────────────────────────────────────────────────────────────────────

/// Subset estable de campos del User del core. Excluye passwordHash,
/// mfaSecret, sessions, etc. — info que un módulo NUNCA debe ver.
export interface DidactaUser {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  status: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'DEACTIVATED';
  locale: string;
  externalSource: string | null;
  externalId: string | null;
  createdAt: string; // ISO-8601
  updatedAt: string;
}

export interface DidactaCourse {
  id: string;
  tenantId: string;
  slug: string;
  title: string;
  description: string | null;
  language: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  externalSource: string | null;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

/// "Module" = sección de un curso (analogía LearnDash: section). El nombre
/// se mantiene por consistencia con el modelo Prisma `ModCoursesModule`.
export interface DidactaCourseModule {
  id: string;
  tenantId: string;
  courseId: string;
  title: string;
  description: string | null;
  position: number;
  externalSource: string | null;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DidactaLesson {
  id: string;
  tenantId: string;
  moduleId: string;
  type: 'VIDEO' | 'HTML' | 'PDF' | 'TEXT' | 'QUIZ' | 'SCORM';
  title: string;
  position: number;
  /// Content opaco (JSON). El shape depende del `type` — ver docs de mod.courses.
  content: Record<string, unknown>;
  durationMinutes: number | null;
  externalSource: string | null;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DidactaQuiz {
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
  createdAt: string;
  updatedAt: string;
}

export interface DidactaEnrollment {
  id: string;
  tenantId: string;
  userId: string;
  courseId: string;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'PAUSED';
  source: 'ADMIN' | 'CODE' | 'INVITATION_LINK' | 'PURCHASE' | 'IMPORT' | 'SUBSCRIPTION';
  progressPercent: number;
  externalSource: string | null;
  externalId: string | null;
  enrolledAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/// Resultado de una operación de upload de media. `storageKey` es opaco
/// y se pasa como referencia en `Lesson.content` (ej. `{ videoUrl: storageKey }`).
export interface DidactaMediaUpload {
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  /// SHA-256 del contenido. Permite al módulo detectar duplicados antes
  /// de subir el mismo asset dos veces.
  checksum: string;
  uploadedAt: string;
}

/// Resultado de un delete por externalRef. Indica si el recurso existía
/// y fue borrado, o si no existía (idempotencia: re-borrar es no-op OK).
export interface DidactaDeleteResult {
  deleted: boolean;
  /// ID del recurso borrado (para audit). null si no existía.
  resourceId: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inputs (lo mínimo que el host necesita para crear cada recurso)
// ─────────────────────────────────────────────────────────────────────────────

export interface DidactaUpsertUserInput extends DidactaExternalRef {
  email: string;
  name?: string;
  /// Rol asignado en el tenant. Default: 'alumno'.
  role?: 'tenant_admin' | 'formador' | 'alumno' | 'auditor' | 'empresa_manager';
  locale?: string;
  /// DNI/NIE en mayúsculas y sin separadores (Fundae). Validado por el core.
  documentId?: string;
  /// Si true, crea el user SIN enviar email de invitación/activación. El user
  /// queda igualmente en estado PENDING (puede activarse luego con resend-invite
  /// desde el admin). El migrador lo usa SIEMPRE: importa miles de users de un
  /// LMS de origen y NO queremos bombardearlos con emails durante la migración;
  /// el operador notifica después de forma explícita. Default (ausente/false):
  /// se envía el email de bienvenida — mismo comportamiento que el invite manual
  /// de un admin. Idempotente: si el user ya existe por externalRef, NUNCA se
  /// reenvía email (independiente de este flag).
  suppressInvite?: boolean;
}

export interface DidactaCreateCourseInput {
  slug: string;
  title: string;
  description?: string;
  language?: string;
  estimatedMinutes?: number;
  category?: string;
}

export interface DidactaUpsertCourseInput extends DidactaExternalRef, DidactaCreateCourseInput {}

export interface DidactaUpsertCourseModuleInput extends DidactaExternalRef {
  courseExternalRef: DidactaExternalRef;
  title: string;
  description?: string;
  position: number;
}

export interface DidactaUpsertLessonInput extends DidactaExternalRef {
  /// Referencia a la sección padre por externalRef. El host la resuelve a
  /// `moduleId` del core antes de invocar el service. Si la sección no
  /// existe (extracción out-of-order) → `DIDACTA_FOREIGN_REFERENCE`.
  moduleExternalRef: DidactaExternalRef;
  type: 'VIDEO' | 'HTML' | 'PDF' | 'TEXT' | 'QUIZ' | 'SCORM';
  title: string;
  position: number;
  content: Record<string, unknown>;
  durationMinutes?: number;
}

export interface DidactaUpsertQuizInput extends DidactaExternalRef {
  /// Si el quiz vive como lección (type=QUIZ), poner `lessonExternalRef`.
  /// Si el quiz es standalone (raro en LearnDash), omitir.
  lessonExternalRef?: DidactaExternalRef;
  title: string;
  description?: string;
  passThreshold?: number;
  maxAttempts?: number;
  timeLimitMinutes?: number;
  /// Questions van en bulk junto al quiz. El shape detallado lo valida
  /// el AssessmentsService del core (mismo schema que `mod.assessments`).
  questions?: unknown[];
}

/// Tipo de pregunta soportado por el AssessmentsService del core.
/// Si LearnDash trae un tipo no soportado (matrix, cloze, etc.) el módulo
/// debe convertirlo a uno soportado o mandarlo a DLQ.
export type DidactaQuestionType =
  | 'SINGLE_CHOICE'
  | 'MULTIPLE_CHOICE'
  | 'TRUE_FALSE'
  | 'FILL_IN'
  | 'OPEN_ENDED';

export interface DidactaQuestionOptionInput {
  /// Texto visible de la opción.
  label: string;
  /// Marca si es la respuesta correcta. Para SINGLE_CHOICE / TRUE_FALSE
  /// exactly una; para MULTIPLE_CHOICE puede haber varias.
  isCorrect: boolean;
}

export interface DidactaQuestionInput {
  type: DidactaQuestionType;
  /// Texto del enunciado de la pregunta. HTML permitido.
  prompt: string;
  /// Feedback general mostrado tras submit. HTML permitido. Opcional.
  feedback?: string;
  /// Puntos otorgados si la respuesta es correcta. Default 1.
  points?: number;
  /// Para FILL_IN / OPEN_ENDED: respuestas aceptadas. Para opciones,
  /// usar `options[]` en su lugar.
  acceptedAnswers?: string[];
  /// Opciones de respuesta. Vacío para FILL_IN / OPEN_ENDED.
  options?: DidactaQuestionOptionInput[];
}

export interface DidactaUpsertQuestionsInput {
  /// Quiz padre. El host lo resuelve a `quizId` del core via
  /// externalSource+externalId. Si el quiz no existe → DIDACTA_FOREIGN_REFERENCE.
  quizExternalRef: DidactaExternalRef;
  /// Lista de questions. **Semántica REPLACE**: el host borra TODAS las
  /// questions existentes del quiz antes de insertar las nuevas. Esto da
  /// idempotencia simple sin necesidad de externalId por pregunta. Si
  /// `questions = []` se borran todas las existentes (clear quiz).
  questions: DidactaQuestionInput[];
}

export interface DidactaQuestionsResult {
  quizId: string;
  createdCount: number;
  deletedCount: number;
}

export interface DidactaUpsertEnrollmentInput extends DidactaExternalRef {
  userExternalRef: DidactaExternalRef;
  courseExternalRef: DidactaExternalRef;
  status?: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'PAUSED';
  /// Cuándo se matriculó el usuario en el sistema origen. Si se omite,
  /// el host usa `now()`.
  enrolledAt?: string;
  /// Si el usuario ya completó el curso en origen, marcar `status: 'COMPLETED'`
  /// + `completedAt`. El progress se setea a 100 automáticamente.
  completedAt?: string;
}

export interface DidactaUploadFromUrlInput {
  /// URL pública o pre-signed del asset en origen. El host la baja con
  /// `ctx.http` aplicando los mismos guards (allowlist, SSRF, cap).
  /// IMPORTANTE: el host del URL debe estar en la allowlist HTTP del
  /// módulo. Si no lo está → `DIDACTA_VALIDATION_ERROR`.
  url: string;
  /// Content-Type esperado. El host valida que la respuesta haga match.
  contentType: string;
  /// Tamaño máximo aceptable del asset (bytes). Cap del host: 100 MB.
  maxBytes?: number;
}

export interface DidactaUploadFromBytesInput {
  bytes: Uint8Array;
  contentType: string;
  /// Filename original (solo para metadata; no afecta storageKey).
  filename?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// API por recurso
// ─────────────────────────────────────────────────────────────────────────────

export interface DidactaUsers {
  upsertByExternalRef(input: DidactaUpsertUserInput): Promise<DidactaUser>;
  findByExternalRef(ref: DidactaExternalRef): Promise<DidactaUser | null>;
  deleteByExternalRef(ref: DidactaExternalRef): Promise<DidactaDeleteResult>;
}

export interface DidactaCourses {
  /// Crea un curso nuevo sin externalRef. Útil para módulos que generan
  /// cursos sintéticos (ej. `mod.ai-content`). Retorna el curso completo.
  create(input: DidactaCreateCourseInput): Promise<DidactaCourse>;
  upsertByExternalRef(input: DidactaUpsertCourseInput): Promise<DidactaCourse>;
  findByExternalRef(ref: DidactaExternalRef): Promise<DidactaCourse | null>;
  /// Publica un curso DRAFT (mismo check que `CoursesService.publish` del core:
  /// debe tener al menos una lesson). Idempotente: re-publicar es no-op.
  publish(courseId: string): Promise<DidactaCourse>;
  deleteByExternalRef(ref: DidactaExternalRef): Promise<DidactaDeleteResult>;
}

export interface DidactaCourseModules {
  upsertByExternalRef(input: DidactaUpsertCourseModuleInput): Promise<DidactaCourseModule>;
  findByExternalRef(ref: DidactaExternalRef): Promise<DidactaCourseModule | null>;
  deleteByExternalRef(ref: DidactaExternalRef): Promise<DidactaDeleteResult>;
}

export interface DidactaLessons {
  upsertByExternalRef(input: DidactaUpsertLessonInput): Promise<DidactaLesson>;
  findByExternalRef(ref: DidactaExternalRef): Promise<DidactaLesson | null>;
  deleteByExternalRef(ref: DidactaExternalRef): Promise<DidactaDeleteResult>;
}

export interface DidactaQuizzes {
  upsertByExternalRef(input: DidactaUpsertQuizInput): Promise<DidactaQuiz>;
  findByExternalRef(ref: DidactaExternalRef): Promise<DidactaQuiz | null>;
  deleteByExternalRef(ref: DidactaExternalRef): Promise<DidactaDeleteResult>;
  /// DD-006 (alpha.56): bulk-create/replace de questions del quiz. Cierra
  /// el gap del warning emitido por upsertByExternalRef cuando recibe
  /// `questions` inline (hoy se ignoran). Semántica REPLACE: borra todas
  /// las existentes y crea las nuevas. Idempotente.
  upsertQuestions(input: DidactaUpsertQuestionsInput): Promise<DidactaQuestionsResult>;
}

export interface DidactaEnrollments {
  upsertByExternalRef(input: DidactaUpsertEnrollmentInput): Promise<DidactaEnrollment>;
  findByExternalRef(ref: DidactaExternalRef): Promise<DidactaEnrollment | null>;
  deleteByExternalRef(ref: DidactaExternalRef): Promise<DidactaDeleteResult>;
}

export interface DidactaMedia {
  uploadFromUrl(input: DidactaUploadFromUrlInput): Promise<DidactaMediaUpload>;
  uploadFromBytes(input: DidactaUploadFromBytesInput): Promise<DidactaMediaUpload>;
}

/// Surface principal expuesta al módulo en `ctx.didacta`. Cada recurso
/// vive en su propio interface — el módulo solo accede a los recursos
/// para los que declaró permisos.
export interface DidactaApi {
  users: DidactaUsers;
  courses: DidactaCourses;
  courseModules: DidactaCourseModules;
  lessons: DidactaLessons;
  quizzes: DidactaQuizzes;
  enrollments: DidactaEnrollments;
  media: DidactaMedia;
}

// ─────────────────────────────────────────────────────────────────────────────
// Caps duros del host
// ─────────────────────────────────────────────────────────────────────────────

/// Caps duros del cliente Didacta scoped a un módulo. Mirror de los
/// defaults usados en `sandboxed-didacta.service.ts` (DD-002). Cualquier
/// cambio requiere actualizar los dos sitios + bumpar `@didacta/module-package-spec`.
export const DIDACTA_CAPS = {
  /// Tope de questions por upsertQuiz. Más que esto significa quiz mal
  /// diseñado (el alumno debería tener un examen, no un cuestionario).
  MAX_QUESTIONS_PER_QUIZ: 200,
  /// Tope de bytes para `media.uploadFromBytes`. Para más, usar `uploadFromUrl`
  /// que streamea con cap 100 MB del cliente HTTP scoped.
  MAX_INLINE_UPLOAD_BYTES: 10 * 1024 * 1024,
  /// Tope del body content de una lesson. Más que esto debería ser asset.
  MAX_LESSON_CONTENT_BYTES: 256 * 1024,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Stubs: Blocked + Noop
// ─────────────────────────────────────────────────────────────────────────────

/// Cliente que rechaza TODA llamada con `DIDACTA_PERMISSION_DENIED`. Se
/// inyecta a los módulos que NO declaran el bloque `didacta` en su manifest.
/// Mensaje accionable para el dev: explica exactamente qué añadir al manifest.
export class BlockedDidactaApi implements DidactaApi {
  constructor(private readonly moduleName: string) {}

  readonly users: DidactaUsers = {
    upsertByExternalRef: async () => this.reject('users.upsertByExternalRef'),
    findByExternalRef: async () => this.reject('users.findByExternalRef'),
    deleteByExternalRef: async () => this.reject('users.deleteByExternalRef'),
  };
  readonly courses: DidactaCourses = {
    create: async () => this.reject('courses.create'),
    upsertByExternalRef: async () => this.reject('courses.upsertByExternalRef'),
    findByExternalRef: async () => this.reject('courses.findByExternalRef'),
    publish: async () => this.reject('courses.publish'),
    deleteByExternalRef: async () => this.reject('courses.deleteByExternalRef'),
  };
  readonly courseModules: DidactaCourseModules = {
    upsertByExternalRef: async () => this.reject('modules.upsertByExternalRef'),
    findByExternalRef: async () => this.reject('modules.findByExternalRef'),
    deleteByExternalRef: async () => this.reject('modules.deleteByExternalRef'),
  };
  readonly lessons: DidactaLessons = {
    upsertByExternalRef: async () => this.reject('lessons.upsertByExternalRef'),
    findByExternalRef: async () => this.reject('lessons.findByExternalRef'),
    deleteByExternalRef: async () => this.reject('lessons.deleteByExternalRef'),
  };
  readonly quizzes: DidactaQuizzes = {
    upsertByExternalRef: async () => this.reject('quizzes.upsertByExternalRef'),
    findByExternalRef: async () => this.reject('quizzes.findByExternalRef'),
    deleteByExternalRef: async () => this.reject('quizzes.deleteByExternalRef'),
    upsertQuestions: async () => this.reject('quizzes.upsertQuestions'),
  };
  readonly enrollments: DidactaEnrollments = {
    upsertByExternalRef: async () => this.reject('enrollments.upsertByExternalRef'),
    findByExternalRef: async () => this.reject('enrollments.findByExternalRef'),
    deleteByExternalRef: async () => this.reject('enrollments.deleteByExternalRef'),
  };
  readonly media: DidactaMedia = {
    uploadFromUrl: async () => this.reject('media.uploadFromUrl'),
    uploadFromBytes: async () => this.reject('media.uploadFromBytes'),
  };

  private reject(method: string): never {
    throw new DidactaError(
      'DIDACTA_PERMISSION_DENIED',
      `Módulo "${this.moduleName}" intentó usar ctx.didacta.${method} pero no declara el bloque \`didacta\` en su manifest. Añadí didacta: { externalSource: "<tu-source>", permissions: ["${method}", ...] } al module.json para habilitar la API pública del core.`,
    );
  }
}

/// Placeholder histórico (transición). Se mantiene SOLO para los tests del
/// dispatcher que fijan el contrato cuando no hay implementación cableada.
/// En runtime el dispatcher usa `BlockedDidactaApi` (módulo sin manifest.didacta)
/// o `ScopedDidactaApi` (módulo con permisos declarados).
export class NoopDidactaApi implements DidactaApi {
  readonly users: DidactaUsers = noopResource('users');
  readonly courses: DidactaCourses = {
    create: async () => noopReject('courses.create'),
    upsertByExternalRef: async () => noopReject('courses.upsertByExternalRef'),
    findByExternalRef: async () => noopReject('courses.findByExternalRef'),
    publish: async () => noopReject('courses.publish'),
    deleteByExternalRef: async () => noopReject('courses.deleteByExternalRef'),
  };
  readonly courseModules: DidactaCourseModules = noopResource('modules');
  readonly lessons: DidactaLessons = noopResource('lessons');
  readonly quizzes: DidactaQuizzes = {
    ...noopResource<DidactaQuizzes>('quizzes'),
    upsertQuestions: async () => noopReject('quizzes.upsertQuestions'),
  };
  readonly enrollments: DidactaEnrollments = noopResource('enrollments');
  readonly media: DidactaMedia = {
    uploadFromUrl: async () => noopReject('media.uploadFromUrl'),
    uploadFromBytes: async () => noopReject('media.uploadFromBytes'),
  };
}

function noopReject(method: string): never {
  throw new DidactaError(
    'DIDACTA_INTERNAL_ERROR',
    `NoopDidactaApi invocado en ${method} — esto solo debería ocurrir en tests. En runtime el dispatcher inyecta BlockedDidactaApi o ScopedDidactaApi.`,
  );
}

function noopResource<T extends { upsertByExternalRef: unknown }>(name: string): T {
  return {
    upsertByExternalRef: async () => noopReject(`${name}.upsertByExternalRef`),
    findByExternalRef: async () => noopReject(`${name}.findByExternalRef`),
    deleteByExternalRef: async () => noopReject(`${name}.deleteByExternalRef`),
  } as unknown as T;
}
