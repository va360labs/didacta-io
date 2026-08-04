/**
 * Tests unit de SetupTokenService — token de un solo uso que protege
 * `POST /setup/init` mientras la instancia está virgen.
 *
 * Usamos un fake de Prisma con estado in-memory para `tenant` +
 * `instanceSetting` (mismo patrón que setup.service.test.ts), y la
 * `PrismaInstanceConfigService` REAL contra ese fake — así el test cubre la
 * integración real entre ambos servicios, no solo SetupTokenService aislado.
 */

import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { PrismaInstanceConfigService } from '../src/modules/prisma-instance-config.service';
import { SecretCipherService } from '../src/modules/secret-cipher.service';
import { SetupTokenService } from '../src/setup/setup-token.service';

interface TenantRow {
  id: string;
  deletedAt: Date | null;
}
interface InstanceSettingRow {
  scope: string;
  key: string;
  isSecret: boolean;
  valueJson: unknown;
  valueCipher: Buffer | null;
  valueIv: Buffer | null;
  valueTag: Buffer | null;
  updatedById: string | null;
  updatedAt: Date;
}

function makeFakePrisma() {
  const state = {
    tenants: [] as TenantRow[],
    instanceSettings: [] as InstanceSettingRow[],
  };

  const findRow = (scope: string, key: string) =>
    state.instanceSettings.find((s) => s.scope === scope && s.key === key);

  const client = {
    tenant: {
      count: vi.fn(
        async ({ where }: { where?: { deletedAt?: null } } = {}) =>
          state.tenants.filter((t) => (where?.deletedAt === null ? t.deletedAt === null : true))
            .length,
      ),
    },
    instanceSetting: {
      findUnique: vi.fn(
        async ({ where }: { where: { scope_key: { scope: string; key: string } } }) =>
          findRow(where.scope_key.scope, where.scope_key.key) ?? null,
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { scope_key: { scope: string; key: string } };
          create: Omit<InstanceSettingRow, 'updatedAt'>;
          update: Omit<InstanceSettingRow, 'updatedAt'>;
        }) => {
          const existing = findRow(where.scope_key.scope, where.scope_key.key);
          if (existing) {
            Object.assign(existing, update, { updatedAt: new Date() });
            return existing;
          }
          const row: InstanceSettingRow = { ...create, updatedAt: new Date() };
          state.instanceSettings.push(row);
          return row;
        },
      ),
      delete: vi.fn(async ({ where }: { where: { scope_key: { scope: string; key: string } } }) => {
        const idx = state.instanceSettings.findIndex(
          (s) => s.scope === where.scope_key.scope && s.key === where.scope_key.key,
        );
        if (idx >= 0) state.instanceSettings.splice(idx, 1);
      }),
    },
  };

  return { state, client };
}

// isSecret siempre false en este flujo (el token guardado es un hash SHA-256,
// no reversible — no necesita cifrado at-rest), pero el constructor de
// PrismaInstanceConfigService igual exige una key válida para SecretCipherService.
const cipher = new SecretCipherService('a'.repeat(64));

function makeService() {
  const { state, client } = makeFakePrisma();
  const settings = new PrismaInstanceConfigService(client as never, cipher);
  const service = new SetupTokenService(client as never, settings);
  return { state, service };
}

describe('SetupTokenService.issue', () => {
  it('genera un token distinto en cada llamada y persiste solo su hash SHA-256', async () => {
    const { state, service } = makeService();
    const a = await service.issue();
    const b = await service.issue();

    expect(a).not.toBe(b);
    expect(state.instanceSettings).toHaveLength(1);
    const row = state.instanceSettings[0];
    expect(row?.scope).toBe('setup');
    expect(row?.key).toBe('init-token-hash');
    expect(row?.isSecret).toBe(false);
    // El valor guardado es el hash, nunca el plano.
    expect(row?.valueJson).not.toBe(a);
    expect(row?.valueJson).not.toBe(b);
    expect(row?.valueJson).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('SetupTokenService.onApplicationBootstrap', () => {
  it('genera y persiste un token si la instancia está virgen', async () => {
    const { state, service } = makeService();
    await service.onApplicationBootstrap();
    expect(state.instanceSettings).toHaveLength(1);
  });

  it('no genera token si ya hay al menos un tenant activo', async () => {
    const { state, service } = makeService();
    state.tenants.push({ id: 't1', deletedAt: null });
    await service.onApplicationBootstrap();
    expect(state.instanceSettings).toHaveLength(0);
  });

  it('ignora tenants soft-deleted (sigue considerándose virgen)', async () => {
    const { state, service } = makeService();
    state.tenants.push({ id: 't1', deletedAt: new Date() });
    await service.onApplicationBootstrap();
    expect(state.instanceSettings).toHaveLength(1);
  });
});

describe('SetupTokenService.assertValid', () => {
  it('lanza SETUP_TOKEN_REQUIRED si candidate es null/undefined/vacío', async () => {
    const { service } = makeService();
    await expect(service.assertValid(null)).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ code: 'SETUP_TOKEN_REQUIRED' }),
    });
    await expect(service.assertValid(undefined)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.assertValid('')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lanza SETUP_TOKEN_INVALID si no hay ningún token emitido todavía', async () => {
    const { service } = makeService();
    await expect(service.assertValid('cualquier-cosa')).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ code: 'SETUP_TOKEN_INVALID' }),
    });
  });

  it('lanza SETUP_TOKEN_INVALID si el candidate no coincide con el emitido', async () => {
    const { service } = makeService();
    await service.issue();
    await expect(service.assertValid('token-incorrecto')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'SETUP_TOKEN_INVALID' }),
    });
  });

  it('no lanza si el candidate coincide con el emitido', async () => {
    const { service } = makeService();
    const plain = await service.issue();
    await expect(service.assertValid(plain)).resolves.toBeUndefined();
  });

  it('solo el token vigente pasa tras reemitir (issue() invalida el anterior)', async () => {
    const { service } = makeService();
    const first = await service.issue();
    const second = await service.issue();
    await expect(service.assertValid(first)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.assertValid(second)).resolves.toBeUndefined();
  });
});

describe('SetupTokenService.invalidate', () => {
  it('tras invalidar, incluso el token correcto es rechazado', async () => {
    const { state, service } = makeService();
    const plain = await service.issue();
    await service.invalidate();
    expect(state.instanceSettings).toHaveLength(0);
    await expect(service.assertValid(plain)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'SETUP_TOKEN_INVALID' }),
    });
  });

  it('invalidar sin token emitido no lanza (no-op idempotente)', async () => {
    const { service } = makeService();
    await expect(service.invalidate()).resolves.toBeUndefined();
  });
});
