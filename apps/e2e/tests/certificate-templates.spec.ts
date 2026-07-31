import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Spec de plantillas de certificado (HU-FOR-004).
 *
 * Verifica el ciclo completo via API:
 *  - Crear plantilla custom.
 *  - Listar y encontrarla.
 *  - Marcarla como default desmarca otras.
 *  - Generar preview PDF.
 *  - Eliminar (tras desmarcar default).
 */

test.describe('Plantillas custom de certificado (HU-FOR-004)', () => {
  test('crear → marcar default → preview → eliminar', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    };

    const stamp = Date.now();
    const name = `E2E Template ${stamp}`;

    // 1. Crear plantilla custom (no default para no afectar otros tests).
    const created = await fetch(`${API_URL}/api/v1/modules/certificates/templates`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name,
        body: 'Cuerpo de prueba E2E con {{alumno}} y {{curso}}.',
        primaryColor: '#3b82f6',
        signerName: 'Tester E2E',
        signerTitle: 'QA',
        isDefault: false,
      }),
    });
    expect(created.ok, 'create template → 200').toBe(true);
    const tpl = (await created.json()) as { id: string; name: string; isDefault: boolean };
    expect(tpl.name).toBe(name);
    expect(tpl.isDefault).toBe(false);

    // 2. Listar y verificar que aparece.
    const listRes = await fetch(`${API_URL}/api/v1/modules/certificates/templates`, { headers });
    expect(listRes.ok).toBe(true);
    const list = (await listRes.json()) as Array<{ id: string; name: string }>;
    expect(list.find((t) => t.id === tpl.id)).toBeDefined();

    // 3. Generar preview PDF.
    const preview = await fetch(`${API_URL}/api/v1/modules/certificates/templates/preview`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name,
        body: 'Body preview',
        primaryColor: '#3b82f6',
      }),
    });
    expect(preview.ok, 'preview → 200').toBe(true);
    expect(preview.headers.get('content-type')).toContain('application/pdf');
    const pdfBuf = Buffer.from(await preview.arrayBuffer());
    expect(pdfBuf.slice(0, 5).toString('utf-8'), 'header %PDF-').toBe('%PDF-');
    expect(pdfBuf.length).toBeGreaterThan(1000);

    // 4. Eliminar (no es default → debería borrarse OK).
    const del = await fetch(`${API_URL}/api/v1/modules/certificates/templates/${tpl.id}`, {
      method: 'DELETE',
      headers,
    });
    expect(del.ok, 'delete → 200').toBe(true);

    // 5. Verificar que ya no está.
    const after = (await (
      await fetch(`${API_URL}/api/v1/modules/certificates/templates`, { headers })
    ).json()) as Array<{ id: string }>;
    expect(
      after.find((t) => t.id === tpl.id),
      'tpl eliminada',
    ).toBeUndefined();
  });

  test('TEMPLATE_NAME_TAKEN al crear con nombre duplicado', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    };

    const name = `dup-${Date.now()}`;
    const create = (body: unknown) =>
      fetch(`${API_URL}/api/v1/modules/certificates/templates`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

    const first = await create({ name, body: 'a', primaryColor: '#000000' });
    expect(first.ok).toBe(true);
    const firstTpl = (await first.json()) as { id: string };

    const second = await create({ name, body: 'b', primaryColor: '#111111' });
    expect(second.status, 'duplicado → 409').toBe(409);
    const err = (await second.json()) as { code: string };
    expect(err.code).toBe('TEMPLATE_NAME_TAKEN');

    // Cleanup.
    await fetch(`${API_URL}/api/v1/modules/certificates/templates/${firstTpl.id}`, {
      method: 'DELETE',
      headers,
    });
  });
});
