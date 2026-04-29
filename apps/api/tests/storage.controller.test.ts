import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { StorageController } from '../src/modules/storage.controller';
import type { ModuleContextFactory } from '../src/modules/module-context.factory';
import type { SessionClaims } from '../src/auth/token.service';

/**
 * Smoke tests del endpoint POST /storage/upload (FU-5). Cubren
 * - guard de rol (alumno no puede subir),
 * - whitelist de MIME types,
 * - límites de tamaño en bytes (post base64-decode),
 * - hand-off al adapter per-tenant (ModuleContextFactory.getStorageForTenant),
 * - normalización del filename para evitar path traversal.
 */
function makeUser(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    sub: 'user-1',
    tenantId: 'tenant-1',
    roles: ['formador'],
    email: 'foo@example.com',
    ...(overrides as Record<string, unknown>),
  } as SessionClaims;
}

function makeFakeFactory() {
  const upload = vi.fn(async () => undefined);
  const getSignedUrl = vi.fn(async (key: string) => `https://cdn.example.test/${key}`);
  const storage = { upload, getSignedUrl } as unknown;
  const getStorageForTenant = vi.fn(async () => storage);
  return {
    factory: { getStorageForTenant } as unknown as ModuleContextFactory,
    spies: { upload, getSignedUrl, getStorageForTenant },
  };
}

const PNG_PIXEL_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

describe('StorageController · POST /storage/upload (FU-5)', () => {
  it('sin sesión → UnauthorizedException', async () => {
    const { factory } = makeFakeFactory();
    const c = new StorageController(factory);
    await expect(
      c.upload(undefined, {
        data: PNG_PIXEL_BASE64,
        filename: 'pixel.png',
        contentType: 'image/png',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rol alumno → ForbiddenException', async () => {
    const { factory } = makeFakeFactory();
    const c = new StorageController(factory);
    await expect(
      c.upload(makeUser({ roles: ['alumno'] }), {
        data: PNG_PIXEL_BASE64,
        filename: 'pixel.png',
        contentType: 'image/png',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each(['formador', 'tenant_admin', 'super_admin'] as const)(
    'rol %s → permitido',
    async (role) => {
      const { factory, spies } = makeFakeFactory();
      const c = new StorageController(factory);
      const result = await c.upload(makeUser({ roles: [role] }), {
        data: PNG_PIXEL_BASE64,
        filename: 'pixel.png',
        contentType: 'image/png',
      });
      expect(result.url).toMatch(/^https:\/\/cdn\.example\.test\//);
      expect(result.contentType).toBe('image/png');
      expect(spies.getStorageForTenant).toHaveBeenCalledWith('tenant-1');
      expect(spies.upload).toHaveBeenCalledTimes(1);
    },
  );

  it('imagen >5 MiB tras decodificar → ForbiddenException', async () => {
    const { factory } = makeFakeFactory();
    const c = new StorageController(factory);
    // Buffer de 6 MiB → base64 ≈ 8 MiB. La pipe no corre acá; lo que validamos
    // es la guarda manual de tamaño en bytes después del decode.
    const big = Buffer.alloc(6 * 1024 * 1024, 0x42).toString('base64');
    await expect(
      c.upload(makeUser(), {
        data: big,
        filename: 'grande.png',
        contentType: 'image/png',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('clave de storage incluye tenantId y filename normalizado (sin path traversal real)', async () => {
    const { factory, spies } = makeFakeFactory();
    const c = new StorageController(factory);
    await c.upload(makeUser({ tenantId: 'abc-123' }), {
      data: PNG_PIXEL_BASE64,
      filename: '../../etc/passwd?evil.png',
      contentType: 'image/png',
    });
    const [calledKey] = spies.upload.mock.calls[0] as [string];
    // Contrato: tres segmentos exactos (tenants / {tenantId} / uploads / {filename})
    // — el filename de usuario no puede inyectar separadores ni reintroducir
    // segmentos arbitrarios. Los `..` literales sobreviven como caracteres
    // dentro del último segmento, lo cual no traversa.
    const segments = calledKey.split('/');
    expect(segments).toHaveLength(4);
    expect(segments[0]).toBe('tenants');
    expect(segments[1]).toBe('abc-123');
    expect(segments[2]).toBe('uploads');
    expect(segments[3]).not.toContain('?');
    expect(segments[3]).toMatch(/^\d+-/);
  });

  it('image/svg+xml está permitido (uso legítimo: branding/logos inline)', async () => {
    const { factory } = makeFakeFactory();
    const c = new StorageController(factory);
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
      'utf-8',
    ).toString('base64');
    const result = await c.upload(makeUser(), {
      data: svg,
      filename: 'logo.svg',
      contentType: 'image/svg+xml',
    });
    expect(result.contentType).toBe('image/svg+xml');
  });
});
