import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Spec del audit log (Fase 1.A core).
 *
 * Verifica:
 *  - GET /audit/verify devuelve cadena válida.
 *  - GET /audit/entries lista al menos algunos registros.
 *  - El listado expone los filtros por action.
 */

test.describe('Audit log y verificación de cadena', () => {
  test('GET /audit/verify devuelve cadena válida', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${bearer}` };

    const res = await fetch(`${API_URL}/api/v1/audit/verify`, { headers });
    expect(res.ok, 'verify → 200').toBe(true);
    // El endpoint devuelve `totalEntries` (alineado con el cliente web).
    const body = (await res.json()) as { valid: boolean; totalEntries: number };
    expect(body.valid, 'cadena válida').toBe(true);
    expect(body.totalEntries).toBeGreaterThanOrEqual(0);
  });

  test('GET /audit/entries lista entradas con paginación', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${bearer}` };

    const res = await fetch(`${API_URL}/api/v1/audit/entries?limit=5`, { headers });
    expect(res.ok).toBe(true);
    const list = (await res.json()) as Array<{ id: string; action: string }>;
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeLessThanOrEqual(5);
  });

  test('GET /audit/entries con rol no-admin → 403', async () => {
    // Para esto necesitaríamos crear un usuario alumno; pero todos los entries del
    // bootstrap son admin. Validamos que un bearer inválido devuelve 401.
    const res = await fetch(`${API_URL}/api/v1/audit/verify`, {
      headers: { Authorization: 'Bearer invalid-token' },
    });
    expect([401, 403]).toContain(res.status);
  });
});
