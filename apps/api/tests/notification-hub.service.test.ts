import { describe, expect, it, vi } from 'vitest';
import { PrismaNotificationHubService } from '../src/modules/prisma-notification-hub.service';

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
}

function makeFakePrisma() {
  const rows: NotificationRow[] = [];
  let next = 1;
  return {
    notification: {
      async create(args: { data: Partial<NotificationRow> }) {
        // Defaultear los nullable a null como hace Prisma real, así los tests
        // pueden hacer assertions con toBeNull().
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
    _rows: rows,
  };
}

const noopLogger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as never;

describe('PrismaNotificationHubService', () => {
  it('IN_APP: persiste con sentAt poblado al instante (entregar = persistir)', async () => {
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
    expect(n.userId).toBe('u1');
    expect(n.sentAt).toBeInstanceOf(Date);
    expect(n.subject).toBe('Te matriculaste en NodeJS Avanzado');
    expect(n.body).toContain('NodeJS Avanzado');
  });

  it('EMAIL: persiste con sentAt rellenado tras log (stub adapter)', async () => {
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
    expect(n.channel).toBe('EMAIL');
    expect(n.sentAt).toBeInstanceOf(Date);
    expect(n.failedAt).toBeNull();
    expect(n.body).toContain('LS-2026-000001');
  });

  it('WEBHOOK: queda failedAt con failureReason porque no hay adapter', async () => {
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
    expect(n.channel).toBe('WEBHOOK');
    expect(n.sentAt).toBeNull();
    expect(n.failedAt).toBeInstanceOf(Date);
    expect(n.failureReason).toBe('webhook_adapter_not_implemented');
  });

  it('templateKey desconocida: render fallback con JSON.stringify de variables', async () => {
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

  it('interpolación: variables ausentes se reemplazan por cadena vacía sin romper', async () => {
    const prisma = makeFakePrisma();
    const svc = new PrismaNotificationHubService(prisma as never, noopLogger);

    await svc.send({
      tenantId: 't1',
      channel: 'in-app',
      templateKey: 'attempt.passed',
      locale: 'es-ES',
      to: 'u1',
      variables: { quiz: 'Quiz Final' }, // falta scorePercent
    });

    const n = prisma._rows[0]!;
    expect(n.body).toContain('Quiz Final');
    expect(n.body).toContain('%'); // template tiene "{{scorePercent}}%" → "%"
  });

  it('mapping de canal: in-app ↔ IN_APP, email ↔ EMAIL, webhook ↔ WEBHOOK', async () => {
    const prisma = makeFakePrisma();
    const svc = new PrismaNotificationHubService(prisma as never, noopLogger);

    await svc.send({
      tenantId: 't1',
      channel: 'in-app',
      templateKey: 'enrollment.created',
      locale: 'es-ES',
      to: 'u1',
      variables: { course: 'A' },
    });
    await svc.send({
      tenantId: 't1',
      channel: 'email',
      templateKey: 'enrollment.created',
      locale: 'es-ES',
      to: 'u1',
      variables: { course: 'A' },
    });

    expect(prisma._rows[0]?.channel).toBe('IN_APP');
    expect(prisma._rows[1]?.channel).toBe('EMAIL');
  });
});
