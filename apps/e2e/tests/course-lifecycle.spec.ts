import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Spec del lifecycle del curso desde el formador.
 *
 * Verifica las transiciones DRAFT → PUBLISHED → ARCHIVED y el rollback
 * detrás de la flecha (no se puede archivar un DRAFT sin lecciones, etc).
 */

test.describe('Lifecycle del curso (DRAFT → PUBLISHED → ARCHIVED)', () => {
  test('crear DRAFT → publicar requiere lecciones → publicar OK → archivar', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    };

    const stamp = Date.now();
    const slug = `e2e-lifecycle-${stamp}`;

    // 1. Crear DRAFT.
    const created = await fetch(`${API_URL}/api/v1/modules/courses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: `Lifecycle E2E ${stamp}`,
        slug,
        description: 'Curso de prueba lifecycle',
        category: 'general',
      }),
    });
    expect(created.ok).toBe(true);
    const course = (await created.json()) as { id: string; status: string };
    expect(course.status).toBe('DRAFT');

    // 2. Intentar publicar sin lecciones → debería fallar (HasNoLessonsError o similar).
    const failPublish = await fetch(`${API_URL}/api/v1/modules/courses/${course.id}/publish`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(failPublish.status, 'publish sin lecciones → 4xx').toBeGreaterThanOrEqual(400);
    expect(failPublish.status).toBeLessThan(500);

    // 3. Crear módulo + lección.
    const mod = (await (
      await fetch(`${API_URL}/api/v1/modules/courses/${course.id}/modules`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'Módulo único', orderIndex: 0 }),
      })
    ).json()) as { id: string };

    await fetch(`${API_URL}/api/v1/modules/courses/modules/${mod.id}/lessons`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: 'Lección 1',
        type: 'TEXT',
        orderIndex: 0,
        content: { text: 'Contenido' },
        durationSec: 60,
      }),
    });

    // 4. Publicar OK.
    const publish = await fetch(`${API_URL}/api/v1/modules/courses/${course.id}/publish`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(publish.ok).toBe(true);
    const published = (await publish.json()) as { status: string };
    expect(published.status).toBe('PUBLISHED');

    // 5. Archivar.
    const archive = await fetch(`${API_URL}/api/v1/modules/courses/${course.id}/archive`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(archive.ok).toBe(true);
    const archived = (await archive.json()) as { status: string };
    expect(archived.status).toBe('ARCHIVED');

    // 6. Desarchivar → vuelve a DRAFT (editable, no expuesto a alumnos).
    const unarchive = await fetch(`${API_URL}/api/v1/modules/courses/${course.id}/unarchive`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(unarchive.ok).toBe(true);
    const unarchived = (await unarchive.json()) as { status: string };
    expect(unarchived.status).toBe('DRAFT');
  });

  test('rechaza slug duplicado en mismo tenant', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    };

    const slug = `dup-slug-${Date.now()}`;
    const body = JSON.stringify({ title: 'Dup', slug, category: 'g' });
    const first = await fetch(`${API_URL}/api/v1/modules/courses`, {
      method: 'POST',
      headers,
      body,
    });
    expect(first.ok).toBe(true);
    const second = await fetch(`${API_URL}/api/v1/modules/courses`, {
      method: 'POST',
      headers,
      body,
    });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBeLessThan(500);
  });
});
