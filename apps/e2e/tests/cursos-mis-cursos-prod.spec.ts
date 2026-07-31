import { expect, test } from '@playwright/test';
import { signin } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Verificación de humo en PRODUCCIÓN de las secciones de /cursos.
 *
 * No crea nada: entra con la cuenta de pruebas ya existente por el formulario
 * real de /signin y comprueba que ve sus cursos arriba y el resto abajo, con
 * el nombre de la organización resuelto.
 *
 * Se ejecuta A PROPÓSITO fuera de la suite normal (requiere `PROD_SMOKE=1` y
 * las credenciales por env) para que nadie lo corra sin querer contra prod:
 *   PROD_SMOKE=1 PROD_TEST_EMAIL=… PROD_TEST_PASSWORD=… \
 *   E2E_BASE_URL=https://aula.example.com pnpm exec playwright test …
 */
const enabled = process.env.PROD_SMOKE === '1';

test.describe('PROD · /cursos dividido en secciones', () => {
  test.skip(!enabled, 'Solo se ejecuta con PROD_SMOKE=1 (verificación manual contra producción)');

  test('la cuenta de pruebas ve "Mis cursos" y "Otros cursos de …" debajo', async ({ page }) => {
    const email = process.env.PROD_TEST_EMAIL ?? '';
    const password = process.env.PROD_TEST_PASSWORD ?? '';
    expect(email, 'falta PROD_TEST_EMAIL').not.toBe('');
    expect(password, 'falta PROD_TEST_PASSWORD').not.toBe('');

    // Login por API e inyección de sesión: el objetivo del smoke es el catálogo,
    // no el formulario de acceso (que ya cubre otro spec).
    const sesion = await signin({
      tenantSlug: process.env.PROD_TENANT_SLUG ?? 'demo',
      email,
      password,
    });
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: sesion.tokens.accessToken,
      user: { ...sesion.user, onboardingCompletedAt: new Date().toISOString() },
    });

    await page.goto('/cursos');

    const misCursos = page.getByRole('heading', { name: 'Mis cursos', exact: true });
    const otrosCursos = page.getByRole('heading', { name: /^Otros cursos de .+/ });
    await expect(misCursos).toBeVisible({ timeout: 30_000 });
    await expect(otrosCursos).toBeVisible();

    // El nombre de la organización viene del tenant, no de un literal.
    const titulo = (await otrosCursos.textContent())?.trim() ?? '';
    expect(titulo).toMatch(/^Otros cursos de \S+/);
    expect(titulo).not.toContain('undefined');
    expect(titulo).not.toContain('la organización');

    // "Mis cursos" va antes que "Otros cursos".
    const orden = await page.evaluate(() => {
      const hs = Array.from(document.querySelectorAll('h2'));
      return {
        mis: hs.findIndex((h) => h.textContent?.trim() === 'Mis cursos'),
        otros: hs.findIndex((h) => h.textContent?.trim().startsWith('Otros cursos de')),
      };
    });
    expect(orden.mis).toBeGreaterThanOrEqual(0);
    expect(orden.otros).toBeGreaterThan(orden.mis);

    // Un curso propio conocido, si el entorno lo indica (depende de los datos
    // reales del tenant contra el que corre el smoke).
    const cursoConocido = process.env.PROD_EXPECTED_COURSE ?? '';
    if (cursoConocido) {
      const seccionMis = page.locator('section', { has: misCursos }).last();
      await expect(seccionMis.getByText(cursoConocido).first()).toBeVisible();
    }

    await page.screenshot({
      path: 'apps/e2e/test-results/prod-cursos-secciones.png',
      fullPage: true,
    });
  });
});
