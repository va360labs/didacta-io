import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TenantSmtpResolverService,
  type ResolvedSmtp,
} from '../src/modules/tenant-smtp-resolver.service';
import { SmtpAdapterService } from '../src/modules/smtp-adapter.service';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

const VALID_TENANT_CFG = {
  host: 'smtp.tenant.example',
  port: 587,
  user: 'tenantA',
  password: 'pwd-tenantA',
  from: 'no-reply@tenant-a.example',
};

const VALID_TENANT_META_VERIFIED = {
  verifiedAt: '2026-06-02T00:00:00.000Z',
  verifiedByUserId: 'user-1',
};

/**
 * Stub minimalista de TenantConfigService. Soporta un mapa
 * (tenantId, moduleName, key) → valor en memoria. NO cifra (no hace
 * falta para los tests del resolver — éste se queda con el contrato
 * `get/set` de la interface del kernel).
 */
function makeTenantConfig() {
  const store = new Map<string, unknown>();
  const key = (t: string, m: string, k: string) => `${t}|${m}|${k}`;
  return {
    store,
    async get(t: string, m: string, k: string) {
      return store.get(key(t, m, k));
    },
    async set(t: string, m: string, k: string, v: unknown) {
      store.set(key(t, m, k), v);
    },
    seed(t: string, m: string, k: string, v: unknown) {
      store.set(key(t, m, k), v);
    },
    /** Hace que `get` para una clave concreta lance error (simula clave rotada). */
    failOn: null as { t: string; m: string; k: string } | null,
  };
}

function makeFailingTenantConfig(fail: { t: string; m: string; k: string }) {
  const base = makeTenantConfig();
  const origGet = base.get.bind(base);
  base.get = async (t: string, m: string, k: string) => {
    if (t === fail.t && m === fail.m && k === fail.k) {
      throw new Error('Unsupported state or unable to authenticate data');
    }
    return origGet(t, m, k);
  };
  return base;
}

describe('TenantSmtpResolverService', () => {
  const smtp = new SmtpAdapterService();

  // Limpiamos env vars globales antes de cada test para que cada caso
  // controle explícitamente si hay fallback global o no.
  const SAVED_ENV: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASS',
    'SMTP_PASSWORD',
    'SMTP_FROM',
    'SMTP_SECURE',
  ];

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      SAVED_ENV[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (SAVED_ENV[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = SAVED_ENV[k];
      }
    }
  });

  describe('resolve — cascada tenant → global → none', () => {
    it('devuelve null si no hay config en ningún nivel', async () => {
      const config = makeTenantConfig();
      const r = new TenantSmtpResolverService(config as never, smtp);
      expect(await r.resolve(TENANT_A)).toBeNull();
    });

    it('devuelve config del tenant si está y es válida (source=tenant_unverified)', async () => {
      const config = makeTenantConfig();
      config.seed(TENANT_A, 'notifications', 'smtp', VALID_TENANT_CFG);
      const r = new TenantSmtpResolverService(config as never, smtp);
      const result = (await r.resolve(TENANT_A)) as ResolvedSmtp;
      expect(result.source).toBe('tenant_unverified');
      expect(result.verified).toBe(false);
      expect(result.config.host).toBe('smtp.tenant.example');
    });

    it('marca verified=true cuando smtp_meta.verifiedAt está presente', async () => {
      const config = makeTenantConfig();
      config.seed(TENANT_A, 'notifications', 'smtp', VALID_TENANT_CFG);
      config.seed(TENANT_A, 'notifications', 'smtp_meta', VALID_TENANT_META_VERIFIED);
      const r = new TenantSmtpResolverService(config as never, smtp);
      const result = (await r.resolve(TENANT_A)) as ResolvedSmtp;
      expect(result.source).toBe('tenant');
      expect(result.verified).toBe(true);
    });

    it('cae al fallback global cuando el tenant no tiene config', async () => {
      const config = makeTenantConfig();
      process.env['SMTP_HOST'] = 'global.smtp.example';
      process.env['SMTP_PORT'] = '587';
      process.env['SMTP_USER'] = 'globalu';
      process.env['SMTP_PASS'] = 'globalp';
      process.env['SMTP_FROM'] = 'no-reply@global.example';
      const r = new TenantSmtpResolverService(config as never, smtp);
      const result = (await r.resolve(TENANT_B)) as ResolvedSmtp;
      expect(result.source).toBe('global');
      expect(result.verified).toBe(false);
      expect(result.config.host).toBe('global.smtp.example');
      expect(result.config.from).toBe('no-reply@global.example');
    });

    it('SMTP_FROM "Nombre <email>" extrae el email correctamente', async () => {
      const config = makeTenantConfig();
      process.env['SMTP_HOST'] = 'g.example';
      process.env['SMTP_PORT'] = '465';
      process.env['SMTP_FROM'] = 'Didacta <noreply@didacta.example>';
      const r = new TenantSmtpResolverService(config as never, smtp);
      const result = (await r.resolve(TENANT_A)) as ResolvedSmtp;
      expect(result.config.from).toBe('noreply@didacta.example');
      // port 465 → el adapter inferirá secure=true; no lo verificamos acá.
    });

    it('SMTP_PASSWORD se acepta como alias de SMTP_PASS', async () => {
      const config = makeTenantConfig();
      process.env['SMTP_HOST'] = 'g.example';
      process.env['SMTP_PORT'] = '587';
      process.env['SMTP_USER'] = 'u';
      process.env['SMTP_PASSWORD'] = 'p';
      process.env['SMTP_FROM'] = 'a@b.co';
      const r = new TenantSmtpResolverService(config as never, smtp);
      const result = (await r.resolve(TENANT_A)) as ResolvedSmtp;
      expect(result.config.password).toBe('p');
    });

    it('SMTP_USER ausente → user/password se rellenan con "anonymous" (MTA local sin auth)', async () => {
      const config = makeTenantConfig();
      process.env['SMTP_HOST'] = 'localhost';
      process.env['SMTP_PORT'] = '1025';
      process.env['SMTP_FROM'] = 'noreply@local.example';
      const r = new TenantSmtpResolverService(config as never, smtp);
      const result = (await r.resolve(TENANT_A)) as ResolvedSmtp;
      expect(result.config.user).toBe('anonymous');
      expect(result.config.password).toBe('anonymous');
    });

    it('fallback global con puerto inválido → null', async () => {
      const config = makeTenantConfig();
      process.env['SMTP_HOST'] = 'g.example';
      process.env['SMTP_PORT'] = 'no-es-numero';
      process.env['SMTP_FROM'] = 'a@b.co';
      const r = new TenantSmtpResolverService(config as never, smtp);
      expect(await r.resolve(TENANT_A)).toBeNull();
    });

    it('fallback global sin SMTP_FROM → null', async () => {
      const config = makeTenantConfig();
      process.env['SMTP_HOST'] = 'g.example';
      process.env['SMTP_PORT'] = '587';
      const r = new TenantSmtpResolverService(config as never, smtp);
      expect(await r.resolve(TENANT_A)).toBeNull();
    });

    it('tenant con config + global presente → gana el tenant', async () => {
      const config = makeTenantConfig();
      config.seed(TENANT_A, 'notifications', 'smtp', VALID_TENANT_CFG);
      process.env['SMTP_HOST'] = 'global.example';
      process.env['SMTP_PORT'] = '587';
      process.env['SMTP_FROM'] = 'a@b.co';
      const r = new TenantSmtpResolverService(config as never, smtp);
      const result = (await r.resolve(TENANT_A)) as ResolvedSmtp;
      expect(result.source).toBe('tenant_unverified');
      expect(result.config.host).toBe('smtp.tenant.example');
    });

    it('descifrar del tenant falla → cae a global si existe', async () => {
      const config = makeFailingTenantConfig({
        t: TENANT_A,
        m: 'notifications',
        k: 'smtp',
      });
      process.env['SMTP_HOST'] = 'global.example';
      process.env['SMTP_PORT'] = '587';
      process.env['SMTP_FROM'] = 'a@b.co';
      const r = new TenantSmtpResolverService(config as never, smtp);
      const result = (await r.resolve(TENANT_A)) as ResolvedSmtp;
      expect(result.source).toBe('global');
    });

    it('descifrar falla y sin global → null', async () => {
      const config = makeFailingTenantConfig({
        t: TENANT_A,
        m: 'notifications',
        k: 'smtp',
      });
      const r = new TenantSmtpResolverService(config as never, smtp);
      expect(await r.resolve(TENANT_A)).toBeNull();
    });
  });

  describe('resolveTenantOnly — no cae a global', () => {
    it('null cuando tenant no tiene config, aunque haya global', async () => {
      const config = makeTenantConfig();
      process.env['SMTP_HOST'] = 'g.example';
      process.env['SMTP_PORT'] = '587';
      process.env['SMTP_FROM'] = 'a@b.co';
      const r = new TenantSmtpResolverService(config as never, smtp);
      expect(await r.resolveTenantOnly(TENANT_A)).toBeNull();
    });

    it('devuelve config del tenant si está', async () => {
      const config = makeTenantConfig();
      config.seed(TENANT_A, 'notifications', 'smtp', VALID_TENANT_CFG);
      const r = new TenantSmtpResolverService(config as never, smtp);
      const result = (await r.resolveTenantOnly(TENANT_A)) as ResolvedSmtp;
      expect(result.config.host).toBe('smtp.tenant.example');
    });
  });

  describe('hasTenantConfig', () => {
    it('true cuando hay config válida', async () => {
      const config = makeTenantConfig();
      config.seed(TENANT_A, 'notifications', 'smtp', VALID_TENANT_CFG);
      const r = new TenantSmtpResolverService(config as never, smtp);
      expect(await r.hasTenantConfig(TENANT_A)).toBe(true);
    });

    it('false cuando no hay config (aunque haya global)', async () => {
      const config = makeTenantConfig();
      process.env['SMTP_HOST'] = 'g.example';
      process.env['SMTP_PORT'] = '587';
      process.env['SMTP_FROM'] = 'a@b.co';
      const r = new TenantSmtpResolverService(config as never, smtp);
      expect(await r.hasTenantConfig(TENANT_A)).toBe(false);
    });
  });
});
