import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, createPublishedCourse, signup } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * /cursos se divide en dos secciones: "Mis cursos" (donde el alumno está
 * matriculado) primero, y debajo "Otros cursos de <organización>", donde el
 * nombre de la organización viene del tenant (nunca hardcodeado).
 */
test.describe('Catálogo dividido en "Mis cursos" y "Otros cursos"', () => {
  test('el alumno ve su curso arriba y el resto del catálogo abajo', async ({ page }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);

    // Dos cursos publicados: uno se matricula el alumno, el otro no.
    const mio = await createPublishedCourse({
      bearer: adminToken,
      title: `Secciones MIO ${stamp}`,
      slug: `secciones-mio-${stamp}`,
    });
    const ajeno = await createPublishedCourse({
      bearer: adminToken,
      title: `Secciones AJENO ${stamp}`,
      slug: `secciones-ajeno-${stamp}`,
    });

    const alumno = await signup({
      tenantSlug,
      email: `e2e-secciones-${stamp}@example.test`,
      password: 'E2eSecciones123!',
      name: 'Alumno Secciones',
    });

    // Matrícula solo en el primero, vía auto-matriculación del propio alumno.
    const enrolled = await fetch(`${API_URL}/api/v1/modules/learning/enrollments/me`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alumno.tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ courseId: mio.id }),
    });
    expect(enrolled.ok).toBe(true);

    await page.goto('/signin');
    await injectSession(page, {
      accessToken: alumno.tokens.accessToken,
      // Salta el gate de onboarding: el signup deja onboardingCompletedAt=null y
      // el shell secuestraría la navegación hacia /onboarding.
      user: { ...alumno.user, onboardingCompletedAt: new Date().toISOString() },
    });
    await page.goto('/cursos');

    // 1) Ambas secciones existen. El título de la segunda incluye el nombre del
    // tenant resuelto en runtime: comprobamos el prefijo, no un literal.
    const misCursos = page.getByRole('heading', { name: 'Mis cursos', exact: true });
    const otrosCursos = page.getByRole('heading', { name: /^Otros cursos de .+/ });
    await expect(misCursos).toBeVisible({ timeout: 20_000 });
    await expect(otrosCursos).toBeVisible();

    // 2) El nombre del tenant no está vacío ni es el placeholder del slug crudo.
    const otrosTitulo = (await otrosCursos.textContent())?.trim() ?? '';
    expect(otrosTitulo).toMatch(/^Otros cursos de \S+/);
    expect(otrosTitulo).not.toContain('undefined');

    // 3) "Mis cursos" va ANTES que "Otros cursos" en el documento.
    const orden = await page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll('h2')) as {
        textContent: string | null;
      }[];
      return {
        mis: headings.findIndex((h) => h.textContent?.trim() === 'Mis cursos'),
        otros: headings.findIndex((h) =>
          (h.textContent ?? '').trim().startsWith('Otros cursos de'),
        ),
      };
    });
    expect(orden.mis).toBeGreaterThanOrEqual(0);
    expect(orden.otros).toBeGreaterThan(orden.mis);

    // 4) Cada curso cae en su sección. Se localiza la <section> que contiene el
    // heading y se busca el título del curso dentro de ella.
    const seccionMis = page.locator('section', { has: misCursos }).last();
    const seccionOtros = page.locator('section', { has: otrosCursos }).last();

    await expect(seccionMis.getByText(mio.title, { exact: false })).toBeVisible();
    await expect(seccionOtros.getByText(ajeno.title, { exact: false })).toBeVisible();

    // Y no están cruzados.
    await expect(seccionMis.getByText(ajeno.title, { exact: false })).toHaveCount(0);
    await expect(seccionOtros.getByText(mio.title, { exact: false })).toHaveCount(0);
  });

  test('un alumno sin matrículas ve "Mis cursos" vacía con explicación', async ({ page }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);

    await createPublishedCourse({
      bearer: adminToken,
      title: `Secciones SOLO ${stamp}`,
      slug: `secciones-solo-${stamp}`,
    });

    const alumno = await signup({
      tenantSlug,
      email: `e2e-secciones-vacio-${stamp}@example.test`,
      password: 'E2eSeccionesVacio123!',
      name: 'Alumno Sin Cursos',
    });

    await page.goto('/signin');
    await injectSession(page, {
      accessToken: alumno.tokens.accessToken,
      // Salta el gate de onboarding: el signup deja onboardingCompletedAt=null y
      // el shell secuestraría la navegación hacia /onboarding.
      user: { ...alumno.user, onboardingCompletedAt: new Date().toISOString() },
    });
    await page.goto('/cursos');

    await expect(page.getByRole('heading', { name: 'Mis cursos', exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/Aún no estás matriculado en ningún curso/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Otros cursos de .+/ })).toBeVisible();
  });
});
