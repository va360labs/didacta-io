import { expect, test } from '@playwright/test';
import { API_URL, adminTokenForBootstrap, signup } from '../helpers/api';

/**
 * /join no promete lo que el aula no tiene (feedback del 26-nov-2026):
 *   - «¿Qué pasa cuando termina la prueba gratis?» solo si algún plan tiene
 *     prueba. Con planes sin prueba salía igual.
 *   - «N alumnos activos» cuenta alumnos (sin el equipo) y no se enseña por
 *     debajo de 10. Un aula con dos administradores presumía de «2 alumnos
 *     activos».
 *
 * La BD de test es compartida y otros specs dejan planes con prueba: este los
 * apaga mientras corre y los deja como estaban al terminar.
 */

const TENANT_SLUG = process.env.E2E_TENANT_SLUG ?? 'va360';
const PREGUNTA_PRUEBA = '¿Qué pasa cuando termina la prueba gratis?';

interface Plan {
  id: string;
  trialDays: number;
  active: boolean;
}

async function api<T>(path: string, bearer: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function abrirJoin(page: import('@playwright/test').Page) {
  await page.goto('/join');
  // La FAQ sale con y sin niveles (el botón de pago, con niveles, no hasta elegir).
  await expect(page.getByText('¿Puedo cancelar cuando quiera?')).toBeVisible({ timeout: 20_000 });
}

test.describe('/join · lo que se promete', () => {
  test('la pregunta de la prueba sale solo si algún plan tiene prueba', async ({ page }) => {
    const token = await adminTokenForBootstrap(TENANT_SLUG);
    await api('/api/v1/membership/admin/config', token, 'PUT', { active: true });

    const { plans } = await api<{ plans: Plan[] }>('/api/v1/membership/admin/plans', token);
    const conPrueba = plans.filter((p) => p.active && p.trialDays > 0);
    const propio = await api<Plan>('/api/v1/membership/admin/plans', token, 'POST', {
      name: `Plan sin prueba E2E ${Date.now()}`,
      intervalMonths: 1,
      amountCents: 1500,
      trialDays: 0,
    });

    try {
      for (const p of conPrueba) {
        await api(`/api/v1/membership/admin/plans/${p.id}`, token, 'PATCH', { active: false });
      }

      await abrirJoin(page);
      await expect(page.getByText(PREGUNTA_PRUEBA)).toHaveCount(0);

      await api(`/api/v1/membership/admin/plans/${propio.id}`, token, 'PATCH', { trialDays: 7 });
      await abrirJoin(page);
      await expect(page.getByText(PREGUNTA_PRUEBA)).toBeVisible();
    } finally {
      await api(`/api/v1/membership/admin/plans/${propio.id}`, token, 'DELETE');
      for (const p of conPrueba) {
        await api(`/api/v1/membership/admin/plans/${p.id}`, token, 'PATCH', { active: true });
      }
    }
  });

  test('«alumnos activos»: no sale por debajo de 10; desde 10, sí', async ({ page }) => {
    test.setTimeout(120_000);
    const token = await adminTokenForBootstrap(TENANT_SLUG);
    await api('/api/v1/membership/admin/config', token, 'PUT', { active: true });

    const alumnosActivos = async () => {
      const res = await page.request.get('/api/v1/membership/page');
      expect(res.ok(), `membership/page (${res.status()})`).toBe(true);
      return ((await res.json()) as { stats: { activeMembers: number } }).stats.activeMembers;
    };
    // El recuadro: la cifra encima y «alumnos activos» debajo.
    const cifra = page.getByText(/^alumnos? activos?$/);

    await abrirJoin(page);
    let n = await alumnosActivos();
    if (n === 0) {
      // Por debajo del mínimo: ni la cifra ni el recuadro.
      await expect(cifra).toHaveCount(0);
      // Con 10 alumnos más se pasa seguro del mínimo.
      const stamp = Date.now();
      for (let i = 0; i < 10; i++) {
        await signup({
          tenantSlug: TENANT_SLUG,
          email: `e2e-join-alumno-${stamp}-${i}@example.test`,
          password: 'E2eUneteAlumno123!',
          name: `Alumno Join ${i}`,
        });
      }
      await abrirJoin(page);
      n = await alumnosActivos();
    }
    expect(n).toBeGreaterThanOrEqual(10);
    await expect(cifra.first()).toBeVisible();
    await expect(cifra.first().locator('..')).toContainText(String(n));
  });
});
