import { expect, test } from '@playwright/test';
import { signup } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Bloque 9 — Simplificar navegación:
 *  - "Eventos en directo" desaparece del menú: /eventos redirige a la pestaña
 *    "Eventos" de /calendario (una sola entrada "Calendario" en Agenda).
 *  - "Grupos" desaparece del menú mientras la feature no esté activa (la ruta
 *    /grupos sigue viva por URL).
 *  - Los canales tipo foro (espacios) se agrupan bajo un único menú "Foro"
 *    plegable, plegado por defecto salvo que estés dentro de un espacio.
 *
 * Usa sesión REAL (patrón de calendario-agenda.spec.ts): el spec de humo con
 * sesión falsa rebota a /signin al primer 401.
 */

test.describe('Navegación simplificada (bloque 9)', () => {
  test('sidebar sin Eventos/Grupos, Foro plegable y /eventos redirige', async ({ page }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const stamp = Date.now();
    const alumno = await signup({
      tenantSlug,
      email: `e2e-nav-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Alumno Navegación',
    });

    await page.goto('/signin');
    await injectSession(page, {
      accessToken: alumno.tokens.accessToken,
      refreshToken: alumno.tokens.refreshToken,
      user: { ...alumno.user, onboardingCompletedAt: new Date().toISOString() },
    });

    await page.goto('/comunidad');
    const nav = page.locator('aside nav').first();
    await expect(nav.getByRole('link', { name: 'Calendario' })).toBeVisible();

    // Fusionado y ocultado: ni "Eventos en directo" ni "Grupos" en el menú.
    await expect(nav.getByRole('link', { name: 'Eventos en directo' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Grupos' })).toHaveCount(0);

    // "Foro" plegado por defecto: los canales no se ven hasta expandir.
    const foroToggle = nav.getByRole('button', { name: /Foro/ });
    await expect(foroToggle).toBeVisible();
    await expect(nav.getByRole('link', { name: 'General' })).toHaveCount(0);
    await foroToggle.click();
    await expect(nav.getByRole('link', { name: 'General' })).toBeVisible();

    // Dentro de un espacio el grupo queda expandido (contiene la ruta activa).
    await nav.getByRole('link', { name: 'General' }).click();
    await expect(page).toHaveURL(/\/espacios\/general/);
    await expect(nav.getByRole('link', { name: 'General' })).toBeVisible();

    // /eventos redirige a la pestaña Eventos del calendario.
    await page.goto('/eventos');
    await expect(page).toHaveURL(/\/calendario\?vista=eventos/);
    await expect(page.getByText('Agenda · Calendario')).toBeVisible();
    await expect(page.getByText('Sesiones, talleres y mentorías programadas')).toBeVisible();
  });
});
