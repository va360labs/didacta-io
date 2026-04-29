import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { FundaeRlptController } from '../src/modules/fundae-rlpt.controller';
import type { ModuleRegistryService } from '../src/modules/module-registry.service';
import type { SessionClaims } from '../src/auth/token.service';

function makeUser(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    sub: 'admin-1',
    tenantId: 'tenant-A',
    roles: ['tenant_admin'],
    email: 'admin@example.com',
    ...(overrides as Record<string, unknown>),
  } as SessionClaims;
}

function makeRegistry() {
  const upload = vi.fn(async () => ({ id: 'rlpt-1', tipo: 'NOTIFICACION_INICIAL' }));
  const listByCompany = vi.fn(async () => []);
  const softDelete = vi.fn(async () => ({ id: 'rlpt-1', deletedAt: new Date().toISOString() }));
  return {
    registry: {
      getFundaeRlptService: () => ({ upload, listByCompany, softDelete }),
    } as unknown as ModuleRegistryService,
    spies: { upload, listByCompany, softDelete },
  };
}

const PDF_DUMMY_B64 = Buffer.from('PDF dummy contenido').toString('base64');

describe('FundaeRlptController · guard admin', () => {
  it('rechaza sin sesión', async () => {
    const { registry } = makeRegistry();
    const c = new FundaeRlptController(registry);
    await expect(c.list(undefined, 'c-1')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza alumno', async () => {
    const { registry } = makeRegistry();
    const c = new FundaeRlptController(registry);
    await expect(c.list(makeUser({ roles: ['alumno'] }), 'c-1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('FundaeRlptController.upload', () => {
  it('upload pasa tenantId del JWT + companyId del path al service', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeRlptController(registry);
    await c.upload(makeUser({ tenantId: 'tenant-A', sub: 'admin-1' }), 'c-1', {
      tipo: 'NOTIFICACION_INICIAL',
      data: PDF_DUMMY_B64,
      contentType: 'application/pdf',
    });
    expect(spies.upload).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-A', companyId: 'c-1', actorId: 'admin-1' }),
    );
    const call = spies.upload.mock.calls[0]?.[0] as { blob: Buffer; contentType: string };
    expect(Buffer.isBuffer(call.blob)).toBe(true);
    expect(call.blob.toString('utf-8')).toBe('PDF dummy contenido');
    expect(call.contentType).toBe('application/pdf');
  });

  it('rechaza con ForbiddenException si la base64 decodifica a >10 MiB', async () => {
    const { registry } = makeRegistry();
    const c = new FundaeRlptController(registry);
    const big = Buffer.alloc(11 * 1024 * 1024, 0x42).toString('base64');
    await expect(
      c.upload(makeUser(), 'c-1', {
        tipo: 'NOTIFICACION_INICIAL',
        data: big,
        contentType: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each(['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const)(
    'acepta MIME permitido: %s',
    async (mime) => {
      const { registry } = makeRegistry();
      const c = new FundaeRlptController(registry);
      await expect(
        c.upload(makeUser(), 'c-1', {
          tipo: 'NOTIFICACION_INICIAL',
          data: PDF_DUMMY_B64,
          contentType: mime,
        }),
      ).resolves.toBeDefined();
    },
  );
});

describe('FundaeRlptController.list / remove', () => {
  it('list delega con tenantId del JWT y companyId del path', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeRlptController(registry);
    await c.list(makeUser({ tenantId: 'tenant-A' }), 'c-2');
    expect(spies.listByCompany).toHaveBeenCalledWith('tenant-A', 'c-2');
  });

  it('remove dispara soft-delete con tenantId del JWT y devuelve { deleted: true }', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeRlptController(registry);
    const result = await c.remove(makeUser({ tenantId: 'tenant-A' }), 'c-1', 'rlpt-1');
    expect(spies.softDelete).toHaveBeenCalledWith('tenant-A', 'admin-1', 'rlpt-1');
    expect(result).toEqual({ deleted: true });
  });
});
