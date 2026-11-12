import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminSmtpController, SenderUpsertSchema } from '../src/admin/admin-smtp.controller';
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
    // Dirección del aula del tenant: aquí solo cuelga el logo del email de prueba.
    getTenantWebBaseUrl: async () => 'https://aula.example.test',
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
        encryption: null,
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

    it('persiste `encryption` y lo devuelve en el DTO', async () => {
      const dto = await controller.upsert(ADMIN_USER as never, {
        ...VALID_BODY,
        encryption: 'starttls' as const,
      });
      expect(dto.encryption).toBe('starttls');

      const stored = configStub.store.get(`${TENANT_A}|notifications|smtp`);
      expect((stored?.value as { encryption?: string }).encryption).toBe('starttls');
    });

    it('si viajan encryption y el `secure` legado, gana encryption y secure no se persiste', async () => {
      await controller.upsert(ADMIN_USER as never, {
        ...VALID_BODY,
        encryption: 'starttls' as const,
        secure: true,
      });
      const stored = configStub.store.get(`${TENANT_A}|notifications|smtp`);
      expect((stored?.value as { encryption?: string }).encryption).toBe('starttls');
      expect(stored?.value).not.toHaveProperty('secure');
    });

    it('config legada sin encryption → el GET deriva el modo (secure:true → tls; sin boolean, por puerto)', async () => {
      // Guardado por un cliente viejo: solo el boolean.
      await controller.upsert(ADMIN_USER as never, { ...VALID_BODY, secure: true });
      expect((await controller.getCurrent(ADMIN_USER as never)).encryption).toBe('tls');

      // Sin boolean ni encryption: puerto 587 → starttls.
      await controller.upsert(ADMIN_USER as never, VALID_BODY);
      expect((await controller.getCurrent(ADMIN_USER as never)).encryption).toBe('starttls');
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

  describe('«Correo para respuestas» (GET/PUT sender)', () => {
    const ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const;
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      for (const k of ENV) saved[k] = process.env[k];
      process.env['SMTP_HOST'] = 'email-smtp.eu-west-1.amazonaws.com';
      process.env['SMTP_PORT'] = '587';
      process.env['SMTP_USER'] = 'u';
      process.env['SMTP_PASS'] = 'p';
      process.env['SMTP_FROM'] = 'Didacta <hola@didacta.io>';
      resolver = new TenantSmtpResolverService(configStub as never, smtp, {
        primaryAdminEmail: async () => 'creador@nandu.es',
      });
      controller = new AdminSmtpController(factory as never, prisma as never, resolver);
      return () => {
        for (const k of ENV) {
          if (saved[k] === undefined) delete process.env[k];
          else process.env[k] = saved[k];
        }
      };
    });

    it('sin rol admin → 403 (leer y escribir)', async () => {
      await expect(controller.getSender(NON_ADMIN as never)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        controller.upsertSender(NON_ADMIN as never, { replyToEmail: 'a@b.es' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('sin configurar: las respuestas van al administrador principal', async () => {
      expect(await controller.getSender(ADMIN_USER as never)).toEqual({
        replyToEmail: null,
        effectiveReplyTo: 'creador@nandu.es',
        usesOwnSmtp: false,
      });
    });

    it('al guardarlo, el Reply-To efectivo pasa a ser ese; al quitarlo, vuelve al administrador', async () => {
      const dto = await controller.upsertSender(ADMIN_USER as never, {
        replyToEmail: 'contacto@nandu.es',
      });
      expect(dto).toEqual({
        replyToEmail: 'contacto@nandu.es',
        effectiveReplyTo: 'contacto@nandu.es',
        usesOwnSmtp: false,
      });
      // Y se guarda como ajuste NO secreto, en su propia fila.
      expect(configStub.store.get(`${TENANT_A}|notifications|sender`)).toEqual({
        value: { replyToEmail: 'contacto@nandu.es' },
        isSecret: false,
      });
      const cleared = await controller.upsertSender(ADMIN_USER as never, { replyToEmail: null });
      expect(cleared.effectiveReplyTo).toBe('creador@nandu.es');
    });

    it('sin SMTP compartido todavía, enseña igualmente adónde irán (al administrador)', async () => {
      delete process.env['SMTP_HOST'];
      expect((await controller.getSender(ADMIN_USER as never)).effectiveReplyTo).toBe(
        'creador@nandu.es',
      );
    });

    it('con SMTP propio, las respuestas van a su dirección de envío', async () => {
      await controller.upsert(ADMIN_USER as never, VALID_BODY);
      expect(await controller.getSender(ADMIN_USER as never)).toEqual({
        replyToEmail: null,
        effectiveReplyTo: VALID_BODY.fromEmail,
        usesOwnSmtp: true,
      });
    });

    it('el schema acepta vacío como «quitar» y rechaza listas e inyección', () => {
      expect(SenderUpsertSchema.parse({ replyToEmail: '' })).toEqual({ replyToEmail: null });
      expect(SenderUpsertSchema.parse({ replyToEmail: ' a@b.es ' })).toEqual({
        replyToEmail: 'a@b.es',
      });
      expect(SenderUpsertSchema.safeParse({ replyToEmail: 'a@b.es,c@d.es' }).success).toBe(false);
      expect(
        SenderUpsertSchema.safeParse({
          replyToEmail: 'a@b.es' + String.fromCharCode(13, 10) + 'Bcc: c@d.es',
        }).success,
      ).toBe(false);
      expect(SenderUpsertSchema.safeParse({ replyToEmail: 'no-es-correo' }).success).toBe(false);
    });
  });
});
