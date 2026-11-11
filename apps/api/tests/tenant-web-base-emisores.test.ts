/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Los correos de FONDO enlazan al aula del tenant, no al dominio general.
 *
 * `WEB_PUBLIC_URL` es UNA dirección por instalación. En un servidor con varias
 * academias (cada una en su dominio) todos los emisores que no nacen de una
 * petición —el hub de notificaciones, los recordatorios de clase, las
 * encuestas, los avisos de la comunidad— la leían directamente, así que el
 * alumno de una academia recibía enlaces al dominio general del servidor.
 *
 * Cada test monta DOS tenants con dominio propio y deja `WEB_PUBLIC_URL`
 * apuntando al dominio general: si un emisor vuelve a leer la variable, el
 * enlace sale con `pool.example.test` y el test falla. Ese es el control.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveWebBaseUrlForBackground } from '../src/common/resolve-web-base-url';
import { CommunityBroadcastWorker } from '../src/modules/community/community-broadcast.worker';
import { verifyUnsubscribeToken } from '../src/modules/community/broadcast-unsubscribe';
import { EmailVerificationService } from '../src/modules/member-registration/email-verification.service';
import { MemberRegistrationAdminController } from '../src/modules/member-registration/member-registration-admin.controller';
import { PaymentConnectionsController } from '../src/modules/payment-connections/payment-connections.controller';
import { SubscriptionsDailyWorker } from '../src/modules/payment-connections/subscriptions-daily.worker';
import { PrismaNotificationHubService } from '../src/modules/prisma-notification-hub.service';
import type { SmtpAdapterService } from '../src/modules/smtp-adapter.service';
import { SurveysReminderWorker } from '../src/modules/surveys/surveys-reminder.worker';
import { SurveysZoomBridge } from '../src/modules/surveys/surveys-zoom.bridge';
import {
  calendarGoogleUrl,
  calendarIcsUrl,
  calendarVariables,
  classUrl,
} from '../src/modules/zoom-live/class-links';
import { ZoomCalendarController } from '../src/modules/zoom-live/zoom-calendar.controller';
import { ZoomLiveNotificationsBridge } from '../src/modules/zoom-live/zoom-live-notifications.bridge';
import { ZoomReminderWorker } from '../src/modules/zoom-live/zoom-reminder.worker';
import { AdminSmtpController } from '../src/admin/admin-smtp.controller';
import { TenantResolverService } from '../src/tenancy/tenant-resolver.service';

const POOL = 'https://pool.example.test';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
/** Tenant sin dominio propio: instalación de un solo dominio. */
const TENANT_SIN_DOMINIO = '33333333-3333-4333-8333-333333333333';
const AULA_A = 'https://aula-a.example.test';
const AULA_B = 'https://aula-b.example.test';
const SESSION = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';

const DOMINIOS: Record<string, string> = {
  [TENANT_A]: 'aula-a.example.test',
  [TENANT_B]: 'aula-b.example.test',
};

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

/**
 * `TenantResolverService` REAL sobre un `tenant_domain` de mentira: lo que se
 * prueba es que cada emisor pregunta por SU tenant y usa lo que le contestan.
 */
function makeTenantResolver() {
  const findFirst = vi.fn(
    async (args: { where: { tenantId: string; isPrimary: boolean; isVerified: boolean } }) => {
      // Solo cuenta el dominio primario Y verificado.
      if (!args.where.isPrimary || !args.where.isVerified) return null;
      const hostname = DOMINIOS[args.where.tenantId];
      return hostname ? { hostname } : null;
    },
  );
  const resolver = new TenantResolverService({ tenantDomain: { findFirst } } as never);
  return { resolver, findFirst };
}

type HubSend = {
  tenantId: string;
  channel: string;
  templateKey: string;
  to: string;
  variables: Record<string, unknown>;
};

/** `ModuleContextFactory` mínima: bus capturable, hub espía y base por tenant. */
function makeFactory(prisma: unknown = {}) {
  const { resolver } = makeTenantResolver();
  const sends: HubSend[] = [];
  const handlers = new Map<string, (event: unknown) => Promise<void>>();
  const hub = {
    send: vi.fn(async (n: HubSend) => {
      sends.push(n);
    }),
  };
  const factory = {
    getTenantWebBaseUrl: (tenantId: string) =>
      resolver.resolveTenantWebBaseUrlForBackground(tenantId),
    getNotificationHub: () => hub,
    build: () => ({ notificationHub: hub }),
    getPrisma: () => prisma,
    getEventBus: () => ({
      subscribe: (name: string, handler: (event: unknown) => Promise<void>) => {
        handlers.set(name, handler);
      },
    }),
  };
  return { factory: factory as never, sends, handlers, hub };
}

let originalWebPublicUrl: string | undefined;
let originalAuthSecret: string | undefined;

beforeEach(() => {
  originalWebPublicUrl = process.env.WEB_PUBLIC_URL;
  originalAuthSecret = process.env.AUTH_SECRET;
  // El dominio GENERAL del servidor: es lo que NO debe aparecer en ningún
  // correo de un tenant que tiene dominio propio.
  process.env.WEB_PUBLIC_URL = POOL;
  process.env.AUTH_SECRET = 'secreto-de-pruebas-con-mas-de-treinta-y-dos-caracteres';
});

afterEach(() => {
  if (originalWebPublicUrl === undefined) delete process.env.WEB_PUBLIC_URL;
  else process.env.WEB_PUBLIC_URL = originalWebPublicUrl;
  if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = originalAuthSecret;
});

// ---------------------------------------------------------------------------
// El mecanismo
// ---------------------------------------------------------------------------

describe('resolveWebBaseUrlForBackground', () => {
  it('el dominio del tenant gana a WEB_PUBLIC_URL', () => {
    expect(resolveWebBaseUrlForBackground('aula-a.example.test')).toBe(AULA_A);
  });

  it('sin dominio de tenant, WEB_PUBLIC_URL es el último recurso (sin barra final)', () => {
    process.env.WEB_PUBLIC_URL = `${POOL}//`;
    expect(resolveWebBaseUrlForBackground(null)).toBe(POOL);
  });

  it("sin ninguna de las dos devuelve '' — nunca un localhost en la bandeja del alumno", () => {
    delete process.env.WEB_PUBLIC_URL;
    expect(resolveWebBaseUrlForBackground(null)).toBe('');
    process.env.WEB_PUBLIC_URL = 'no-es-una-url';
    expect(resolveWebBaseUrlForBackground(undefined)).toBe('');
  });

  it('localhost se sirve por http (desarrollo)', () => {
    expect(resolveWebBaseUrlForBackground('localhost')).toBe('http://localhost');
  });
});

describe('TenantResolverService.resolveTenantWebBaseUrlForBackground', () => {
  it('cada tenant recibe SU dominio primario verificado, no el general', async () => {
    const { resolver, findFirst } = makeTenantResolver();
    expect(await resolver.resolveTenantWebBaseUrlForBackground(TENANT_A)).toBe(AULA_A);
    expect(await resolver.resolveTenantWebBaseUrlForBackground(TENANT_B)).toBe(AULA_B);
    expect(findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT_A, isPrimary: true, isVerified: true },
    });
  });

  it('un tenant sin dominio propio cae a WEB_PUBLIC_URL (instalación de un solo dominio)', async () => {
    const { resolver } = makeTenantResolver();
    expect(await resolver.resolveTenantWebBaseUrlForBackground(TENANT_SIN_DOMINIO)).toBe(POOL);
  });

  it('si no se puede leer el dominio NO cae al general: el envío falla antes que apuntar a otra aula', async () => {
    const resolver = new TenantResolverService({
      tenantDomain: { findFirst: vi.fn().mockRejectedValue(new Error('db down')) },
    } as never);
    await expect(resolver.resolveTenantWebBaseUrlForBackground(TENANT_A)).rejects.toThrow(
      'db down',
    );
  });
});

// ---------------------------------------------------------------------------
// Hub de notificaciones: el botón de TODOS los correos
// ---------------------------------------------------------------------------

function makeHubPrisma(logoUrl: string | null = null) {
  return {
    userNotificationPreference: { findUnique: async () => null },
    user: {
      findUnique: async () => ({
        id: USER,
        tenantId: TENANT_A,
        email: 'alumna@example.test',
        locale: 'es-ES',
        status: 'ACTIVE',
        deletedAt: null,
      }),
    },
    notification: {
      create: async (args: { data: Record<string, unknown> }) => ({ id: 'n1', ...args.data }),
      update: async () => ({}),
    },
    notificationTemplate: { findUnique: async () => null },
    tenant: { findUnique: async () => ({ name: 'Academia A' }) },
    modThemingTenantTheme: {
      findUnique: async () => (logoUrl ? { logoUrl, brandHue: 213, brandSaturation: 70 } : null),
    },
  };
}

async function sendHubEmail(opts: { conResolver: boolean; logoUrl?: string | null }) {
  const send = vi.fn(async (_config: unknown, _msg: { html: string; text: string }) => ({
    ok: true,
    messageId: '<id>',
  }));
  const smtp = {
    parseConfig: (raw: unknown) => raw,
    send,
  } as unknown as SmtpAdapterService;
  const tenantConfig = { get: async () => ({ host: 'smtp.example.test' }) } as never;
  const hub = new PrismaNotificationHubService(
    makeHubPrisma(opts.logoUrl ?? null) as never,
    logger,
    tenantConfig,
    smtp,
    undefined,
    undefined,
    opts.conResolver ? makeTenantResolver().resolver : undefined,
  );
  await hub.send({
    tenantId: TENANT_A,
    channel: 'email',
    templateKey: 'enrollment.created',
    to: USER,
    variables: { course: 'Curso A' },
  });
  expect(send).toHaveBeenCalledTimes(1);
  return send.mock.calls[0]![1];
}

describe('NotificationHub · el botón del correo lleva al aula del tenant', () => {
  it('el CTA enlaza al dominio del tenant aunque WEB_PUBLIC_URL sea el general', async () => {
    const msg = await sendHubEmail({ conResolver: true });
    expect(msg.html).toContain(`href="${AULA_A}"`);
    expect(msg.text).toContain(AULA_A);
    expect(msg.html).not.toContain('pool.example.test');
    expect(msg.text).not.toContain('pool.example.test');
  });

  it('el logo de ruta relativa también cuelga del aula del tenant', async () => {
    const msg = await sendHubEmail({ conResolver: true, logoUrl: '/api/v1/storage/file/logo.png' });
    expect(msg.html).toContain(`src="${AULA_A}/api/v1/storage/file/logo.png"`);
    expect(msg.html).not.toContain('pool.example.test');
  });

  it('CONTROL: sin resolver de tenant sigue cayendo a WEB_PUBLIC_URL (hub mínimo de tests)', async () => {
    // Deja claro que el test de arriba discrimina: mismo envío, sin la pieza
    // que resuelve el tenant, y el botón vuelve al dominio general.
    const msg = await sendHubEmail({ conResolver: false });
    expect(msg.html).toContain(`href="${POOL}"`);
  });

  it('in-app no paga la consulta del dominio: ahí no hay ni botón ni logo', async () => {
    const { resolver, findFirst } = makeTenantResolver();
    const hub = new PrismaNotificationHubService(
      makeHubPrisma() as never,
      logger,
      undefined,
      undefined,
      undefined,
      undefined,
      resolver,
    );
    await hub.send({
      tenantId: TENANT_A,
      channel: 'in-app',
      templateKey: 'enrollment.created',
      to: USER,
      variables: { course: 'Curso A' },
    });
    expect(findFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Clases en directo: confirmación, recordatorio y .ics
// ---------------------------------------------------------------------------

describe('class-links · la base la pone quien llama (el tenant), no una variable global', () => {
  it('compone los tres enlaces sobre la base recibida', () => {
    expect(classUrl(`${AULA_A}/`, SESSION)).toBe(`${AULA_A}/clase/${SESSION}`);
    expect(calendarIcsUrl(AULA_A, SESSION)).toBe(
      `${AULA_A}/api/v1/modules/zoom-live/sessions/${SESSION}/calendar.ics`,
    );
    expect(calendarGoogleUrl(AULA_A, SESSION)).toBe(
      `${AULA_A}/api/v1/modules/zoom-live/sessions/${SESSION}/calendar/google`,
    );
  });

  it("sin base devuelve '' aunque WEB_PUBLIC_URL esté puesta: ya no la lee", () => {
    expect(calendarVariables('', SESSION)).toEqual({
      classUrl: '',
      calendarGoogleUrl: '',
      calendarIcsUrl: '',
    });
  });
});

describe('ZoomLiveNotificationsBridge · confirmación de inscripción', () => {
  it('los enlaces de clase y calendario salen del dominio del tenant del evento', async () => {
    const { factory, sends, handlers } = makeFactory();
    new ZoomLiveNotificationsBridge(factory, logger).onModuleInit();

    for (const tenantId of [TENANT_A, TENANT_B]) {
      await handlers.get('zoom.session.registration.created')!({
        metadata: { tenantId },
        data: {
          sessionId: SESSION,
          userId: USER,
          topic: 'Clase 1',
          startTime: '2026-03-14T17:00:00.000Z',
          timezone: 'Europe/Madrid',
          courseId: null,
        },
      });
    }

    const deA = sends.filter((s) => s.tenantId === TENANT_A);
    const deB = sends.filter((s) => s.tenantId === TENANT_B);
    expect(deA.length).toBe(2); // in-app + email
    for (const s of deA) {
      expect(s.variables.classUrl).toBe(`${AULA_A}/clase/${SESSION}`);
      expect(String(s.variables.calendarIcsUrl).startsWith(`${AULA_A}/api/v1/`)).toBe(true);
      expect(String(s.variables.calendarGoogleUrl).startsWith(`${AULA_A}/api/v1/`)).toBe(true);
    }
    for (const s of deB) {
      expect(s.variables.classUrl).toBe(`${AULA_B}/clase/${SESSION}`);
    }
    expect(JSON.stringify(sends)).not.toContain('pool.example.test');
  });
});

describe('ZoomReminderWorker · recordatorio de clase', () => {
  it('el barrido es cross-tenant y cada clase enlaza a SU aula', async () => {
    const { factory, sends } = makeFactory();
    const SESSION_B = '66666666-6666-4666-8666-666666666666';
    const zoom = {
      listSessionsPendingReminder: vi.fn().mockResolvedValue([
        { id: SESSION, tenantId: TENANT_A },
        { id: SESSION_B, tenantId: TENANT_B },
      ]),
      claimReminder: vi.fn().mockResolvedValue(true),
      getCalendarInfo: vi.fn(async (id: string) => ({
        id,
        tenantId: id === SESSION ? TENANT_A : TENANT_B,
        topic: 'Clase',
        startTime: new Date('2026-03-14T17:00:00.000Z'),
        durationMinutes: 60,
        timezone: 'Europe/Madrid',
        status: 'SCHEDULED',
        organizerName: 'Academia',
      })),
      listRegisteredUserIds: vi.fn().mockResolvedValue([USER]),
    };
    const registry = { getZoomLiveService: () => zoom } as never;
    const worker = new ZoomReminderWorker(registry, factory, logger);

    const out = await worker.runSweep(new Date('2026-03-14T15:00:00.000Z'));

    expect(out).toEqual({ sessions: 2, reminders: 2 });
    const deA = sends.filter((s) => s.tenantId === TENANT_A);
    const deB = sends.filter((s) => s.tenantId === TENANT_B);
    expect(deA.length).toBeGreaterThan(0);
    expect(deB.length).toBeGreaterThan(0);
    for (const s of deA) expect(s.variables.classUrl).toBe(`${AULA_A}/clase/${SESSION}`);
    for (const s of deB) expect(s.variables.classUrl).toBe(`${AULA_B}/clase/${SESSION_B}`);
    expect(JSON.stringify(sends)).not.toContain('pool.example.test');
  });
});

describe('ZoomCalendarController · el .ics guarda el enlace del aula del tenant', () => {
  function makeController(tenantId: string) {
    const zoom = {
      getCalendarInfo: vi.fn().mockResolvedValue({
        id: SESSION,
        tenantId,
        topic: 'Clase 1',
        startTime: new Date('2026-03-14T17:00:00.000Z'),
        durationMinutes: 60,
        timezone: 'Europe/Madrid',
        status: 'SCHEDULED',
        organizerName: 'Academia A',
      }),
    };
    const registry = { getZoomLiveService: () => zoom } as never;
    return new ZoomCalendarController(registry, makeTenantResolver().resolver);
  }

  function makeReply() {
    const sent: { body?: string; headers: Record<string, string>; code?: number } = { headers: {} };
    const reply = {
      header(name: string, value: string) {
        sent.headers[name] = value;
        return reply;
      },
      code(n: number) {
        sent.code = n;
        return reply;
      },
      send(body?: string) {
        sent.body = body;
        return reply;
      },
    };
    return { reply: reply as never, sent };
  }

  it('URL y LOCATION del evento apuntan al dominio del tenant dueño de la clase', async () => {
    const { reply, sent } = makeReply();
    await makeController(TENANT_A).ics(SESSION, reply);
    expect(sent.body).toContain(`${AULA_A}/clase/${SESSION}`);
    expect(sent.body).not.toContain('pool.example.test');
  });

  it('el enlace a Google Calendar lleva la página de la clase del tenant', async () => {
    const { reply, sent } = makeReply();
    await makeController(TENANT_B).google(SESSION, reply);
    expect(sent.code).toBe(302);
    const location = decodeURIComponent(sent.headers['Location'] ?? '');
    expect(location).toContain(`${AULA_B}/clase/${SESSION}`);
    expect(location).not.toContain('pool.example.test');
  });
});

// ---------------------------------------------------------------------------
// Encuestas post-clase: invitación y recordatorio
// ---------------------------------------------------------------------------

describe('SurveysReminderWorker · recordatorio de encuesta', () => {
  it('cada encuesta enlaza a la clase en el aula de su tenant', async () => {
    const prisma = {
      modZoomSessionRegistration: { findMany: vi.fn().mockResolvedValue([{ userId: USER }]) },
    };
    const { factory, sends } = makeFactory(prisma);
    const surveys = {
      findDueReminders: vi.fn().mockResolvedValue([
        { id: 's-a', tenantId: TENANT_A, title: 'Clase A', zoomSessionId: SESSION },
        { id: 's-b', tenantId: TENANT_B, title: 'Clase B', zoomSessionId: SESSION },
      ]),
      claimReminder: vi.fn().mockResolvedValue(true),
      filterPendingRespondents: vi.fn().mockResolvedValue([USER]),
    };
    const registry = { getSurveysService: () => surveys } as never;
    const worker = new SurveysReminderWorker(registry, factory, logger);

    const out = await worker.runSweep();

    expect(out).toEqual({ surveys: 2, reminders: 2 });
    for (const s of sends.filter((x) => x.tenantId === TENANT_A)) {
      expect(s.variables.surveyUrl).toBe(`${AULA_A}/clase/${SESSION}`);
    }
    for (const s of sends.filter((x) => x.tenantId === TENANT_B)) {
      expect(s.variables.surveyUrl).toBe(`${AULA_B}/clase/${SESSION}`);
    }
    expect(sends.length).toBe(4); // 2 tenants × (in-app + email)
    expect(JSON.stringify(sends)).not.toContain('pool.example.test');
  });
});

describe('SurveysZoomBridge · invitación a la encuesta al terminar la clase', () => {
  it('el enlace de la encuesta sale del dominio del tenant de la clase', async () => {
    const prisma = {
      modZoomSession: { findFirst: vi.fn().mockResolvedValue({ topic: 'Clase 1' }) },
      modZoomSessionRegistration: { findMany: vi.fn().mockResolvedValue([{ userId: USER }]) },
    };
    const { factory, sends, handlers } = makeFactory(prisma);
    const surveys = {
      createForZoomSession: vi.fn().mockResolvedValue({ surveyId: 'sv1', created: true }),
    };
    const registry = { getSurveysService: () => surveys } as never;
    new SurveysZoomBridge(registry, factory, logger).onModuleInit();

    await handlers.get('zoom.session.ended')!({
      metadata: { tenantId: TENANT_B },
      data: { sessionId: SESSION },
    });

    expect(sends.length).toBe(2);
    for (const s of sends) {
      expect(s.templateKey).toBe('surveys.post_class.invitation');
      expect(s.variables.surveyUrl).toBe(`${AULA_B}/clase/${SESSION}`);
    }
    expect(JSON.stringify(sends)).not.toContain('pool.example.test');
  });
});

// ---------------------------------------------------------------------------
// Avisos de la comunidad: «ver la publicación» y el enlace de baja
// ---------------------------------------------------------------------------

describe('CommunityBroadcastWorker · aviso masivo', () => {
  async function runBatch(tenantId: string) {
    const { factory, sends } = makeFactory();
    const community = {
      claimBroadcastBatch: vi.fn().mockResolvedValue({
        broadcast: {
          id: 'b1',
          tenantId,
          subject: 'Aviso',
          bodyText: 'Hola',
          important: false,
          postId: 'p1',
          cursorUserId: null,
        },
        recipients: [{ userId: USER, email: 'alumna@example.test', optedOut: false }],
        done: false,
      }),
      commitBroadcastBatch: vi.fn().mockResolvedValue(undefined),
    };
    const registry = { getCommunityService: () => community } as never;
    const worker = new CommunityBroadcastWorker(factory, registry, logger);
    await (worker as unknown as { processBatch(id: string): Promise<boolean> }).processBatch('b1');
    return sends;
  }

  it('la publicación y la baja enlazan al aula del tenant del aviso', async () => {
    const sends = await runBatch(TENANT_A);
    const email = sends.find((s) => s.channel === 'email')!;
    expect(email.variables.postUrl).toBe(`${AULA_A}/comunidad`);
    const unsubUrl = String(email.variables.unsubUrl);
    expect(unsubUrl.startsWith(`${AULA_A}/api/v1/modules/community/unsubscribe?token=`)).toBe(true);
    // El token sigue siendo el del destinatario en SU tenant.
    const token = new URL(unsubUrl).searchParams.get('token')!;
    expect(verifyUnsubscribeToken(token)).toEqual({ tenantId: TENANT_A, userId: USER });
    expect(JSON.stringify(sends)).not.toContain('pool.example.test');
  });

  it('un segundo tenant del mismo servidor recibe los suyos', async () => {
    const sends = await runBatch(TENANT_B);
    const email = sends.find((s) => s.channel === 'email')!;
    expect(String(email.variables.unsubUrl).startsWith(`${AULA_B}/`)).toBe(true);
    expect(email.variables.postUrl).toBe(`${AULA_B}/comunidad`);
  });

  it('sin dirección conocida no compone enlaces relativos: los omite', async () => {
    delete process.env.WEB_PUBLIC_URL;
    const sends = await runBatch(TENANT_SIN_DOMINIO);
    const email = sends.find((s) => s.channel === 'email')!;
    expect(email.variables.postUrl).toBe('');
    expect(email.variables.unsubUrl).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Emisores que solo usan la base para el LOGO del correo
// ---------------------------------------------------------------------------

/** Prisma mínimo para `resolveEmailBranding`, con un logo de ruta relativa. */
const LOGO_PATH = '/api/v1/storage/file/logo.png';
function brandingPrisma(extra: Record<string, unknown> = {}) {
  return {
    tenant: { findUnique: vi.fn().mockResolvedValue({ name: 'Academia A', slug: 'a' }) },
    modThemingTenantTheme: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ logoUrl: LOGO_PATH, brandHue: 213, brandSaturation: 70 }),
    },
    notificationTemplate: { findUnique: vi.fn().mockResolvedValue(null) },
    ...extra,
  };
}

function expectLogoDelTenant(html: string, aula: string): void {
  expect(html).toContain(`src="${aula}${LOGO_PATH}"`);
  expect(html).not.toContain('pool.example.test');
}

describe('logo del correo · cuelga del aula del tenant en los emisores que lo componen a mano', () => {
  const ADMIN = { sub: USER, tenantId: TENANT_A, roles: ['super_admin', 'tenant_admin'] } as never;

  it('prueba de SMTP del panel (AdminSmtpController.test)', async () => {
    const send = vi.fn(async (_c: unknown, _m: { html: string }) => ({ ok: true }));
    const { resolver } = makeTenantResolver();
    const modules = {
      getSmtpAdapter: () => ({ send }),
      getTenantConfig: () => ({
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
      }),
      getTenantWebBaseUrl: (t: string) => resolver.resolveTenantWebBaseUrlForBackground(t),
    };
    const prisma = brandingPrisma({
      user: { findUnique: vi.fn().mockResolvedValue({ locale: 'es-ES', tenantId: TENANT_A }) },
    });
    const smtpResolver = {
      resolveTenantOnly: vi.fn().mockResolvedValue({ config: { host: 'smtp.example.test' } }),
    };
    const controller = new AdminSmtpController(
      modules as never,
      prisma as never,
      smtpResolver as never,
    );

    await controller.test(ADMIN, { toEmail: 'admin@example.test' });

    expect(send).toHaveBeenCalledTimes(1);
    expectLogoDelTenant(send.mock.calls[0]![1].html, AULA_A);
  });

  it('código de verificación del alta (EmailVerificationService)', async () => {
    const send = vi.fn(async (_c: unknown, _m: { html: string }) => ({ ok: true }));
    const prisma = brandingPrisma({
      emailVerificationCode: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({}),
      },
      user: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    const service = new EmailVerificationService(
      prisma as never,
      { record: vi.fn() } as never,
      { send } as never,
      { resolve: vi.fn().mockResolvedValue({ config: {}, source: 'tenant' }) } as never,
      logger,
      makeTenantResolver().resolver,
    );

    await service.requestCode(TENANT_B, 'nueva@example.test', { ip: null, userAgent: null });

    expect(send).toHaveBeenCalledTimes(1);
    expectLogoDelTenant(send.mock.calls[0]![1].html, AULA_B);
  });

  it('recordatorio de pago a un solicitante (MemberRegistrationAdminController)', async () => {
    const send = vi.fn(async (_c: unknown, _m: { html: string }) => ({ ok: true }));
    const controller = new MemberRegistrationAdminController(
      { getUserEmail: vi.fn().mockResolvedValue('aspirante@example.test') } as never,
      {} as never,
      {} as never,
      {} as never,
      { send } as never,
      { resolve: vi.fn().mockResolvedValue({ config: {} }) } as never,
      brandingPrisma() as never,
      makeTenantResolver().resolver,
    );

    await controller.sendRenewalEmail(ADMIN, USER, { subject: 'Renueva', body: 'Paga aquí' });

    expectLogoDelTenant(send.mock.calls[0]![1].html, AULA_A);
  });

  it('recordatorio de renovación a un suscriptor (PaymentConnectionsController)', async () => {
    const send = vi.fn(async (_c: unknown, _m: { html: string }) => ({ ok: true }));
    const registry = {
      getPaymentConnectionsService: () => ({
        getSubscriber: vi.fn().mockResolvedValue({ userEmail: 'suscriptora@example.test' }),
      }),
    };
    const controller = new PaymentConnectionsController(
      registry as never,
      {} as never,
      {} as never,
      { send } as never,
      { resolve: vi.fn().mockResolvedValue({ config: {} }) } as never,
      {} as never,
      brandingPrisma() as never,
      makeTenantResolver().resolver,
    );

    await controller.sendRenewalEmail(ADMIN, 'sub-1', { subject: 'Renueva', body: 'Paga aquí' });

    expectLogoDelTenant(send.mock.calls[0]![1].html, AULA_A);
  });

  it('barrido diario de suscripciones (SubscriptionsDailyWorker)', async () => {
    const enviados: Array<{ html: string }> = [];
    const service = {
      listTenantsWithVerifiedConnections: vi.fn().mockResolvedValue([TENANT_B]),
      getSubscriptionDigest: vi.fn().mockResolvedValue({ activeCount: 1, upcoming: [] }),
      listTenantAdminEmails: vi.fn().mockResolvedValue(['admin@example.test']),
      listSubscribersToWarn: vi.fn().mockResolvedValue([]),
      getCancelPortalUrl: vi.fn().mockResolvedValue(null),
      markRenewalWarned: vi.fn(),
    };
    const registry = {
      getPaymentConnectionsService: () => service,
      getOrderMirrorService: () => ({
        listTimedAccessToWarn: vi.fn().mockResolvedValue([]),
        markExpiryWarned: vi.fn(),
      }),
    };
    const smtp = {
      send: vi.fn(async (_c: unknown, msg: { html: string }) => {
        enviados.push(msg);
        return { ok: true };
      }),
    };
    const prisma = brandingPrisma({ user: { findMany: vi.fn().mockResolvedValue([]) } });
    const worker = new SubscriptionsDailyWorker(
      registry as never,
      smtp as never,
      { resolve: vi.fn().mockResolvedValue({ config: {} }) } as never,
      prisma as never,
      logger,
      makeTenantResolver().resolver,
    );

    await worker.triggerNow();

    expect(enviados.length).toBeGreaterThan(0);
    for (const msg of enviados) expectLogoDelTenant(msg.html, AULA_B);
  });
});
