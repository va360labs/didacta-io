import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminSmtpController } from '../src/admin/admin-smtp.controller';
import { SmtpAdapterService } from '../src/modules/smtp-adapter.service';
import { TenantSmtpResolverService } from '../src/modules/tenant-smtp-resolver.service';

const TENANT_A = 'tenant-a';
const ADMIN_USER = {
  sub: 'user-1',
  tenantId: TENANT_A,
  roles: ['tenant_admin'],
};
const NON_ADMIN = { sub: 'user-2', tenantId: TENANT_A, roles: ['student'] };

const VALID_BODY = {
  host: 'smtp.example.com',
  port: 587,
  username: 'user-x',
  password: 'pass-x',
  fromEmail: 'noreply@example.com',
  fromName: 'Didacta Test',
};

/**
 * Stub del TenantConfigService usado por el controller via ModuleContextFactory.
 * Guarda los settings en un Map plano (sin cifrado real — el controller solo
 * habla con el contrato get/set).
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

function makeFactoryStub(args: {
  configStub: ReturnType<typeof makeConfigStub>;
  smtp: SmtpAdapterService;
}) {
  return {
    getTenantConfig: () => args.configStub,
    getSmtpAdapter: () => args.smtp,
    getSmtpResolver: () => undefined, // no se usa en estos tests
  };
}

function makePrismaStub() {
  return {
    tenant: {
      findUnique: vi.fn().mockResolvedValue({ slug: 'va360', name: 'VA360' }),
    },
  };
}

describe('AdminSmtpController', () => {
  let configStub: ReturnType<typeof makeConfigStub>;
  let smtp: SmtpAdapterService;
  let factory: ReturnType<typeof makeFactoryStub>;
  let prisma: ReturnType<typeof makePrismaStub>;
  let resolver: TenantSmtpResolverService;
  let controller: AdminSmtpController;

  beforeEach(() => {
    configStub = makeConfigStub();
    smtp = new SmtpAdapterService();
    factory = makeFactoryStub({ configStub, smtp });
    prisma = makePrismaStub();
    resolver = new TenantSmtpResolverService(configStub as never, smtp);
    controller = new AdminSmtpController(factory as never, prisma as never, resolver);
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

  describe('GET — config inicial', () => {
    it('devuelve DTO vacío con flags en false cuando no hay nada', async () => {
      const dto = await controller.getCurrent(ADMIN_USER as never);
      expect(dto).toEqual({
        host: null,
        port: null,
        secure: null,
        username: null,
        hasPassword: false,
        fromEmail: null,
        fromName: null,
        verifiedAt: null,
        verifiedByUserId: null,
        hasTenantConfig: false,
        hasGlobalFallback: false,
      });
    });
  });

  describe('PUT — upsert', () => {
    it('guarda config, hashea password en flag, resetea verifiedAt', async () => {
      const dto = await controller.upsert(ADMIN_USER as never, VALID_BODY);
      expect(dto.host).toBe('smtp.example.com');
      expect(dto.port).toBe(587);
      expect(dto.username).toBe('user-x');
      expect(dto.hasPassword).toBe(true);
      expect(dto.fromEmail).toBe('noreply@example.com');
      expect(dto.fromName).toBe('Didacta Test');
      expect(dto.verifiedAt).toBeNull();
      expect(dto.hasTenantConfig).toBe(true);

      // Verifica que el secret se persistió cifrado-logically (isSecret=true).
      const stored = configStub.store.get(`${TENANT_A}|notifications|smtp`);
      expect(stored?.isSecret).toBe(true);
    });

    it('si password vacío y hay previo → conserva el previo', async () => {
      await controller.upsert(ADMIN_USER as never, VALID_BODY);
      const dto = await controller.upsert(ADMIN_USER as never, {
        ...VALID_BODY,
        password: undefined,
        host: 'smtp.updated.com',
      });
      expect(dto.host).toBe('smtp.updated.com');
      expect(dto.hasPassword).toBe(true);

      // Verifica que el password efectivo persistido es el anterior.
      const stored = configStub.store.get(`${TENANT_A}|notifications|smtp`);
      expect((stored?.value as { password: string }).password).toBe('pass-x');
    });

    it('si password vacío y NO hay previo → 400', async () => {
      await expect(
        controller.upsert(ADMIN_USER as never, { ...VALID_BODY, password: undefined }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('POST /test — smoke test', () => {
    it('400 si tenant no tiene config', async () => {
      await expect(
        controller.test(ADMIN_USER as never, { toEmail: 'me@test.com' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('marca verifiedAt cuando el envío tiene éxito', async () => {
      // Mockea el send del adapter para no contactar un MTA real.
      vi.spyOn(smtp, 'send').mockResolvedValue({ ok: true, messageId: '<test@id>' });

      await controller.upsert(ADMIN_USER as never, VALID_BODY);
      const result = await controller.test(ADMIN_USER as never, { toEmail: 'qa@test.com' });

      expect(result.ok).toBe(true);
      expect(result.sentTo).toBe('qa@test.com');
      expect(result.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // El subsiguiente GET ya debe reflejar verifiedAt.
      const dto = await controller.getCurrent(ADMIN_USER as never);
      expect(dto.verifiedAt).toBe(result.verifiedAt);
      expect(dto.verifiedByUserId).toBe('user-1');
    });

    it('400 con error real cuando el MTA rechaza', async () => {
      vi.spyOn(smtp, 'send').mockResolvedValue({ ok: false, error: 'auth failed' });

      await controller.upsert(ADMIN_USER as never, VALID_BODY);
      await expect(
        controller.test(ADMIN_USER as never, { toEmail: 'qa@test.com' }),
      ).rejects.toThrow(/auth failed/);

      // verifiedAt sigue null tras fallo.
      const dto = await controller.getCurrent(ADMIN_USER as never);
      expect(dto.verifiedAt).toBeNull();
    });
  });
});
