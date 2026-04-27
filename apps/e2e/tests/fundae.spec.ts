import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Spec de mod.fundae (#161). API-driven.
 *
 * Cubre:
 * - Admin crea acción formativa con campos válidos.
 * - El listado la devuelve.
 * - Código duplicado rechaza con 409.
 * - Fechas invertidas rechazan con 422.
 * - GET export.xml devuelve `application/xml` con los campos esperados.
 * - Archive marca status ARCHIVED.
 */
test.describe('mod.fundae · acciones formativas', () => {
  test('CRUD completo + export XML + validaciones', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const headers = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };

    const codigo = `AF-E2E-${stamp}`;

    // 1. Crear acción.
    const created = await fetch(`${API_URL}/api/v1/modules/fundae/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        codigoAccion: codigo,
        nombre: 'Curso E2E Fundae',
        modalidad: 'TELEFORMACION',
        horasFormacion: 12.5,
        fechaInicio: '2026-05-01',
        fechaFin: '2026-05-15',
        lugar: 'On-line',
      }),
    });
    expect(created.ok, `create OK (got ${created.status})`).toBe(true);
    const action = (await created.json()) as {
      id: string;
      status: string;
      codigoAccion: string;
    };
    expect(action.status).toBe('DRAFT');

    // 2. Aparece en el listado.
    const listRes = await fetch(`${API_URL}/api/v1/modules/fundae/actions`, { headers });
    const list = (await listRes.json()) as Array<{ id: string }>;
    expect(list.some((a) => a.id === action.id)).toBe(true);

    // 3. Código duplicado → 409.
    const dup = await fetch(`${API_URL}/api/v1/modules/fundae/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        codigoAccion: codigo, // mismo código
        nombre: 'Otro',
        modalidad: 'TELEFORMACION',
        horasFormacion: 5,
        fechaInicio: '2026-06-01',
        fechaFin: '2026-06-15',
      }),
    });
    expect(dup.status).toBe(409);

    // 4. Fechas invertidas → 422.
    const invalidDates = await fetch(`${API_URL}/api/v1/modules/fundae/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        codigoAccion: `AF-E2E-INV-${stamp}`,
        nombre: 'Inválido',
        modalidad: 'PRESENCIAL',
        horasFormacion: 5,
        fechaInicio: '2026-07-15',
        fechaFin: '2026-07-01', // antes del inicio
      }),
    });
    expect(invalidDates.status).toBe(422);

    // 5. Export XML.
    const xmlRes = await fetch(`${API_URL}/api/v1/modules/fundae/actions/${action.id}/export.xml`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(xmlRes.ok).toBe(true);
    expect(xmlRes.headers.get('content-type')).toContain('application/xml');
    const xml = await xmlRes.text();
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain(`<codigoAccion>${codigo}</codigoAccion>`);
    expect(xml).toContain('<modalidad>TELEFORMACION</modalidad>');
    expect(xml).toContain('<horasFormacion>12.5</horasFormacion>');

    // 6. Archive.
    const arch = await fetch(`${API_URL}/api/v1/modules/fundae/actions/${action.id}`, {
      method: 'DELETE',
      headers,
    });
    expect(arch.ok).toBe(true);

    const afterArch = await fetch(`${API_URL}/api/v1/modules/fundae/actions/${action.id}`, {
      headers,
    });
    const detail = (await afterArch.json()) as { status: string };
    expect(detail.status).toBe('ARCHIVED');
  });
});
