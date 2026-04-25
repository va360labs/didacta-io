import { expect, test } from '@playwright/test';
import {
  adminTokenForBootstrap,
  createInvitation,
  createPublishedCourse,
  signup,
} from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Flujo: alumno se matricula con código de invitación.
 *
 * Cubre la rama "Canjear código" del CourseAlumnoPage que hasta ahora
 * sólo testeábamos por unit (mod.learning.enrollByCode).
 */
test.describe('Matriculación por código de invitación', () => {
  test('alumno con código válido queda enrollado en el curso', async ({ page }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);

    const course = await createPublishedCourse({
      bearer: adminToken,
      title: `Invite E2E ${stamp}`,
      slug: `invite-e2e-${stamp}`,
    });

    // Crear invitación con maxUses=1 para verificar que se consuma
    const invitation = await createInvitation({
      bearer: adminToken,
      courseId: course.id,
      maxUses: 1,
    });

    const alumnoEmail = `e2e-invite-alumno-${stamp}@example.test`;
    const alumno = await signup({
      tenantSlug,
      email: alumnoEmail,
      password: 'E2eInviteAlumno123!',
      name: 'Alumno Invite',
    });

    await page.goto('/signin');
    await injectSession(page, {
      accessToken: alumno.tokens.accessToken,
      user: alumno.user,
    });

    // 1) Entrar al detalle del curso (sin estar matriculado)
    await page.goto(`/cursos/${course.slug}`);
    await expect(page.getByRole('heading', { name: 'Matricularme' })).toBeVisible({
      timeout: 15_000,
    });

    // 2) Pegar el código y canjearlo
    await page.getByLabel('Código').fill(invitation.code);
    await page.getByRole('button', { name: 'Canjear código' }).click();

    // 3) Tras canjear, el panel cambia a "Tu progreso" (alumno ya enrollado)
    await expect(page.getByText('Tu progreso')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/0% — meta para finalizar/)).toBeVisible();
  });
});
