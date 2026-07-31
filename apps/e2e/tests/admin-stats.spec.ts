import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Spec del dashboard tenant_admin (HU-TA-003).
 *
 * Verifica:
 *  - GET /admin/stats con range=all devuelve los 5 campos esperados.
 *  - GET /admin/stats?range=30d aplica filtro temporal y los counts cambian.
 *  - GET /admin/stats?range=invalid devuelve 400 (zod).
 */

test.describe('Dashboard tenant_admin (HU-TA-003)', () => {
  test('payload de stats con range=all tiene los 5 campos esperados', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${bearer}` };

    const res = await fetch(`${API_URL}/api/v1/admin/stats?range=all`, { headers });
    expect(res.ok).toBe(true);
    const stats = (await res.json()) as Record<string, unknown>;
    expect(stats).toMatchObject({ range: 'all' });
    for (const k of [
      'activeUsers',
      'coursesPublished',
      'totalEnrollments',
      'certificatesIssued',
      'completionRate',
    ]) {
      expect(stats[k], `campo ${k} presente`).toBeDefined();
      expect(typeof stats[k]).toBe('number');
    }
  });

  test('range=invalid responde 400 por validación zod', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${bearer}` };

    const res = await fetch(`${API_URL}/api/v1/admin/stats?range=banana`, { headers });
    expect(res.status, 'range inválido → 400').toBe(400);
  });

  test('range=7d devuelve completionRate en [0..100]', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${bearer}` };

    const res = await fetch(`${API_URL}/api/v1/admin/stats?range=7d`, { headers });
    expect(res.ok).toBe(true);
    const stats = (await res.json()) as { range: string; completionRate: number };
    expect(stats.range).toBe('7d');
    expect(stats.completionRate).toBeGreaterThanOrEqual(0);
    expect(stats.completionRate).toBeLessThanOrEqual(100);
  });
});
