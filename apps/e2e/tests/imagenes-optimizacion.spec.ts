import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';
import { injectSession } from '../helpers/auth';
import { fotoPngBase64 } from '../helpers/png';

/**
 * Spec de la optimización de imágenes de TODA la plataforma.
 *
 * Antes la optimización vivía solo en `StorageController`, así que cada vía de
 * subida nueva nacía sin ella: el logo del tenant y la API `media` de los
 * módulos guardaban el blob en crudo. Ahora vive en la capa de storage
 * (`ctx.storage.uploadImage`) y la hereda cualquier ruta de subida.
 *
 * Lo que se comprueba aquí es el resultado observable: lo que sube pesa menos y
 * se sirve como WebP, venga por donde venga.
 */

test.describe('Imágenes · optimización en toda la plataforma', () => {
  test('el upload genérico recomprime a WebP y devuelve el ahorro', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const data = fotoPngBase64();
    const originalBytes = Buffer.from(data, 'base64').length;

    const res = await fetch(`${API_URL}/api/v1/storage/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, filename: 'foto.png', contentType: 'image/png' }),
    });
    expect(res.ok, `upload OK (got ${res.status})`).toBe(true);
    const body = (await res.json()) as {
      key: string;
      url: string;
      contentType: string;
      size: number;
      previousSize: number;
      optimized: boolean;
    };

    expect(body.optimized).toBe(true);
    expect(body.contentType).toBe('image/webp');
    // La key acaba en .webp para que el servidor de ficheros resuelva el MIME.
    expect(body.key).toMatch(/\.webp$/);
    expect(body.size).toBeLessThan(originalBytes);
    expect(body.previousSize).toBe(originalBytes);
  });

  test('`optimize.enabled=false` es la única vía para guardar el original', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const data = fotoPngBase64();

    const res = await fetch(`${API_URL}/api/v1/storage/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data,
        filename: 'sin-tocar.png',
        contentType: 'image/png',
        optimize: { enabled: false },
      }),
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { contentType: string; optimized: boolean; key: string };

    expect(body.optimized).toBe(false);
    expect(body.contentType).toBe('image/png');
    expect(body.key).toMatch(/\.png$/);
  });

  test('un SVG se guarda intacto — es vectorial y recomprimirlo lo empeoraría', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    ).toString('base64');

    const res = await fetch(`${API_URL}/api/v1/storage/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: svg, filename: 'icono.svg', contentType: 'image/svg+xml' }),
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { contentType: string; optimized: boolean };

    expect(body.optimized).toBe(false);
    expect(body.contentType).toBe('image/svg+xml');
  });

  test('el inventario de /admin/imagenes responde con totales coherentes', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);

    const res = await fetch(`${API_URL}/api/v1/admin/images/inventory`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(res.ok, `inventory OK (got ${res.status})`).toBe(true);
    const inv = (await res.json()) as {
      items: Array<{ source: string; skipReason: string | null; currentSize: number | null }>;
      currentBytes: number;
      optimizedBytes: number;
      optimizable: number;
      truncated: boolean;
    };

    expect(Array.isArray(inv.items)).toBe(true);
    // Lo optimizable nunca puede pesar más ya optimizado que ahora.
    expect(inv.optimizedBytes).toBeLessThanOrEqual(inv.currentBytes);
    expect(inv.optimizable).toBe(inv.items.filter((i) => i.skipReason === null).length);
    // Solo se cuenta el peso de lo que SÍ se puede mejorar.
    const sumaMejorables = inv.items
      .filter((i) => i.skipReason === null)
      .reduce((a, i) => a + (i.currentSize ?? 0), 0);
    expect(inv.currentBytes).toBe(sumaMejorables);
  });

  test('un alumno no puede tocar el reoptimizador del tenant', async () => {
    const res = await fetch(`${API_URL}/api/v1/admin/images/inventory`);
    // Sin bearer: 401. Lo que no puede es responder 200 a cualquiera.
    expect([401, 403]).toContain(res.status);
  });

  test('/admin/imagenes pinta el inventario y sustituye a la vieja de cursos', async ({ page }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);

    // Una imagen recién subida SIN optimizar deja algo real que reoptimizar,
    // para que la tabla no dependa de lo que hubiera en la BD.
    await fetch(`${API_URL}/api/v1/storage/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: fotoPngBase64(300),
        filename: 'portada-pesada.png',
        contentType: 'image/png',
        optimize: { enabled: false },
      }),
    });

    await page.goto('/signin');
    await injectSession(page, {
      accessToken: bearer,
      user: {
        id: 'admin-stub',
        email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
        name: 'Admin',
        tenantId: 'stub',
        tenantSlug,
        roles: ['super_admin', 'tenant_admin'],
        mfaEnabled: true,
        onboardingCompletedAt: new Date().toISOString(),
      },
    });

    await page.goto('/admin/imagenes');
    await expect(page.getByRole('heading', { name: 'Imágenes', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Imágenes que pueden mejorar')).toBeVisible();
    await expect(page.getByRole('button', { name: /Volver a analizar/i })).toBeVisible({
      timeout: 15_000,
    });

    // La ruta vieja de "Imágenes de cursos" ya no es un segundo camino al mismo
    // sitio: redirige aquí (regla de no duplicar secciones).
    await page.goto('/admin/cursos/imagenes');
    await expect(page).toHaveURL(/\/admin\/imagenes$/, { timeout: 15_000 });
  });
});
