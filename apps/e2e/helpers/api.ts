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
  secret: string;
  otpAuthUrl: string;
}

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; bearer?: string } = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(init.bearer ? { Authorization: `Bearer ${init.bearer}` } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
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
 * setup -> verify con código TOTP generado de otplib.
 * Devuelve el access token verificado (mfaVerified=true).
 */
export async function setupMfaAndVerify(
  bearer: string,
): Promise<{ accessToken: string; secret: string }> {
  const setup = await api<MfaSetupResponse>('/api/v1/auth/mfa/setup', {
    method: 'POST',
    bearer,
  });
  const code = authenticator.generate(setup.secret);
  const verified = await api<{ tokens: Tokens }>('/api/v1/auth/mfa/verify', {
    method: 'POST',
    body: { code },
    bearer,
  });
  return { accessToken: verified.tokens.accessToken, secret: setup.secret };
}

interface CourseDetail {
  id: string;
  slug: string;
  title: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  modules: Array<{
    id: string;
    title: string;
    lessons: Array<{ id: string; title: string; type: string }>;
  }>;
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
  const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
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
