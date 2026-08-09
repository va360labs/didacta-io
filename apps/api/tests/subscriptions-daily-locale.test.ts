/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Idioma de los TRES emails que compone el worker diario de suscripciones:
 * el resumen a los admins, el aviso de renovación al suscriptor y el aviso de
 * fin de acceso al comprador.
 *
 * Los tres salían enteros en español —incluida la fecha larga, que se
 * formateaba con `es-ES` cableado— aunque el destinatario tuviera
 * `locale = 'en-US'` en su fila de `user`.
 *
 * Los destinatarios de este worker son emails ARBITRARIOS: un suscriptor de
 * Stripe o un comprador de WooCommerce puede no ser usuario de la plataforma.
 * Por eso el idioma se resuelve por lote contra `user` y quien no tenga fila
 * cae a `HUB_DEFAULT_LOCALE` — un camino degradado nombrado, con test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionsDailyWorker } from '../src/modules/payment-connections/subscriptions-daily.worker';
import { HUB_DEFAULT_LOCALE } from '../src/modules/notifications/email-template-catalog';

const TENANT = 'tenant-1';
const PERIOD_END = new Date('2026-07-24T10:00:00.000Z');

type Sent = { to: string; subject: string; text: string; html: string };

interface Escenario {
  /** Filas de `user` del tenant: email → locale guardado. */
  usuarios?: Record<string, string | null>;
  admins?: string[];
  activeCount?: number;
  upcoming?: Array<{
    productName: string | null;
    unitAmount: number | null;
    currency: string | null;
    userEmail: string;
    currentPeriodEnd: Date;
  }>;
  suscriptores?: Array<{
    id: string;
    userEmail: string;
    productName: string | null;
    currentPeriodEnd: Date;
    unitAmount: number | null;
    currency: string | null;
  }>;
  accesos?: Array<{
    id: string;
    customerEmail: string;
    customerName: string | null;
    products: string[];
    accessEndsAt: Date;
  }>;
  cancelUrl?: string | null;
  /** Fuerza el fallo de la consulta de idiomas (camino degradado). */
  userLookupRevienta?: boolean;
}

function montar(e: Escenario) {
  const enviados: Sent[] = [];
  const usuarios = e.usuarios ?? {};

  const prisma = {
    user: {
      findMany: vi.fn(async (args: { where: { email: { in: string[] } } }) => {
        if (e.userLookupRevienta) throw new Error('db down');
        return args.where.email.in
          .filter((email) => email in usuarios)
          .map((email) => ({ email, locale: usuarios[email] }));
      }),
    },
    tenant: { findUnique: vi.fn().mockResolvedValue({ name: 'Academia Demo' }) },
    modThemingTenantTheme: { findUnique: vi.fn().mockResolvedValue(null) },
    notificationTemplate: { findUnique: vi.fn().mockResolvedValue(null) },
  } as never;

  const service = {
    listTenantsWithVerifiedConnections: vi.fn().mockResolvedValue([TENANT]),
    getSubscriptionDigest: vi
      .fn()
      .mockResolvedValue({ activeCount: e.activeCount ?? 3, upcoming: e.upcoming ?? [] }),
    listTenantAdminEmails: vi.fn().mockResolvedValue(e.admins ?? []),
    listSubscribersToWarn: vi.fn().mockResolvedValue(e.suscriptores ?? []),
    getCancelPortalUrl: vi.fn().mockResolvedValue(e.cancelUrl ?? null),
    markRenewalWarned: vi.fn(),
  };
  const mirror = {
    listTimedAccessToWarn: vi.fn().mockResolvedValue(e.accesos ?? []),
    markExpiryWarned: vi.fn(),
  };
  const registry = {
    getPaymentConnectionsService: () => service,
    getOrderMirrorService: () => mirror,
  } as never;

  const smtp = {
    send: vi.fn(async (_c: unknown, msg: Sent) => {
      enviados.push(msg);
      return { ok: true };
    }),
  } as never;
  const smtpResolver = {
    resolve: vi.fn().mockResolvedValue({ config: { host: 'smtp.example.com' } }),
  } as never;
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

  const worker = new SubscriptionsDailyWorker(registry, smtp, smtpResolver, prisma, logger);
  return { worker, enviados, logger, prisma };
}

/** Corre el barrido completo (sin Redis va in-process). */
async function correr(e: Escenario): Promise<{ enviados: Sent[]; logger: unknown }> {
  const { worker, enviados, logger } = montar(e);
  await worker.triggerNow();
  return { enviados, logger };
}

const UN_SUSCRIPTOR = [
  {
    id: 'sub-1',
    userEmail: 'ana@example.test',
    productName: 'Plan Pro',
    currentPeriodEnd: PERIOD_END,
    unitAmount: 2500,
    currency: 'eur',
  },
];

const UN_ACCESO = [
  {
    id: 'acc-1',
    customerEmail: 'ana@example.test',
    customerName: 'Ana',
    products: ['Acceso ANUAL'],
    accessEndsAt: PERIOD_END,
  },
];

describe('worker diario · resumen a los admins', () => {
  beforeEach(() => vi.clearAllMocks());

  it('cada admin lo recibe en SU idioma, en el mismo barrido', async () => {
    const { enviados } = await correr({
      admins: ['es@x.test', 'en@x.test'],
      usuarios: { 'es@x.test': 'es-ES', 'en@x.test': 'en-US' },
      activeCount: 7,
      upcoming: [
        {
          productName: 'Plan Pro',
          unitAmount: 2500,
          currency: 'eur',
          userEmail: 'ana@example.test',
          currentPeriodEnd: PERIOD_END,
        },
      ],
    });

    const es = enviados.find((m) => m.to === 'es@x.test')!;
    const en = enviados.find((m) => m.to === 'en@x.test')!;

    expect(es.subject).toBe('Resumen de suscripciones — 7 activas, 1 próximas (7 días)');
    expect(es.html).toContain('<html lang="es">');
    expect(es.text).toContain('Suscripciones activas: 7');
    // La fecha de la lista también sale en español.
    expect(es.text).toContain('julio');

    expect(en.subject).toBe('Subscriptions digest — 7 active, 1 upcoming (7 days)');
    expect(en.html).toContain('<html lang="en">');
    expect(en.text).toContain('Active subscriptions: 7');
    expect(en.text).toContain('Renewing/expiring soon');
    // El bug fino: «24 de julio de 2026» en mitad de un email inglés.
    expect(en.text).toContain('July');
    expect(en.text).not.toContain('julio');
  });

  it('sin renovaciones próximas, el «ninguna» también se traduce', async () => {
    const { enviados } = await correr({
      admins: ['en@x.test'],
      usuarios: { 'en@x.test': 'en-US' },
      upcoming: [],
    });
    expect(enviados[0]!.text).toContain('None in the next 7 days.');
    expect(enviados[0]!.text).not.toContain('Ninguna en los próximos');
  });

  it('CAMINO DEGRADADO: un admin sin fila en `user` cae al idioma de referencia', async () => {
    const { enviados } = await correr({ admins: ['fantasma@x.test'], usuarios: {} });
    expect(HUB_DEFAULT_LOCALE).toBe('es-ES');
    expect(enviados[0]!.html).toContain('<html lang="es">');
    expect(enviados[0]!.subject).toContain('Resumen de suscripciones');
  });

  it('CAMINO DEGRADADO: si la consulta de idiomas revienta, el digest sale igual', async () => {
    const { enviados, logger } = await correr({
      admins: ['en@x.test'],
      usuarios: { 'en@x.test': 'en-US' },
      userLookupRevienta: true,
    });
    // Perder el idioma es aceptable; perder el aviso no.
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.html).toContain('<html lang="es">');
    expect((logger as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });
});

describe('worker diario · aviso de renovación al suscriptor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('suscriptor en-US: cuerpo, importe, fecha y botón del portal en inglés', async () => {
    const { enviados } = await correr({
      suscriptores: UN_SUSCRIPTOR,
      usuarios: { 'ana@example.test': 'en-US' },
      cancelUrl: 'https://billing.stripe.test/p/session',
    });

    const mail = enviados[0]!;
    expect(mail.subject).toBe('Your subscription renews soon');
    expect(mail.html).toContain('<html lang="en">');
    expect(mail.text).toContain('Your subscription (Plan Pro) renews on');
    expect(mail.text).toContain('for 25.00 EUR');
    expect(mail.text).toContain('July');
    // El botón del portal es estructural, pero su etiqueta sigue el idioma.
    expect(mail.html).toContain('Manage my subscription');
    expect(mail.html).not.toContain('Gestionar mi suscripción');
    expect(mail.text).not.toContain('se renovará el');
  });

  it('suscriptor es-ES: byte a byte el texto que ya recibía', async () => {
    const { enviados } = await correr({
      suscriptores: UN_SUSCRIPTOR,
      usuarios: { 'ana@example.test': 'es-ES' },
      cancelUrl: 'https://billing.stripe.test/p/session',
    });

    const mail = enviados[0]!;
    expect(mail.subject).toBe('Tu suscripción se renovará pronto');
    expect(mail.html).toContain('<html lang="es">');
    expect(mail.text).toContain('Tu suscripción (Plan Pro) se renovará el 24 de julio de 2026');
    expect(mail.text).toContain('por 25.00 EUR');
    expect(mail.text).toContain(
      'Si no quieres continuar, puedes cancelarla antes de esa fecha con el botón de abajo.',
    );
    expect(mail.text).toContain('Si quieres seguir, no tienes que hacer nada.');
    expect(mail.html).toContain('Gestionar mi suscripción');
  });

  it('sin portal de cancelación, la frase alternativa también se traduce', async () => {
    const { enviados } = await correr({
      suscriptores: UN_SUSCRIPTOR,
      usuarios: { 'ana@example.test': 'en-US' },
      cancelUrl: null,
    });
    expect(enviados[0]!.text).toContain('reply to this email to cancel it');
    expect(enviados[0]!.html).not.toContain('Manage my subscription');
  });

  it('CAMINO DEGRADADO: un suscriptor que no es usuario de la plataforma va en español', async () => {
    // Es el caso NORMAL aquí: la tabla espejo se llena desde Stripe/Woo y el
    // comprador puede no tener cuenta.
    const { enviados } = await correr({ suscriptores: UN_SUSCRIPTOR, usuarios: {} });
    expect(enviados[0]!.subject).toBe('Tu suscripción se renovará pronto');
    expect(enviados[0]!.html).toContain('<html lang="es">');
  });
});

describe('worker diario · aviso de fin de acceso', () => {
  beforeEach(() => vi.clearAllMocks());

  it('comprador en-US: asunto, cuerpo y fecha en inglés', async () => {
    const { enviados } = await correr({
      accesos: UN_ACCESO,
      usuarios: { 'ana@example.test': 'en-US' },
    });

    const mail = enviados[0]!;
    expect(mail.subject).toContain('Your access to Academia Demo ends on');
    expect(mail.subject).toContain('July');
    expect(mail.html).toContain('<html lang="en">');
    expect(mail.text).toContain('Your access to Acceso ANUAL ends on');
    expect(mail.text).toContain('Unlike a subscription, this access does not renew on its own');
    expect(mail.text).not.toContain('A diferencia de una suscripción');
  });

  it('comprador es-ES: byte a byte lo que ya recibía, saludo por nombre incluido', async () => {
    const { enviados } = await correr({
      accesos: UN_ACCESO,
      usuarios: { 'ana@example.test': 'es-ES' },
    });

    const mail = enviados[0]!;
    expect(mail.subject).toBe('Tu acceso a Academia Demo termina el 24 de julio de 2026');
    expect(mail.html).toContain('<html lang="es">');
    expect(mail.text).toContain('Hola Ana,');
    expect(mail.text).toContain('Tu acceso a Acceso ANUAL termina el 24 de julio de 2026.');
    expect(mail.text).toContain(
      'A diferencia de una suscripción, este acceso no se renueva solo: si quieres seguir, tendrás que renovarlo antes de esa fecha.',
    );
  });

  it('sin productos en el pedido, el relleno «tu acceso» también se traduce', async () => {
    const { enviados } = await correr({
      accesos: [{ ...UN_ACCESO[0]!, products: [] }],
      usuarios: { 'ana@example.test': 'en-US' },
    });
    expect(enviados[0]!.text).toContain('your access');
    expect(enviados[0]!.text).not.toContain('tu acceso');
  });
});
