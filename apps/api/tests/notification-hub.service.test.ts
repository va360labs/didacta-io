import { describe, expect, it, vi } from 'vitest';
import type { TenantConfigService } from '@didacta/core-kernel';
import { PrismaNotificationHubService } from '../src/modules/prisma-notification-hub.service';
import { NotificationRealtimePublisher } from '../src/modules/notifications/realtime/notification-realtime.publisher';
import { SmtpAdapterService, type SmtpConfig } from '../src/modules/smtp-adapter.service';

interface NotificationRow {
  id: string;
  tenantId: string;
  userId: string;
  channel: 'EMAIL' | 'IN_APP' | 'WEBHOOK';
  templateKey: string;
  subject: string | null;
  body: string;
  metadata: Record<string, unknown>;
  sentAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
}

interface UserRow {
  id: string;
  tenantId: string;
  email: string;
  /** Ausente a propósito en la mayoría de fixtures: es el camino degradado (b). */
  locale?: string;
}

interface PrefRow {
  tenantId: string;
  userId: string;
  category: 'COMMUNITY' | 'LEARNING' | 'ASSESSMENTS' | 'SYSTEM';
  channel: 'EMAIL' | 'IN_APP' | 'WEBHOOK';
  enabled: boolean;
}

function makeFakePrisma(users: UserRow[] = [], prefs: PrefRow[] = []) {
  const rows: NotificationRow[] = [];
  let next = 1;
  return {
    userNotificationPreference: {
      async findUnique(args: {
        where: {
          tenantId_userId_category_channel: {
            tenantId: string;
            userId: string;
            category: string;
            channel: string;
          };
        };
      }): Promise<{ enabled: boolean } | null> {
        const k = args.where.tenantId_userId_category_channel;
        const found = prefs.find(
          (p) =>
            p.tenantId === k.tenantId &&
            p.userId === k.userId &&
            p.category === k.category &&
            p.channel === k.channel,
        );
        return found ? { enabled: found.enabled } : null;
      },
    },
    notification: {
      async create(args: { data: Partial<NotificationRow> }) {
        const row: NotificationRow = {
          id: `n-${next++}`,
          tenantId: '',
          userId: '',
          channel: 'IN_APP',
          templateKey: '',
          subject: null,
          body: '',
          metadata: {},
          sentAt: null,
          failedAt: null,
          failureReason: null,
          createdAt: new Date('2026-06-03T10:00:00.000Z'),
          ...args.data,
        };
        rows.push(row);
        return row;
      },
      async update(args: { where: { id: string }; data: Partial<NotificationRow> }) {
        const found = rows.find((r) => r.id === args.where.id);
        if (!found) throw new Error('not found');
        Object.assign(found, args.data);
        return found;
      },
    },
    user: {
      async findUnique(args: {
        where: { id: string };
        select?: Record<string, boolean>;
      }): Promise<UserRow | null> {
        return users.find((u) => u.id === args.where.id) ?? null;
      },
    },
    notificationTemplate: {
      // Stub: el render usa este lookup para overrides per-tenant. En
      // estos tests no hay overrides — devolvemos null y dejamos que
      // caiga al template hardcoded del producto.
      async findUnique(_args: unknown): Promise<null> {
        return null;
      },
    },
    _rows: rows,
  };
}

const noopLogger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as never;

const VALID_SMTP: SmtpConfig = {
  host: 'smtp.brevo.com',
  port: 587,
  user: 'foo',
  password: 'p4ss',
  from: 'noreply@x.com',
};

function makeFakeTenantConfig(map: Record<string, unknown>): TenantConfigService {
  return {
    async get<T>(_tenantId: string, moduleName: string, key: string) {
      return map[`${moduleName}:${key}`] as T | undefined;
    },
    async set() {
      /* noop */
    },
  };
}

describe('PrismaNotificationHubService', () => {
  describe('canales legacy (sin tenantConfig/smtp)', () => {
    it('IN_APP: persiste con sentAt poblado al instante', async () => {
      const prisma = makeFakePrisma();
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger);

      await svc.send({
        tenantId: 't1',
        channel: 'in-app',
        templateKey: 'enrollment.created',
        locale: 'es-ES',
        to: 'u1',
        variables: { course: 'NodeJS Avanzado' },
      });

      expect(prisma._rows).toHaveLength(1);
      const n = prisma._rows[0]!;
      expect(n.channel).toBe('IN_APP');
      expect(n.sentAt).toBeInstanceOf(Date);
      expect(n.subject).toBe('Te matriculaste en NodeJS Avanzado');
    });

    it('EMAIL sin tenantConfig/smtp inyectados → failedAt + smtp_not_configured', async () => {
      const prisma = makeFakePrisma();
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger);

      await svc.send({
        tenantId: 't1',
        channel: 'email',
        templateKey: 'certificate.issued',
        locale: 'es-ES',
        to: 'u1',
        variables: { course: 'TS', number: 'LS-2026-000001' },
      });

      const n = prisma._rows[0]!;
      expect(n.sentAt).toBeNull();
      expect(n.failedAt).toBeInstanceOf(Date);
      expect(n.failureReason).toBe('smtp_not_configured');
    });

    it('WEBHOOK: failedAt con failureReason (no implementado)', async () => {
      const prisma = makeFakePrisma();
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger);

      await svc.send({
        tenantId: 't1',
        channel: 'webhook',
        templateKey: 'enrollment.created',
        locale: 'es-ES',
        to: 'https://hook.example.com',
        variables: { course: 'X' },
      });

      const n = prisma._rows[0]!;
      expect(n.failureReason).toBe('webhook_adapter_not_implemented');
    });

    it('templateKey desconocida → fallback con JSON.stringify', async () => {
      const prisma = makeFakePrisma();
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger);
      await svc.send({
        tenantId: 't1',
        channel: 'in-app',
        templateKey: 'inexistente.template',
        locale: 'es-ES',
        to: 'u1',
        variables: { foo: 'bar' },
      });
      const n = prisma._rows[0]!;
      expect(n.subject).toBe('inexistente.template');
      expect(n.body).toContain('"foo":"bar"');
    });
  });

  describe('EMAIL per-tenant (tenantConfig + smtp adapter)', () => {
    it('tenant SIN config SMTP → failedAt + smtp_not_configured (no rompe)', async () => {
      const prisma = makeFakePrisma([{ id: 'u1', tenantId: 't1', email: 'a@b.com' }]);
      const tenantConfig = makeFakeTenantConfig({}); // sin smtp
      const smtp = new SmtpAdapterService();
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger, tenantConfig, smtp);

      await svc.send({
        tenantId: 't1',
        channel: 'email',
        templateKey: 'enrollment.created',
        locale: 'es-ES',
        to: 'u1',
        variables: { course: 'A' },
      });

      const n = prisma._rows[0]!;
      expect(n.sentAt).toBeNull();
      expect(n.failedAt).toBeInstanceOf(Date);
      expect(n.failureReason).toBe('smtp_not_configured');
    });

    it('config SMTP inválida → failedAt con smtp_config_invalid', async () => {
      const prisma = makeFakePrisma([{ id: 'u1', tenantId: 't1', email: 'a@b.com' }]);
      const tenantConfig = makeFakeTenantConfig({
        'notifications:smtp': { host: 'x', port: 999999 }, // inválido
      });
      const svc = new PrismaNotificationHubService(
        prisma as never,
        noopLogger,
        tenantConfig,
        new SmtpAdapterService(),
      );

      await svc.send({
        tenantId: 't1',
        channel: 'email',
        templateKey: 'enrollment.created',
        locale: 'es-ES',
        to: 'u1',
        variables: { course: 'A' },
      });

      const n = prisma._rows[0]!;
      expect(n.failureReason?.startsWith('smtp_config_invalid:')).toBe(true);
    });

    it('user inexistente o de otro tenant → recipient_email_not_found', async () => {
      const prisma = makeFakePrisma([{ id: 'u1', tenantId: 'OTRO', email: 'a@b.com' }]);
      const tenantConfig = makeFakeTenantConfig({ 'notifications:smtp': VALID_SMTP });
      const svc = new PrismaNotificationHubService(
        prisma as never,
        noopLogger,
        tenantConfig,
        new SmtpAdapterService(),
      );

      await svc.send({
        tenantId: 't1',
        channel: 'email',
        templateKey: 'enrollment.created',
        locale: 'es-ES',
        to: 'u1',
        variables: { course: 'A' },
      });

      const n = prisma._rows[0]!;
      expect(n.failureReason).toBe('recipient_email_not_found');
    });

    it('config válida + user OK + adapter OK → sentAt rellenado', async () => {
      const prisma = makeFakePrisma([{ id: 'u1', tenantId: 't1', email: 'alumno@x.com' }]);
      const tenantConfig = makeFakeTenantConfig({ 'notifications:smtp': VALID_SMTP });
      const smtp = {
        parseConfig: (raw: unknown) => raw as SmtpConfig,
        isConfigValid: () => true,
        send: vi.fn(async () => ({ ok: true, messageId: '<id@x>' })),
        verify: vi.fn(),
      } as unknown as SmtpAdapterService;
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger, tenantConfig, smtp);

      await svc.send({
        tenantId: 't1',
        channel: 'email',
        templateKey: 'certificate.issued',
        locale: 'es-ES',
        to: 'u1',
        variables: { course: 'TS', number: 'LS-1' },
      });

      const n = prisma._rows[0]!;
      expect(n.sentAt).toBeInstanceOf(Date);
      expect(n.failedAt).toBeNull();
      expect(smtp.send).toHaveBeenCalledWith(
        VALID_SMTP,
        expect.objectContaining({
          to: 'alumno@x.com',
          subject: expect.stringContaining('Tu certificado'),
          // El cuerpo ahora va envuelto en la plantilla de marca (html + text).
          html: expect.stringContaining('Powered by Didacta'),
        }),
        // Tercer arg: fromName (nombre del tenant para el header From).
        expect.any(String),
      );
    });

    it('adapter falla → failedAt con smtp_send_failed:<msg>', async () => {
      const prisma = makeFakePrisma([{ id: 'u1', tenantId: 't1', email: 'a@b.com' }]);
      const tenantConfig = makeFakeTenantConfig({ 'notifications:smtp': VALID_SMTP });
      const smtp = {
        parseConfig: (raw: unknown) => raw as SmtpConfig,
        isConfigValid: () => true,
        send: vi.fn(async () => ({ ok: false, error: 'connection refused' })),
        verify: vi.fn(),
      } as unknown as SmtpAdapterService;
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger, tenantConfig, smtp);

      await svc.send({
        tenantId: 't1',
        channel: 'email',
        templateKey: 'enrollment.created',
        locale: 'es-ES',
        to: 'u1',
        variables: { course: 'A' },
      });

      const n = prisma._rows[0]!;
      expect(n.sentAt).toBeNull();
      expect(n.failureReason).toContain('smtp_send_failed');
      expect(n.failureReason).toContain('connection refused');
    });
  });

  describe('realtime publisher (alpha.79)', () => {
    it('IN_APP llama publishInApp 1x con id=created.id', async () => {
      const prisma = makeFakePrisma();
      const realtime = {
        publishInApp: vi.fn(async () => {}),
      } as unknown as NotificationRealtimePublisher;
      const svc = new PrismaNotificationHubService(
        prisma as never,
        noopLogger,
        undefined,
        undefined,
        undefined,
        realtime,
      );

      await svc.send({
        tenantId: 't1',
        channel: 'in-app',
        templateKey: 'enrollment.created',
        locale: 'es-ES',
        to: 'u1',
        variables: { course: 'NodeJS' },
      });

      const n = prisma._rows[0]!;
      expect(realtime.publishInApp).toHaveBeenCalledTimes(1);
      expect(realtime.publishInApp).toHaveBeenCalledWith(
        't1',
        'u1',
        expect.objectContaining({
          id: n.id,
          templateKey: 'enrollment.created',
          subject: 'Te matriculaste en NodeJS',
          createdAt: n.createdAt,
        }),
      );
    });

    it('EMAIL NO llama publishInApp', async () => {
      const prisma = makeFakePrisma([{ id: 'u1', tenantId: 't1', email: 'a@b.com' }]);
      const tenantConfig = makeFakeTenantConfig({}); // sin smtp → falla pero no realtime
      const realtime = {
        publishInApp: vi.fn(async () => {}),
      } as unknown as NotificationRealtimePublisher;
      const svc = new PrismaNotificationHubService(
        prisma as never,
        noopLogger,
        tenantConfig,
        new SmtpAdapterService(),
        undefined,
        realtime,
      );

      await svc.send({
        tenantId: 't1',
        channel: 'email',
        templateKey: 'certificate.issued',
        locale: 'es-ES',
        to: 'u1',
        variables: { course: 'TS', number: 'LS-1' },
      });

      expect(realtime.publishInApp).not.toHaveBeenCalled();
    });

    it('IN_APP sin publisher inyectado no rompe (best-effort)', async () => {
      const prisma = makeFakePrisma();
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger);

      await expect(
        svc.send({
          tenantId: 't1',
          channel: 'in-app',
          templateKey: 'enrollment.created',
          locale: 'es-ES',
          to: 'u1',
          variables: { course: 'X' },
        }),
      ).resolves.toBeUndefined();
      expect(prisma._rows).toHaveLength(1);
    });

    it('IN_APP publica metadata (variables) en el evento realtime', async () => {
      const prisma = makeFakePrisma();
      const realtime = {
        publishInApp: vi.fn(async () => {}),
      } as unknown as NotificationRealtimePublisher;
      const svc = new PrismaNotificationHubService(
        prisma as never,
        noopLogger,
        undefined,
        undefined,
        undefined,
        realtime,
      );

      await svc.send({
        tenantId: 't1',
        channel: 'in-app',
        templateKey: 'community.comment.on_post',
        locale: 'es-ES',
        to: 'u1',
        variables: { postId: 'p1', commentId: 'c1', actorName: 'Ana' },
      });

      expect(realtime.publishInApp).toHaveBeenCalledWith(
        't1',
        'u1',
        expect.objectContaining({
          metadata: { postId: 'p1', commentId: 'c1', actorName: 'Ana' },
        }),
      );
    });
  });

  describe('preferencias por usuario (category)', () => {
    it('sin category → envío incondicional (comportamiento legacy)', async () => {
      const prisma = makeFakePrisma(
        [],
        [
          {
            tenantId: 't1',
            userId: 'u1',
            category: 'COMMUNITY',
            channel: 'IN_APP',
            enabled: false,
          },
        ],
      );
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger);

      // Sin category, la preferencia deshabilitada se ignora.
      await svc.send({
        tenantId: 't1',
        channel: 'in-app',
        templateKey: 'community.mention',
        locale: 'es-ES',
        to: 'u1',
        variables: {},
      });

      expect(prisma._rows).toHaveLength(1);
    });

    it('IN_APP con la preferencia deshabilitada → no persiste ni publica', async () => {
      const prisma = makeFakePrisma(
        [],
        [
          {
            tenantId: 't1',
            userId: 'u1',
            category: 'COMMUNITY',
            channel: 'IN_APP',
            enabled: false,
          },
        ],
      );
      const realtime = {
        publishInApp: vi.fn(async () => {}),
      } as unknown as NotificationRealtimePublisher;
      const svc = new PrismaNotificationHubService(
        prisma as never,
        noopLogger,
        undefined,
        undefined,
        undefined,
        realtime,
      );

      await svc.send({
        tenantId: 't1',
        channel: 'in-app',
        templateKey: 'community.comment.on_post',
        locale: 'es-ES',
        to: 'u1',
        variables: { postId: 'p1' },
        category: 'COMMUNITY',
      });

      expect(prisma._rows).toHaveLength(0);
      expect(realtime.publishInApp).not.toHaveBeenCalled();
    });

    it('sin fila de preferencia → default activado → persiste', async () => {
      const prisma = makeFakePrisma();
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger);

      await svc.send({
        tenantId: 't1',
        channel: 'in-app',
        templateKey: 'community.comment.on_post',
        locale: 'es-ES',
        to: 'u1',
        variables: { postId: 'p1' },
        category: 'COMMUNITY',
      });

      expect(prisma._rows).toHaveLength(1);
    });

    it('EMAIL con la preferencia deshabilitada → no persiste ni intenta enviar', async () => {
      const prisma = makeFakePrisma(
        [{ id: 'u1', tenantId: 't1', email: 'a@b.com' }],
        [{ tenantId: 't1', userId: 'u1', category: 'COMMUNITY', channel: 'EMAIL', enabled: false }],
      );
      const smtp = {
        parseConfig: (raw: unknown) => raw as SmtpConfig,
        send: vi.fn(async () => ({ ok: true, messageId: '<x>' })),
        verify: vi.fn(),
      } as unknown as SmtpAdapterService;
      const tenantConfig = makeFakeTenantConfig({ 'notifications:smtp': VALID_SMTP });
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger, tenantConfig, smtp);

      await svc.send({
        tenantId: 't1',
        channel: 'email',
        templateKey: 'community.comment.on_post',
        locale: 'es-ES',
        to: 'u1',
        variables: { postId: 'p1' },
        category: 'COMMUNITY',
      });

      expect(prisma._rows).toHaveLength(0);
      expect(smtp.send).not.toHaveBeenCalled();
    });

    it('otra categoría deshabilitada no afecta a COMMUNITY', async () => {
      const prisma = makeFakePrisma(
        [],
        [{ tenantId: 't1', userId: 'u1', category: 'LEARNING', channel: 'IN_APP', enabled: false }],
      );
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger);

      await svc.send({
        tenantId: 't1',
        channel: 'in-app',
        templateKey: 'community.comment.on_post',
        locale: 'es-ES',
        to: 'u1',
        variables: {},
        category: 'COMMUNITY',
      });

      expect(prisma._rows).toHaveLength(1);
    });
  });

  describe('render de plantillas (secciones condicionales tipo Mustache)', () => {
    it('community.mention: {{#commentId}}…{{/commentId}} rinde sin dejar marcadores', async () => {
      const prisma = makeFakePrisma();
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger);
      await svc.send({
        tenantId: 't1',
        channel: 'in-app',
        templateKey: 'community.mention',
        locale: 'es-ES',
        to: 'u1',
        variables: { authorName: 'AutorEjemplo', commentId: 'c1', postId: null, handle: 'ana' },
      });
      const n = prisma._rows[0]!;
      expect(n.body).toContain('AutorEjemplo te mencionó en un comentario');
      expect(n.body).not.toContain('{{');
    });

    it('community.mention: sección de post cuando la mención es en un post', async () => {
      const prisma = makeFakePrisma();
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger);
      await svc.send({
        tenantId: 't1',
        channel: 'in-app',
        templateKey: 'community.mention',
        locale: 'es-ES',
        to: 'u1',
        variables: { authorName: 'Ana', commentId: null, postId: 'p1', handle: 'ana' },
      });
      const n = prisma._rows[0]!;
      expect(n.body).toContain('Ana te mencionó en un post');
      expect(n.body).not.toContain('comentario');
      expect(n.body).not.toContain('{{');
    });
  });

  // ==========================================================================
  // i18n: `locale` es OPCIONAL. Sin él, el hub resuelve `user.locale` a partir
  // de `to`. Los tres caminos degradados aterrizan en es-ES a propósito; si
  // alguno dejara de hacerlo en silencio, estos tests lo cazan.
  // ==========================================================================
  describe('resolución del idioma del destinatario (locale opcional)', () => {
    const EN_ENROLLMENT = 'You have just enrolled in the course';
    const ES_ENROLLMENT = 'Acabas de matricularte en el curso';

    async function sendWithoutLocale(users: UserRow[]) {
      const prisma = makeFakePrisma(users);
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger);
      await svc.send({
        tenantId: 't1',
        channel: 'in-app',
        templateKey: 'enrollment.created',
        to: 'u1',
        variables: { course: 'NodeJS' },
      });
      return prisma._rows[0];
    }

    it('camino feliz: el usuario en en-US recibe la notificación en inglés', async () => {
      const n = await sendWithoutLocale([
        { id: 'u1', tenantId: 't1', email: 'a@example.com', locale: 'en-US' },
      ]);
      expect(n!.subject).toBe('You enrolled in NodeJS');
      expect(n!.body).toContain(EN_ENROLLMENT);
    });

    it('el usuario en es-ES sigue recibiendo el copy español', async () => {
      const n = await sendWithoutLocale([
        { id: 'u1', tenantId: 't1', email: 'a@example.com', locale: 'es-ES' },
      ]);
      expect(n!.body).toContain(ES_ENROLLMENT);
    });

    it('degradado (a): destinatario inexistente → es-ES, sin romper el envío', async () => {
      const n = await sendWithoutLocale([]);
      expect(n!.body).toContain(ES_ENROLLMENT);
    });

    it('degradado (a): destinatario de otro tenant → es-ES', async () => {
      const n = await sendWithoutLocale([
        { id: 'u1', tenantId: 'OTRO', email: 'a@example.com', locale: 'en-US' },
      ]);
      expect(n!.body).toContain(ES_ENROLLMENT);
    });

    it('degradado (a): si el lookup lanza, el envío continúa en es-ES', async () => {
      const prisma = makeFakePrisma();
      prisma.user.findUnique = () => Promise.reject(new Error('db down'));
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger);
      await expect(
        svc.send({
          tenantId: 't1',
          channel: 'in-app',
          templateKey: 'enrollment.created',
          to: 'u1',
          variables: { course: 'NodeJS' },
        }),
      ).resolves.toBeUndefined();
      expect(prisma._rows[0]!.body).toContain(ES_ENROLLMENT);
    });

    it('degradado (b): usuario con locale vacío o en blanco → es-ES', async () => {
      for (const locale of ['', '   ']) {
        const n = await sendWithoutLocale([
          { id: 'u1', tenantId: 't1', email: 'a@example.com', locale },
        ]);
        expect(n!.body, `locale=${JSON.stringify(locale)}`).toContain(ES_ENROLLMENT);
      }
    });

    it('degradado (c): locale sin catálogo (pt-BR) → copy español', async () => {
      const n = await sendWithoutLocale([
        { id: 'u1', tenantId: 't1', email: 'a@example.com', locale: 'pt-BR' },
      ]);
      expect(n!.body).toContain(ES_ENROLLMENT);
      expect(n!.body).not.toContain('{{');
    });

    it('el locale explícito del caller manda sobre el del usuario', async () => {
      const prisma = makeFakePrisma([
        { id: 'u1', tenantId: 't1', email: 'a@example.com', locale: 'en-US' },
      ]);
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger);
      await svc.send({
        tenantId: 't1',
        channel: 'in-app',
        templateKey: 'enrollment.created',
        locale: 'es-ES',
        to: 'u1',
        variables: { course: 'NodeJS' },
      });
      expect(prisma._rows[0]!.body).toContain(ES_ENROLLMENT);
    });

    it('con locale explícito NO consulta al usuario (sin query de más)', async () => {
      const prisma = makeFakePrisma([{ id: 'u1', tenantId: 't1', email: 'a@example.com' }]);
      const spy = vi.fn(prisma.user.findUnique);
      prisma.user.findUnique = spy;
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger);
      await svc.send({
        tenantId: 't1',
        channel: 'in-app',
        templateKey: 'enrollment.created',
        locale: 'es-ES',
        to: 'u1',
        variables: { course: 'NodeJS' },
      });
      expect(spy).not.toHaveBeenCalled();
    });

    it('el override per-tenant del locale del usuario gana al default traducido', async () => {
      const prisma = makeFakePrisma([
        { id: 'u1', tenantId: 't1', email: 'a@example.com', locale: 'en-US' },
      ]);
      const seen: string[] = [];
      prisma.notificationTemplate.findUnique = (args: unknown) => {
        const locale = (args as { where: { tenantId_key_channel_locale: { locale: string } } })
          .where.tenantId_key_channel_locale.locale;
        seen.push(locale);
        return Promise.resolve(
          locale === 'en-US' ? { subject: 'Custom {{course}}', body: 'Custom body' } : null,
        ) as never;
      };
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger);
      await svc.send({
        tenantId: 't1',
        channel: 'in-app',
        templateKey: 'enrollment.created',
        to: 'u1',
        variables: { course: 'NodeJS' },
      });
      expect(seen).toEqual(['en-US']);
      expect(prisma._rows[0]!.subject).toBe('Custom NodeJS');
    });
  });
});
