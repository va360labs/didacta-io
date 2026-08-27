/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Test del cliente HTTP del acceso de seguimiento Fundae (LMS-123).
 *
 * Lo que se blinda aquí es la parte que falla EN SILENCIO: la URL. Un path mal
 * escrito no rompe la compilación ni el build de Next — se manifiesta como un
 * 404 en pantalla el día que un inspector entra con las claves comunicadas a
 * Fundae, que es exactamente el peor momento.
 *
 * Los dos contratos se prueban por separado porque tienen prefijos distintos a
 * propósito: conceder es `/admin/...` (solo admin), leer el expediente es
 * `/fundae/inspection/...` (lo llama la propia inspección, que NO es admin).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { fundaeInspectionApi, fundaeInspectorsApi } from './inspection-client';

function mockOk(body: unknown) {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function lastCall(): [string, RequestInit] {
  const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1] as [string, RequestInit];
}

describe('cliente del acceso de seguimiento Fundae', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
    vi.spyOn(authStorage, 'getAccessToken').mockReturnValue('jwt-token');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('lista los accesos del grupo contra el endpoint de admin, con el bearer', async () => {
    mockOk([]);
    await fundaeInspectorsApi.list('grupo-1');
    const [url, init] = lastCall();
    expect(url.endsWith('/api/v1/admin/fundae/groups/grupo-1/inspectors')).toBe(true);
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer jwt-token');
  });

  it('concede el acceso con POST y manda solo los campos informados', async () => {
    mockOk({ id: 'a1' });
    await fundaeInspectorsApi.grant('grupo-1', { userId: 'user-1' });
    const [url, init] = lastCall();
    expect(url.endsWith('/api/v1/admin/fundae/groups/grupo-1/inspectors')).toBe(true);
    expect(init.method).toBe('POST');
    // `expiresAt` y `notas` son opcionales: si no se rellenan, no viajan — el
    // backend distingue "sin caducidad" de "caducidad vacía".
    expect(JSON.parse(String(init.body))).toEqual({ userId: 'user-1' });
  });

  it('retira el acceso por (grupo, usuario) — no por id de la fila', async () => {
    mockOk({ revoked: true });
    await fundaeInspectorsApi.revoke('grupo-1', 'user-1');
    const [url, init] = lastCall();
    expect(url.endsWith('/api/v1/admin/fundae/groups/grupo-1/inspectors/user-1')).toBe(true);
    expect(init.method).toBe('DELETE');
  });

  it('la inspección lee sus grupos y el expediente fuera del prefijo /admin', async () => {
    mockOk([]);
    await fundaeInspectionApi.myGroups();
    expect(lastCall()[0].endsWith('/api/v1/fundae/inspection/groups')).toBe(true);

    mockOk({ groupId: 'grupo-1', participants: [] });
    await fundaeInspectionApi.get('grupo-1');
    const [url] = lastCall();
    expect(url.endsWith('/api/v1/fundae/inspection/groups/grupo-1')).toBe(true);
    // Control: el expediente NO cuelga de /admin — si lo hiciera, un inspector
    // (que no es admin) recibiría un 403 del guard.
    expect(url.includes('/admin/')).toBe(false);
  });

  it('sin sesión falla en el cliente y no llega a hacer la petición', async () => {
    vi.spyOn(authStorage, 'getAccessToken').mockReturnValue(null);
    await expect(fundaeInspectionApi.myGroups()).rejects.toBeInstanceOf(ApiHttpError);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
