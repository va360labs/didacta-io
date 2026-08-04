import { randomBytes } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import { Prisma } from '@didacta/database';
import { PrismaInstanceConfigService } from '../src/modules/prisma-instance-config.service';
import { SecretCipherService } from '../src/modules/secret-cipher.service';

/**
 * Prisma representa "campo Json a NULL en DB" con el sentinel `Prisma.DbNull`
 * (no con el literal `null`). El fake replica ese comportamiento.
 */
function normalizeJsonField(v: unknown): unknown {
  if (v === Prisma.DbNull || v === Prisma.JsonNull) return null;
  return v;
}

const KEY = randomBytes(32).toString('hex');

interface SettingRow {
  id: string;
  scope: string;
  key: string;
  isSecret: boolean;
  valueJson: unknown;
  valueCipher: Buffer | null;
  valueIv: Buffer | null;
  valueTag: Buffer | null;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeFakePrisma() {
  const rows: SettingRow[] = [];
  let nextId = 1;
  const findKey = (scope: string, key: string) =>
    rows.findIndex((r) => r.scope === scope && r.key === key);

  const instanceSetting = {
    async findUnique(args: {
      where: { scope_key: { scope: string; key: string } };
      select?: Record<string, boolean>;
    }) {
      const { scope, key } = args.where.scope_key;
      const idx = findKey(scope, key);
      return idx >= 0 ? rows[idx] : null;
    },
    async findMany(args: { where?: { scope?: string }; orderBy?: unknown }) {
      return rows
        .filter((r) => !args.where?.scope || r.scope === args.where.scope)
        .sort((a, b) => {
          const s = a.scope.localeCompare(b.scope);
          return s !== 0 ? s : a.key.localeCompare(b.key);
        });
    },
    async upsert(args: {
      where: { scope_key: { scope: string; key: string } };
      create: Partial<SettingRow> & { scope: string; key: string };
      update: Partial<SettingRow>;
    }) {
      const { scope, key } = args.where.scope_key;
      const idx = findKey(scope, key);
      const now = new Date();
      const normalizedUpdate = {
        ...args.update,
        ...(args.update.valueJson !== undefined
          ? { valueJson: normalizeJsonField(args.update.valueJson) }
          : {}),
      };
      const normalizedCreate = {
        ...args.create,
        ...(args.create.valueJson !== undefined
          ? { valueJson: normalizeJsonField(args.create.valueJson) }
          : {}),
      };
      if (idx >= 0) {
        rows[idx] = { ...rows[idx], ...normalizedUpdate, updatedAt: now };
        return rows[idx];
      }
      const row: SettingRow = {
        id: String(nextId++),
        scope,
        key,
        isSecret: false,
        valueJson: null,
        valueCipher: null,
        valueIv: null,
        valueTag: null,
        updatedById: null,
        createdAt: now,
        updatedAt: now,
        ...normalizedCreate,
      };
      rows.push(row);
      return row;
    },
    async delete(args: { where: { scope_key: { scope: string; key: string } } }) {
      const { scope, key } = args.where.scope_key;
      const idx = findKey(scope, key);
      if (idx < 0) throw new Error('not found');
      return rows.splice(idx, 1)[0];
    },
  };

  return { instanceSetting, _rows: rows };
}

describe('PrismaInstanceConfigService', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let cipher: SecretCipherService;
  let svc: PrismaInstanceConfigService;

  beforeEach(() => {
    prisma = makeFakePrisma();
    cipher = new SecretCipherService(KEY);
    svc = new PrismaInstanceConfigService(prisma as never, cipher);
  });

  describe('valores no secretos (JSON plano)', () => {
    it('set + get devuelve el mismo valor', async () => {
      await svc.set('telemetry', 'disabled', true);
      expect(await svc.get('telemetry', 'disabled')).toBe(true);
    });

    it('get devuelve undefined cuando no hay setting', async () => {
      expect(await svc.get('license', 'inexistente')).toBeUndefined();
    });

    it('un set posterior overridea el anterior', async () => {
      await svc.set('scope', 'k', 'v1');
      await svc.set('scope', 'k', 'v2');
      expect(prisma._rows).toHaveLength(1);
      expect(await svc.get('scope', 'k')).toBe('v2');
    });
  });

  describe('valores secretos (cifrados)', () => {
    it('set con isSecret=true cifra el valor antes de persistir', async () => {
      const jwt = 'eyJhbGciOiJFUzI1NiJ9.super-secreto.firma';
      await svc.set('license', 'key', jwt, { isSecret: true });
      const row = prisma._rows[0];
      expect(row.isSecret).toBe(true);
      expect(row.valueJson).toBeNull();
      expect(row.valueCipher).not.toBeNull();
      expect(row.valueCipher!.toString('utf8')).not.toContain('super-secreto');
    });

    it('get descifra transparentemente', async () => {
      const jwt = 'eyJ.header.payload.signature';
      await svc.set('license', 'key', jwt, { isSecret: true });
      expect(await svc.get('license', 'key')).toBe(jwt);
    });
  });

  describe('sin tenant_id — es global por diseño', () => {
    it('el mismo scope.key es visible sin necesitar contexto de tenant', async () => {
      await svc.set('license', 'key', 'valor-instancia');
      // No hay parámetro tenantId en ninguna firma del servicio.
      expect(await svc.get('license', 'key')).toBe('valor-instancia');
    });
  });

  describe('list / has / delete', () => {
    it('list devuelve metadata sin exponer el valor de los secretos', async () => {
      await svc.set('license', 'key', 'jwt-secreto', { isSecret: true });
      await svc.set('telemetry', 'disabled', false);
      const items = await svc.list();
      expect(items).toHaveLength(2);
      const license = items.find((i) => i.key === 'key');
      expect(license?.isSecret).toBe(true);
      expect(license?.hasValue).toBe(true);
      expect(license).not.toHaveProperty('value');
    });

    it('list filtra por scope cuando se pasa', async () => {
      await svc.set('license', 'key', 'v1');
      await svc.set('telemetry', 'disabled', true);
      const onlyLicense = await svc.list('license');
      expect(onlyLicense).toHaveLength(1);
      expect(onlyLicense[0].scope).toBe('license');
    });

    it('has devuelve true/false correctamente', async () => {
      await svc.set('license', 'key', 'v');
      expect(await svc.has('license', 'key')).toBe(true);
      expect(await svc.has('license', 'missing')).toBe(false);
    });

    it('delete remueve la fila y siguientes get devuelven undefined', async () => {
      await svc.set('license', 'key', 'v');
      await svc.delete('license', 'key');
      expect(prisma._rows).toHaveLength(0);
      expect(await svc.get('license', 'key')).toBeUndefined();
    });

    it('delete sobre clave inexistente es no-op', async () => {
      await expect(svc.delete('license', 'nope')).resolves.toBeUndefined();
    });
  });
});
