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
}

function makeFakePrisma(users: UserRow[] = []) {
  const rows: NotificationRow[] = [];
  let next = 1;
  return {
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
          ...(args.data as NotificationRow),
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
      async findUnique(): Promise<null> {
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
      const [n] = prisma._rows;
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

      const [n] = prisma._rows;
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

      const [n] = prisma._rows;
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
      const [n] = prisma._rows;
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

      const [n] = prisma._rows;
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

      const [n] = prisma._rows;
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

      const [n] = prisma._rows;
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

      const [n] = prisma._rows;
      expect(n.sentAt).toBeInstanceOf(Date);
      expect(n.failedAt).toBeNull();
      expect(smtp.send).toHaveBeenCalledWith(
        VALID_SMTP,
        expect.objectContaining({
          to: 'alumno@x.com',
          subject: expect.stringContaining('Tu certificado'),
        }),
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

      const [n] = prisma._rows;
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

      const [n] = prisma._rows;
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
  });
});
