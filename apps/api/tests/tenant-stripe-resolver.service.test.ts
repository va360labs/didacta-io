import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  TenantStripeResolverService,
  buildGlobalFallbackFlagReader,
  type GlobalFallbackPolicyStore,
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

  /**
   * UC-C101 — candado `billing.allowGlobalStripeFallback`.
   *
   * El fallback global existe para el self-hoster que aún cobra por env. En un
   * pool multi-tenant es una trampa: el tenant que no configuró su Stripe
   * cobraría en la cuenta del operador. El candado lo apaga.
   */
  describe('candado del fallback global (allowGlobalStripeFallback)', () => {
    beforeEach(() => {
      process.env['STRIPE_SECRET_KEY'] = 'sk_test_global';
      process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_global';
    });

    it('SIN lector de flag el comportamiento no cambia (regresión del self-hoster)', async () => {
      const config = makeTenantConfig();
      const r = new TenantStripeResolverService(config as never);
      const result = (await r.resolve(TENANT_B)) as ResolvedStripeCredentials;
      expect(result.source).toBe('global');
    });

    it('flag a true → sigue heredando de la instancia', async () => {
      const config = makeTenantConfig();
      const r = new TenantStripeResolverService(config as never, async () => true);
      const result = (await r.resolve(TENANT_B)) as ResolvedStripeCredentials;
      expect(result.source).toBe('global');
    });

    it('flag a false → NO hereda aunque las env estén pobladas', async () => {
      const config = makeTenantConfig();
      const r = new TenantStripeResolverService(config as never, async () => false);
      expect(await r.resolve(TENANT_B)).toBeNull();
    });

    it('flag a false pero el tenant TIENE lo suyo → sigue resolviendo con lo del tenant', async () => {
      const config = makeTenantConfig();
      config.seed(TENANT_A, 'billing', 'stripe', VALID_TENANT_CREDS);
      const r = new TenantStripeResolverService(config as never, async () => false);
      const result = (await r.resolve(TENANT_A)) as ResolvedStripeCredentials;
      expect(result.source).toBe('tenant_unverified');
      expect(result.credentials.secretKey).toBe('sk_test_tenantA');
    });

    it('si el lector revienta y no hay valor previo NO se hereda: el dinero no va a la cuenta de otro por un fallo de BD', async () => {
      // Antes se asumía permitido. En un servidor con varias aulas eso mandaba
      // los cobros de un aula a la cuenta del operador justo cuando no se podía
      // comprobar si estaba permitido. Un checkout que falla se reintenta; un
      // cobro en la cuenta equivocada, no.
      const config = makeTenantConfig();
      const r = new TenantStripeResolverService(config as never, async () => {
        throw new Error('BD caída');
      });
      expect(await r.resolve(TENANT_B)).toBeNull();
    });

    it('si el lector revienta pero hubo un valor previo, se mantiene ese (y el fallo no se cachea)', async () => {
      const config = makeTenantConfig();
      let lecturas = 0;
      let rota = false;
      const r = new TenantStripeResolverService(config as never, async () => {
        lecturas += 1;
        if (rota) throw new Error('BD caída');
        return true;
      });
      expect(((await r.resolve(TENANT_B)) as ResolvedStripeCredentials).source).toBe('global');

      // Caduca el cache (sin invalidar el último valor conocido) y la BD se cae.
      rota = true;
      (r as unknown as { flagCache: { expiresAt: number } }).flagCache.expiresAt = 0;
      expect(((await r.resolve(TENANT_B)) as ResolvedStripeCredentials).source).toBe('global');
      // Vuelve a intentarlo en la siguiente llamada: el fallo no se cachea.
      await r.resolve(TENANT_B);
      expect(lecturas).toBe(3);
    });

    it('cachea el flag: resolve() corre en cada checkout y no puede ir a BD siempre', async () => {
      const config = makeTenantConfig();
      let lecturas = 0;
      const r = new TenantStripeResolverService(config as never, async () => {
        lecturas += 1;
        return false;
      });
      await r.resolve(TENANT_B);
      await r.resolve(TENANT_B);
      await r.resolve(TENANT_B);
      expect(lecturas).toBe(1);
    });

    it('invalidateGlobalFallbackFlag() vuelve a leer, para que guardar en el panel surta efecto', async () => {
      const config = makeTenantConfig();
      let permitido = false;
      let lecturas = 0;
      const r = new TenantStripeResolverService(config as never, async () => {
        lecturas += 1;
        return permitido;
      });
      expect(await r.resolve(TENANT_B)).toBeNull();

      permitido = true;
      r.invalidateGlobalFallbackFlag();
      const result = (await r.resolve(TENANT_B)) as ResolvedStripeCredentials;
      expect(result.source).toBe('global');
      expect(lecturas).toBe(2);
    });
  });

  /**
   * La política de verdad (la que montan `ModuleRegistryService` y `AuthModule`).
   *
   * El valor por defecto era «permitido» siempre. En la instalación de UNA aula
   * es lo correcto —el dueño de la instancia y el del aula son la misma persona—
   * pero en un servidor con varias, el aula que no había configurado su Stripe
   * cobraba a sus alumnos con la cuenta del operador sin que nadie lo decidiera.
   */
  describe('política del fallback global (buildGlobalFallbackFlagReader)', () => {
    function store(opts: { setting?: unknown; aulas: number }) {
      const calls = { count: 0, where: undefined as unknown };
      const s: GlobalFallbackPolicyStore = {
        instanceSetting: {
          findUnique: async () => (opts.setting === undefined ? null : { valueJson: opts.setting }),
        },
        tenant: {
          count: async (args) => {
            calls.count += 1;
            calls.where = args.where;
            return opts.aulas;
          },
        },
      };
      return { s, calls };
    }

    it('UNA sola aula y nadie ha dicho nada → permitido (la edición Community no cambia)', async () => {
      const { s } = store({ aulas: 1 });
      expect(await buildGlobalFallbackFlagReader(s, {})()).toEqual({
        allowed: true,
        reason: 'single-tenant',
        tenants: 1,
      });
    });

    it('instancia recién creada, aún sin aulas → permitido', async () => {
      const { s } = store({ aulas: 0 });
      expect(await buildGlobalFallbackFlagReader(s, {})()).toMatchObject({ allowed: true });
    });

    it('VARIAS aulas y nadie ha dicho nada → NO permitido', async () => {
      const { s, calls } = store({ aulas: 2 });
      expect(await buildGlobalFallbackFlagReader(s, {})()).toEqual({
        allowed: false,
        reason: 'multiple-tenants',
        tenants: 2,
      });
      // Las archivadas no cuentan: un aula dada de baja no convierte la
      // instancia en multi-aula.
      expect(calls.where).toEqual({ status: { not: 'ARCHIVED' }, deletedAt: null });
    });

    it('VARIAS aulas con STRIPE_ALLOW_GLOBAL_FALLBACK=true → permitido (mismo dueño, decisión explícita)', async () => {
      const { s, calls } = store({ aulas: 5 });
      const env = { STRIPE_ALLOW_GLOBAL_FALLBACK: ' TRUE ' };
      expect(await buildGlobalFallbackFlagReader(s, env)()).toEqual({
        allowed: true,
        reason: 'env',
      });
      expect(calls.count).toBe(0);
    });

    it('UNA aula con STRIPE_ALLOW_GLOBAL_FALLBACK=false → NO permitido', async () => {
      const { s } = store({ aulas: 1 });
      const env = { STRIPE_ALLOW_GLOBAL_FALLBACK: 'false' };
      expect(await buildGlobalFallbackFlagReader(s, env)()).toEqual({
        allowed: false,
        reason: 'env',
      });
    });

    it('el setting de instancia manda sobre la variable y sobre el recuento', async () => {
      const permitido = store({ setting: true, aulas: 9 });
      expect(
        await buildGlobalFallbackFlagReader(permitido.s, {
          STRIPE_ALLOW_GLOBAL_FALLBACK: 'false',
        })(),
      ).toEqual({ allowed: true, reason: 'instance-setting' });

      const prohibido = store({ setting: false, aulas: 1 });
      expect(
        await buildGlobalFallbackFlagReader(prohibido.s, {
          STRIPE_ALLOW_GLOBAL_FALLBACK: 'true',
        })(),
      ).toEqual({ allowed: false, reason: 'instance-setting' });
    });

    it('un setting que no es booleano o una variable ilegible no deciden nada: se cae al recuento', async () => {
      const { s } = store({ setting: 'sí', aulas: 3 });
      const env = { STRIPE_ALLOW_GLOBAL_FALLBACK: 'quizá' };
      expect(await buildGlobalFallbackFlagReader(s, env)()).toMatchObject({
        allowed: false,
        reason: 'multiple-tenants',
      });
    });

    it('integrado con el resolutor: en un servidor con dos aulas, la que no tiene Stripe NO hereda el de instancia', async () => {
      process.env['STRIPE_SECRET_KEY'] = 'sk_test_global';
      process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_global';
      const config = makeTenantConfig();
      config.seed(TENANT_A, 'billing', 'stripe', VALID_TENANT_CREDS);

      const multi = new TenantStripeResolverService(
        config as never,
        buildGlobalFallbackFlagReader(store({ aulas: 2 }).s, {}),
      );
      expect(await multi.resolve(TENANT_B)).toBeNull();
      // La que sí tiene lo suyo no se entera.
      expect(((await multi.resolve(TENANT_A)) as ResolvedStripeCredentials).source).toBe(
        'tenant_unverified',
      );

      // Control: la misma instancia con una sola aula sigue cobrando por env.
      const single = new TenantStripeResolverService(
        config as never,
        buildGlobalFallbackFlagReader(store({ aulas: 1 }).s, {}),
      );
      expect(((await single.resolve(TENANT_B)) as ResolvedStripeCredentials).source).toBe('global');
    });
  });

  /**
   * El valor por defecto se apaga SOLO al crear la segunda aula: es lo seguro
   * (nadie ha dicho que las dos sean del mismo dueño), pero la primera deja de
   * cobrar. Eso no puede enterarse nadie por un alumno que no pudo pagar: se
   * dice en el log, bien alto, al arrancar, al crear el aula y en el momento en
   * que el valor efectivo cambia.
   */
  describe('el corte del fallback no es silencioso', () => {
    let errorLog: MockInstance<(...args: unknown[]) => void>;
    let warnLog: MockInstance<(...args: unknown[]) => void>;

    beforeEach(() => {
      process.env['STRIPE_SECRET_KEY'] = 'sk_test_global';
      process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_global';
      errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      warnLog = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Un recuento de aulas que se puede cambiar en caliente. */
    function instancia(aulas: number) {
      const estado = { aulas };
      const store: GlobalFallbackPolicyStore = {
        instanceSetting: { findUnique: async () => null },
        tenant: { count: async () => estado.aulas },
      };
      const r = new TenantStripeResolverService(
        makeTenantConfig() as never,
        buildGlobalFallbackFlagReader(store, {}),
      );
      return { r, estado };
    }

    it('al arrancar con VARIAS aulas y cuenta de instancia: error que dice qué pasa y qué definir', async () => {
      const { r } = instancia(3);

      await r.reportGlobalFallback('startup');

      expect(errorLog).toHaveBeenCalledTimes(1);
      const msg = String(errorLog.mock.calls[0]![0]);
      expect(msg).toContain('COBROS');
      expect(msg).toContain('3 aulas');
      expect(msg).toContain('NO PUEDEN COBRAR');
      expect(msg).toContain('STRIPE_ALLOW_GLOBAL_FALLBACK=true');
    });

    it('al arrancar con UNA aula: aviso de que crear la segunda cortará sus cobros', async () => {
      const { r } = instancia(1);

      await r.reportGlobalFallback('startup');

      expect(errorLog).not.toHaveBeenCalled();
      expect(warnLog).toHaveBeenCalledTimes(1);
      expect(String(warnLog.mock.calls[0]![0])).toContain('segunda aula');
    });

    it('al CREAR la segunda aula: se reevalúa al momento (sin esperar al cache) y sale el error', async () => {
      const { r, estado } = instancia(1);
      // La instancia venía cobrando con la cuenta de instancia.
      expect(((await r.resolve(TENANT_B)) as ResolvedStripeCredentials).source).toBe('global');

      estado.aulas = 2;
      await r.reportGlobalFallback('tenant-created');

      expect(errorLog).toHaveBeenCalled();
      expect(errorLog.mock.calls.map((c) => String(c[0])).join(' ')).toContain('NO PUEDEN COBRAR');
      // Y desde ese momento ya no se hereda.
      expect(await r.resolve(TENANT_B)).toBeNull();
    });

    it('si el valor cambia en marcha (cache caducado), el propio cambio se registra como error', async () => {
      const { r, estado } = instancia(1);
      await r.resolve(TENANT_B);
      expect(errorLog).not.toHaveBeenCalled();

      estado.aulas = 2;
      (r as unknown as { flagCache: { expiresAt: number } }).flagCache.expiresAt = 0;
      expect(await r.resolve(TENANT_B)).toBeNull();

      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(String(errorLog.mock.calls[0]![0])).toContain('HA DEJADO de heredarse');
    });

    it('con la decisión explícita del operador no hay nada que avisar', async () => {
      const store: GlobalFallbackPolicyStore = {
        instanceSetting: { findUnique: async () => null },
        tenant: { count: async () => 5 },
      };
      const r = new TenantStripeResolverService(
        makeTenantConfig() as never,
        buildGlobalFallbackFlagReader(store, { STRIPE_ALLOW_GLOBAL_FALLBACK: 'true' }),
      );

      await r.reportGlobalFallback('startup');

      expect(errorLog).not.toHaveBeenCalled();
      expect(warnLog).not.toHaveBeenCalled();
    });

    it('sin cuenta de instancia no hay nada que heredar ni que avisar', async () => {
      delete process.env['STRIPE_SECRET_KEY'];
      const { r } = instancia(3);

      await r.reportGlobalFallback('startup');

      expect(errorLog).not.toHaveBeenCalled();
      expect(warnLog).not.toHaveBeenCalled();
    });

    it('describeGlobalFallback: lo que necesita el panel de pagos', async () => {
      expect(await instancia(2).r.describeGlobalFallback()).toEqual({
        allowed: false,
        reason: 'multiple-tenants',
        tenants: 2,
        instanceCredentials: true,
      });
      delete process.env['STRIPE_SECRET_KEY'];
      expect((await instancia(2).r.describeGlobalFallback()).instanceCredentials).toBe(false);
    });
  });
});
