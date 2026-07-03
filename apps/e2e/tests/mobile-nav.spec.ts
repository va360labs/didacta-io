import { expect, test, type Page } from '@playwright/test';
import { injectSession } from '../helpers/auth';

/**
 * Navegación móvil — drawer off-canvas + barra inferior de pestañas.
 *
 * En <lg el rail persistente (`AppSidebar`, `hidden lg:flex`) se oculta y la
 * navegación se sirve como: (1) barra superior con hamburguesa que abre un
 * drawer que reutiliza el MISMO contenido del sidebar, y (2) bottom-nav fija.
 * En ≥lg el rail vuelve y ni hamburguesa ni bottom-nav se muestran.
 *
 * Nota de robustez: `SidebarContent` se renderiza a la vez en el rail y en el
 * drawer. Las aserciones usan queries POR ROL acotadas a cada contenedor: el
 * rail queda `display:none` en móvil y el drawer cerrado queda `aria-hidden`,
 * así ambos salen del árbol de accesibilidad y no hay coincidencias duplicadas.
 */

// Sesión inyectada (permitido en specs por la regla #3). `onboardingCompletedAt`
// evita el gate de onboarding de primera vez del layout.
const SESSION = {
  accessToken: 'fake-token-mobile-nav',
  user: {
    id: 'user-mobile-1',
    email: 'lucia@acme.com',
    name: 'Lucía Gómez',
    tenantId: 'tenant-acme',
    tenantSlug: 'acme',
    roles: ['alumno'],
    mfaEnabled: false,
    onboardingCompletedAt: '2026-01-01T00:00:00.000Z',
  },
};

const MOBILE = { width: 390, height: 844 }; // iPhone 12/13/14
const DESKTOP = { width: 1280, height: 900 };

async function withSession(page: Page, url: string, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto('/signin');
  await injectSession(page, SESSION);
  await page.goto(url);
}

test.describe('Navegación móvil — drawer + bottom nav', () => {
  test('móvil: rail oculto, hamburguesa + bottom-nav; el drawer abre, navega y cierra', async ({
    page,
  }) => {
    await withSession(page, '/comunidad', MOBILE);

    const hamburger = page.getByRole('button', { name: 'Abrir menú de navegación' });
    const tabBar = page.getByRole('navigation', { name: 'Navegación principal' });
    const drawer = page.getByRole('dialog', { name: 'Menú de navegación' });

    // Hamburguesa y bottom-nav presentes en móvil.
    await expect(hamburger).toBeVisible();
    await expect(tabBar).toBeVisible();
    await expect(tabBar.getByRole('link', { name: 'Feed' })).toBeVisible();
    await expect(tabBar.getByRole('link', { name: 'Cursos' })).toBeVisible();
    await expect(tabBar.getByRole('button', { name: 'Menú' })).toBeVisible();

    // Drawer cerrado → fuera del árbol de accesibilidad (aria-hidden).
    await expect(drawer).toBeHidden();

    // Abrir por hamburguesa.
    await hamburger.click();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Feed de la comunidad' })).toBeVisible();

    // Cerrar con la X de la cabecera (acotada al drawer, no al scrim).
    await drawer.getByRole('button', { name: 'Cerrar menú' }).click();
    await expect(drawer).toBeHidden();

    // Reabrir por la pestaña "Menú" del bottom-nav y navegar a Cursos.
    await tabBar.getByRole('button', { name: 'Menú' }).click();
    await expect(drawer).toBeVisible();
    await drawer.getByRole('link', { name: 'Cursos' }).click();
    await expect(page).toHaveURL(/\/cursos/);
    // Al navegar el drawer se cierra solo.
    await expect(drawer).toBeHidden();
  });

  test('escritorio: rail visible, sin hamburguesa ni bottom-nav', async ({ page }) => {
    await withSession(page, '/comunidad', DESKTOP);

    // Rail persistente presente (sus enlaces existen; el drawer queda display:none).
    await expect(page.getByRole('link', { name: 'Feed de la comunidad' })).toBeVisible();

    // Piezas móviles ausentes en escritorio (lg:hidden → fuera del árbol a11y).
    await expect(page.getByRole('button', { name: 'Abrir menú de navegación' })).toBeHidden();
    await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeHidden();
  });
});
