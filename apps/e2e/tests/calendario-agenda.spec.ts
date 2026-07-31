import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signup } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * La vista Agenda de /calendario tiene que mostrar clases PASADAS, EN CURSO y
 * PRÓXIMAS aunque caigan fuera del mes que se está mirando.
 *
 * Regresión que cubre: el calendario solo pedía el mes visible, así que una
 * clase del mes siguiente no aparecía ni en la rejilla ni en "Próximas citas"
 * — el usuario veía "Sin eventos ni clases próximos" teniendo una la semana
 * siguiente.
 *
 * Usa sesión REAL (token del API): el spec de humo con sesión falsa no sirve
 * aquí porque cualquier 401 limpia la sesión y rebota a /signin.
 */

function isoIn(days: number, hour = 18): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

test.describe('/calendario · agenda con pasadas, en curso y próximas', () => {
  test('muestra una clase del mes siguiente y una pasada, fuera del mes visible', async ({
    page,
  }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

    // Clase FUTURA a 40 días: cae con seguridad fuera del mes en curso.
    const futura = `Clase futura ${stamp}`;
    const resFutura = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        topic: futura,
        startTime: isoIn(40),
        durationMinutes: 60,
        hostEmail: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
        timezone: 'Europe/Madrid',
      }),
    });
    expect(resFutura.ok, `crear clase futura (${resFutura.status})`).toBe(true);

    // Clase PASADA a 40 días atrás.
    const pasada = `Clase pasada ${stamp}`;
    const resPasada = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        topic: pasada,
        startTime: isoIn(-40),
        durationMinutes: 60,
        hostEmail: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
        timezone: 'Europe/Madrid',
      }),
    });
    expect(resPasada.ok, `crear clase pasada (${resPasada.status})`).toBe(true);

    // Alumno real (sesión válida contra el API).
    const alumno = await signup({
      tenantSlug,
      email: `e2e-cal-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Alumno Calendario',
    });

    await page.goto('/signin');
    await injectSession(page, {
      accessToken: alumno.tokens.accessToken,
      refreshToken: alumno.tokens.refreshToken,
      user: { ...alumno.user, onboardingCompletedAt: new Date().toISOString() },
    });

    await page.goto('/calendario');
    await expect(page.getByText('Agenda · Calendario')).toBeVisible();

    // En la rejilla del mes actual NO están (son de otros meses)…
    await expect(page.getByText(futura)).toHaveCount(0);

    // …pero la Agenda las encuentra sin navegar de mes, cada una en su
    // sección. (`.first()` porque la próxima sale también en la barra
    // lateral "Próximas citas" — que es justo lo que se arregló.)
    await page.getByRole('button', { name: 'Agenda', exact: true }).click();
    const proximas = page.locator('section').filter({ hasText: 'Próximas' }).first();
    await expect(proximas.getByText(futura).first()).toBeVisible();
    const pasadas = page.locator('section').filter({ hasText: 'Pasadas' }).first();
    await expect(pasadas.getByText(pasada).first()).toBeVisible();

    // La clase futura NO puede estar clasificada como "En curso".
    const enCurso = page.locator('section').filter({ hasText: 'En curso' }).first();
    if (await enCurso.count()) {
      await expect(enCurso.getByText(futura)).toHaveCount(0);
    }

    // La barra lateral avisa de la próxima aunque sea de otro mes (el bug
    // original: decía "Sin eventos ni clases próximos").
    await expect(page.getByText('Sin eventos ni clases próximos')).toHaveCount(0);
  });
});
