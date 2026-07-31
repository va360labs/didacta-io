import { expect, test } from '@playwright/test';
import {
  adminTokenForBootstrap,
  createPublishedCourse,
  createTenantApiKey,
  inscribeViaApi,
  listCoursesViaApi,
  revokeViaApi,
  signup,
} from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Flujo: una página de ventas externa inscribe a un comprador vía API.
 *
 * Cubre:
 *  - El admin crea una API key con scope `enrollments:write`.
 *  - `POST /api/v1/inscribe` (Authorization: ApiKey …) crea el usuario y lo
 *    matricula. Repetir la llamada es idempotente (alreadyEnrolled).
 *  - La ficha del curso ya NO muestra "Matricularme" (matrícula libre quitada
 *    globalmente).
 */
test.describe('Inscripción externa por API', () => {
  test('una API key inscribe a un comprador nuevo y es idempotente', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);

    const course = await createPublishedCourse({
      bearer: adminToken,
      title: `Inscribe API E2E ${stamp}`,
      slug: `inscribe-api-e2e-${stamp}`,
    });

    const apiKey = await createTenantApiKey({
      bearer: adminToken,
      name: `E2E ventas ${stamp}`,
    });
    expect(apiKey.token).toMatch(/^lmsk_/);

    const buyerEmail = `e2e-inscribe-${stamp}@example.test`;

    // 1) Primera inscripción: crea el usuario y lo matricula.
    const first = await inscribeViaApi({
      apiKey: apiKey.token,
      email: buyerEmail,
      name: 'Comprador Externo',
      courseIds: [course.id],
    });
    expect(first.userCreated).toBe(true);
    expect(first.enrollments).toHaveLength(1);
    expect(first.enrollments[0]).toMatchObject({
      courseId: course.id,
      status: 'ACTIVE',
      alreadyEnrolled: false,
    });

    // 2) Segunda inscripción idéntica: idempotente (usuario existente + ya matriculado).
    const second = await inscribeViaApi({
      apiKey: apiKey.token,
      email: buyerEmail,
      courseIds: [course.id],
    });
    expect(second.userCreated).toBe(false);
    expect(second.userId).toBe(first.userId);
    expect(second.enrollments[0]).toMatchObject({
      courseId: course.id,
      status: 'ACTIVE',
      alreadyEnrolled: true,
    });
  });

  test('reembolso: la baja revoca la matrícula y es idempotente', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);

    const course = await createPublishedCourse({
      bearer: adminToken,
      title: `Revoke API E2E ${stamp}`,
      slug: `revoke-api-e2e-${stamp}`,
    });
    const apiKey = await createTenantApiKey({
      bearer: adminToken,
      name: `E2E revoke ${stamp}`,
      scopes: ['enrollments:write', 'courses:read'],
    });
    const buyerEmail = `e2e-revoke-${stamp}@example.test`;

    await inscribeViaApi({
      apiKey: apiKey.token,
      email: buyerEmail,
      name: 'Comprador Reembolsado',
      courseIds: [course.id],
    });

    // 1) Reembolso → se revoca la matrícula creada por API.
    const first = await revokeViaApi({
      apiKey: apiKey.token,
      email: buyerEmail,
      courseIds: [course.id],
      externalRef: `wc_refund_${stamp}`,
      reason: 'refund',
    });
    expect(first.userFound).toBe(true);
    expect(first.revoked).toEqual([{ courseId: course.id, status: 'REVOKED' }]);

    // 2) Reintento del webhook de reembolso → idempotente, ya no hay matrícula viva.
    const second = await revokeViaApi({
      apiKey: apiKey.token,
      email: buyerEmail,
      courseIds: [course.id],
    });
    expect(second.revoked).toEqual([{ courseId: course.id, status: 'NOT_ENROLLED' }]);

    // 3) Email desconocido → no 404, userFound=false.
    const unknown = await revokeViaApi({
      apiKey: apiKey.token,
      email: `no-existe-${stamp}@example.test`,
      courseIds: [course.id],
    });
    expect(unknown.userFound).toBe(false);
    expect(unknown.revoked).toEqual([{ courseId: course.id, status: 'NOT_ENROLLED' }]);
  });

  test('catálogo: /inscribe/courses lista los cursos con estado y exige scope courses:read', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);

    const course = await createPublishedCourse({
      bearer: adminToken,
      title: `Catalogo API E2E ${stamp}`,
      slug: `catalogo-api-e2e-${stamp}`,
    });

    // Key CON courses:read → ve el curso con su estado.
    const fullKey = await createTenantApiKey({
      bearer: adminToken,
      name: `E2E catalogo ${stamp}`,
      scopes: ['enrollments:write', 'courses:read'],
    });
    const listed = await listCoursesViaApi({ apiKey: fullKey.token });
    expect(listed.status).toBe(200);
    const found = listed.courses.find((c) => c.id === course.id);
    expect(found).toBeDefined();
    expect(found).toMatchObject({ id: course.id, status: 'PUBLISHED' });
    expect(found?.publishedAt).toBeTruthy();

    // Key SIN courses:read → 403 (el scope se exige de verdad).
    const limitedKey = await createTenantApiKey({
      bearer: adminToken,
      name: `E2E catalogo limitado ${stamp}`,
      scopes: ['enrollments:write'],
    });
    const denied = await listCoursesViaApi({ apiKey: limitedKey.token });
    expect(denied.status).toBe(403);
  });

  test('la ficha de curso ya no ofrece "Matricularme"', async ({ page }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);

    const course = await createPublishedCourse({
      bearer: adminToken,
      title: `Sin matricula E2E ${stamp}`,
      slug: `sin-matricula-e2e-${stamp}`,
    });

    const alumno = await signup({
      tenantSlug,
      email: `e2e-no-matricula-${stamp}@example.test`,
      password: 'E2eNoMatricula123!',
      name: 'Alumno Sin Matrícula',
    });

    await page.goto('/signin');
    await injectSession(page, {
      accessToken: alumno.tokens.accessToken,
      user: alumno.user,
    });

    await page.goto(`/cursos/${course.slug}`);
    await expect(page.getByRole('heading', { name: 'Empieza este curso' })).toBeVisible({
      timeout: 15_000,
    });

    // El botón de matrícula libre fue eliminado globalmente.
    await expect(page.getByRole('button', { name: 'Matricularme' })).toHaveCount(0);
  });
});
