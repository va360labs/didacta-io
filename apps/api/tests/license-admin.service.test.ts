import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type {
  LicensePayload,
  LicenseService,
  LicenseState,
  LoadOptions,
} from '@didacta/license-sdk';
import { LicenseAdminService } from '../src/license/license-admin.service';
import { PrismaInstanceConfigService } from '../src/modules/prisma-instance-config.service';
import { SecretCipherService } from '../src/modules/secret-cipher.service';
import { randomBytes } from 'node:crypto';

const ENV_KEY = 'DIDACTA_LICENSE_KEY';
const ENV_BYPASS = 'DIDACTA_DEV_BYPASS';

function activeState(overrides: Partial<LicenseState> = {}): LicenseState {
  return {
    status: 'active',
    loadedAt: new Date('2026-08-03T00:00:00Z'),
    source: 'admin-panel',
    warnings: [],
    subject: {
      licenseId: 'lic_1',
      customerId: 'cus_1',
      organizationId: 'org_1',
      organizationName: 'Test Org',
      plan: 'enterprise-standard',
      edition: 'enterprise',
      issuedAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2027-01-01T00:00:00Z'),
      capabilities: ['feat:white_label'],
    },
    ...overrides,
  };
}

/** Como `activeState()` pero con `payload.didacta.constraints` poblado — lo
 * que `checkAllowedDomains()` lee de verdad (no `subject`, que no lleva constraints). */
function activeStateWithAllowedDomains(allowedDomains: string[]): LicenseState {
  const base = activeState();
  const payload: LicensePayload = {
    iss: 'didacta.io',
    aud: 'didacta-runtime',
    exp: Math.floor(base.subject!.expiresAt.getTime() / 1000),
    iat: Math.floor(base.subject!.issuedAt.getTime() / 1000),
    didacta: {
      licenseId: base.subject!.licenseId,
      customerId: base.subject!.customerId,
      organizationId: base.subject!.organizationId,
      organizationName: base.subject!.organizationName,
      product: 'didacta',
      plan: base.subject!.plan,
      edition: base.subject!.edition,
      issuedAt: base.subject!.issuedAt.toISOString(),
      expiresAt: base.subject!.expiresAt.toISOString(),
      gracePeriodDays: 30,
      capabilities: base.subject!.capabilities,
      constraints: { allowedDomains },
    },
  };
  return { ...base, payload };
}

/** Fake duck-typed de LicenseService: solo lo que LicenseAdminService usa. */
class FakeLicenseService {
  calls: LoadOptions[] = [];
  nextState: LicenseState = {
    status: 'community',
    loadedAt: new Date(0),
    source: 'unknown',
    warnings: [],
  };

  async load(options: LoadOptions = {}): Promise<LicenseState> {
    this.calls.push(options);
    return this.nextState;
  }
}

describe('LicenseAdminService', () => {
  let envSnapshot: Record<string, string | undefined>;
  let fakeLicense: FakeLicenseService;
  let settings: PrismaInstanceConfigService;
  let svc: LicenseAdminService;
  let tenantDomains: Array<{ hostname: string; isVerified: boolean }>;

  beforeEach(() => {
    envSnapshot = { [ENV_KEY]: process.env[ENV_KEY], [ENV_BYPASS]: process.env[ENV_BYPASS] };
    delete process.env[ENV_KEY];
    delete process.env[ENV_BYPASS];

    fakeLicense = new FakeLicenseService();
    const cipher = new SecretCipherService(randomBytes(32).toString('hex'));
    // Fake Prisma mínimo, suficiente para PrismaInstanceConfigService.
    interface Row {
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
    const rows: Row[] = [];
    const findIdx = (scope: string, key: string) =>
      rows.findIndex((r) => r.scope === scope && r.key === key);
    tenantDomains = [];
    const fakePrisma = {
      tenantDomain: {
        async findMany(args: { where?: { isVerified?: boolean } }) {
          return tenantDomains.filter(
            (d) => args.where?.isVerified === undefined || d.isVerified === args.where.isVerified,
          );
        },
      },
      instanceSetting: {
        async findUnique(args: { where: { scope_key: { scope: string; key: string } } }) {
          const { scope, key } = args.where.scope_key;
          const idx = findIdx(scope, key);
          return idx >= 0 ? rows[idx] : null;
        },
        async findMany(args: { where?: { scope?: string } }) {
          return rows.filter((r) => !args.where?.scope || r.scope === args.where.scope);
        },
        async upsert(args: {
          where: { scope_key: { scope: string; key: string } };
          create: Partial<Row> & { scope: string; key: string };
          update: Partial<Row>;
        }) {
          const { scope, key } = args.where.scope_key;
          const idx = findIdx(scope, key);
          const now = new Date();
          if (idx >= 0) {
            rows[idx] = { ...rows[idx]!, ...args.update, updatedAt: now };
            return rows[idx];
          }
          const row: Row = {
            isSecret: false,
            valueJson: null,
            valueCipher: null,
            valueIv: null,
            valueTag: null,
            updatedById: null,
            updatedAt: now,
            ...args.create,
          };
          rows.push(row);
          return row;
        },
        async delete(args: { where: { scope_key: { scope: string; key: string } } }) {
          const { scope, key } = args.where.scope_key;
          const idx = findIdx(scope, key);
          if (idx < 0) throw new Error('not found');
          return rows.splice(idx, 1)[0];
        },
      },
    };
    settings = new PrismaInstanceConfigService(fakePrisma as never, cipher);
    svc = new LicenseAdminService(
      fakeLicense as unknown as LicenseService,
      settings,
      fakePrisma as never,
    );
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('precedencia env > BD', () => {
    it('reload() usa la key del env con source "env" si DIDACTA_LICENSE_KEY está seteada', async () => {
      process.env[ENV_KEY] = 'jwt-del-operador';
      await settings.set('license', 'key', 'jwt-del-panel', { isSecret: true });

      await svc.reload();

      expect(fakeLicense.calls[0]).toMatchObject({ key: 'jwt-del-operador', source: 'env' });
    });

    it('reload() cae a la key de instance_setting con source "admin-panel" si no hay env', async () => {
      await settings.set('license', 'key', 'jwt-del-panel', { isSecret: true });

      await svc.reload();

      expect(fakeLicense.calls[0]).toMatchObject({ key: 'jwt-del-panel', source: 'admin-panel' });
    });

    it('reload() manda key null si no hay ni env ni BD', async () => {
      await svc.reload();
      expect(fakeLicense.calls[0]).toMatchObject({ key: null });
    });
  });

  describe('getStatus()', () => {
    it('mapea LicenseState + metadata de instance_setting al DTO admin', async () => {
      fakeLicense.nextState = activeState();
      await settings.set('license', 'key', 'jwt-del-panel', { isSecret: true });

      const dto = await svc.getStatus();

      expect(dto.status).toBe('active');
      expect(dto.organizationName).toBe('Test Org');
      expect(dto.plan).toBe('enterprise-standard');
      expect(dto.capabilities).toEqual(['feat:white_label']);
      expect(dto.hasKeyConfigured).toBe(true);
      expect(dto.managedByEnv).toBe(false);
    });

    it('managedByEnv=true cuando DIDACTA_LICENSE_KEY está seteada', async () => {
      process.env[ENV_KEY] = 'jwt-del-operador';
      const dto = await svc.getStatus();
      expect(dto.managedByEnv).toBe(true);
    });
  });

  describe('setKey()', () => {
    it('rechaza y NO persiste si la licencia resulta inválida', async () => {
      fakeLicense.nextState = {
        status: 'invalid',
        loadedAt: new Date(),
        source: 'admin-panel',
        warnings: ['firma inválida'],
      };

      await expect(svc.setKey('clave-basura', 'user-1')).rejects.toThrow(/inválida/i);
      expect(await settings.has('license', 'key')).toBe(false);
    });

    it('persiste la key cuando la licencia es válida', async () => {
      fakeLicense.nextState = activeState();

      const dto = await svc.setKey('jwt-valido', 'user-1');

      expect(dto.status).toBe('active');
      expect(await settings.get('license', 'key')).toBe('jwt-valido');
    });

    it('rechaza con conflicto si la licencia está fijada por env', async () => {
      process.env[ENV_KEY] = 'jwt-del-operador';
      await expect(svc.setKey('otra-clave', 'user-1')).rejects.toThrow(/entorno/i);
      expect(await settings.has('license', 'key')).toBe(false);
    });

    it('rechaza clave vacía sin llamar a license.load', async () => {
      await expect(svc.setKey('   ', 'user-1')).rejects.toThrow(/vacía/i);
      expect(fakeLicense.calls).toHaveLength(0);
    });
  });

  describe('clearKey()', () => {
    it('borra la key y recarga (cae a community si no hay env)', async () => {
      await settings.set('license', 'key', 'jwt-del-panel', { isSecret: true });
      fakeLicense.nextState = {
        status: 'community',
        loadedAt: new Date(),
        source: 'env',
        warnings: [],
      };

      const dto = await svc.clearKey('user-1');

      expect(await settings.has('license', 'key')).toBe(false);
      expect(dto.status).toBe('community');
      expect(dto.hasKeyConfigured).toBe(false);
    });

    it('rechaza con conflicto si la licencia está fijada por env', async () => {
      process.env[ENV_KEY] = 'jwt-del-operador';
      await settings.set('license', 'key', 'jwt-del-panel', { isSecret: true });
      await expect(svc.clearKey('user-1')).rejects.toThrow(/entorno/i);
      // No se tocó lo guardado en BD.
      expect(await settings.has('license', 'key')).toBe(true);
    });
  });

  describe('L1 — enforcement de constraints.allowedDomains (modo warning)', () => {
    it('sin allowedDomains en el payload: no añade warnings', async () => {
      fakeLicense.nextState = activeState();
      tenantDomains = [{ hostname: 'academia.example.com', isVerified: true }];

      const dto = await svc.getStatus();

      expect(dto.warnings).toEqual([]);
    });

    it('dominio verificado NO cubierto por allowedDomains: añade warning (no bloquea, status sigue active)', async () => {
      fakeLicense.nextState = activeStateWithAllowedDomains(['otra-academia.com']);
      tenantDomains = [{ hostname: 'academia.example.com', isVerified: true }];

      const dto = await svc.getStatus();

      expect(dto.status).toBe('active');
      expect(dto.warnings).toHaveLength(1);
      expect(dto.warnings[0]).toContain('academia.example.com');
    });

    it('dominio verificado SÍ cubierto por allowedDomains: sin warnings', async () => {
      fakeLicense.nextState = activeStateWithAllowedDomains(['academia.example.com']);
      tenantDomains = [{ hostname: 'academia.example.com', isVerified: true }];

      const dto = await svc.getStatus();

      expect(dto.warnings).toEqual([]);
    });

    it('comparación case-insensitive', async () => {
      fakeLicense.nextState = activeStateWithAllowedDomains(['Academia.Example.COM']);
      tenantDomains = [{ hostname: 'academia.example.com', isVerified: true }];

      const dto = await svc.getStatus();

      expect(dto.warnings).toEqual([]);
    });

    it('ignora dominios no verificados', async () => {
      fakeLicense.nextState = activeStateWithAllowedDomains(['academia.example.com']);
      tenantDomains = [{ hostname: 'sin-verificar.com', isVerified: false }];

      const dto = await svc.getStatus();

      expect(dto.warnings).toEqual([]);
    });
  });
});
