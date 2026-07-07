import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Vista previa de cursos para editores (profesor/admin) SIN publicarlos.
 *
 * Un curso DRAFT no es visible para alumnos, pero un editor debe poder abrir
 * `/cursos/<slug>` y ver el contenido en modo vista previa (sin matrícula ni
 * tracking de progreso).
 */
test.describe('Vista previa de curso (editor, sin publicar)', () => {
  test('un admin ve el contenido de un curso DRAFT sin matricularse', async ({ page }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const headers = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };

    // Curso DRAFT (NO publicado) con una lección de texto con contenido.
    const slug = `e2e-preview-${stamp}`;
    const created = await fetch(`${API_URL}/api/v1/modules/courses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: `Preview E2E ${stamp}`,
        slug,
        description: 'Curso de prueba de vista previa',
        category: 'Tecnología',
      }),
    });
    expect(created.ok).toBe(true);
    const course = (await created.json()) as { id: string; status: string };
    expect(course.status).toBe('DRAFT');

    const mod = (await (
      await fetch(`${API_URL}/api/v1/modules/courses/${course.id}/modules`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'Sección 1' }),
      })
    ).json()) as { id: string };

    const lessonText = `Contenido visible en preview ${stamp}`;
    await fetch(`${API_URL}/api/v1/modules/courses/modules/${mod.id}/lessons`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Lección texto', type: 'TEXT', content: { text: lessonText } }),
    });

    // Sesión admin y navegación a la vista de alumno por slug.
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: adminToken,
      user: {
        id: 'admin-stub',
        email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
        name: 'Admin',
        tenantId: 'stub',
        tenantSlug,
        roles: ['super_admin', 'tenant_admin'],
        mfaEnabled: true,
      },
    });
    await page.goto(`/cursos/${slug}`);

    // Banner de vista previa + contenido de la lección visibles (sin publicar).
    await expect(page.getByText('Vista previa', { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(lessonText)).toBeVisible({ timeout: 15_000 });

    // NO debe aparecer el muro de compra ni "Contenido bloqueado".
    await expect(page.getByText('Contenido bloqueado')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Empieza este curso' })).toHaveCount(0);
  });
});
