/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Baja de los correos y cuentas a las que ya no se les escribe.
 *
 *  - El hub no escribe NADA (ni email ni in-app, ni guarda la notificación) a
 *    una cuenta eliminada, suspendida o desactivada.
 *  - El resumen semanal lleva enlace de baja, en el idioma del destinatario.
 *  - Los correos con enlace de baja lo llevan además como cabecera
 *    `List-Unsubscribe` (baja en un clic de Gmail/Outlook, RFC 8058).
 *  - El enlace de baja —por GET desde el correo o por POST desde el gestor de
 *    correo— corta los DOS correos de la comunidad.
 *
 * Qué baja corta qué envío se prueba en el módulo
 * (`modules/community/tests/community-email-opt-out.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  communityUnsubscribeUrl,
  verifyUnsubscribeToken,
} from '../src/modules/community/broadcast-unsubscribe';
import { CommunityDigestWorker } from '../src/modules/community/community-digest.worker';
import { CommunityPublicController } from '../src/modules/community/community-public.controller';
import {
  interpolate,
  resolveHubDefault,
} from '../src/modules/notifications/email-template-catalog';
import { PrismaNotificationHubService } from '../src/modules/prisma-notification-hub.service';
import type { SmtpAdapterService } from '../src/modules/smtp-adapter.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const AULA = 'https://aula-a.example.test';

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

let originalAuthSecret: string | undefined;
beforeEach(() => {
  originalAuthSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = 'secreto-de-pruebas-con-mas-de-treinta-y-dos-caracteres';
});
afterEach(() => {
  if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = originalAuthSecret;
});

// ---------------------------------------------------------------------------
// Hub: a quién ya no se le escribe
// ---------------------------------------------------------------------------

interface Recipient {
  status: string;
  deletedAt: Date | null;
  locale?: string;
}

function makeHub(recipient: Recipient | null) {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    userNotificationPreference: { findUnique: async () => null },
    user: {
      findUnique: vi.fn(async () =>
        recipient
          ? {
              id: USER,
              tenantId: TENANT,
              email: 'alumna@example.test',
              locale: recipient.locale ?? 'es-ES',
              status: recipient.status,
              deletedAt: recipient.deletedAt,
            }
          : null,
      ),
    },
    notification: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const row = { id: `n${rows.length + 1}`, ...args.data };
        rows.push(row);
        return row;
      }),
      update: vi.fn(async () => ({})),
    },
    notificationTemplate: { findUnique: async () => null },
    tenant: { findUnique: async () => ({ name: 'Academia A' }) },
    modThemingTenantTheme: { findUnique: async () => null },
  };
  const send = vi.fn(
    async (_config: unknown, _msg: { text: string; html: string; unsubscribeUrl?: string }) => ({
      ok: true,
      messageId: '<id>',
    }),
  );
  const smtp = { parseConfig: (raw: unknown) => raw, send } as unknown as SmtpAdapterService;
  const tenantConfig = { get: async () => ({ host: 'smtp.example.test' }) } as never;
  const publishInApp = vi.fn(async () => undefined);
  const hub = new PrismaNotificationHubService(
    prisma as never,
    logger,
    tenantConfig,
    smtp,
    undefined,
    { publishInApp } as never,
    { resolveTenantWebBaseUrlForBackground: async () => AULA },
  );
  return { hub, rows, send, publishInApp, prisma };
}

const MENTION = {
  tenantId: TENANT,
  templateKey: 'community.mention',
  to: USER,
  variables: { actorName: 'Lucía', excerpt: 'hola' },
  category: 'COMMUNITY',
} as const;

describe('NotificationHub · a una cuenta eliminada o suspendida no se le escribe', () => {
  const CASOS: Array<[string, Recipient]> = [
    ['eliminada (deletedAt) aunque siga ACTIVE', { status: 'ACTIVE', deletedAt: new Date() }],
    ['suspendida', { status: 'SUSPENDED', deletedAt: null }],
    ['desactivada', { status: 'DEACTIVATED', deletedAt: null }],
    ['eliminada y desactivada (baja por SCIM)', { status: 'DEACTIVATED', deletedAt: new Date() }],
  ];

  for (const [nombre, recipient] of CASOS) {
    it(`cuenta ${nombre}: ni email, ni in-app, ni fila guardada`, async () => {
      const { hub, rows, send, publishInApp } = makeHub(recipient);

      await hub.send({ ...MENTION, channel: 'email' });
      await hub.send({ ...MENTION, channel: 'in-app' });

      expect(send).not.toHaveBeenCalled();
      expect(publishInApp).not.toHaveBeenCalled();
      expect(rows).toEqual([]);
    });
  }

  it('CONTROL: a una cuenta ACTIVE sí le llega por los dos canales', async () => {
    const { hub, rows, send, publishInApp } = makeHub({ status: 'ACTIVE', deletedAt: null });

    await hub.send({ ...MENTION, channel: 'email' });
    await hub.send({ ...MENTION, channel: 'in-app' });

    expect(send).toHaveBeenCalledTimes(1);
    expect(publishInApp).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
  });

  it('una cuenta PENDING (alta sin terminar) sigue recibiendo: no es una cuenta cerrada', async () => {
    const { hub, send } = makeHub({ status: 'PENDING', deletedAt: null });
    await hub.send({ ...MENTION, channel: 'email' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('CAMINO DEGRADADO: si la comprobación revienta, la notificación in-app no se pierde', async () => {
    const { hub, rows, prisma } = makeHub({ status: 'ACTIVE', deletedAt: null });
    prisma.user.findUnique.mockRejectedValueOnce(new Error('db down'));

    await hub.send({ ...MENTION, channel: 'in-app', locale: 'es-ES' });

    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Resumen semanal: enlace de baja en el cuerpo y en la cabecera
// ---------------------------------------------------------------------------

describe('plantilla del resumen semanal · pie de baja', () => {
  const vars = { mentionsCount: 2, repliesCount: 1, sinceIso: '2026-01-05T09:00:00.000Z' };

  it('es-ES: el pie nombra los dos correos y lleva el enlace', () => {
    const body = interpolate(resolveHubDefault('community.digest.weekly', 'es-ES')!.body, {
      ...vars,
      unsubUrl: 'https://u/unsub',
    });
    expect(body).toContain(
      'Para dejar de recibir los correos de la comunidad (resumen semanal y avisos), entra aquí: https://u/unsub',
    );
  });

  it('en-US: el mismo pie, traducido', () => {
    const body = interpolate(resolveHubDefault('community.digest.weekly', 'en-US')!.body, {
      ...vars,
      unsubUrl: 'https://u/unsub',
    });
    expect(body).toContain(
      'To stop receiving community emails (the weekly digest and notices), go here: https://u/unsub',
    );
    expect(body).not.toContain('Para dejar de recibir');
  });

  it('sin enlace (no se conoce la dirección del aula) el pie desaparece entero', () => {
    for (const locale of ['es-ES', 'en-US']) {
      const body = interpolate(resolveHubDefault('community.digest.weekly', locale)!.body, {
        ...vars,
        unsubUrl: '',
      });
      expect(body).not.toContain('———');
      expect(body.trim().endsWith('.')).toBe(true);
    }
  });

  it('el aviso masivo dice lo mismo en los dos idiomas: la baja es de los dos correos', () => {
    const es = resolveHubDefault('community.broadcast', 'es-ES')!.body;
    const en = resolveHubDefault('community.broadcast', 'en-US')!.body;
    expect(es).toContain('los correos de la comunidad (avisos y resumen semanal)');
    expect(en).toContain('community emails (notices and the weekly digest)');
  });
});

describe('NotificationHub · cabecera List-Unsubscribe', () => {
  it('el resumen semanal sale con el enlace de baja en el cuerpo y como cabecera', async () => {
    const { hub, send } = makeHub({ status: 'ACTIVE', deletedAt: null, locale: 'en-US' });
    const unsubUrl = communityUnsubscribeUrl(AULA, TENANT, USER);

    await hub.send({
      tenantId: TENANT,
      channel: 'email',
      templateKey: 'community.digest.weekly',
      to: USER,
      variables: { mentionsCount: 1, repliesCount: 0, sinceIso: '2026-01-05', unsubUrl },
    });

    const msg = send.mock.calls[0]![1];
    expect(msg.unsubscribeUrl).toBe(unsubUrl);
    expect(msg.text).toContain(`go here: ${unsubUrl}`);
  });

  it('un correo sin enlace de baja NO lleva la cabecera (una mención, un recordatorio)', async () => {
    const { hub, send } = makeHub({ status: 'ACTIVE', deletedAt: null });
    await hub.send({ ...MENTION, channel: 'email' });
    expect(send.mock.calls[0]![1]).not.toHaveProperty('unsubscribeUrl');
  });

  it('solo una URL absoluta llega a la cabecera', async () => {
    const { hub, send } = makeHub({ status: 'ACTIVE', deletedAt: null });
    await hub.send({
      tenantId: TENANT,
      channel: 'email',
      templateKey: 'community.digest.weekly',
      to: USER,
      variables: { mentionsCount: 1, repliesCount: 0, sinceIso: 'x', unsubUrl: '/api/v1/relativo' },
    });
    expect(send.mock.calls[0]![1]).not.toHaveProperty('unsubscribeUrl');
  });
});

describe('communityUnsubscribeUrl', () => {
  it('cuelga del aula del tenant y lleva el token del destinatario', () => {
    const url = communityUnsubscribeUrl(`${AULA}/`, TENANT, USER);
    expect(url.startsWith(`${AULA}/api/v1/modules/community/unsubscribe?token=`)).toBe(true);
    expect(verifyUnsubscribeToken(new URL(url).searchParams.get('token')!)).toEqual({
      tenantId: TENANT,
      userId: USER,
    });
  });

  it("sin dirección del aula devuelve '' — nunca un enlace relativo", () => {
    expect(communityUnsubscribeUrl('', TENANT, USER)).toBe('');
    expect(communityUnsubscribeUrl('   ', TENANT, USER)).toBe('');
  });
});

describe('CommunityDigestWorker · el resumen lleva su enlace de baja', () => {
  function makeWorker(webBase: string) {
    const sends: Array<{ to: string; variables: Record<string, unknown> }> = [];
    const hub = {
      send: vi.fn(async (n: { to: string; variables: Record<string, unknown> }) => {
        sends.push(n);
      }),
    };
    const getTenantWebBaseUrl = vi.fn(async () => webBase);
    const factory = { build: () => ({ notificationHub: hub }), getTenantWebBaseUrl };
    const community = {
      listActiveUsersForDigest: vi.fn().mockResolvedValue([
        { tenantId: TENANT, userId: USER },
        { tenantId: TENANT, userId: 'otro' },
      ]),
      buildDigest: vi.fn().mockResolvedValue({
        mentions: [{ postId: 'p1' }],
        replies: [],
      }),
    };
    const metrics = {
      startRunTimer: () => () => 0,
      recordUserProcessed: vi.fn(),
      recordSkipped: vi.fn(),
      recordSent: vi.fn(),
      recordFailed: vi.fn(),
    };
    const worker = new CommunityDigestWorker(
      factory as never,
      { getCommunityService: () => community } as never,
      logger,
      metrics as never,
    );
    return { worker, sends, getTenantWebBaseUrl };
  }

  it('cada destinatario recibe SU enlace, sobre el aula de su tenant', async () => {
    const { worker, sends, getTenantWebBaseUrl } = makeWorker(AULA);

    await worker.triggerNow(new Date('2026-01-05T09:00:00.000Z'));

    expect(sends).toHaveLength(2);
    const url = String(sends[0]!.variables.unsubUrl);
    expect(url.startsWith(`${AULA}/api/v1/modules/community/unsubscribe?token=`)).toBe(true);
    expect(verifyUnsubscribeToken(new URL(url).searchParams.get('token')!)).toEqual({
      tenantId: TENANT,
      userId: USER,
    });
    expect(sends[1]!.variables.unsubUrl).not.toBe(sends[0]!.variables.unsubUrl);
    // La dirección del aula se resuelve una vez por tenant, no una por alumno.
    expect(getTenantWebBaseUrl).toHaveBeenCalledTimes(1);
  });

  it('sin dirección pública del aula el resumen sale igual, sin enlace', async () => {
    const { worker, sends } = makeWorker('');
    await worker.triggerNow(new Date('2026-01-05T09:00:00.000Z'));
    expect(sends).toHaveLength(2);
    expect(sends[0]!.variables.unsubUrl).toBe('');
  });
});

// ---------------------------------------------------------------------------
// El enlace de baja
// ---------------------------------------------------------------------------

describe('CommunityPublicController · darse de baja', () => {
  function makeController(locale: string | null = 'es-ES') {
    const setCommunityEmailOptOut = vi.fn().mockResolvedValue(undefined);
    const registry = { getCommunityService: () => ({ setCommunityEmailOptOut }) };
    const prisma = {
      user: {
        findUnique: vi.fn(async () => (locale === null ? null : { locale })),
      },
    };
    const controller = new CommunityPublicController(registry as never, prisma as never);
    return { controller, setCommunityEmailOptOut };
  }

  function makeReply() {
    const out: { status?: number; body?: string; headers: Record<string, string> } = {
      headers: {},
    };
    const reply = {
      status(code: number) {
        out.status = code;
        return reply;
      },
      header(name: string, value: string) {
        out.headers[name] = value;
        return reply;
      },
      send(body: string) {
        out.body = body;
        return reply;
      },
    };
    return { reply: reply as never, out };
  }

  const req = (acceptLanguage?: string) =>
    ({ headers: acceptLanguage ? { 'accept-language': acceptLanguage } : {} }) as never;

  it('GET con el enlace del correo: corta los correos de la comunidad (las dos marcas)', async () => {
    const { controller, setCommunityEmailOptOut } = makeController();
    const { reply, out } = makeReply();
    const token = new URL(communityUnsubscribeUrl(AULA, TENANT, USER)).searchParams.get('token')!;

    await controller.unsubscribe(token, req(), reply);

    expect(setCommunityEmailOptOut).toHaveBeenCalledWith(TENANT, USER, true);
    expect(out.status).toBe(200);
    expect(out.body).toContain('<html lang="es">');
    expect(out.body).toContain('ni avisos ni el resumen semanal');
  });

  it('la página sale en el idioma del destinatario, no en el del navegador', async () => {
    const { controller } = makeController('en-US');
    const { reply, out } = makeReply();
    const token = new URL(communityUnsubscribeUrl(AULA, TENANT, USER)).searchParams.get('token')!;

    await controller.unsubscribe(token, req('es-ES,es;q=0.9'), reply);

    expect(out.body).toContain('<html lang="en">');
    expect(out.body).toContain('You have unsubscribed');
    expect(out.body).not.toContain('Te has dado de baja');
  });

  it('CAMINO DEGRADADO: sin fila de usuario se usa el idioma del navegador y la baja se hace igual', async () => {
    const { controller, setCommunityEmailOptOut } = makeController(null);
    const { reply, out } = makeReply();
    const token = new URL(communityUnsubscribeUrl(AULA, TENANT, USER)).searchParams.get('token')!;

    await controller.unsubscribe(token, req('en-GB,en;q=0.9'), reply);

    expect(setCommunityEmailOptOut).toHaveBeenCalledTimes(1);
    expect(out.status).toBe(200);
    expect(out.body).toContain('<html lang="en">');
  });

  it('POST (baja en un clic del gestor de correo): hace la misma baja y responde 200', async () => {
    const { controller, setCommunityEmailOptOut } = makeController();
    const { reply, out } = makeReply();
    const token = new URL(communityUnsubscribeUrl(AULA, TENANT, USER)).searchParams.get('token')!;

    await controller.unsubscribeOneClick(token, req(), reply);

    expect(setCommunityEmailOptOut).toHaveBeenCalledWith(TENANT, USER, true);
    expect(out.status).toBe(200);
    expect(out.body).toBe('ok');
  });

  it('un token manipulado no da de baja a nadie: 400 por GET y por POST', async () => {
    const { controller, setCommunityEmailOptOut } = makeController();
    const token = new URL(communityUnsubscribeUrl(AULA, TENANT, USER)).searchParams.get('token')!;
    const manipulado = `${token.split('.')[0]}.firma-falsa`;

    const get = makeReply();
    await controller.unsubscribe(manipulado, req('en-US'), get.reply);
    expect(get.out.status).toBe(400);
    expect(get.out.body).toContain('Invalid link');

    const post = makeReply();
    await controller.unsubscribeOneClick(manipulado, req(), post.reply);
    expect(post.out.status).toBe(400);
    expect(post.out.body).toBe('invalid_token');

    const vacio = makeReply();
    await controller.unsubscribe(undefined, req(), vacio.reply);
    expect(vacio.out.status).toBe(400);
    expect(vacio.out.body).toContain('Enlace no válido');

    expect(setCommunityEmailOptOut).not.toHaveBeenCalled();
  });

  it('si la baja falla responde 500 y no dice que está hecha', async () => {
    const { controller, setCommunityEmailOptOut } = makeController();
    setCommunityEmailOptOut.mockRejectedValueOnce(new Error('db down'));
    const { reply, out } = makeReply();
    const token = new URL(communityUnsubscribeUrl(AULA, TENANT, USER)).searchParams.get('token')!;

    await controller.unsubscribe(token, req(), reply);

    expect(out.status).toBe(500);
    expect(out.body).not.toContain('Te has dado de baja');
  });
});
