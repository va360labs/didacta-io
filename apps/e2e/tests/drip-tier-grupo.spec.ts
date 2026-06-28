import { expect, test } from '@playwright/test';
import { injectSession } from '../helpers/auth';

/**
 * EVIDENCIA E2E — DRIP de lecciones por tier/grupo + vínculo Tier↔Grupo.
 *
 * Prueba el flujo COMPLETO contra el stack vivo (dev):
 *   1. availability: con un drip de 7 días por lección, la lección 0 está libre y
 *      la lección 1 bloqueada con fecha de desbloqueo ≈ matrícula + 7 días.
 *   2. enforcement: el alumno NO puede registrar progreso en la lección bloqueada
 *      (403 LESSON_LOCKED); sí en la libre (200).
 *   3. UI alumno: la lección bloqueada muestra el candado + el card "no disponible"
 *      (captura screenshot).
 *   4. UI admin: el panel de drip del editor de curso muestra el calendario
 *      (captura screenshot).
 *   5. vínculo tier→grupo: PATCH linkedTierName persiste y el grupo aparece con el
 *      badge del tier en /admin/grupos-acceso (captura screenshot).
 *
 * Self-contained: usa signin plano (sin tocar el MFA del admin seed). Las
 * capturas quedan en apps/e2e/drip-evidence/*.png como evidencia revisable.
 *
 * Requiere: E2E_API_URL + E2E_BASE_URL (dev) + E2E_ADMIN_EMAIL/PASSWORD seed.
 */

const API = process.env.E2E_API_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const SHOTS = 'drip-evidence';

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
  tokens: { accessToken: string; refreshToken: string };
  mfaRequired: boolean;
  user: AuthUser;
}

async function http<T>(
  path: string,
  init: { method?: string; body?: unknown; bearer?: string } = {},
): Promise<{ ok: boolean; status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.bearer) headers['Authorization'] = `Bearer ${init.bearer}`;
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

// ── Estado compartido (setup una vez, fullyParallel:false + workers:1) ──────────
let adminToken = '';
let adminUser: AuthUser;
let studentToken = '';
let studentUser: AuthUser;
let courseId = '';
let courseSlug = '';
let enrollmentId = '';
let lesson0 = '';
let lesson1 = '';
let dripId = '';
let studentOnboardedAt = '';
let evidenciaTierId = '';
let enrolledAt = '';
let availability: {
  drip: boolean;
  lessons: Record<string, { availableAt: string; available: boolean }>;
};

const stamp = Date.now();

test.beforeAll(async () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_EMAIL/PASSWORD requeridos');

  // 1. Admin (signin plano, NO toca MFA).
  const adminRes = await http<AuthResponse>('/api/v1/auth/signin', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(adminRes.ok, `admin signin (got ${adminRes.status})`).toBe(true);
  adminToken = adminRes.body.tokens.accessToken;
  adminUser = adminRes.body.user;

  // 2. Curso DRAFT + módulo + 2 lecciones TEXT + publicar.
  const course = (
    await http<{ id: string; slug: string }>('/api/v1/modules/courses', {
      method: 'POST',
      bearer: adminToken,
      body: {
        title: `Drip Evidence ${stamp}`,
        slug: `drip-evidence-${stamp}`,
        description: 'Curso de evidencia E2E del drip',
        category: 'general',
      },
    })
  ).body;
  courseId = course.id;
  courseSlug = course.slug;

  const mod = (
    await http<{ id: string }>(`/api/v1/modules/courses/${courseId}/modules`, {
      method: 'POST',
      bearer: adminToken,
      body: { title: 'Módulo 1', orderIndex: 0 },
    })
  ).body;

  for (const [i, title] of [
    ['0', 'Lección 1 (libre)'],
    ['1', 'Lección 2 (drip +7d)'],
  ]) {
    await http(`/api/v1/modules/courses/modules/${mod.id}/lessons`, {
      method: 'POST',
      bearer: adminToken,
      body: {
        title,
        type: 'TEXT',
        orderIndex: Number(i),
        content: { text: `Contenido ${title}` },
        durationSec: 60,
      },
    });
  }
  await http(`/api/v1/modules/courses/${courseId}/publish`, { method: 'POST', bearer: adminToken });

  // La API devuelve módulos y lecciones ya ordenados por `position` asc.
  const detail = (
    await http<{
      modules: Array<{ lessons: Array<{ id: string }> }>;
    }>(`/api/v1/modules/courses/${courseId}`, { bearer: adminToken })
  ).body;
  const lessons = detail.modules.flatMap((m) => m.lessons);
  expect(lessons.length, 'el curso tiene 2 lecciones').toBeGreaterThanOrEqual(2);
  lesson0 = lessons[0]!.id;
  lesson1 = lessons[1]!.id;

  // 3. Alumno nuevo (signup; sin MFA) en el mismo tenant que el admin.
  const studentRes = await http<AuthResponse>('/api/v1/auth/signup', {
    method: 'POST',
    body: {
      tenantSlug: adminUser.tenantSlug,
      email: `e2e-drip-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Alumno Drip E2E',
    },
  });
  expect(studentRes.ok, `student signup (got ${studentRes.status})`).toBe(true);
  studentToken = studentRes.body.tokens.accessToken;
  studentUser = studentRes.body.user;

  // 4. Completar onboarding del alumno (foto OBLIGATORIA) para que el web no lo
  //    redirija al asistente y pueda entrar al curso.
  await http('/api/v1/me/profile', {
    method: 'PATCH',
    bearer: studentToken,
    body: { avatarUrl: 'https://example.test/avatar-e2e.png' },
  });
  const onb = await http<{ onboardingCompletedAt: string }>('/api/v1/me/onboarding/complete', {
    method: 'POST',
    bearer: studentToken,
  });
  studentOnboardedAt = onb.body?.onboardingCompletedAt ?? new Date().toISOString();

  // 5. Matrícula del alumno.
  const enroll = await http<{ id: string; enrolledAt: string }>(
    '/api/v1/modules/learning/enrollments/me',
    { method: 'POST', bearer: studentToken, body: { courseId } },
  );
  expect(enroll.ok, `self-enroll (got ${enroll.status})`).toBe(true);
  enrollmentId = enroll.body.id;
  enrolledAt = enroll.body.enrolledAt;

  // 5. Drip: TIER del alumno (lo asignamos manual) cada 7 días, por lección.
  //    Asignamos al alumno el tier "Evidencia" y creamos el drip para ese tier
  //    → prueba el camino real (tier efectivo → regla aplicable).
  // Creamos el tier de catálogo y se lo asignamos manualmente al alumno.
  const tier = await http<{ tier: { id: string } }>(
    '/api/v1/modules/payment-connections/tiers/catalog',
    { method: 'POST', bearer: adminToken, body: { name: `Evidencia ${stamp}` } },
  );
  expect(tier.ok, `crear tier (got ${tier.status}; el admin seed debe ser super_admin)`).toBe(true);
  evidenciaTierId = tier.body.tier.id;
  const assign = await http(`/api/v1/modules/payment-connections/user-tiers/${studentUser.id}`, {
    method: 'PUT',
    bearer: adminToken,
    body: { tierId: evidenciaTierId },
  });
  expect(assign.ok, `asignar tier al alumno (got ${assign.status})`).toBe(true);
  const drip = await http<{ schedule: { id: string } }>(
    `/api/v1/modules/learning/courses/${courseId}/drip`,
    {
      method: 'POST',
      bearer: adminToken,
      body: {
        audienceKind: 'TIER',
        audienceRef: `Evidencia ${stamp}`,
        unit: 'LESSON',
        intervalDays: 7,
        startOffsetDays: 0,
      },
    },
  );
  expect(drip.ok, `crear drip (got ${drip.status})`).toBe(true);
  dripId = drip.body.schedule.id;

  // Disponibilidad del alumno (el cálculo real con su tier efectivo).
  availability = (
    await http<typeof availability>(`/api/v1/modules/learning/courses/${courseId}/availability`, {
      bearer: studentToken,
    })
  ).body;
});

test.afterAll(async () => {
  if (dripId && adminToken) {
    await http(`/api/v1/modules/learning/drip/${dripId}`, { method: 'DELETE', bearer: adminToken });
  }
});

test('1) availability: lección 0 libre, lección 1 bloqueada en enrolledAt + EXACTAMENTE 7 días', async () => {
  expect(availability.drip, 'el curso tiene drip para este alumno').toBe(true);
  expect(availability.lessons[lesson0]?.available, 'lección 0 disponible').toBe(true);
  expect(availability.lessons[lesson1]?.available, 'lección 1 bloqueada').toBe(false);
  // Ancla = enrolledAt (sin progreso aún → startedAt null). La fórmula es
  // exacta: unlock(L1) = enrolledAt + 1×7 días. Tolerancia 2s (no ±1 día) para
  // que un bug de la aritmética del offset NO pase desapercibido.
  const unlock = new Date(availability.lessons[lesson1]!.availableAt).getTime();
  const expected = new Date(enrolledAt).getTime() + 7 * 24 * 60 * 60 * 1000;
  expect(Math.abs(unlock - expected), 'unlock == enrolledAt + 7d exacto').toBeLessThan(2000);
  // Y la lección 0 se desbloquea EN el ancla (offset 0), no antes ni después.
  const unlock0 = new Date(availability.lessons[lesson0]!.availableAt).getTime();
  expect(Math.abs(unlock0 - new Date(enrolledAt).getTime())).toBeLessThan(2000);
});

test('2) enforcement: progreso en lección BLOQUEADA → 403 LESSON_LOCKED', async () => {
  const res = await http<{ code?: string }>('/api/v1/modules/learning/progress', {
    method: 'POST',
    bearer: studentToken,
    body: { enrollmentId, lessonId: lesson1, watchedSeconds: 30, completed: true },
  });
  expect(res.status, 'lección bloqueada → 403').toBe(403);
  expect(res.body.code).toBe('LESSON_LOCKED');
});

test('3) enforcement: progreso en lección LIBRE → 200', async () => {
  const res = await http('/api/v1/modules/learning/progress', {
    method: 'POST',
    bearer: studentToken,
    body: { enrollmentId, lessonId: lesson0, watchedSeconds: 60, completed: true },
  });
  expect(res.ok, `lección libre → 200 (got ${res.status})`).toBe(true);
});

test('3b) fuga: el contenido de la lección bloqueada NO viaja al alumno (sí al editor)', async () => {
  type Detail = {
    modules: Array<{ lessons: Array<{ id: string; content: unknown }> }>;
  };
  // Como ALUMNO: la lección bloqueada llega SIN contenido; la libre con contenido.
  const asStudent = await http<Detail>(`/api/v1/modules/courses/${courseId}`, {
    bearer: studentToken,
  });
  const sLessons = asStudent.body.modules.flatMap((m) => m.lessons);
  expect(
    sLessons.find((l) => l.id === lesson1)?.content,
    'lección bloqueada → contenido oculto al alumno',
  ).toBeFalsy();
  expect(
    sLessons.find((l) => l.id === lesson0)?.content,
    'lección libre → contenido presente',
  ).toBeTruthy();

  // Como EDITOR (admin): ve el contenido completo, incluso de la bloqueada.
  const asAdmin = await http<Detail>(`/api/v1/modules/courses/${courseId}`, { bearer: adminToken });
  const aLessons = asAdmin.body.modules.flatMap((m) => m.lessons);
  expect(
    aLessons.find((l) => l.id === lesson1)?.content,
    'el editor sí ve el contenido de la lección bloqueada',
  ).toBeTruthy();
});

test('3c) sin matrícula: el alumno recibe la estructura del curso pero NUNCA el contenido', async () => {
  // Curso publicado en el que el alumno NO está matriculado.
  const c3 = (
    await http<{ id: string }>('/api/v1/modules/courses', {
      method: 'POST',
      bearer: adminToken,
      body: {
        title: `Drip NoEnroll ${stamp}`,
        slug: `drip-noenroll-${stamp}`,
        description: 'curso sin matrícula',
        category: 'general',
      },
    })
  ).body;
  const m3 = (
    await http<{ id: string }>(`/api/v1/modules/courses/${c3.id}/modules`, {
      method: 'POST',
      bearer: adminToken,
      body: { title: 'M', orderIndex: 0 },
    })
  ).body;
  await http(`/api/v1/modules/courses/modules/${m3.id}/lessons`, {
    method: 'POST',
    bearer: adminToken,
    body: {
      title: 'Privada',
      type: 'TEXT',
      orderIndex: 0,
      content: { text: 'secreto' },
      durationSec: 60,
    },
  });
  await http(`/api/v1/modules/courses/${c3.id}/publish`, { method: 'POST', bearer: adminToken });

  const asStudent = await http<{
    modules: Array<{ lessons: Array<{ id: string; title: string; content: unknown }> }>;
  }>(`/api/v1/modules/courses/${c3.id}`, { bearer: studentToken });
  const lessons = asStudent.body.modules.flatMap((m) => m.lessons);
  expect(lessons.length, 'la estructura (currículo) sí llega').toBeGreaterThanOrEqual(1);
  expect(lessons[0]?.title, 'el título de la lección sí llega').toBeTruthy();
  expect(lessons[0]?.content, 'el contenido NO llega al no-matriculado').toBeFalsy();

  await http(`/api/v1/modules/courses/${c3.id}/archive`, { method: 'POST', bearer: adminToken });
});

test('4) UI alumno: la lección bloqueada muestra candado + card "no disponible"', async ({
  page,
}) => {
  test.setTimeout(90000); // dev (next dev) compila la ruta del player en frío
  await page.goto('/signin');
  await injectSession(page, {
    accessToken: studentToken,
    user: { ...studentUser, onboardingCompletedAt: studentOnboardedAt },
  });
  await page.goto(`/cursos/${courseSlug}`);

  // El candado "🔒" con la pista de días aparece en la lista de lecciones.
  await expect(page.getByText(/🔒/).first()).toBeVisible({ timeout: 45000 });
  await page.screenshot({ path: `${SHOTS}/04-alumno-candados.png`, fullPage: true });

  // Al abrir la lección bloqueada, el reproductor muestra el card "no disponible".
  await page.getByText('Lección 2 (drip +7d)').click();
  await expect(page.getByText(/Lección aún no disponible/i)).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/04b-alumno-leccion-bloqueada.png`, fullPage: true });
});

test('5) UI admin: el panel de drip del editor muestra el calendario', async ({ page }) => {
  await page.goto('/signin');
  await injectSession(page, { accessToken: adminToken, user: adminUser });
  await page.goto(`/formador/cursos/${courseId}`);

  await expect(page.getByText('Liberación programada (drip)')).toBeVisible({ timeout: 20000 });
  // Anclamos al tier REAL creado en setup (no a un regex genérico que un
  // placeholder hardcodeado podría satisfacer): el badge "Tier: Evidencia <stamp>".
  await expect(page.getByText(new RegExp(`Tier:\\s*Evidencia ${stamp}`))).toBeVisible({
    timeout: 10000,
  });
  // Y la cadencia "cada 7 día(s)" de ese calendario.
  await expect(page.getByText(/cada\s*7\s*día/i)).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/05-admin-panel-drip.png`, fullPage: true });
});

test('6) vínculo tier→grupo: PATCH linkedTierName persiste + badge en UI', async ({ page }) => {
  // Grupo temporal vinculado al tier de evidencia.
  const g = await http<{ id: string }>('/api/v1/modules/access-groups', {
    method: 'POST',
    bearer: adminToken,
    body: { name: `TMP evidencia ${stamp}`, kind: 'MULTI_COURSE' },
  });
  const gid = g.body.id;
  const patched = await http<{ linkedTierName: string | null }>(
    `/api/v1/modules/access-groups/${gid}`,
    { method: 'PATCH', bearer: adminToken, body: { linkedTierName: `Evidencia ${stamp}` } },
  );
  expect(patched.body.linkedTierName, 'linkedTierName persiste').toBe(`Evidencia ${stamp}`);

  // UI: el grupo aparece con el badge "Tier: ..." en /admin/grupos-acceso.
  await page.goto('/signin');
  await injectSession(page, { accessToken: adminToken, user: adminUser });
  await page.goto('/admin/grupos-acceso');
  await expect(page.getByText(new RegExp(`Tier:\\s*Evidencia ${stamp}`))).toBeVisible({
    timeout: 20000,
  });
  await page.screenshot({ path: `${SHOTS}/06-admin-vinculo-tier.png`, fullPage: true });

  // Cleanup del grupo temporal.
  await http(`/api/v1/modules/access-groups/${gid}`, { method: 'DELETE', bearer: adminToken });
});

test('7) vínculo tier→grupo END-TO-END: asignar el tier reconcilia membresía TIER + auto-matrícula', async () => {
  test.setTimeout(120000); // la reconciliación va por el outbox/BullMQ (asíncrona)

  // Curso nuevo que el alumno NO tiene → para verificar la matrícula automática.
  const c2 = (
    await http<{ id: string }>('/api/v1/modules/courses', {
      method: 'POST',
      bearer: adminToken,
      body: {
        title: `Drip Reconcile ${stamp}`,
        slug: `drip-reconcile-${stamp}`,
        description: 'Curso del grupo vinculado al tier',
        category: 'general',
      },
    })
  ).body;
  const m2 = (
    await http<{ id: string }>(`/api/v1/modules/courses/${c2.id}/modules`, {
      method: 'POST',
      bearer: adminToken,
      body: { title: 'M', orderIndex: 0 },
    })
  ).body;
  await http(`/api/v1/modules/courses/modules/${m2.id}/lessons`, {
    method: 'POST',
    bearer: adminToken,
    body: { title: 'L', type: 'TEXT', orderIndex: 0, content: { text: 'x' }, durationSec: 60 },
  });
  await http(`/api/v1/modules/courses/${c2.id}/publish`, { method: 'POST', bearer: adminToken });

  // Grupo con ese curso, vinculado al tier que el alumno YA tiene.
  const grp = (
    await http<{ id: string }>('/api/v1/modules/access-groups', {
      method: 'POST',
      bearer: adminToken,
      body: { name: `Reconcile ${stamp}`, kind: 'MULTI_COURSE', courseIds: [c2.id] },
    })
  ).body;
  await http(`/api/v1/modules/access-groups/${grp.id}`, {
    method: 'PATCH',
    bearer: adminToken,
    body: { linkedTierName: `Evidencia ${stamp}` },
  });

  // Disparador real: re-asignar el tier al alumno emite
  // payment_connections.user_tier.changed → el bridge reconcilia la membresía.
  const reassign = await http(`/api/v1/modules/payment-connections/user-tiers/${studentUser.id}`, {
    method: 'PUT',
    bearer: adminToken,
    body: { tierId: evidenciaTierId },
  });
  expect(reassign.ok, `re-asignar tier (got ${reassign.status})`).toBe(true);

  // Poll hasta que el outbox procese el evento: el alumno debe aparecer como
  // miembro del grupo con source TIER.
  let member: { userId: string; source: string } | undefined;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const detail = await http<{
      members: Array<{ userId: string; source: string }>;
    }>(`/api/v1/modules/access-groups/${grp.id}`, { bearer: adminToken });
    member = detail.body.members?.find((mm) => mm.userId === studentUser.id);
    if (member) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
  expect(member, 'el alumno fue añadido al grupo por el bridge de tiers').toBeDefined();
  expect(member!.source, 'la membresía es de origen TIER').toBe('TIER');

  // Y quedó auto-matriculado en el curso del grupo, con source GROUP.
  const enrolls = await http<Array<{ courseId: string; source: string }>>(
    '/api/v1/modules/learning/me/enrollments',
    { bearer: studentToken },
  );
  const groupEnroll = enrolls.body.find((e) => e.courseId === c2.id);
  expect(groupEnroll, 'el alumno se matriculó en el curso del grupo').toBeDefined();
  expect(groupEnroll!.source, 'matrícula de origen GROUP').toBe('GROUP');

  // BAJA DE TIER: quitar el tier debe revocar la membresía TIER (refcount).
  await http(`/api/v1/modules/payment-connections/user-tiers/${studentUser.id}`, {
    method: 'PUT',
    bearer: adminToken,
    body: { tierId: null },
  });
  let stillMember = true;
  const deadline2 = Date.now() + 90000;
  while (Date.now() < deadline2) {
    const detail = await http<{ members: Array<{ userId: string }> }>(
      `/api/v1/modules/access-groups/${grp.id}`,
      { bearer: adminToken },
    );
    stillMember = !!detail.body.members?.find((mm) => mm.userId === studentUser.id);
    if (!stillMember) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
  expect(stillMember, 'al quitar el tier, el alumno deja de ser miembro del grupo').toBe(false);

  // Cleanup.
  await http(`/api/v1/modules/access-groups/${grp.id}`, { method: 'DELETE', bearer: adminToken });
  await http(`/api/v1/modules/courses/${c2.id}/archive`, { method: 'POST', bearer: adminToken });
});

test('8) BORRAR el tier revoca la membresía TIER del grupo vinculado (B4)', async () => {
  test.setTimeout(120000);
  // Tier dedicado + grupo vinculado + curso del grupo.
  const tierName = `Borrable ${stamp}`;
  const tid = (
    await http<{ tier: { id: string } }>('/api/v1/modules/payment-connections/tiers/catalog', {
      method: 'POST',
      bearer: adminToken,
      body: { name: tierName },
    })
  ).body.tier.id;
  const c4 = (
    await http<{ id: string }>('/api/v1/modules/courses', {
      method: 'POST',
      bearer: adminToken,
      body: {
        title: `Drip Del ${stamp}`,
        slug: `drip-del-${stamp}`,
        description: 'x',
        category: 'general',
      },
    })
  ).body;
  const m4 = (
    await http<{ id: string }>(`/api/v1/modules/courses/${c4.id}/modules`, {
      method: 'POST',
      bearer: adminToken,
      body: { title: 'M', orderIndex: 0 },
    })
  ).body;
  await http(`/api/v1/modules/courses/modules/${m4.id}/lessons`, {
    method: 'POST',
    bearer: adminToken,
    body: { title: 'L', type: 'TEXT', orderIndex: 0, content: { text: 'x' }, durationSec: 60 },
  });
  await http(`/api/v1/modules/courses/${c4.id}/publish`, { method: 'POST', bearer: adminToken });
  const grp = (
    await http<{ id: string }>('/api/v1/modules/access-groups', {
      method: 'POST',
      bearer: adminToken,
      body: { name: `DelGroup ${stamp}`, kind: 'MULTI_COURSE', courseIds: [c4.id] },
    })
  ).body;
  await http(`/api/v1/modules/access-groups/${grp.id}`, {
    method: 'PATCH',
    bearer: adminToken,
    body: { linkedTierName: tierName },
  });
  // Asignar el tier → reconcile añade al alumno.
  await http(`/api/v1/modules/payment-connections/user-tiers/${studentUser.id}`, {
    method: 'PUT',
    bearer: adminToken,
    body: { tierId: tid },
  });
  const poll = async (want: boolean) => {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const detail = await http<{ members: Array<{ userId: string }> }>(
        `/api/v1/modules/access-groups/${grp.id}`,
        { bearer: adminToken },
      );
      const isMember = !!detail.body.members?.find((mm) => mm.userId === studentUser.id);
      if (isMember === want) return true;
      await new Promise((r) => setTimeout(r, 2500));
    }
    return false;
  };
  expect(await poll(true), 'el alumno entró al grupo por el tier').toBe(true);

  // BORRAR el tier → debe emitir el evento y el bridge retira la membresía.
  const del = await http(`/api/v1/modules/payment-connections/tiers/catalog/${tid}`, {
    method: 'DELETE',
    bearer: adminToken,
  });
  expect(del.ok, `delete tier (got ${del.status})`).toBe(true);
  expect(await poll(false), 'al borrar el tier, el alumno deja de ser miembro').toBe(true);

  // Cleanup.
  await http(`/api/v1/modules/access-groups/${grp.id}`, { method: 'DELETE', bearer: adminToken });
  await http(`/api/v1/modules/courses/${c4.id}/archive`, { method: 'POST', bearer: adminToken });
});
