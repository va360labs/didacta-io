import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TenantStripeResolverService,
  type ResolvedStripeCredentials,
} from '../src/modules/tenant-stripe-resolver.service';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

const VALID_TENANT_CREDS = {
  secretKey: 'sk_test_tenantA',
  webhookSecret: 'whsec_tenantA',
};

const VALID_TENANT_META_VERIFIED = {
  verifiedAt: '2026-06-02T00:00:00.000Z',
  verifiedByUserId: 'user-1',
};

/**
 * Stub minimalista de TenantConfigService — mismo patrón que
 * tenant-smtp-resolver.service.test.ts. No cifra: el resolver se queda con
 * el contrato get/set de la interface del kernel.
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

describe('TenantStripeResolverService', () => {
  const SAVED_ENV: Record<string, string | undefined> = {};
  const ENV_KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SUBSCRIPTIONS_WEBHOOK_SECRET'];

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
      const r = new TenantStripeResolverService(config as never);
      expect(await r.resolve(TENANT_A)).toBeNull();
    });

    it('devuelve credenciales del tenant si están y son válidas (source=tenant_unverified)', async () => {
      const config = makeTenantConfig();
      config.seed(TENANT_A, 'billing', 'stripe', VALID_TENANT_CREDS);
      const r = new TenantStripeResolverService(config as never);
      const result = (await r.resolve(TENANT_A)) as ResolvedStripeCredentials;
      expect(result.source).toBe('tenant_unverified');
      expect(result.verified).toBe(false);
      expect(result.credentials.secretKey).toBe('sk_test_tenantA');
    });

    it('marca verified=true cuando stripe_meta.verifiedAt está presente', async () => {
      const config = makeTenantConfig();
      config.seed(TENANT_A, 'billing', 'stripe', VALID_TENANT_CREDS);
      config.seed(TENANT_A, 'billing', 'stripe_meta', VALID_TENANT_META_VERIFIED);
      const r = new TenantStripeResolverService(config as never);
      const result = (await r.resolve(TENANT_A)) as ResolvedStripeCredentials;
      expect(result.source).toBe('tenant');
      expect(result.verified).toBe(true);
    });

    it('cae al fallback global cuando el tenant no tiene config', async () => {
      const config = makeTenantConfig();
      process.env['STRIPE_SECRET_KEY'] = 'sk_test_global';
      process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_global';
      const r = new TenantStripeResolverService(config as never);
      const result = (await r.resolve(TENANT_B)) as ResolvedStripeCredentials;
      expect(result.source).toBe('global');
      expect(result.verified).toBe(false);
      expect(result.credentials.secretKey).toBe('sk_test_global');
    });

    it('SUBSCRIPTIONS_WEBHOOK_SECRET global se incluye si está', async () => {
      const config = makeTenantConfig();
      process.env['STRIPE_SECRET_KEY'] = 'sk_test_global';
      process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_global';
      process.env['SUBSCRIPTIONS_WEBHOOK_SECRET'] = 'whsec_subs_global';
      const r = new TenantStripeResolverService(config as never);
      const result = (await r.resolve(TENANT_A)) as ResolvedStripeCredentials;
      expect(result.credentials.subscriptionsWebhookSecret).toBe('whsec_subs_global');
    });

    it('fallback global sin STRIPE_WEBHOOK_SECRET → null', async () => {
      const config = makeTenantConfig();
      process.env['STRIPE_SECRET_KEY'] = 'sk_test_global';
      const r = new TenantStripeResolverService(config as never);
      expect(await r.resolve(TENANT_A)).toBeNull();
    });

    it('fallback global sin STRIPE_SECRET_KEY → null', async () => {
      const config = makeTenantConfig();
      process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_global';
      const r = new TenantStripeResolverService(config as never);
      expect(await r.resolve(TENANT_A)).toBeNull();
    });

    it('tenant con config + global presente → gana el tenant', async () => {
      const config = makeTenantConfig();
      config.seed(TENANT_A, 'billing', 'stripe', VALID_TENANT_CREDS);
      process.env['STRIPE_SECRET_KEY'] = 'sk_test_global';
      process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_global';
      const r = new TenantStripeResolverService(config as never);
      const result = (await r.resolve(TENANT_A)) as ResolvedStripeCredentials;
      expect(result.source).toBe('tenant_unverified');
      expect(result.credentials.secretKey).toBe('sk_test_tenantA');
    });

    it('descifrar del tenant falla → cae a global si existe', async () => {
      const config = makeFailingTenantConfig({ t: TENANT_A, m: 'billing', k: 'stripe' });
      process.env['STRIPE_SECRET_KEY'] = 'sk_test_global';
      process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_global';
      const r = new TenantStripeResolverService(config as never);
      const result = (await r.resolve(TENANT_A)) as ResolvedStripeCredentials;
      expect(result.source).toBe('global');
    });

    it('descifrar falla y sin global → null', async () => {
      const config = makeFailingTenantConfig({ t: TENANT_A, m: 'billing', k: 'stripe' });
      const r = new TenantStripeResolverService(config as never);
      expect(await r.resolve(TENANT_A)).toBeNull();
    });
  });

  describe('resolveTenantOnly — no cae a global', () => {
    it('null cuando tenant no tiene config, aunque haya global', async () => {
      const config = makeTenantConfig();
      process.env['STRIPE_SECRET_KEY'] = 'sk_test_global';
      process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_global';
      const r = new TenantStripeResolverService(config as never);
      expect(await r.resolveTenantOnly(TENANT_A)).toBeNull();
    });

    it('devuelve credenciales del tenant si están', async () => {
      const config = makeTenantConfig();
      config.seed(TENANT_A, 'billing', 'stripe', VALID_TENANT_CREDS);
      const r = new TenantStripeResolverService(config as never);
      const result = (await r.resolveTenantOnly(TENANT_A)) as ResolvedStripeCredentials;
      expect(result.credentials.secretKey).toBe('sk_test_tenantA');
    });
  });

  describe('hasTenantConfig', () => {
    it('true cuando hay config válida', async () => {
      const config = makeTenantConfig();
      config.seed(TENANT_A, 'billing', 'stripe', VALID_TENANT_CREDS);
      const r = new TenantStripeResolverService(config as never);
      expect(await r.hasTenantConfig(TENANT_A)).toBe(true);
    });

    it('false cuando no hay config (aunque haya global)', async () => {
      const config = makeTenantConfig();
      process.env['STRIPE_SECRET_KEY'] = 'sk_test_global';
      process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_global';
      const r = new TenantStripeResolverService(config as never);
      expect(await r.hasTenantConfig(TENANT_A)).toBe(false);
    });
  });
});
