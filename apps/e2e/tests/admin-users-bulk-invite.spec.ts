import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Alta masiva (CSV) de usuarios (viaje 1 de captación de alumnos).
 *
 * Mismo riesgo que `invitaciones-lote.spec.ts`: cada fila crea un user +
 * manda un email de bienvenida, así que el endpoint responde ANTES de
 * terminar y el progreso se sigue con GET bulk-invite/status — si fuera
 * síncrono, un CSV de tamaño moderado pasaría de los ~30 s que aguanta el
 * proxy.
 */

interface BulkInviteState {
  enCurso: boolean;
  total: number;
  creados: number;
  fallidos: Array<{ email: string; error: string }>;
}

test.describe('Admin: alta masiva de usuarios desde CSV', () => {
  test('arranca al instante, crea a todos y el progreso se sigue desde status', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

    const rows = [0, 1, 2].map((i) => ({
      email: `e2e-bulk-${stamp}-${i}@example.test`,
      name: `Alumno bulk ${i}`,
    }));

    const status = async (): Promise<BulkInviteState | null> => {
      const r = await fetch(`${API_URL}/api/v1/admin/users/bulk-invite/status`, { headers });
      expect(r.ok).toBe(true);
      return (await r.json()) as BulkInviteState | null;
    };

    // Arranca y responde de inmediato: nada de esperar a que se creen los 3
    // users + se manden los 3 emails de bienvenida.
    const t0 = Date.now();
    const res = await fetch(`${API_URL}/api/v1/admin/users/bulk-invite`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ rows, role: 'alumno' }),
    });
    const transcurrido = Date.now() - t0;
    expect(res.ok, `bulk-invite OK (got ${res.status})`).toBe(true);
    const arranque = (await res.json()) as { aceptado: boolean; yaEnCurso: boolean; total: number };
    expect(arranque.aceptado).toBe(true);
    expect(arranque.yaEnCurso).toBe(false);
    expect(arranque.total).toBe(3);
    expect(transcurrido).toBeLessThan(3000);

    // Un segundo lote mientras corre el primero no arranca otro bucle.
    const segundo = await fetch(`${API_URL}/api/v1/admin/users/bulk-invite`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ rows, role: 'alumno' }),
    });
    expect(((await segundo.json()) as { yaEnCurso: boolean }).yaEnCurso).toBe(true);

    // Y acaba solo, con los tres creados.
    await expect
      .poll(async () => (await status())?.enCurso, { timeout: 30_000, intervals: [500] })
      .toBe(false);
    const final = await status();
    expect(final?.creados).toBe(3);
    expect(final?.fallidos ?? []).toHaveLength(0);

    // Los 3 quedan de verdad en el listado de usuarios, ACTIVE.
    const list = await fetch(
      `${API_URL}/api/v1/admin/users?search=${encodeURIComponent(`e2e-bulk-${stamp}`)}`,
      { headers },
    );
    expect(list.ok).toBe(true);
    const { items } = (await list.json()) as { items: Array<{ email: string; status: string }> };
    for (const row of rows) {
      const found = items.find((u) => u.email === row.email);
      expect(found, `${row.email} en el listado`).toBeDefined();
      expect(found?.status).toBe('ACTIVE');
    }
  });

  test('una fila con email ya existente falla, no corta el lote y queda en fallidos', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

    const dupEmail = `e2e-bulk-dup-${stamp}@example.test`;
    // Ya existe de antes (invite individual).
    const previo = await fetch(`${API_URL}/api/v1/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: dupEmail, role: 'alumno' }),
    });
    expect(previo.ok).toBe(true);

    const rows = [{ email: dupEmail }, { email: `e2e-bulk-ok-${stamp}@example.test` }];
    const res = await fetch(`${API_URL}/api/v1/admin/users/bulk-invite`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ rows, role: 'alumno' }),
    });
    expect(res.ok).toBe(true);

    const status = async (): Promise<BulkInviteState | null> => {
      const r = await fetch(`${API_URL}/api/v1/admin/users/bulk-invite/status`, { headers });
      return (await r.json()) as BulkInviteState | null;
    };
    await expect
      .poll(async () => (await status())?.enCurso, { timeout: 30_000, intervals: [500] })
      .toBe(false);

    const final = await status();
    expect(final?.creados).toBe(1);
    expect(final?.fallidos).toHaveLength(1);
    expect(final?.fallidos[0]?.email).toBe(dupEmail);
  });
});
