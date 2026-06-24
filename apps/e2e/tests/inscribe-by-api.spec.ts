import { expect, test } from '@playwright/test';
import {
  adminTokenForBootstrap,
  createPublishedCourse,
  createTenantApiKey,
  inscribeViaApi,
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
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
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

  test('la ficha de curso ya no ofrece "Matricularme"', async ({ page }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
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
