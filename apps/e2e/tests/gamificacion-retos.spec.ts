import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signup } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Bloque 1 — Puntos, niveles y retos (mod.gamification):
 *  - Las reglas se siembran solas con los pesos del ranking anterior (post 10,
 *    comentario 5), así el traspaso no mueve a nadie de puesto.
 *  - Los niveles y los retos nacen VACÍOS: los crea el operador.
 *  - El admin crea un reto y lo abre; un ALUMNO lo ve en /retos y entrega con
 *    prueba; el admin lo aprueba y los puntos aparecen en la clasificación.
 *  - Reglas de integridad: no se entrega dos veces el mismo reto (409), no se
 *    revisa dos veces la misma entrega (409), y el relleno del histórico es
 *    idempotente (repetirlo no crea asientos nuevos).
 *
 * Usa sesión REAL (patrón de recursos-biblioteca.spec.ts).
 */

async function fullSession(
  page: Parameters<typeof injectSession>[0],
  auth: {
    tokens: { accessToken: string; refreshToken: string };
    user: Parameters<typeof injectSession>[1]['user'];
  },
) {
  await page.goto('/signin');
  await injectSession(page, {
    accessToken: auth.tokens.accessToken,
    refreshToken: auth.tokens.refreshToken,
    user: { ...auth.user, onboardingCompletedAt: new Date().toISOString() },
  });
}

const BASE = '/api/v1/modules/gamification';

test.describe('Puntos, niveles y retos (mod.gamification)', () => {
  test('catálogo, entrega con prueba, aprobación y clasificación', async ({ page }) => {
    test.setTimeout(180_000);
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

    // 1. Las reglas se siembran solas, conservando los pesos del ranking viejo.
    const rulesRes = await fetch(`${API_URL}${BASE}/admin/rules`, { headers });
    expect(rulesRes.ok, `listar reglas (${rulesRes.status})`).toBe(true);
    const { rules } = (await rulesRes.json()) as {
      rules: Array<{ key: string; points: number; dailyCap: number; enabled: boolean }>;
    };
    expect(rules.find((r) => r.key === 'community.post')?.points).toBe(10);
    expect(rules.find((r) => r.key === 'community.comment')?.points).toBe(5);

    // 2. El relleno del histórico es idempotente: la segunda pasada no acredita
    //    nada nuevo aunque la primera sí lo haya hecho.
    const firstFill = await fetch(`${API_URL}${BASE}/admin/backfill`, { method: 'POST', headers });
    expect(firstFill.ok, `primer relleno (${firstFill.status})`).toBe(true);
    const secondFill = await fetch(`${API_URL}${BASE}/admin/backfill`, { method: 'POST', headers });
    const second = (await secondFill.json()) as { awarded: number };
    expect(second.awarded, 'el segundo relleno no duplica puntos').toBe(0);

    // 3. El admin crea un reto y lo abre.
    const title = `Publica tu caso de éxito E2E ${stamp}`;
    const createRes = await fetch(`${API_URL}${BASE}/admin/challenges`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title,
        description: 'Sube una captura del resultado y cuéntanos qué cambió.',
        points: 120,
        proofRequired: true,
        status: 'OPEN',
      }),
    });
    expect(createRes.status, 'crear reto').toBe(201);
    const challenge = (await createRes.json()) as { id: string };

    // 4. Un alumno nuevo ve el reto en /retos y entrega con prueba.
    const student = await signup({
      tenantSlug,
      email: `reto.alumno.${stamp}@e2e.test`,
      password: 'RetoE2E2026!',
      name: 'Alumna de retos',
    });
    await fullSession(page, student as never);
    await page.goto('/retos');
    // exact: true — si no, colisiona con el h2 "Retos abiertos" de más abajo.
    await expect(page.getByRole('heading', { name: 'Retos', exact: true })).toBeVisible();
    await expect(page.getByText(title).first()).toBeVisible();
    // La entrega vive en un modal, y antes de enviar hay un paso de
    // confirmación: la entrega es única por reto y persona.
    //
    // Acotado a la tarjeta del reto: la cabecera tiene su propio atajo
    // ("Entregar el reto más rápido") que también case con /Entregar/.
    await page
      .getByTestId('challenge-card')
      .filter({ hasText: title })
      .getByRole('button', { name: 'Entregar', exact: true })
      .click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByText('Entregar reto')).toBeVisible();
    await modal.getByLabel('Cuéntanos qué has hecho').fill('Automaticé el alta de clientes.');
    await modal.getByLabel('…o pega un enlace').fill('https://ejemplo.com/mi-caso');
    await modal.getByRole('button', { name: 'Continuar' }).click();

    await expect(modal.getByText('Confirmar entrega')).toBeVisible();
    await expect(modal.getByText('https://ejemplo.com/mi-caso')).toBeVisible();
    await modal.getByRole('button', { name: 'Confirmar y enviar' }).click();

    await expect(page.getByText('En revisión').first()).toBeVisible();

    const studentToken = (student as { tokens: { accessToken: string } }).tokens.accessToken;
    const studentHeaders = {
      Authorization: `Bearer ${studentToken}`,
      'Content-Type': 'application/json',
    };

    // 5. Entregar dos veces el mismo reto es un conflicto, no un duplicado.
    const dupe = await fetch(`${API_URL}${BASE}/challenges/${challenge.id}/submit`, {
      method: 'POST',
      headers: studentHeaders,
      body: JSON.stringify({ proofUrl: 'https://ejemplo.com/otra' }),
    });
    expect(dupe.status, 'segunda entrega del mismo reto').toBe(409);

    // 6. El admin ve la entrega pendiente y la aprueba desde la UI.
    const adminAuthRes = await fetch(`${API_URL}/api/v1/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantSlug,
        email: process.env.E2E_ADMIN_EMAIL,
        password: process.env.E2E_ADMIN_PASSWORD,
      }),
    });
    const adminAuth = (await adminAuthRes.json()) as never;
    await fullSession(page, adminAuth);
    await page.goto('/admin/gamificacion');
    await expect(page.getByRole('heading', { name: 'Puntos y retos' })).toBeVisible();

    await page.getByRole('tab', { name: 'Entregas' }).click();
    await expect(page.getByText(title).first()).toBeVisible();
    await page.getByRole('button', { name: 'Aprobar y dar puntos' }).first().click();
    await expect(page.getByText('No hay entregas pendientes')).toBeVisible();

    // 7. Los puntos del reto ya están en el saldo del alumno.
    const standingRes = await fetch(`${API_URL}${BASE}/me?range=all`, { headers: studentHeaders });
    const standing = (await standingRes.json()) as { points: number; lifetimePoints: number };
    expect(standing.lifetimePoints, 'el reto acreditó sus puntos').toBeGreaterThanOrEqual(120);

    // 8. Revisar dos veces la misma entrega no paga dos veces.
    const pending = await fetch(`${API_URL}${BASE}/admin/submissions?status=APPROVED`, { headers });
    const { submissions } = (await pending.json()) as { submissions: Array<{ id: string }> };
    const approved = submissions[0];
    expect(approved, 'hay una entrega aprobada').toBeTruthy();
    const reReview = await fetch(`${API_URL}${BASE}/admin/submissions/${approved!.id}/review`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ approve: true }),
    });
    expect(reReview.status, 'segunda revisión de la misma entrega').toBe(409);

    // 9. El alumno aparece en la clasificación con esos puntos.
    await fullSession(page, student as never);
    await page.goto('/leaderboard');
    await expect(page.getByRole('heading', { name: 'Clasificación' })).toBeVisible();
    await page.getByRole('button', { name: 'Global' }).click();
    await expect(page.getByText('Alumna de retos').first()).toBeVisible();
  });

  test('los niveles nacen vacíos y el admin los crea', async ({ page }) => {
    test.setTimeout(120_000);
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();

    const adminAuthRes = await fetch(`${API_URL}/api/v1/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantSlug,
        email: process.env.E2E_ADMIN_EMAIL,
        password: process.env.E2E_ADMIN_PASSWORD,
      }),
    });
    const adminAuth = (await adminAuthRes.json()) as never;
    await fullSession(page, adminAuth);

    await page.goto('/admin/gamificacion');
    await page.getByRole('tab', { name: 'Niveles' }).click();

    // Un beneficio cuelga de un nivel y NO se concede solo: se solicita y una
    // persona lo atiende. A propósito no toca los grupos de acceso — eso es
    // acceso comprado y no puede ganarse participando.
    const name = `Nivel E2E ${stamp}`;
    // Un mínimo alto pero dentro del tope permitido (100.000), y único por
    // ejecución: la unique (tenant, minPoints) rechaza dos niveles con el mismo.
    const minPoints = 50_000 + (stamp % 10_000);
    await page.getByLabel('Nombre').fill(name);
    await page.getByLabel('Desde (puntos)').fill(String(minPoints));
    await page.getByLabel('Beneficio').fill('Acceso anticipado a las clases nuevas.');
    await page.getByRole('button', { name: 'Crear nivel' }).click();

    await expect(page.getByText(name)).toBeVisible();

    // El nivel recién creado ya se puede colgar un beneficio.
    await page.getByRole('tab', { name: 'Beneficios' }).click();
    const perkTitle = `Sesión 1:1 E2E ${stamp}`;
    await page.getByLabel('Qué desbloquea').fill(perkTitle);
    await page
      .getByLabel('Nivel que lo desbloquea')
      .selectOption({ label: `${name} (${minPoints} pts)` });
    await page.getByLabel('Detalle para el alumno').fill('Media hora para revisar tu caso.');
    await page.getByRole('button', { name: 'Crear beneficio' }).click();

    await expect(page.getByText(perkTitle)).toBeVisible();
    await expect(page.getByText('Activo').first()).toBeVisible();
  });

  test('el alumno ve el beneficio bloqueado y no lo puede pedir sin nivel', async ({ page }) => {
    test.setTimeout(120_000);
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

    // Nivel altísimo: nadie lo alcanza, así el beneficio sale bloqueado.
    const levelRes = await fetch(`${API_URL}${BASE}/admin/levels`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        key: `inalcanzable-${stamp}`,
        name: `Inalcanzable ${stamp}`,
        minPoints: 90_000 + (stamp % 1000),
      }),
    });
    expect(levelRes.status, 'crear nivel').toBe(201);
    const level = (await levelRes.json()) as { id: string };

    const perkRes = await fetch(`${API_URL}${BASE}/admin/perks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        levelId: level.id,
        title: `Píldora a medida ${stamp}`,
        description: 'Un vídeo corto resolviendo tu caso concreto.',
      }),
    });
    expect(perkRes.status, 'crear beneficio').toBe(201);
    const perk = (await perkRes.json()) as { id: string };

    const student = await signup({
      tenantSlug,
      email: `perk.alumno.${stamp}@e2e.test`,
      password: 'PerkE2E2026!',
      name: 'Alumno de beneficios',
    });
    const studentHeaders = {
      Authorization: `Bearer ${(student as { tokens: { accessToken: string } }).tokens.accessToken}`,
      'Content-Type': 'application/json',
    };

    // Pedirlo sin nivel se rechaza en el servidor, no solo en la UI.
    const denied = await fetch(`${API_URL}${BASE}/perks/${perk.id}/request`, {
      method: 'POST',
      headers: studentHeaders,
      body: JSON.stringify({}),
    });
    expect(denied.status, 'solicitar sin nivel suficiente').toBe(409);

    await fullSession(page, student as never);
    await page.goto('/retos');
    await expect(page.getByText(`Píldora a medida ${stamp}`)).toBeVisible();
    // Acotado al stamp: ejecuciones anteriores dejan sus propios niveles.
    await expect(
      page.getByText(new RegExp(`Se desbloquea en Inalcanzable ${stamp}`)),
    ).toBeVisible();
  });
});
