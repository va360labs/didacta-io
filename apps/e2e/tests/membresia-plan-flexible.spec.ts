import { expect, test } from '@playwright/test';
import { API_URL, adminTokenForBootstrap } from '../helpers/api';

/**
 * F7 — planes de membresía con periodicidad libre (1..12 meses) y moneda por
 * plan. Antes el producto solo admitía 1/3/12 meses y cableaba 'eur'.
 *
 * Cubre:
 *  - crear un plan SEMESTRAL en USD y verlo en la página pública /membership/page
 *    con su periodicidad y su moneda (lo que pinta /unete);
 *  - editar la periodicidad a un valor sin nombre clásico (bimestral);
 *  - la moneda por defecto sigue siendo eur si el admin no la indica;
 *  - periodicidades fuera de 1..12 (o moneda malformada) → 400.
 *
 * Estilo API-only (como viaje1-matricula-admin.spec.ts): sin navegador, contra
 * el stack efímero. Un solo signin de admin cacheado (rate-limit de /auth/signin).
 */

const TENANT = process.env.E2E_TENANT_SLUG ?? 'demo';

let cachedAdminToken: string | null = null;
async function adminToken(): Promise<string> {
  if (!cachedAdminToken) cachedAdminToken = await adminTokenForBootstrap(TENANT);
  return cachedAdminToken;
}

async function adminHeaders(): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await adminToken()}`,
    'Content-Type': 'application/json',
  };
}

interface PlanView {
  id: string;
  name: string;
  intervalMonths: number;
  amountCents: number;
  currency: string;
}

async function createPlan(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${API_URL}/api/v1/membership/admin/plans`, {
    method: 'POST',
    headers: await adminHeaders(),
    body: JSON.stringify(body),
  });
}

async function deletePlan(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/v1/membership/admin/plans/${id}`, {
    method: 'DELETE',
    headers: await adminHeaders(),
  });
  expect(res.ok, 'borrar plan de prueba').toBe(true);
}

test.describe('Membresía: periodicidad 1..12 y moneda por plan (F7)', () => {
  test('plan semestral en USD → visible en la página pública; editable a bimestral', async () => {
    const headers = await adminHeaders();
    const stamp = Date.now();

    // La página pública exige config activa (PUT parcial: no pisa el resto).
    const cfg = await fetch(`${API_URL}/api/v1/membership/admin/config`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ active: true }),
    });
    expect(cfg.ok, 'activar página de membresía').toBe(true);

    const created = await createPlan({
      name: `Plan Semestral E2E ${stamp}`,
      intervalMonths: 6,
      amountCents: 14_900,
      currency: 'usd',
    });
    expect(created.status, 'crear plan semestral USD').toBe(201);
    const plan = (await created.json()) as PlanView;
    expect(plan.intervalMonths).toBe(6);
    expect(plan.currency).toBe('usd');

    try {
      // La página pública (la que consume /unete, sin bearer) lo enseña tal cual.
      const pageRes = await fetch(`${API_URL}/api/v1/membership/page`);
      expect(pageRes.ok, 'GET /membership/page sin auth').toBe(true);
      const page = (await pageRes.json()) as { plans: PlanView[] };
      const publicado = page.plans.find((p) => p.id === plan.id);
      expect(publicado, 'el plan sale en la página pública').toBeDefined();
      expect(publicado?.intervalMonths).toBe(6);
      expect(publicado?.currency).toBe('usd');

      // Editable a una periodicidad sin nombre clásico (bimestral).
      const patched = await fetch(`${API_URL}/api/v1/membership/admin/plans/${plan.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ intervalMonths: 2 }),
      });
      expect(patched.ok, 'editar a bimestral').toBe(true);
      expect(((await patched.json()) as PlanView).intervalMonths).toBe(2);
    } finally {
      await deletePlan(plan.id);
    }
  });

  test('sin moneda indicada, el plan queda en eur (default, no imposición)', async () => {
    const stamp = Date.now();
    const created = await createPlan({
      name: `Plan Default E2E ${stamp}`,
      intervalMonths: 1,
      amountCents: 990,
    });
    expect(created.status).toBe(201);
    const plan = (await created.json()) as PlanView;
    expect(plan.currency).toBe('eur');
    await deletePlan(plan.id);
  });

  test('periodicidad fuera de 1..12 o moneda malformada → 400', async () => {
    const stamp = Date.now();
    for (const intervalMonths of [0, 13, 24, 1.5]) {
      const res = await createPlan({
        name: `Plan Inválido E2E ${stamp}`,
        intervalMonths,
        amountCents: 990,
      });
      expect(res.status, `intervalMonths=${intervalMonths} rechazado`).toBe(400);
    }
    const badCurrency = await createPlan({
      name: `Plan Moneda Mala E2E ${stamp}`,
      intervalMonths: 1,
      amountCents: 990,
      currency: 'euros',
    });
    expect(badCurrency.status, 'moneda no ISO-4217 rechazada').toBe(400);
  });
});
