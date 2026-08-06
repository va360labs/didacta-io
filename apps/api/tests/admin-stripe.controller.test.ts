import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { AdminStripeController } from '../src/admin/admin-stripe.controller';
import { TenantStripeResolverService } from '../src/modules/tenant-stripe-resolver.service';

const TENANT_A = 'tenant-a';
const ADMIN_USER = {
  sub: 'user-1',
  tenantId: TENANT_A,
  roles: ['tenant_admin'],
};
const NON_ADMIN = { sub: 'user-2', tenantId: TENANT_A, roles: ['student'] };

const VALID_BODY = {
  secretKey: 'sk_test_abc123',
  webhookSecret: 'whsec_abc123',
};

/**
 * Stub del TenantConfigService usado por el controller vía
 * ModuleContextFactory — mismo patrón que admin-smtp.controller.test.ts.
 */
function makeConfigStub() {
  const store = new Map<string, { value: unknown; isSecret: boolean }>();
  const key = (t: string, m: string, k: string) => `${t}|${m}|${k}`;
  return {
    store,
    async get(t: string, m: string, k: string) {
      return store.get(key(t, m, k))?.value;
    },
    async set(t: string, m: string, k: string, v: unknown, opts?: { isSecret?: boolean }) {
      store.set(key(t, m, k), { value: v, isSecret: opts?.isSecret ?? false });
    },
  };
}

function makeFactoryStub(configStub: ReturnType<typeof makeConfigStub>) {
  return { getTenantConfig: () => configStub };
}

describe('AdminStripeController', () => {
  let configStub: ReturnType<typeof makeConfigStub>;
  let factory: ReturnType<typeof makeFactoryStub>;
  let resolver: TenantStripeResolverService;
  let controller: AdminStripeController;

  const SAVED_ENV: Record<string, string | undefined> = {};
  const ENV_KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SUBSCRIPTIONS_WEBHOOK_SECRET'];

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      SAVED_ENV[k] = process.env[k];
      delete process.env[k];
    }
    configStub = makeConfigStub();
    factory = makeFactoryStub(configStub);
    resolver = new TenantStripeResolverService(configStub as never);
    controller = new AdminStripeController(factory as never, resolver);
  });

  describe('autorización', () => {
    it('GET sin usuario → 401', async () => {
      await expect(controller.getCurrent(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('GET con rol no admin → 403', async () => {
      await expect(controller.getCurrent(NON_ADMIN as never)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('PUT con rol no admin → 403', async () => {
      await expect(controller.upsert(NON_ADMIN as never, VALID_BODY)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('GET — estado inicial', () => {
    it('devuelve DTO vacío con flags en false cuando no hay nada', async () => {
      const dto = await controller.getCurrent(ADMIN_USER as never);
      expect(dto).toEqual({
        hasSecretKey: false,
        hasWebhookSecret: false,
        hasSubscriptionsWebhookSecret: false,
        mode: null,
        verifiedAt: null,
        verifiedByUserId: null,
        hasTenantConfig: false,
        hasGlobalFallback: false,
      });
    });

    it('hasGlobalFallback=true cuando hay envs globales pero el tenant no configuró nada', async () => {
      process.env['STRIPE_SECRET_KEY'] = 'sk_test_global';
      process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_global';
      const dto = await controller.getCurrent(ADMIN_USER as never);
      expect(dto.hasTenantConfig).toBe(false);
      expect(dto.hasGlobalFallback).toBe(true);
    });
  });

  describe('PUT — upsert', () => {
    it('guarda credenciales, deriva mode=test, resetea verifiedAt', async () => {
      const dto = await controller.upsert(ADMIN_USER as never, VALID_BODY);
      expect(dto.hasSecretKey).toBe(true);
      expect(dto.hasWebhookSecret).toBe(true);
      expect(dto.mode).toBe('test');
      expect(dto.verifiedAt).toBeNull();
      expect(dto.hasTenantConfig).toBe(true);

      const stored = configStub.store.get(`${TENANT_A}|billing|stripe`);
      expect(stored?.isSecret).toBe(true);
    });

    it('deriva mode=live de una clave sk_live_', async () => {
      const dto = await controller.upsert(ADMIN_USER as never, {
        secretKey: 'sk_live_abc123',
        webhookSecret: 'whsec_abc123',
      });
      expect(dto.mode).toBe('live');
    });

    it('merge-on-omit: campo vacío conserva el valor guardado', async () => {
      await controller.upsert(ADMIN_USER as never, VALID_BODY);
      const dto = await controller.upsert(ADMIN_USER as never, {
        secretKey: 'sk_test_rotated',
        webhookSecret: undefined,
      });
      expect(dto.hasWebhookSecret).toBe(true);

      const stored = configStub.store.get(`${TENANT_A}|billing|stripe`);
      expect((stored?.value as { webhookSecret: string }).webhookSecret).toBe('whsec_abc123');
      expect((stored?.value as { secretKey: string }).secretKey).toBe('sk_test_rotated');
    });

    it('sin secretKey ni previo guardado → 400', async () => {
      await expect(
        controller.upsert(ADMIN_USER as never, { webhookSecret: 'whsec_abc123' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sin webhookSecret ni previo guardado → 400', async () => {
      await expect(
        controller.upsert(ADMIN_USER as never, { secretKey: 'sk_test_abc123' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cambiar cualquier campo resetea verifiedAt', async () => {
      await controller.upsert(ADMIN_USER as never, VALID_BODY);
      const meta = configStub.store.get(`${TENANT_A}|billing|stripe_meta`);
      expect((meta?.value as { verifiedAt: string | null }).verifiedAt).toBeNull();
    });
  });

  describe('POST /test — sin config', () => {
    it('400 si el tenant no tiene credenciales guardadas', async () => {
      await expect(controller.test(ADMIN_USER as never)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
    // La llamada real a la API de Stripe (balance.retrieve) se verifica en
    // vivo — mismo criterio que el resto de usos de `require('stripe')` en
    // este codebase (module-registry.service.ts, los webhook controllers):
    // no hay mock del SDK, la superficie unit-testeable es hasta la
    // resolución de credenciales.
  });
});
