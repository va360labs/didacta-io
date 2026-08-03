import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AiProvidersController } from '../src/modules/ai-providers.controller';
import type { ApiKeyCipher } from '../src/ai/api-key-cipher';
import type { ProviderRegistry } from '../src/ai/provider-registry';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { SessionClaims } from '../src/auth/token.service';

/**
 * Tests del controller admin de providers IA per-tenant (LMS-90.E).
 *
 * Verifican:
 *   - guards de admin (super_admin / tenant_admin) en todas las rutas.
 *   - validación de capability del provider para el purpose.
 *   - cifrado de la API key antes de persistir + nunca devolverla.
 *   - aislamiento por tenantId del JWT.
 *   - rechazo si el cipher no está configurado (env AI_CONFIG_ENCRYPTION_KEY).
 */

function makeUser(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    sub: 'admin-1',
    tenantId: 'tenant-A',
    roles: ['tenant_admin'],
    email: 'admin@example.com',
    ...(overrides as Record<string, unknown>),
  } as SessionClaims;
}

function makeDeps(opts: { cipherReady?: boolean; capabilities?: ('chat' | 'embed')[] } = {}) {
  const findMany = vi.fn(async () => []);
  const findFirst = vi.fn(async () => null as { id: string } | null);
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'new-id',
    purpose: data.purpose,
    provider: data.provider,
    model: data.model,
    baseUrl: data.baseUrl,
    enabled: data.enabled,
    notas: data.notas,
    createdAt: new Date('2026-04-29T00:00:00Z'),
    updatedAt: new Date('2026-04-29T00:00:00Z'),
  }));
  const update = vi.fn(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      purpose: data.purpose,
      provider: data.provider,
      model: data.model,
      baseUrl: data.baseUrl,
      enabled: data.enabled,
      notas: data.notas,
      createdAt: new Date('2026-04-29T00:00:00Z'),
      updatedAt: new Date('2026-04-29T00:00:00Z'),
    }),
  );
  const deleteMany = vi.fn(async () => ({ count: 1 }));

  const prisma = {
    tenantAiProviderConfig: { findMany, findFirst, create, update, deleteMany },
  } as unknown as PrismaService;

  const cipher = {
    isReady: vi.fn(() => opts.cipherReady !== false),
    encrypt: vi.fn(() => ({
      cipher: Buffer.from('cipher'),
      iv: Buffer.from('iv'),
      tag: Buffer.from('tag'),
    })),
  } as unknown as ApiKeyCipher;

  const adapter = {
    id: 'openai',
    capabilities: opts.capabilities ?? ['chat', 'embed'],
  };
  const registry = {
    list: vi.fn(() => [
      { id: 'openai', capabilities: ['chat', 'embed'] },
      { id: 'voyage', capabilities: ['embed'] },
    ]),
    get: vi.fn(() => adapter),
  } as unknown as ProviderRegistry;

  return {
    prisma,
    cipher,
    registry,
    spies: {
      findMany,
      findFirst,
      create,
      update,
      deleteMany,
      encrypt: (cipher as unknown as { encrypt: ReturnType<typeof vi.fn> }).encrypt,
    },
  };
}

describe('AiProvidersController · guards', () => {
  it('catalog rechaza sin sesión', async () => {
    const { prisma, cipher, registry } = makeDeps();
    const c = new AiProvidersController(prisma, cipher, registry);
    await expect(c.catalog(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('catalog rechaza alumno con 403', async () => {
    const { prisma, cipher, registry } = makeDeps();
    const c = new AiProvidersController(prisma, cipher, registry);
    await expect(c.catalog(makeUser({ roles: ['alumno'] }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it.each(['tenant_admin', 'super_admin'] as const)(
    'catalog: rol %s devuelve el listado',
    async (role) => {
      const { prisma, cipher, registry } = makeDeps();
      const c = new AiProvidersController(prisma, cipher, registry);
      const result = await c.catalog(makeUser({ roles: [role] }));
      expect(result).toHaveLength(2);
    },
  );

  it('list rechaza sin sesión', async () => {
    const { prisma, cipher, registry } = makeDeps();
    const c = new AiProvidersController(prisma, cipher, registry);
    await expect(c.list(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('list filtra por tenantId del JWT', async () => {
    const { prisma, cipher, registry, spies } = makeDeps();
    const c = new AiProvidersController(prisma, cipher, registry);
    await c.list(makeUser({ tenantId: 'tenant-X' }));
    expect(spies.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-X' },
      orderBy: { purpose: 'asc' },
    });
  });

  it('list nunca devuelve API keys (solo metadatos)', async () => {
    const { prisma, cipher, registry, spies } = makeDeps();
    spies.findMany.mockResolvedValueOnce([
      {
        id: 'r1',
        purpose: 'chat',
        provider: 'openai',
        model: 'gpt-4o',
        baseUrl: null,
        enabled: true,
        notas: null,
        apiKeyCipher: Buffer.from('SECRET'),
        apiKeyIv: Buffer.from('IV'),
        apiKeyTag: Buffer.from('TAG'),
        createdAt: new Date('2026-04-29T00:00:00Z'),
        updatedAt: new Date('2026-04-29T00:00:00Z'),
      },
    ]);
    const c = new AiProvidersController(prisma, cipher, registry);
    const out = (await c.list(makeUser())) as Array<Record<string, unknown>>;
    const row = out[0];
    expect(row).not.toHaveProperty('apiKeyCipher');
    expect(row).not.toHaveProperty('apiKeyIv');
    expect(row).not.toHaveProperty('apiKeyTag');
    expect(row.hasApiKey).toBe(true);
  });
});

describe('AiProvidersController · upsert', () => {
  it('rechaza sin sesión', async () => {
    const { prisma, cipher, registry } = makeDeps();
    const c = new AiProvidersController(prisma, cipher, registry);
    await expect(c.upsert(undefined, 'chat', {} as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rechaza purpose inválido', async () => {
    const { prisma, cipher, registry } = makeDeps();
    const c = new AiProvidersController(prisma, cipher, registry);
    await expect(
      c.upsert(makeUser(), 'invalid', {
        provider: 'openai',
        apiKey: 'sk-x',
      } as never),
    ).rejects.toThrow();
  });

  it('rechaza provider que no soporta el purpose pedido', async () => {
    const { prisma, cipher, registry } = makeDeps({ capabilities: ['embed'] });
    const c = new AiProvidersController(prisma, cipher, registry);
    await expect(
      c.upsert(makeUser(), 'chat', {
        provider: 'openai',
        apiKey: 'sk-x',
      } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza si el cipher no está configurado', async () => {
    const { prisma, cipher, registry } = makeDeps({ cipherReady: false });
    const c = new AiProvidersController(prisma, cipher, registry);
    await expect(
      c.upsert(makeUser(), 'chat', {
        provider: 'openai',
        apiKey: 'sk-x',
      } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('crea config nueva con la API key cifrada', async () => {
    const { prisma, cipher, registry, spies } = makeDeps();
    const c = new AiProvidersController(prisma, cipher, registry);
    const out = (await c.upsert(makeUser({ tenantId: 'tenant-Z' }), 'chat', {
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-secret',
      enabled: true,
    } as never)) as Record<string, unknown>;

    expect(spies.encrypt).toHaveBeenCalledWith('sk-secret');
    expect(spies.create).toHaveBeenCalled();
    const data = (spies.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.tenantId).toBe('tenant-Z');
    expect(data.purpose).toBe('chat');
    expect(data.provider).toBe('openai');
    expect(data.apiKeyCipher).toBeInstanceOf(Buffer);
    // El response NUNCA expone la key
    expect(out).not.toHaveProperty('apiKeyCipher');
    expect(out.hasApiKey).toBe(true);
  });

  it('actualiza si ya existe config para ese (tenant, purpose)', async () => {
    const { prisma, cipher, registry, spies } = makeDeps();
    spies.findFirst.mockResolvedValueOnce({ id: 'existing-id' });
    const c = new AiProvidersController(prisma, cipher, registry);
    await c.upsert(makeUser(), 'chat', {
      provider: 'openai',
      apiKey: 'sk-new',
    } as never);
    expect(spies.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'existing-id' } }),
    );
    expect(spies.create).not.toHaveBeenCalled();
  });
});

describe('AiProvidersController · remove', () => {
  it('rechaza sin sesión', async () => {
    const { prisma, cipher, registry } = makeDeps();
    const c = new AiProvidersController(prisma, cipher, registry);
    await expect(c.remove(undefined, 'chat')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('borra solo del tenantId del JWT', async () => {
    const { prisma, cipher, registry, spies } = makeDeps();
    const c = new AiProvidersController(prisma, cipher, registry);
    await c.remove(makeUser({ tenantId: 'tenant-Q' }), 'embed');
    expect(spies.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-Q', purpose: 'embed' },
    });
  });
});
