import { expect, test } from '@playwright/test';
import { injectSession } from '../helpers/auth';

const FAKE_SESSION = {
  accessToken: 'fake-token-smoke',
  user: {
    id: 'user-smoke-1',
    email: 'lucia@acme.com',
    name: 'Lucía Gómez',
    tenantId: 'tenant-acme',
    tenantSlug: 'acme',
    roles: ['alumno'],
    mfaEnabled: false,
  },
};

async function withSession(page: Parameters<typeof injectSession>[0], url: string) {
  await page.goto('/signin');
  await injectSession(page, FAKE_SESSION);
  await page.goto(url);
}

test.describe('Redesign smoke — páginas principales', () => {
  test('/inicio redirige a /comunidad', async ({ page }) => {
    await withSession(page, '/inicio');
    await expect(page).toHaveURL(/\/comunidad/);
  });

  test('/inicio/mi-panel muestra heading y stat cards', async ({ page }) => {
    await withSession(page, '/inicio/mi-panel');
    await expect(page.getByRole('heading', { name: 'Mi panel' })).toBeVisible();
    await expect(page.getByText('Cursos en marcha')).toBeVisible();
    await expect(page.getByText('Progreso medio')).toBeVisible();
  });

  test('/espacios/general muestra heading y botón compositor', async ({ page }) => {
    await withSession(page, '/espacios/general');
    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nueva publicación' })).toBeVisible();
  });

  test('/espacios/anuncios muestra heading', async ({ page }) => {
    await withSession(page, '/espacios/anuncios');
    await expect(page.getByRole('heading', { name: 'Anuncios' })).toBeVisible();
  });

  test('/grupos muestra heading y tabs', async ({ page }) => {
    await withSession(page, '/grupos');
    await expect(page.getByRole('heading', { name: 'Grupos' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Mis grupos/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Explorar' })).toBeVisible();
    // Mis grupos: empty state
    await expect(page.getByText('Aún no perteneces a ningún grupo')).toBeVisible();
    // Explorar: empty state
    await page.getByRole('button', { name: 'Explorar' }).click();
    await expect(page.getByText('No hay grupos disponibles')).toBeVisible();
  });

  test('/grupos/[id] inexistente muestra "Grupo no encontrado"', async ({ page }) => {
    await withSession(page, '/grupos/slug-que-no-existe');
    await expect(page.getByText('Grupo no encontrado')).toBeVisible();
  });

  test('/leaderboard muestra heading y filtros', async ({ page }) => {
    await withSession(page, '/leaderboard');
    await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Este mes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Esta semana' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Global' })).toBeVisible();
  });

  test('/eventos redirige a la pestaña Eventos del calendario', async ({ page }) => {
    // Bloque 9 (simplificar navegación): /eventos se fusionó con /calendario.
    await withSession(page, '/eventos');
    await expect(page).toHaveURL(/\/calendario\?vista=eventos/);
    await expect(page.getByText('No hay eventos programados')).toBeVisible();
  });

  test('/calendario muestra grid y navegación entre meses', async ({ page }) => {
    await withSession(page, '/calendario');
    await expect(page.getByText('Agenda · Calendario')).toBeVisible();
    // Cabeceras de días L M X J V S D
    await expect(page.getByText('L').first()).toBeVisible();
    // Toggle a la agenda (pasadas / en curso / próximas)
    await page.getByRole('button', { name: 'Agenda', exact: true }).click();
    await expect(page.getByText('No hay eventos ni clases programados')).toBeVisible();
    // Volver a mes
    await page.getByRole('button', { name: 'Mes' }).click();
    // Navegar mes anterior
    await page.getByRole('button', { name: 'Mes anterior' }).click();
    // Navegar mes siguiente
    await page.getByRole('button', { name: 'Mes siguiente' }).click();
    // El heading del mes debe ser visible
    await expect(page.locator('h2').filter({ hasText: /\d{4}/ })).toBeVisible();
  });

  test('/miembros muestra heading y buscador', async ({ page }) => {
    await withSession(page, '/miembros');
    await expect(page.getByRole('heading', { name: 'Miembros' })).toBeVisible();
    // Para rol alumno: empty state del directorio público
    await expect(page.getByText('Directorio de miembros')).toBeVisible();
  });

  test('/mensajes muestra heading y área vacía', async ({ page }) => {
    await withSession(page, '/mensajes');
    await expect(page.getByRole('heading', { name: 'Mensajes' })).toBeVisible();
    await expect(page.getByText('No tienes conversaciones todavía.')).toBeVisible();
    await expect(page.getByText('Mensajes directos')).toBeVisible();
  });
});
