/**
 * Helpers que hablan directo con la API REST para bootstrap del entorno de test.
 * Todo lo que no es estrictamente UI lo hacemos por API: más rápido y menos frágil.
 */

import { authenticator } from 'otplib';

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  tenantId: string;
  tenantSlug: string;
  roles: string[];
  mfaEnabled: boolean;
}

interface AuthResponse {
  tokens: Tokens;
  mfaRequired: boolean;
  user: AuthUser;
}

interface MfaSetupResponse {
  /**
   * URL `otpauth://totp/...?secret=XXX&issuer=YYY` que el endpoint
   * `POST /auth/mfa/setup` devuelve para que el cliente arme el QR. El
   * secret base32 viaja en el query string.
   */
  otpauthUrl: string;
  qrCodeDataUrl: string;
  recoveryCodes: string[];
}

interface MfaEnableResponse {
  enabled: true;
  tokens: Tokens;
}

/**
 * Extrae el secret base32 del query `?secret=` de un `otpauth://...` URL.
 * Hecho con regex porque Node URL parser puede tropezar con el path con
 * `:` (ej. `/Didacta:user@example.com`) interpretándolo como puerto.
 */
function extractOtpSecret(otpauthUrl: string): string {
  const m = otpauthUrl.match(/[?&]secret=([^&]+)/);
  if (!m || !m[1]) {
    throw new Error(`otpauthUrl no contiene secret en query string: ${otpauthUrl}`);
  }
  return decodeURIComponent(m[1]);
}

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; bearer?: string } = {},
): Promise<T> {
  // Solo setear Content-Type cuando enviamos body. Fastify rechaza con
  // 400 "Body cannot be empty when content-type is set to 'application/json'"
  // si llega Content-Type sin body — afecta a endpoints como
  // POST /auth/mfa/setup que no esperan payload.
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.bearer) headers['Authorization'] = `Bearer ${init.bearer}`;

  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'message' in body
        ? String((body as { message: unknown }).message)
        : res.statusText;
    throw new Error(`API ${init.method ?? 'GET'} ${path} -> ${res.status}: ${message}`);
  }
  return body as T;
}

export async function signup(args: {
  tenantSlug: string;
  email: string;
  password: string;
  name?: string;
}): Promise<AuthResponse> {
  return api<AuthResponse>('/api/v1/auth/signup', { method: 'POST', body: args });
}

export async function signin(args: {
  tenantSlug: string;
  email: string;
  password: string;
}): Promise<AuthResponse> {
  return api<AuthResponse>('/api/v1/auth/signin', { method: 'POST', body: args });
}

/**
 * Para usuarios con rol administrativo (que requieren MFA), corre el flow:
 *   POST /auth/mfa/setup     → genera nuevo secret + recoveryCodes (deja MFA disabled)
 *   POST /auth/mfa/enable    → confirma con primer TOTP, activa MFA y devuelve tokens elevados
 *
 * `verify` no aplica acá: ese endpoint requiere `mfaEnabled: true` en DB
 * (es para iniciar sesión cuando MFA ya está activado). El flow de
 * primera vez (E2E ejecuta esto cada run con un admin distinto) usa
 * setup → enable.
 *
 * Devuelve el access token con mfaVerified=true y el secret recién
 * generado (por si el spec necesita más codes después).
 */
export async function setupMfaAndVerify(
  bearer: string,
): Promise<{ accessToken: string; secret: string }> {
  const setup = await api<MfaSetupResponse>('/api/v1/auth/mfa/setup', {
    method: 'POST',
    bearer,
  });
  const secret = extractOtpSecret(setup.otpauthUrl);
  const code = authenticator.generate(secret);
  const enabled = await api<MfaEnableResponse>('/api/v1/auth/mfa/enable', {
    method: 'POST',
    body: { code },
    bearer,
  });
  return { accessToken: enabled.tokens.accessToken, secret };
}

interface CourseDetail {
  id: string;
  slug: string;
  title: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  modules: Array<{
    id: string;
    title: string;
    lessons: Array<{ id: string; title: string; type: string; content?: Record<string, unknown> }>;
  }>;
}

interface QuizFormadorView {
  id: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  questions: Array<{
    id: string;
    type: 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'TRUE_FALSE';
    options: Array<{ id: string; isCorrect: boolean }>;
  }>;
}

interface InvitationCreated {
  id: string;
  code: string;
  token: string;
  courseId: string;
}

export async function createPublishedCourse(args: {
  bearer: string;
  title: string;
  slug: string;
}): Promise<CourseDetail> {
  // 1. Curso DRAFT
  const course = await api<{ id: string }>('/api/v1/modules/courses', {
    method: 'POST',
    body: {
      title: args.title,
      slug: args.slug,
      description: 'Curso E2E generado automáticamente',
      category: 'general',
    },
    bearer: args.bearer,
  });

  // 2. Módulo
  const moduleResp = await api<{ id: string }>(`/api/v1/modules/courses/${course.id}/modules`, {
    method: 'POST',
    body: { title: 'Módulo 1', orderIndex: 0 },
    bearer: args.bearer,
  });

  // 3. Lección de tipo TEXT (la más fácil de completar)
  await api(`/api/v1/modules/courses/modules/${moduleResp.id}/lessons`, {
    method: 'POST',
    body: {
      title: 'Lección 1',
      type: 'TEXT',
      orderIndex: 0,
      content: { text: 'Contenido de la lección.' },
      durationSec: 60,
    },
    bearer: args.bearer,
  });

  // 4. Publicar
  await api(`/api/v1/modules/courses/${course.id}/publish`, {
    method: 'POST',
    bearer: args.bearer,
  });

  // 5. Devolver detalle (con lecciones para que el test sepa los IDs)
  return api<CourseDetail>(`/api/v1/modules/courses/${course.id}`, { bearer: args.bearer });
}

/**
 * Como `createPublishedCourse` pero con UNA lección de tipo HTML cuyo `content.html`
 * embebe el HTML que se pase (típicamente un `<iframe>` de vídeo). Sirve para
 * reproducir el caso "vídeo incrustado en texto enriquecido" y verificar que el
 * player NO recrea el iframe en cada reporte de progreso (regresión del corte de
 * vídeo cada 20-60s).
 */
export async function createPublishedCourseWithHtmlLesson(args: {
  bearer: string;
  title: string;
  slug: string;
  html: string;
}): Promise<CourseDetail> {
  const course = await api<{ id: string }>('/api/v1/modules/courses', {
    method: 'POST',
    body: {
      title: args.title,
      slug: args.slug,
      description: 'Curso E2E con lección HTML',
      category: 'general',
    },
    bearer: args.bearer,
  });

  const moduleResp = await api<{ id: string }>(`/api/v1/modules/courses/${course.id}/modules`, {
    method: 'POST',
    body: { title: 'Módulo 1', orderIndex: 0 },
    bearer: args.bearer,
  });

  await api(`/api/v1/modules/courses/modules/${moduleResp.id}/lessons`, {
    method: 'POST',
    body: {
      title: 'Lección con vídeo embebido',
      type: 'HTML',
      orderIndex: 0,
      content: { html: args.html },
      durationSec: 300,
    },
    bearer: args.bearer,
  });

  await api(`/api/v1/modules/courses/${course.id}/publish`, {
    method: 'POST',
    bearer: args.bearer,
  });

  return api<CourseDetail>(`/api/v1/modules/courses/${course.id}`, { bearer: args.bearer });
}

export async function trackProgress(args: {
  bearer: string;
  enrollmentId: string;
  lessonId: string;
  durationSec: number;
}): Promise<{ progressPercent: number }> {
  const result = await api<{ progressPercent: number }>('/api/v1/modules/learning/progress', {
    method: 'POST',
    body: {
      enrollmentId: args.enrollmentId,
      lessonId: args.lessonId,
      watchedSeconds: args.durationSec,
      resumePositionSec: args.durationSec,
      completed: true,
    },
    bearer: args.bearer,
  });
  return result;
}

export async function listEnrollments(
  bearer: string,
): Promise<Array<{ id: string; courseId: string; status: string; progressPercent: number }>> {
  return api('/api/v1/modules/learning/me/enrollments', { bearer });
}

/** Crear invitación para un curso publicado (admin). */
export async function createInvitation(args: {
  bearer: string;
  courseId: string;
  maxUses?: number;
  expiresAt?: string;
}): Promise<InvitationCreated> {
  return api<InvitationCreated>('/api/v1/modules/learning/invitations', {
    method: 'POST',
    body: {
      courseId: args.courseId,
      ...(args.maxUses ? { maxUses: args.maxUses } : {}),
      ...(args.expiresAt ? { expiresAt: args.expiresAt } : {}),
    },
    bearer: args.bearer,
  });
}

/**
 * Crea, configura y publica un quiz vinculado a una lección de tipo QUIZ.
 *
 * El quiz queda con 1 pregunta SINGLE_CHOICE de 1 punto, threshold 50%.
 * Devuelve la vista formador con `questions[].options[].isCorrect` para que
 * el spec sepa cuál marcar al responderlo.
 */
export async function createPublishedQuizForLesson(args: {
  bearer: string;
  lessonId: string;
  passThreshold?: number;
}): Promise<{ quizId: string; correctOptionId: string; questionId: string }> {
  const created = await api<{ id: string }>('/api/v1/modules/assessments/quizzes', {
    method: 'POST',
    body: {
      lessonId: args.lessonId,
      title: 'Quiz E2E',
      passThreshold: args.passThreshold ?? 50,
    },
    bearer: args.bearer,
  });
  await api(`/api/v1/modules/assessments/quizzes/${created.id}/questions`, {
    method: 'POST',
    body: {
      type: 'SINGLE_CHOICE',
      prompt: '¿2 + 2?',
      points: 1,
      options: [
        { label: '3', isCorrect: false },
        { label: '4', isCorrect: true },
      ],
    },
    bearer: args.bearer,
  });
  await api(`/api/v1/modules/assessments/quizzes/${created.id}/publish`, {
    method: 'POST',
    bearer: args.bearer,
  });
  // Releer para obtener IDs de opciones (no devuelven en POST raw aunque addQuestion sí)
  const full = await api<QuizFormadorView>(`/api/v1/modules/assessments/quizzes/${created.id}`, {
    bearer: args.bearer,
  });
  const question = full.questions[0];
  if (!question) throw new Error('Quiz E2E quedó sin preguntas tras publish');
  const correct = question.options.find((o) => o.isCorrect);
  if (!correct) throw new Error('Pregunta E2E sin opción correcta');
  return { quizId: created.id, questionId: question.id, correctOptionId: correct.id };
}

/**
 * Crea, configura y publica un quiz con UNA pregunta SHORT_ANSWER (sin
 * auto-corrección). Pensado para testear el flujo PENDING_REVIEW + grading.
 */
export async function createPublishedShortAnswerQuiz(args: {
  bearer: string;
  lessonId: string;
  passThreshold?: number;
  points?: number;
}): Promise<{ quizId: string; questionId: string; questionPoints: number }> {
  const points = args.points ?? 5;
  const created = await api<{ id: string }>('/api/v1/modules/assessments/quizzes', {
    method: 'POST',
    body: {
      lessonId: args.lessonId,
      title: 'Quiz E2E SHORT_ANSWER',
      passThreshold: args.passThreshold ?? 60,
    },
    bearer: args.bearer,
  });
  const question = await api<{ id: string }>(
    `/api/v1/modules/assessments/quizzes/${created.id}/questions`,
    {
      method: 'POST',
      body: {
        type: 'SHORT_ANSWER',
        prompt: 'Explica brevemente qué es Postgres.',
        points,
      },
      bearer: args.bearer,
    },
  );
  await api(`/api/v1/modules/assessments/quizzes/${created.id}/publish`, {
    method: 'POST',
    bearer: args.bearer,
  });
  return { quizId: created.id, questionId: question.id, questionPoints: points };
}

/**
 * Crea un curso DRAFT con una lección de tipo QUIZ vinculada a un quiz
 * publicado, y publica el curso. Devuelve el detalle + ids del quiz.
 */
export async function createPublishedCourseWithQuiz(args: {
  bearer: string;
  title: string;
  slug: string;
}): Promise<{ course: CourseDetail; quizId: string; correctOptionId: string; questionId: string }> {
  const course = await api<{ id: string }>('/api/v1/modules/courses', {
    method: 'POST',
    body: {
      title: args.title,
      slug: args.slug,
      description: 'Curso E2E con quiz',
      category: 'general',
    },
    bearer: args.bearer,
  });
  const moduleResp = await api<{ id: string }>(`/api/v1/modules/courses/${course.id}/modules`, {
    method: 'POST',
    body: { title: 'Módulo único', orderIndex: 0 },
    bearer: args.bearer,
  });
  const lesson = await api<{ id: string }>(
    `/api/v1/modules/courses/modules/${moduleResp.id}/lessons`,
    {
      method: 'POST',
      body: {
        title: 'Quiz lesson',
        type: 'QUIZ',
        orderIndex: 0,
        content: {},
        durationSec: 60,
      },
      bearer: args.bearer,
    },
  );
  const quiz = await createPublishedQuizForLesson({ bearer: args.bearer, lessonId: lesson.id });
  // Vincular el quiz a la lección actualizando lesson.content.quizId
  await api(`/api/v1/modules/courses/lessons/${lesson.id}`, {
    method: 'PUT',
    body: { content: { quizId: quiz.quizId } },
    bearer: args.bearer,
  });
  await api(`/api/v1/modules/courses/${course.id}/publish`, {
    method: 'POST',
    bearer: args.bearer,
  });
  const detail = await api<CourseDetail>(`/api/v1/modules/courses/${course.id}`, {
    bearer: args.bearer,
  });
  return { course: detail, ...quiz };
}

/**
 * Crea un curso DRAFT con una lección QUIZ vinculada a un quiz SHORT_ANSWER
 * publicado. Pensado para tests de grading manual.
 */
export async function createPublishedCourseWithShortAnswerQuiz(args: {
  bearer: string;
  title: string;
  slug: string;
}): Promise<{ course: CourseDetail; quizId: string; questionId: string; questionPoints: number }> {
  const course = await api<{ id: string }>('/api/v1/modules/courses', {
    method: 'POST',
    body: {
      title: args.title,
      slug: args.slug,
      description: 'Curso E2E con quiz de respuesta corta',
      category: 'general',
    },
    bearer: args.bearer,
  });
  const moduleResp = await api<{ id: string }>(`/api/v1/modules/courses/${course.id}/modules`, {
    method: 'POST',
    body: { title: 'Módulo único', orderIndex: 0 },
    bearer: args.bearer,
  });
  const lesson = await api<{ id: string }>(
    `/api/v1/modules/courses/modules/${moduleResp.id}/lessons`,
    {
      method: 'POST',
      body: {
        title: 'Quiz lesson SHORT',
        type: 'QUIZ',
        orderIndex: 0,
        content: {},
        durationSec: 60,
      },
      bearer: args.bearer,
    },
  );
  const quiz = await createPublishedShortAnswerQuiz({ bearer: args.bearer, lessonId: lesson.id });
  await api(`/api/v1/modules/courses/lessons/${lesson.id}`, {
    method: 'PUT',
    body: { content: { quizId: quiz.quizId } },
    bearer: args.bearer,
  });
  await api(`/api/v1/modules/courses/${course.id}/publish`, {
    method: 'POST',
    bearer: args.bearer,
  });
  const detail = await api<CourseDetail>(`/api/v1/modules/courses/${course.id}`, {
    bearer: args.bearer,
  });
  return { course: detail, ...quiz };
}

/** Crea una API key del tenant (admin). Devuelve el token en plano (única vez). */
export async function createTenantApiKey(args: {
  bearer: string;
  name: string;
  scopes?: string[];
}): Promise<{ id: string; token: string; scopes: string[] }> {
  return api('/api/v1/admin/api-keys', {
    method: 'POST',
    body: { name: args.name, scopes: args.scopes ?? ['enrollments:write'] },
    bearer: args.bearer,
  });
}

interface InscribeResponse {
  userId: string;
  userCreated: boolean;
  enrollments: Array<{
    courseId: string;
    enrollmentId: string | null;
    status: 'ACTIVE' | 'FAILED';
    alreadyEnrolled: boolean;
    error?: string;
  }>;
}

/**
 * Llama a `POST /api/v1/inscribe` autenticando con `Authorization: ApiKey <token>`
 * (no Bearer). Replica lo que haría una página de ventas externa tras un pago.
 */
export async function inscribeViaApi(args: {
  apiKey: string;
  email: string;
  name?: string;
  courseIds: string[];
}): Promise<InscribeResponse> {
  const res = await fetch(`${API_URL}/api/v1/inscribe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `ApiKey ${args.apiKey}`,
    },
    body: JSON.stringify({
      email: args.email,
      ...(args.name ? { name: args.name } : {}),
      courseIds: args.courseIds,
    }),
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'message' in body
        ? String((body as { message: unknown }).message)
        : res.statusText;
    throw new Error(`POST /inscribe -> ${res.status}: ${message}`);
  }
  return body as InscribeResponse;
}

export interface RevokeResponse {
  userFound: boolean;
  userId: string | null;
  revoked: Array<{ courseId: string; status: 'REVOKED' | 'NOT_ENROLLED' }>;
}

/** Baja por reembolso/cancelación: `POST /api/v1/inscribe/revoke` con API key. */
export async function revokeViaApi(args: {
  apiKey: string;
  email: string;
  courseIds: string[];
  externalRef?: string;
  reason?: string;
}): Promise<RevokeResponse> {
  const res = await fetch(`${API_URL}/api/v1/inscribe/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `ApiKey ${args.apiKey}`,
    },
    body: JSON.stringify({
      email: args.email,
      courseIds: args.courseIds,
      ...(args.externalRef ? { externalRef: args.externalRef } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
    }),
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'message' in body
        ? String((body as { message: unknown }).message)
        : res.statusText;
    throw new Error(`POST /inscribe/revoke -> ${res.status}: ${message}`);
  }
  return body as RevokeResponse;
}

export interface ApiCourseSummary {
  id: string;
  title: string;
  slug: string;
  status: string;
  category: string | null;
  publishedAt: string | null;
}

/** Catálogo para mapear producto externo → curso: `GET /api/v1/inscribe/courses`. */
export async function listCoursesViaApi(args: {
  apiKey: string;
}): Promise<{ courses: ApiCourseSummary[]; status: number }> {
  const res = await fetch(`${API_URL}/api/v1/inscribe/courses`, {
    headers: { Authorization: `ApiKey ${args.apiKey}` },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as { courses?: ApiCourseSummary[] }) : null;
  return { courses: body?.courses ?? [], status: res.status };
}

export async function adminTokenForBootstrap(tenantSlug: string): Promise<string> {
  const adminSeedEmail = process.env.E2E_ADMIN_EMAIL;
  const adminSeedPassword = process.env.E2E_ADMIN_PASSWORD;
  if (!adminSeedEmail || !adminSeedPassword) {
    throw new Error(
      'E2E_ADMIN_EMAIL y E2E_ADMIN_PASSWORD son obligatorios (usuario seed con rol admin).',
    );
  }
  const adminSession = await signin({
    tenantSlug,
    email: adminSeedEmail,
    password: adminSeedPassword,
  });
  let adminToken = adminSession.tokens.accessToken;
  if (adminSession.mfaRequired) {
    const verified = await setupMfaAndVerify(adminToken);
    adminToken = verified.accessToken;
  }
  return adminToken;
}

export interface BootstrapResult {
  tenantSlug: string;
  course: CourseDetail;
  alumno: {
    email: string;
    password: string;
    accessToken: string;
    user: AuthUser;
  };
}

/**
 * Crea desde cero (asumiendo seed inicial ya corrido):
 * - admin con MFA verificado
 * - curso publicado con 1 lección TEXT
 * - alumno (rol por defecto, sin MFA) con session activa
 */
export async function bootstrapScenario(): Promise<BootstrapResult> {
  const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
  const stamp = Date.now();
  const adminEmail = `e2e-admin-${stamp}@example.test`;
  const alumnoEmail = `e2e-alumno-${stamp}@example.test`;
  const password = 'E2eTestPassword123!';

  // 1. Admin: signup -> MFA setup -> verify
  // Para que tenga rol formador hace falta asignárselo manualmente. Por ahora
  // asumimos que el seed corrió y existe un super_admin con credenciales conocidas.
  const adminSeedEmail = process.env.E2E_ADMIN_EMAIL;
  const adminSeedPassword = process.env.E2E_ADMIN_PASSWORD;
  if (!adminSeedEmail || !adminSeedPassword) {
    throw new Error(
      'E2E_ADMIN_EMAIL y E2E_ADMIN_PASSWORD son obligatorios (usuario seed con rol admin).',
    );
  }
  const adminSession = await signin({
    tenantSlug,
    email: adminSeedEmail,
    password: adminSeedPassword,
  });
  let adminToken = adminSession.tokens.accessToken;
  if (adminSession.mfaRequired) {
    const verified = await setupMfaAndVerify(adminToken);
    adminToken = verified.accessToken;
  }

  // 2. Crear curso publicado
  const course = await createPublishedCourse({
    bearer: adminToken,
    title: `Curso E2E ${stamp}`,
    slug: `curso-e2e-${stamp}`,
  });

  // 3. Alumno: signup. Sin rol admin -> sin MFA.
  const alumno = await signup({
    tenantSlug,
    email: alumnoEmail,
    password,
    name: 'Alumno E2E',
  });

  // Alumnos no llevan MFA si no son admins -> token ya viene mfaVerified.
  // Por las dudas, si flag dice required, lo manejamos.
  let alumnoToken = alumno.tokens.accessToken;
  if (alumno.mfaRequired) {
    const verified = await setupMfaAndVerify(alumnoToken);
    alumnoToken = verified.accessToken;
  }

  // adminEmail no se usa para nada visible — silencio TS marcando como void
  void adminEmail;

  return {
    tenantSlug,
    course,
    alumno: {
      email: alumnoEmail,
      password,
      accessToken: alumnoToken,
      user: alumno.user,
    },
  };
}
