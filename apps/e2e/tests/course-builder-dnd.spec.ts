import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Spec del constructor de cursos rediseñado (#143, #150-#153).
 *
 * Cubre:
 * - Hero del curso con métricas reactivas.
 * - Eliminar lección con confirm dialog (#150).
 * - Editar metadatos del curso desde el hero (#151).
 *
 * El reordenamiento por drag & drop de @dnd-kit (#152, #153) NO se testea
 * desde aquí: dnd-kit usa pointer events sintéticos y el test sería frágil.
 * En su lugar verificamos que los handles existen y son `<button>` con
 * `aria-label` (a11y básico).
 */
test.describe('Constructor de cursos del formador (UI kit Didacta)', () => {
  test('hero muestra métricas, edita metadatos inline y elimina lección', async ({ page }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const headers = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };

    // 1. Crear curso DRAFT con 1 sección y 2 lecciones vía API.
    const slug = `e2e-builder-${stamp}`;
    const created = await fetch(`${API_URL}/api/v1/modules/courses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: `Constructor E2E ${stamp}`,
        slug,
        description: 'Original',
        category: 'Tecnología',
      }),
    });
    expect(created.ok).toBe(true);
    const course = (await created.json()) as { id: string };

    const mod = (await (
      await fetch(`${API_URL}/api/v1/modules/courses/${course.id}/modules`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'Sección 1' }),
      })
    ).json()) as { id: string };

    await fetch(`${API_URL}/api/v1/modules/courses/modules/${mod.id}/lessons`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Lección A', type: 'TEXT', content: { text: 'a' } }),
    });
    await fetch(`${API_URL}/api/v1/modules/courses/modules/${mod.id}/lessons`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Lección B', type: 'TEXT', content: { text: 'b' } }),
    });

    // 2. Inyectar sesión admin y abrir el editor del curso.
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
    await page.goto(`/formador/cursos/${course.id}`);

    // 3. Hero muestra el título y métricas correctas.
    await expect(page.getByRole('heading', { name: `Constructor E2E ${stamp}` })).toBeVisible({
      timeout: 15_000,
    });
    // Métricas: 1 sección, 2 lecciones.
    await expect(page.getByText('1', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('2', { exact: true }).first()).toBeVisible();

    // 4. Editar metadatos inline desde el hero.
    await page
      .getByRole('button', { name: /^Editar$/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: 'Editar metadatos del curso' })).toBeVisible({
      timeout: 10_000,
    });
    const descTextarea = page.getByLabel(/Descripción/);
    await descTextarea.fill('Descripción actualizada desde la UI');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    // El form se cierra y el hero refleja la nueva descripción.
    await expect(page.getByText('Descripción actualizada desde la UI')).toBeVisible({
      timeout: 15_000,
    });

    // 5. Eliminar la lección A: hover y click en el botón trash.
    page.on('dialog', (d) => void d.accept());
    const lessonRow = page.locator('li').filter({ hasText: 'Lección A' });
    await lessonRow.getByRole('button', { name: /Eliminar lección Lección A/i }).click();
    await expect(page.getByText('Lección A')).not.toBeVisible({ timeout: 15_000 });
    // La lección B sigue.
    await expect(page.getByText('Lección B')).toBeVisible();

    // 6. Drag handles de a11y: cada lección y módulo expone un button con aria-label
    // de "Arrastrar para reordenar".
    const lessonHandle = page.getByRole('button', {
      name: /Arrastrar para reordenar la lección/,
    });
    await expect(lessonHandle.first()).toBeVisible();
    const moduleHandle = page.getByRole('button', {
      name: /Arrastrar para reordenar la sección/,
    });
    await expect(moduleHandle).toBeVisible();
  });

  test('crea una lección desde el formulario eligiendo el tipo', async ({ page }) => {
    // Regresión: el <Select> de tipo se renderizaba como <option> sueltos dentro
    // de un <div> (no seleccionable) cuando el form no pasaba onChange, y el
    // submit no enviaba `type`. Aquí ejercitamos el formulario real: elegir tipo
    // en el <select>, escribir título y pulsar "Crear".
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const headers = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };

    // Curso DRAFT con 1 sección vacía (sin lecciones) vía API.
    const created = await fetch(`${API_URL}/api/v1/modules/courses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: `Alta lección E2E ${stamp}`,
        slug: `e2e-alta-leccion-${stamp}`,
        description: 'Original',
        category: 'Tecnología',
      }),
    });
    expect(created.ok).toBe(true);
    const course = (await created.json()) as { id: string };

    await fetch(`${API_URL}/api/v1/modules/courses/${course.id}/modules`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Sección única' }),
    });

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
    await page.goto(`/formador/cursos/${course.id}`);

    // Abrir el formulario de alta de lección.
    await page.getByRole('button', { name: /Añadir lección/ }).click();

    // El tipo debe ser un <select> nativo real y seleccionable (no <option> sueltos).
    const typeSelect = page.locator('select[name="type"]');
    await expect(typeSelect).toBeVisible({ timeout: 15_000 });
    await typeSelect.selectOption('PDF');
    await expect(typeSelect).toHaveValue('PDF');

    await page.getByPlaceholder('Título de la lección').fill('Lección desde UI');
    await page.getByRole('button', { name: 'Crear' }).click();

    // La lección aparece con su título y el label del tipo elegido.
    const lessonRow = page.locator('li').filter({ hasText: 'Lección desde UI' });
    await expect(lessonRow).toBeVisible({ timeout: 15_000 });
    await expect(lessonRow.getByText('PDF')).toBeVisible();
  });
});
