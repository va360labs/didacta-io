import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signup } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Bloque 7 — Panel de métricas del negocio (/admin/metricas):
 *  - El endpoint agrega NPS, ventas, impagos, altas/bajas, conexiones y tutor
 *    IA con las formas esperadas (todo de BD local).
 *  - Un alumno recibe 403.
 *  - La página renderiza los KPIs y las dos gráficas semanales.
 *
 * Usa sesión REAL (patrón de calendario-agenda.spec.ts).
 */

test.describe('Métricas del negocio (bloque 7)', () => {
  test('endpoint con shape correcto, 403 para alumno y página con KPIs', async ({ page }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);

    // 1. Shape del endpoint.
    const res = await fetch(`${API_URL}/api/v1/admin/metrics/business`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.ok, `metrics (${res.status})`).toBe(true);
    const m = (await res.json()) as {
      nps: { score: number | null; responses: number };
      revenue: { totalCents30d: number; weekly: Array<{ weekStart: string; value: number }> };
      arrears: { total: number };
      members: { newMembers30d: number; weeklySignups: unknown[] };
      connections: { totalActive: number };
      aiTutor: { questions30d: number };
    };
    expect(m.revenue.weekly).toHaveLength(12);
    expect(m.members.weeklySignups).toHaveLength(12);
    expect(m.connections.totalActive).toBeGreaterThanOrEqual(1);
    // Las encuestas E2E anteriores dejaron respuestas NPS en la ventana.
    expect(m.nps.responses).toBeGreaterThanOrEqual(1);
    expect(typeof m.nps.score).toBe('number');
    expect(m.arrears.total).toBeGreaterThanOrEqual(0);

    // 2. Un alumno no puede verlas.
    const alumno = await signup({
      tenantSlug,
      email: `e2e-metricas-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Alumno Métricas',
    });
    const forbidden = await fetch(`${API_URL}/api/v1/admin/metrics/business`, {
      headers: { Authorization: `Bearer ${alumno.tokens.accessToken}` },
    });
    expect(forbidden.status, 'alumno → 403').toBe(403);

    // 3. La página renderiza KPIs y gráficas.
    const adminAuthRes = await fetch(`${API_URL}/api/v1/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantSlug,
        email: process.env.E2E_ADMIN_EMAIL,
        password: process.env.E2E_ADMIN_PASSWORD,
      }),
    });
    const adminAuth = (await adminAuthRes.json()) as {
      tokens: { accessToken: string; refreshToken: string };
      user: Parameters<typeof injectSession>[1]['user'];
    };
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: adminAuth.tokens.accessToken,
      refreshToken: adminAuth.tokens.refreshToken,
      user: { ...adminAuth.user, onboardingCompletedAt: new Date().toISOString() },
    });
    // /admin/metricas es ahora un redirect a la pestaña "Negocio" del panel:
    // los KPIs dejaron de tener pantalla propia para no competir con /admin.
    await page.goto('/admin/metricas');
    await expect(page).toHaveURL(/\/admin\?tab=negocio/);
    await expect(page.getByRole('heading', { name: 'Panel del tenant' })).toBeVisible();
    await expect(page.getByText('NPS (30 días)')).toBeVisible();
    await expect(page.getByText('Ventas (30 días)')).toBeVisible();
    await expect(page.getByText('Impagos ahora')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ventas por semana' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Altas por semana' })).toBeVisible();

    // Y se llega igual desde la pestaña, entrando por el panel.
    await page.goto('/admin');
    await expect(page.getByRole('tab', { name: 'Actividad' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByRole('tab', { name: 'Negocio' }).click();
    await expect(page.getByText('NPS (30 días)')).toBeVisible();
  });
});
