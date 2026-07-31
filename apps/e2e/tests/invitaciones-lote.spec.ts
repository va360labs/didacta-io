import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signup } from '../helpers/api';

/**
 * El envío por lotes de invitaciones responde SIN esperar a mandar los correos.
 *
 * Regresión que cubre (prod, 2026-07-30): "Enviar a 150" pintaba "No se pudo
 * enviar el lote". El lote salía entero — el bucle seguía en segundo plano —
 * pero a ~1 s por correo la petición pasaba de los 30 s que aguanta el proxy y
 * el panel daba por fallido un envío correcto. En una campaña con un solo
 * disparo por destinatario, eso invita a reintentar a ciegas.
 */

interface Summary {
  sinInvitar: number;
  envio: {
    enCurso: boolean;
    total: number;
    enviados: number;
    fallidos: Array<{ email: string; error: string }>;
  } | null;
}

test.describe('invitaciones · envío por lotes', () => {
  test('arranca el lote al instante y el progreso se sigue desde el summary', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

    // Tres cuentas nuevas que aún no han entrado nunca. El lote se lanza con
    // `emails` (destinatarios explícitos) para no depender de cuántos
    // pendientes haya acumulados en la BD de test.
    const emails = [0, 1, 2].map((i) => `e2e-lote-${stamp}-${i}@example.test`);
    for (const email of emails) {
      const r = await fetch(`${API_URL}/api/v1/admin/users`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, name: `Pendiente ${stamp}`, role: 'alumno' }),
      });
      expect(r.ok, `alta OK (got ${r.status})`).toBe(true);
    }

    const summary = async (): Promise<Summary> => {
      const r = await fetch(`${API_URL}/api/v1/admin/invitations/summary`, { headers });
      expect(r.ok).toBe(true);
      return (await r.json()) as Summary;
    };

    // El lote arranca y responde de inmediato: nada de esperar a los correos.
    const t0 = Date.now();
    const res = await fetch(`${API_URL}/api/v1/admin/invitations/send-batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ emails, pauseMs: 1500 }),
    });
    const transcurrido = Date.now() - t0;
    expect(res.ok, `send-batch OK (got ${res.status})`).toBe(true);
    const arranque = (await res.json()) as { aceptado: boolean; yaEnCurso: boolean; total: number };
    expect(arranque.aceptado).toBe(true);
    expect(arranque.yaEnCurso).toBe(false);
    // 3 correos × 1,5 s de pausa = 4,5 s como poco si fuera síncrono.
    expect(transcurrido).toBeLessThan(3000);

    // Mientras corre, el summary lo dice y un segundo lote no arranca otro bucle.
    const enVuelo = await summary();
    expect(enVuelo.envio?.enCurso).toBe(true);
    const segundo = await fetch(`${API_URL}/api/v1/admin/invitations/send-batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ emails }),
    });
    expect(((await segundo.json()) as { yaEnCurso: boolean }).yaEnCurso).toBe(true);

    // Y acaba solo, con los tres enviados.
    await expect
      .poll(async () => (await summary()).envio?.enCurso, { timeout: 30_000, intervals: [500] })
      .toBe(false);
    const final = await summary();
    expect(final.envio?.enviados).toBeGreaterThanOrEqual(3);
    expect(final.envio?.fallidos ?? []).toHaveLength(0);
  });
});
