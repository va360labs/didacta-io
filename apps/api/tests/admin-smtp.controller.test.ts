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

/**
 * `actorLocale`:
 *   - string  → la fila del admin existe con ese `locale`.
 *   - null    → NO hay fila (admin borrado entre el login y el click).
 *   - 'throw' → la consulta revienta.
 * Los dos últimos son los caminos degradados de `resolveActorLocale`.
 */
function makePrismaStub(actorLocale: string | null | 'throw' = 'es-ES') {
  return {
    tenant: {
      findUnique: vi.fn().mockResolvedValue({ slug: 'demo', name: 'Demo' }),
    },
    user: {
      findUnique: vi.fn(() => {
        if (actorLocale === 'throw') return Promise.reject(new Error('db down'));
        if (actorLocale === null) return Promise.resolve(null);
        return Promise.resolve({ locale: actorLocale, tenantId: TENANT_A });
      }),
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

    it('el diagnóstico del MTA viaja también como campo `detail`, no solo dentro del texto', async () => {
      vi.spyOn(smtp, 'send').mockResolvedValue({ ok: false, error: 'auth failed' });
      await controller.upsert(ADMIN_USER as never, VALID_BODY);

      const err = await controller
        .test(ADMIN_USER as never, { toEmail: 'qa@test.com' })
        .catch((e: BadRequestException) => e);
      const body = (err as BadRequestException).getResponse() as Record<string, unknown>;
      expect(body['code']).toBe('ADMIN_SMTP_TEST_FAILED');
      expect(body['detail']).toBe('auth failed');
      // El `message` sigue igual: los clientes que solo leen esa frase no cambian.
      expect(body['message']).toBe('SMTP falló: auth failed');
    });

    it('CAMINO DEGRADADO: MTA sin texto de error → sin `detail` (no hay nada que traducir)', async () => {
      vi.spyOn(smtp, 'send').mockResolvedValue({ ok: false });
      await controller.upsert(ADMIN_USER as never, VALID_BODY);

      const err = await controller
        .test(ADMIN_USER as never, { toEmail: 'qa@test.com' })
        .catch((e: BadRequestException) => e);
      const body = (err as BadRequestException).getResponse() as Record<string, unknown>;
      expect(body).not.toHaveProperty('detail');
      expect(body['message']).toBe('SMTP falló: sin detalle');
    });
  });

  // ==========================================================================
  // Idioma del email de prueba. Sale en el idioma del ADMIN que lo dispara:
  // es él quien lo lee para comprobar que el SMTP funciona.
  // ==========================================================================
  describe('POST /test — idioma del email', () => {
    /** Monta un controller con el `locale` indicado en la fila del admin. */
    function withActorLocale(actorLocale: string | null | 'throw') {
      const stub = makePrismaStub(actorLocale);
      const ctrl = new AdminSmtpController(factory as never, stub as never, resolver);
      return ctrl;
    }

    async function sentMessage(ctrl: AdminSmtpController) {
      const send = vi.spyOn(smtp, 'send').mockResolvedValue({ ok: true, messageId: '<id>' });
      await ctrl.upsert(ADMIN_USER as never, VALID_BODY);
      await ctrl.test(ADMIN_USER as never, { toEmail: 'qa@test.com' });
      return send.mock.calls[0]![1] as { subject: string; text: string; html: string };
    }

    it('es-ES sale byte a byte como siempre', async () => {
      const msg = await sentMessage(withActorLocale('es-ES'));
      expect(msg.subject).toBe('Prueba de SMTP — Demo');
      expect(msg.text).toContain('Si recibiste este correo, la configuración SMTP de Demo');
      expect(msg.text).toContain('Tenant: demo');
      expect(msg.text).toContain('Prueba de SMTP');
    });

    it('en-US: asunto, título y cuerpo en inglés', async () => {
      const msg = await sentMessage(withActorLocale('en-US'));
      expect(msg.subject).toBe('SMTP test — Demo');
      expect(msg.text).toContain('If you received this email, the SMTP configuration for Demo');
      expect(msg.text).toContain('SMTP test');
      expect(msg.text).not.toContain('Prueba de SMTP');
      expect(msg.html).not.toContain('Prueba de SMTP');
    });

    it('CAMINO DEGRADADO: sin fila de admin, con locale en blanco o con la consulta rota → español', async () => {
      for (const actorLocale of [null, '   ', 'throw'] as const) {
        const msg = await sentMessage(withActorLocale(actorLocale));
        expect(msg.subject, String(actorLocale)).toBe('Prueba de SMTP — Demo');
        vi.restoreAllMocks();
      }
    });
  });
});
