import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signin, signup } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Clases en directo vistas desde la comunidad y desde el calendario.
 *
 * Cubre tres entregas del 2026-07-30:
 *
 *  1. REGRESIÓN de la rejilla del mes: una clase que cae en los días del mes
 *     VECINO que rellenan la rejilla (p. ej. el lunes 3 de agosto visto desde
 *     julio) tiene que pintarse. Antes esas celdas no tenían fecha y salían
 *     siempre vacías, así que la clase parecía no existir.
 *  2. Bloque «Próximas citas» en el feed de la comunidad.
 *  3. Anuncio automático opt-in de la clase en el feed, con tarjeta rica e
 *     inscripción sin salir de la comunidad.
 */

/** Inicio dentro de los días del mes siguiente que rellenan la rejilla actual. */
function inicioEnColaDeLaRejilla(): { iso: string; dia: number } {
  const hoy = new Date();
  // Último día del mes en curso + 2: cae siempre en el mes siguiente y dentro
  // de la primera semana, que es la que la rejilla de este mes sigue pintando.
  const d = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 2, 18, 0, 0, 0);
  return { iso: d.toISOString(), dia: d.getDate() };
}

async function crearClase(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  expect(res.ok, `crear clase (${res.status}): ${await res.clone().text()}`).toBe(true);
  return (await res.json()) as { id: string };
}

test.describe('clases en directo · calendario y comunidad', () => {
  test('la rejilla del mes pinta una clase de los días del mes siguiente', async ({ page }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

    const { iso, dia } = inicioEnColaDeLaRejilla();
    const topic = `Clase cola rejilla ${stamp}`;
    await crearClase(headers, {
      topic,
      startTime: iso,
      durationMinutes: 60,
      hostEmail: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
      timezone: 'Europe/Madrid',
    });

    const alumno = await signup({
      tenantSlug,
      email: `e2e-rejilla-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Alumna Rejilla',
    });

    await page.goto('/signin');
    await injectSession(page, {
      accessToken: alumno.tokens.accessToken,
      refreshToken: alumno.tokens.refreshToken,
      user: { ...alumno.user, onboardingCompletedAt: new Date().toISOString() },
    });

    await page.goto('/calendario');
    await expect(page.getByText('Agenda · Calendario')).toBeVisible();

    // Sin cambiar de mes: la píldora está en la celda del día correspondiente
    // de la cola de la rejilla. `title` lleva el topic completo.
    const pildora = page.locator(`[title="${topic}"]`);
    await expect(pildora.first()).toBeVisible();

    // Y esa celda es la del día que toca (defensa contra pintar en la celda
    // equivocada al cruzar de mes).
    const celda = pildora.first().locator('xpath=ancestor::div[1]');
    await expect(celda).toContainText(String(dia));
  });

  test('el feed de la comunidad muestra las próximas citas y el anuncio con inscripción', async ({
    page,
  }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

    // Clase a 5 días, anunciada en la comunidad.
    const enCinco = new Date();
    enCinco.setDate(enCinco.getDate() + 5);
    enCinco.setHours(17, 0, 0, 0);
    const topic = `Masterclass anunciada ${stamp}`;
    const clase = await crearClase(headers, {
      topic,
      startTime: enCinco.toISOString(),
      durationMinutes: 90,
      hostEmail: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
      timezone: 'Europe/Madrid',
      announce: true,
    });

    const alumno = await signup({
      tenantSlug,
      email: `e2e-feed-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Alumno Feed',
    });

    await page.goto('/signin');
    await injectSession(page, {
      accessToken: alumno.tokens.accessToken,
      refreshToken: alumno.tokens.refreshToken,
      user: { ...alumno.user, onboardingCompletedAt: new Date().toISOString() },
    });

    await page.goto('/comunidad');
    await expect(page.getByRole('heading', { name: 'Comunidad' })).toBeVisible();

    // (2) Bloque «Próximas citas» con la clase, sin ir al calendario.
    await expect(page.getByRole('heading', { name: 'Próximas citas' })).toBeVisible();
    await expect(page.getByTestId('proximas-citas').getByText(topic)).toBeVisible();

    // (3) El anuncio automático está en el feed con su tarjeta rica.
    const tarjeta = page.getByTestId(`clase-embed-${clase.id}`);
    await expect(tarjeta).toBeVisible();
    await expect(tarjeta.getByText('Clase en directo')).toBeVisible();

    // Inscripción SIN salir del feed ni abrir el detalle del post.
    const inscribirme = tarjeta.getByRole('button', { name: 'Inscribirme' });
    await expect(inscribirme).toBeVisible();
    await inscribirme.click();

    await expect(tarjeta.getByText('Inscrito')).toBeVisible();
    // El click en la tarjeta no debe abrir el modal del post.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/\/comunidad$/);
  });

  test('sin marcar «anunciar» la clase no se publica en el feed', async ({ page }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

    const enSeis = new Date();
    enSeis.setDate(enSeis.getDate() + 6);
    enSeis.setHours(19, 0, 0, 0);
    const topic = `Clase silenciosa ${stamp}`;
    await crearClase(headers, {
      topic,
      startTime: enSeis.toISOString(),
      durationMinutes: 60,
      hostEmail: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
      timezone: 'Europe/Madrid',
      // announce omitido a propósito: por defecto NO se anuncia.
    });

    const alumno = await signup({
      tenantSlug,
      email: `e2e-silencio-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Alumna Silencio',
    });

    await page.goto('/signin');
    await injectSession(page, {
      accessToken: alumno.tokens.accessToken,
      refreshToken: alumno.tokens.refreshToken,
      user: { ...alumno.user, onboardingCompletedAt: new Date().toISOString() },
    });

    await page.goto('/comunidad');
    await expect(page.getByRole('heading', { name: 'Comunidad' })).toBeVisible();

    // Sí sale en «Próximas citas» (es una clase real del tenant)…
    await expect(page.getByRole('heading', { name: 'Próximas citas' })).toBeVisible();
    // …pero NO hay post en el feed anunciándola.
    await expect(page.getByRole('heading', { name: topic })).toHaveCount(0);
  });
});

/**
 * Edición de una clase en directo desde /formador/aula-virtual, incluyendo
 * anunciarla a posteriori: el caso real es una clase creada sin marcar
 * «anunciar» que luego se quiere publicar en la comunidad.
 */
test.describe('clases en directo · editar y anunciar', () => {
  test('editar una clase no anunciada permite publicarla; volver a editar sincroniza el post', async ({
    page,
  }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

    const enSiete = new Date();
    enSiete.setDate(enSiete.getDate() + 7);
    enSiete.setHours(16, 0, 0, 0);
    const original = `Clase editable ${stamp}`;
    const clase = await crearClase(headers, {
      topic: original,
      startTime: enSiete.toISOString(),
      durationMinutes: 60,
      hostEmail: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
      timezone: 'Europe/Madrid',
      // Nace SIN anunciar: es lo que luego se publica desde la edición.
    });

    // Sesión de admin en el navegador (el user viene del signin).
    const session = await signin({
      tenantSlug,
      email: process.env.E2E_ADMIN_EMAIL!,
      password: process.env.E2E_ADMIN_PASSWORD!,
    });
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: adminToken,
      user: {
        ...session.user,
        tenantSlug,
        mfaEnabled: true,
        onboardingCompletedAt: new Date().toISOString(),
      },
    });

    await page.goto('/formador/aula-virtual');
    await expect(page.getByRole('heading', { name: 'Aula virtual' })).toBeVisible();

    // De partida NO hay anuncio en el feed.
    await page.goto('/comunidad');
    await expect(page.getByRole('heading', { name: original })).toHaveCount(0);

    // Editar: cambiar el título y marcar «anunciar».
    const renombrada = `Clase renombrada ${stamp}`;
    await page.goto('/formador/aula-virtual');
    await page.getByTestId(`editar-clase-${clase.id}`).click();
    await expect(page.getByRole('heading', { name: 'Editar clase en directo' })).toBeVisible();

    // El formulario viene precargado con los datos de la clase.
    await expect(page.locator('#topic')).toHaveValue(original);
    await expect(page.locator('#durationMinutes')).toHaveValue('60');
    // La hora se lee en la zona de la CLASE: 16:00 en Madrid, no en la del navegador.
    await expect(page.locator('#startTime')).toHaveValue(/T16:00$/);
    // El host no es editable en edición: se muestra como dato.
    await expect(page.locator('#hostEmail')).toHaveCount(0);

    await page.locator('#topic').fill(renombrada);
    // En edición la casilla NO viene marcada: hay que pedirlo explícitamente.
    const anunciar = page.getByTestId('anunciar-clase');
    await expect(anunciar).not.toBeChecked();
    await anunciar.check();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();

    // Vuelve al listado con el título nuevo.
    await expect(page.getByRole('heading', { name: renombrada })).toBeVisible();

    // Y ahora sí hay anuncio en el feed, con su tarjeta e inscripción.
    await page.goto('/comunidad');
    const tarjeta = page.getByTestId(`clase-embed-${clase.id}`);
    await expect(tarjeta).toBeVisible();
    await expect(page.getByRole('heading', { name: renombrada })).toBeVisible();

    // Segunda edición SIN marcar la casilla: no duplica el post y lo sincroniza.
    const definitiva = `Clase definitiva ${stamp}`;
    await page.goto('/formador/aula-virtual');
    await page.getByTestId(`editar-clase-${clase.id}`).click();
    await page.locator('#topic').fill(definitiva);
    await expect(page.getByTestId('anunciar-clase')).not.toBeChecked();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByRole('heading', { name: definitiva })).toBeVisible();

    await page.goto('/comunidad');
    // Un único post, con el título ya actualizado.
    await expect(page.getByRole('heading', { name: definitiva })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: renombrada })).toHaveCount(0);
    await expect(page.getByTestId(`clase-embed-${clase.id}`)).toHaveCount(1);
  });
});
