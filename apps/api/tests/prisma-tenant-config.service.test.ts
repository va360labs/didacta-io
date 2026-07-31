import { randomBytes } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import type { AuditLogService } from '@didacta/core-kernel';
import { Prisma } from '@didacta/database';
import { PrismaTenantConfigService } from '../src/modules/prisma-tenant-config.service';
import { SecretCipherService } from '../src/modules/secret-cipher.service';

/**
 * Prisma representa "campo Json a NULL en DB" con el sentinel `Prisma.DbNull`
 * (no con el literal `null`). Al persistir, la DB guarda NULL y al leer se
 * devuelve `null`. El fake replica ese comportamiento con esta función.
 */
function normalizeJsonField(v: unknown): unknown {
  if (v === Prisma.DbNull || v === Prisma.JsonNull) return null;
  return v;
}

const KEY = randomBytes(32).toString('hex');
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

interface SettingRow {
  id: string;
  tenantId: string;
  moduleName: string;
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

interface AuditEntry {
  tenantId: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
}

function makeFakePrisma() {
  const rows: SettingRow[] = [];
  let nextId = 1;
  const findKey = (tenantId: string, moduleName: string, key: string) =>
    rows.findIndex((r) => r.tenantId === tenantId && r.moduleName === moduleName && r.key === key);

  const tenantSetting = {
    async findUnique(args: {
      where: { tenantId_moduleName_key: { tenantId: string; moduleName: string; key: string } };
      select?: Record<string, boolean>;
    }) {
      const { tenantId, moduleName, key } = args.where.tenantId_moduleName_key;
      const idx = findKey(tenantId, moduleName, key);
      return idx >= 0 ? rows[idx] : null;
    },
    async findMany(args: { where: { tenantId: string; moduleName?: string }; orderBy?: unknown }) {
      return rows
        .filter(
          (r) =>
            r.tenantId === args.where.tenantId &&
            (!args.where.moduleName || r.moduleName === args.where.moduleName),
        )
        .sort((a, b) => {
          const m = a.moduleName.localeCompare(b.moduleName);
          return m !== 0 ? m : a.key.localeCompare(b.key);
        });
    },
    async upsert(args: {
      where: { tenantId_moduleName_key: { tenantId: string; moduleName: string; key: string } };
      create: Partial<SettingRow> & { tenantId: string; moduleName: string; key: string };
      update: Partial<SettingRow>;
    }) {
      const { tenantId, moduleName, key } = args.where.tenantId_moduleName_key;
      const idx = findKey(tenantId, moduleName, key);
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
        tenantId,
        moduleName,
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
    async delete(args: {
      where: { tenantId_moduleName_key: { tenantId: string; moduleName: string; key: string } };
    }) {
      const { tenantId, moduleName, key } = args.where.tenantId_moduleName_key;
      const idx = findKey(tenantId, moduleName, key);
      if (idx < 0) throw new Error('not found');
      const removed = rows.splice(idx, 1)[0];
      return removed;
    },
  };

  return {
    tenantSetting,
    _rows: rows,
  };
}

function makeFakeAuditLog(): AuditLogService & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    async record(entry) {
      entries.push(entry);
    },
  };
}

describe('PrismaTenantConfigService', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let cipher: SecretCipherService;
  let audit: ReturnType<typeof makeFakeAuditLog>;
  let svc: PrismaTenantConfigService;

  beforeEach(() => {
    prisma = makeFakePrisma();
    cipher = new SecretCipherService(KEY);
    audit = makeFakeAuditLog();
    svc = new PrismaTenantConfigService(prisma as never, cipher, audit);
  });

  describe('valores no secretos (JSON plano)', () => {
    it('set + get devuelve el mismo objeto', async () => {
      await svc.set(TENANT_A, 'notifications', 'default-locale', 'es-ES');
      expect(await svc.get(TENANT_A, 'notifications', 'default-locale')).toBe('es-ES');
    });

    it('set con objeto complejo se persiste y se lee igual', async () => {
      const cfg = { from: 'noreply@x.com', enabled: true, retries: 3 };
      await svc.set(TENANT_A, 'notifications', 'config', cfg);
      expect(await svc.get(TENANT_A, 'notifications', 'config')).toEqual(cfg);
    });

    it('get devuelve undefined cuando no hay setting', async () => {
      expect(await svc.get(TENANT_A, 'notifications', 'inexistente')).toBeUndefined();
    });

    it('persiste en valueJson y NO en valueCipher cuando isSecret=false', async () => {
      await svc.set(TENANT_A, 'mod', 'k', { foo: 'bar' });
      const row = prisma._rows[0];
      expect(row.isSecret).toBe(false);
      expect(row.valueJson).toEqual({ foo: 'bar' });
      expect(row.valueCipher).toBeNull();
      expect(row.valueIv).toBeNull();
      expect(row.valueTag).toBeNull();
    });

    it('un set posterior overridea el anterior', async () => {
      await svc.set(TENANT_A, 'mod', 'k', 'v1');
      await svc.set(TENANT_A, 'mod', 'k', 'v2');
      expect(prisma._rows).toHaveLength(1);
      expect(await svc.get(TENANT_A, 'mod', 'k')).toBe('v2');
    });
  });

  describe('valores secretos (cifrados)', () => {
    it('set con isSecret=true cifra el valor antes de persistir', async () => {
      await svc.set(
        TENANT_A,
        'notifications',
        'smtp',
        { host: 'smtp.x.com', pass: 'p4ss!' },
        {
          isSecret: true,
        },
      );
      const row = prisma._rows[0];
      expect(row.isSecret).toBe(true);
      expect(row.valueJson).toBeNull();
      expect(row.valueCipher).not.toBeNull();
      expect(row.valueIv).toHaveLength(12);
      expect(row.valueTag).toHaveLength(16);
      // El ciphertext NO debe contener el plaintext en claro
      expect(row.valueCipher!.toString('utf8')).not.toContain('p4ss!');
    });

    it('get descifra transparentemente', async () => {
      const secret = { user: 'foo', pass: 'r4nd0m!' };
      await svc.set(TENANT_A, 'notifications', 'smtp', secret, { isSecret: true });
      expect(await svc.get(TENANT_A, 'notifications', 'smtp')).toEqual(secret);
    });

    it('cambiar de secret a no-secret limpia los campos cipher/iv/tag', async () => {
      await svc.set(TENANT_A, 'mod', 'k', 'old-secret', { isSecret: true });
      await svc.set(TENANT_A, 'mod', 'k', 'now-public', { isSecret: false });
      const row = prisma._rows[0];
      expect(row.isSecret).toBe(false);
      expect(row.valueJson).toBe('now-public');
      expect(row.valueCipher).toBeNull();
      expect(row.valueIv).toBeNull();
      expect(row.valueTag).toBeNull();
    });

    it('cambiar de no-secret a secret limpia valueJson', async () => {
      await svc.set(TENANT_A, 'mod', 'k', 'public');
      await svc.set(TENANT_A, 'mod', 'k', 'now-secret', { isSecret: true });
      const row = prisma._rows[0];
      expect(row.isSecret).toBe(true);
      expect(row.valueJson).toBeNull();
      expect(row.valueCipher).not.toBeNull();
    });
  });

  describe('aislamiento por tenant', () => {
    it('un setting de tenant A no se ve desde tenant B', async () => {
      await svc.set(TENANT_A, 'mod', 'k', 'value-A');
      expect(await svc.get(TENANT_B, 'mod', 'k')).toBeUndefined();
    });

    it('list filtra por tenant', async () => {
      await svc.set(TENANT_A, 'mod', 'k1', 'a1');
      await svc.set(TENANT_B, 'mod', 'k2', 'b2');
      const a = await svc.list(TENANT_A);
      const b = await svc.list(TENANT_B);
      expect(a).toHaveLength(1);
      expect(a[0].key).toBe('k1');
      expect(b).toHaveLength(1);
      expect(b[0].key).toBe('k2');
    });
  });

  describe('list / has / delete', () => {
    it('list devuelve metadata sin filtrar el value de los secretos', async () => {
      await svc.set(TENANT_A, 'notifications', 'smtp', { pass: 'secret' }, { isSecret: true });
      await svc.set(TENANT_A, 'notifications', 'default-locale', 'es-ES');
      const items = await svc.list(TENANT_A);
      expect(items).toHaveLength(2);
      const smtp = items.find((i) => i.key === 'smtp');
      expect(smtp?.isSecret).toBe(true);
      expect(smtp?.hasValue).toBe(true);
      // metadata NO incluye el valor cifrado ni en plain
      expect(smtp).not.toHaveProperty('value');
    });

    it('list filtra por moduleName cuando se pasa', async () => {
      await svc.set(TENANT_A, 'notifications', 'k1', 'v1');
      await svc.set(TENANT_A, 'zoom', 'k2', 'v2');
      const onlyNotif = await svc.list(TENANT_A, 'notifications');
      expect(onlyNotif).toHaveLength(1);
      expect(onlyNotif[0].moduleName).toBe('notifications');
    });

    it('has devuelve true/false correctamente', async () => {
      await svc.set(TENANT_A, 'mod', 'k', 'v');
      expect(await svc.has(TENANT_A, 'mod', 'k')).toBe(true);
      expect(await svc.has(TENANT_A, 'mod', 'missing')).toBe(false);
    });

    it('delete remueve la fila y siguientes get devuelven undefined', async () => {
      await svc.set(TENANT_A, 'mod', 'k', 'v');
      await svc.delete(TENANT_A, 'mod', 'k');
      expect(prisma._rows).toHaveLength(0);
      expect(await svc.get(TENANT_A, 'mod', 'k')).toBeUndefined();
    });

    it('delete sobre clave inexistente es no-op', async () => {
      await expect(svc.delete(TENANT_A, 'mod', 'nope')).resolves.toBeUndefined();
    });
  });

  describe('audit log', () => {
    it('registra audit "tenant_setting.created" en el primer set', async () => {
      await svc.set(TENANT_A, 'mod', 'k', 'v', { actorId: 'user-1' });
      expect(audit.entries).toHaveLength(1);
      expect(audit.entries[0]).toMatchObject({
        tenantId: TENANT_A,
        actorId: 'user-1',
        action: 'tenant_setting.created',
        resourceType: 'tenant_setting',
        resourceId: 'mod.k',
      });
    });

    it('registra audit "tenant_setting.updated" en sets siguientes', async () => {
      await svc.set(TENANT_A, 'mod', 'k', 'v1');
      await svc.set(TENANT_A, 'mod', 'k', 'v2');
      expect(audit.entries.map((e) => e.action)).toEqual([
        'tenant_setting.created',
        'tenant_setting.updated',
      ]);
    });

    it('registra audit "tenant_setting.deleted" en el delete', async () => {
      await svc.set(TENANT_A, 'mod', 'k', 'v');
      await svc.delete(TENANT_A, 'mod', 'k', { actorId: 'admin-99' });
      expect(audit.entries[1]).toMatchObject({
        action: 'tenant_setting.deleted',
        actorId: 'admin-99',
        resourceId: 'mod.k',
      });
    });

    it('audit metadata incluye flag isSecret', async () => {
      await svc.set(TENANT_A, 'mod', 'k', 'v', { isSecret: true });
      expect(audit.entries[0].metadata).toMatchObject({ isSecret: true });
    });
  });
});
