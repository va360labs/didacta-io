/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del reoptimizador del histórico de imágenes (/admin/imagenes).
 *
 * Lo que importa aquí no es comprimir (eso ya lo cubre image-optimizing-storage)
 * sino el repunte: después de crear el blob nuevo hay que dejar la fila dueña
 * apuntando a él. Cada fuente lo guarda en un sitio distinto y una equivocación
 * ahí deja imágenes rotas en producción.
 */

import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AdminImagesService, extractStorageUrls } from '../src/admin/admin-images.service';

const TENANT = 'tenant-1';
const MARKER = '/api/v1/storage/file/';

/** PNG con degradado suave: comprime mucho a WebP, como una foto real. */
async function makeFoto(size = 400): Promise<Buffer> {
  const channels = 3;
  const raw = Buffer.alloc(size * size * channels);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * channels;
      raw[i] = (x * 255) / size;
      raw[i + 1] = (y * 255) / size;
      raw[i + 2] = 128;
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels } })
    .png()
    .toBuffer();
}

function makeHarness(foto: Buffer) {
  const blobs = new Map<string, Buffer>([[`tenants/${TENANT}/uploads/vieja.png`, foto]]);

  const storage = {
    download: vi.fn(async (key: string) => {
      const b = blobs.get(key);
      if (!b) throw new Error('not found');
      return b;
    }),
    upload: vi.fn(async (key: string, data: Buffer) => {
      blobs.set(key, Buffer.from(data));
      return { key };
    }),
    getSignedUrl: vi.fn(async (key: string) => `${MARKER}${key}`),
    delete: vi.fn(),
  };

  const rows = {
    user: [
      {
        id: 'u1',
        tenantId: TENANT,
        name: 'Ana',
        email: 'ana@x.test',
        avatarUrl: null as string | null,
      },
    ],
    course: [{ id: 'c1', tenantId: TENANT, title: 'Curso', thumbnailUrl: null as string | null }],
    collection: [
      { id: 'k1', tenantId: TENANT, title: 'Colección', coverUrl: null as string | null },
    ],
    theme: {
      tenantId: TENANT,
      logoStorageKey: null as string | null,
      logoMimeType: null as string | null,
      logoUrl: null as string | null,
    },
    post: [{ id: 'p1', tenantId: TENANT, title: 'Post', body: '' }],
  };

  // `urlField` reproduce el `{ not: null }` del where real: sin él, el fake
  // devolvería filas sin imagen que en producción Prisma nunca entrega.
  const updater = <T extends { id?: string; tenantId: string }>(list: T[], urlField: keyof T) => ({
    findMany: vi.fn(async () => list.filter((r) => r[urlField] != null && r[urlField] !== '')),
    findFirst: vi.fn(async (args: { where: { id: string; tenantId: string } }) =>
      list.find((r) => r.id === args.where.id && r.tenantId === args.where.tenantId),
    ),
    updateMany: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = list.find((r) => r.id === args.where.id);
      if (row) Object.assign(row, args.data);
      return { count: row ? 1 : 0 };
    }),
  });

  const prisma = {
    user: updater(rows.user, 'avatarUrl'),
    modCoursesCourse: updater(rows.course, 'thumbnailUrl'),
    modResourcesCollection: updater(rows.collection, 'coverUrl'),
    modCommunityPost: updater(rows.post, 'body'),
    modThemingTenantTheme: {
      findUnique: vi.fn(async () => rows.theme),
      updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
        Object.assign(rows.theme, args.data);
        return { count: 1 };
      }),
    },
  };

  const factory = { getStorageForTenant: vi.fn(async () => storage) };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const service = new AdminImagesService(prisma as never, factory as never, logger as never);
  return { service, rows, blobs, storage };
}

const URL_VIEJA = `${MARKER}tenants/${TENANT}/uploads/vieja.png`;

describe('AdminImagesService', () => {
  let foto: Buffer;

  beforeAll(async () => {
    foto = await makeFoto();
  });

  describe('inventory', () => {
    it('mide peso actual y previsto de cada imagen del tenant', async () => {
      const { service, rows } = makeHarness(foto);
      rows.user[0]!.avatarUrl = URL_VIEJA;
      rows.course[0]!.thumbnailUrl = URL_VIEJA;

      const inv = await service.inventory(TENANT);

      expect(inv.items).toHaveLength(2);
      expect(inv.optimizable).toBe(2);
      expect(inv.currentBytes).toBe(foto.length * 2);
      expect(inv.optimizedBytes).toBeGreaterThan(0);
      expect(inv.optimizedBytes).toBeLessThan(inv.currentBytes);
      // NO escribe nada: es una vista previa.
      expect(inv.items.every((i) => i.skipReason === null)).toBe(true);
    });

    it('marca como externa la imagen que no vive en el storage del tenant', async () => {
      const { service, rows } = makeHarness(foto);
      rows.user[0]!.avatarUrl = 'https://cdn.ajeno.test/foto.jpg';

      const inv = await service.inventory(TENANT);

      expect(inv.items[0]!.skipReason).toBe('externa');
      expect(inv.optimizable).toBe(0);
      expect(inv.currentBytes).toBe(0);
    });

    it('no toca imágenes de OTRO tenant aunque estén en nuestro storage', async () => {
      const { service, rows } = makeHarness(foto);
      rows.user[0]!.avatarUrl = `${MARKER}tenants/otro-tenant/uploads/ajena.png`;

      const inv = await service.inventory(TENANT);

      expect(inv.items[0]!.skipReason).toBe('externa');
    });

    it('una imagen ya optimizada NO vuelve a salir: el reoptimizador converge', async () => {
      // Recomprimir un WebP ya optimizado arranca unos bytes más por pérdida
      // generacional. Sin umbral de ganancia mínima la misma imagen reaparecía
      // en cada pasada y el admin la degradaría a fuerza de clicar.
      const { service, rows, blobs } = makeHarness(foto);
      const yaOptima = await sharp(foto).resize({ width: 512 }).webp({ quality: 80 }).toBuffer();
      blobs.set(`tenants/${TENANT}/uploads/optima.webp`, yaOptima);
      rows.user[0]!.avatarUrl = `${MARKER}tenants/${TENANT}/uploads/optima.webp`;

      const inv = await service.inventory(TENANT);

      expect(inv.items[0]!.skipReason).toBe('ya-optima');
      expect(inv.optimizable).toBe(0);
    });

    it('una ganancia insignificante tampoco cuenta como optimizable', async () => {
      const { service, rows, blobs } = makeHarness(foto);
      // 6 KB que como mucho ahorrarían unos cientos de bytes: no compensa
      // reescribir la fila ni perder calidad.
      const casiOptima = await sharp(foto).resize({ width: 120 }).webp({ quality: 80 }).toBuffer();
      blobs.set(`tenants/${TENANT}/uploads/pequena.webp`, casiOptima);
      rows.user[0]!.avatarUrl = `${MARKER}tenants/${TENANT}/uploads/pequena.webp`;

      const inv = await service.inventory(TENANT);

      expect(inv.items[0]!.skipReason).toBe('ya-optima');
    });

    it('una imagen borrada del storage se reporta, no revienta el inventario', async () => {
      const { service, rows } = makeHarness(foto);
      rows.user[0]!.avatarUrl = `${MARKER}tenants/${TENANT}/uploads/fantasma.png`;

      const inv = await service.inventory(TENANT);

      expect(inv.items[0]!.skipReason).toBe('no-encontrada');
    });
  });

  describe('optimize · repunte de la fila dueña', () => {
    it('avatar: deja al usuario apuntando a la imagen nueva', async () => {
      const { service, rows, blobs } = makeHarness(foto);
      rows.user[0]!.avatarUrl = URL_VIEJA;

      const [res] = await service.optimize(TENANT, [
        { source: 'avatar', ownerId: 'u1', label: 'Ana', url: URL_VIEJA },
      ]);

      expect(res!.ok).toBe(true);
      expect(res!.size).toBeLessThan(res!.previousSize!);
      expect(rows.user[0]!.avatarUrl).not.toBe(URL_VIEJA);
      expect(rows.user[0]!.avatarUrl).toMatch(/\.webp$/);
      // El original NO se borra: sigue referenciado hasta que el repunte cuaja.
      expect(blobs.has(`tenants/${TENANT}/uploads/vieja.png`)).toBe(true);
    });

    it('curso y colección repuntan su propia columna', async () => {
      const { service, rows } = makeHarness(foto);
      rows.course[0]!.thumbnailUrl = URL_VIEJA;
      rows.collection[0]!.coverUrl = URL_VIEJA;

      await service.optimize(TENANT, [
        { source: 'curso', ownerId: 'c1', label: 'Curso', url: URL_VIEJA },
        { source: 'coleccion', ownerId: 'k1', label: 'Colección', url: URL_VIEJA },
      ]);

      expect(rows.course[0]!.thumbnailUrl).toMatch(/\.webp$/);
      expect(rows.collection[0]!.coverUrl).toMatch(/\.webp$/);
    });

    it('logo: actualiza key, MIME y el cache-buster de la URL pública', async () => {
      const { service, rows } = makeHarness(foto);
      rows.theme.logoStorageKey = `tenants/${TENANT}/uploads/vieja.png`;

      const [res] = await service.optimize(TENANT, [
        { source: 'logo', ownerId: TENANT, label: 'Logo', url: URL_VIEJA },
      ]);

      expect(res!.ok).toBe(true);
      expect(rows.theme.logoStorageKey).toMatch(/\.webp$/);
      expect(rows.theme.logoMimeType).toBe('image/webp');
      // El `?v=` es lo que hace que el navegador suelte el logo cacheado.
      expect(rows.theme.logoUrl).toMatch(/\/logo\?v=\d+$/);
    });

    it('post: sustituye la URL DENTRO del body y deja el resto del texto igual', async () => {
      const { service, rows } = makeHarness(foto);
      rows.post[0]!.body = `Mirad esto:\n\n![foto](${URL_VIEJA})\n\nY un enlace externo https://x.test/a.png`;

      const [res] = await service.optimize(TENANT, [
        { source: 'post', ownerId: 'p1', label: 'Post', url: URL_VIEJA },
      ]);

      expect(res!.ok).toBe(true);
      expect(rows.post[0]!.body).not.toContain(URL_VIEJA);
      expect(rows.post[0]!.body).toMatch(/!\[foto\]\(.*\.webp\)/);
      expect(rows.post[0]!.body).toContain('Y un enlace externo https://x.test/a.png');
    });

    it('post: si el autor quitó la imagen entre analizar y optimizar, falla sin tocar nada', async () => {
      const { service, rows } = makeHarness(foto);
      rows.post[0]!.body = 'Ya no hay ninguna imagen aquí.';

      const [res] = await service.optimize(TENANT, [
        { source: 'post', ownerId: 'p1', label: 'Post', url: URL_VIEJA },
      ]);

      expect(res!.ok).toBe(false);
      expect(res!.error).toMatch(/ya no contiene/i);
      expect(rows.post[0]!.body).toBe('Ya no hay ninguna imagen aquí.');
    });

    it('una imagen de otro tenant se rechaza sin descargar nada', async () => {
      const { service, storage } = makeHarness(foto);

      const [res] = await service.optimize(TENANT, [
        {
          source: 'avatar',
          ownerId: 'u1',
          label: 'Ana',
          url: `${MARKER}tenants/otro/uploads/x.png`,
        },
      ]);

      expect(res!.ok).toBe(false);
      expect(storage.download).not.toHaveBeenCalled();
    });

    it('un fallo suelto no tumba el lote entero', async () => {
      const { service, rows } = makeHarness(foto);
      rows.user[0]!.avatarUrl = URL_VIEJA;

      const results = await service.optimize(TENANT, [
        {
          source: 'curso',
          ownerId: 'c1',
          label: 'Roto',
          url: `${MARKER}tenants/${TENANT}/uploads/fantasma.png`,
        },
        { source: 'avatar', ownerId: 'u1', label: 'Ana', url: URL_VIEJA },
      ]);

      expect(results[0]!.ok).toBe(false);
      expect(results[1]!.ok).toBe(true);
      expect(rows.user[0]!.avatarUrl).toMatch(/\.webp$/);
    });
  });
});

describe('extractStorageUrls', () => {
  it('saca las imágenes de nuestro storage embebidas en markdown y HTML', () => {
    const body = [
      `![a](${MARKER}tenants/t/uploads/a.png)`,
      `<img src="${MARKER}tenants/t/uploads/b.jpg" alt="b">`,
      'https://cdn.ajeno.test/c.png',
    ].join('\n');

    expect(extractStorageUrls(body)).toEqual([
      `${MARKER}tenants/t/uploads/a.png`,
      `${MARKER}tenants/t/uploads/b.jpg`,
    ]);
  });

  it('la misma imagen repetida cuenta una sola vez', () => {
    const url = `${MARKER}tenants/t/uploads/a.png`;
    expect(extractStorageUrls(`![a](${url}) y otra vez ![a](${url})`)).toEqual([url]);
  });

  it('un body sin imágenes nuestras devuelve vacío', () => {
    expect(extractStorageUrls('Solo texto y https://externo.test/x.png')).toEqual([]);
  });
});
