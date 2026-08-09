/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * MUST-FIX 37 — el formateo de las variables de notificación se hace EN EL HUB.
 *
 * Los dos lados que este fichero fija:
 *
 *  1. El ES no cambia NI UN BYTE. Los valores esperados de abajo son los que
 *     producían los `Intl.*` cableados en cada emisor y los literales que
 *     estaban incrustados en su código. Si alguien cambia una opción de
 *     formato, aquí se ve.
 *  2. El EN sale en inglés Y con formato inglés. Que la plantilla estuviera
 *     traducida nunca bastó: el dato viajaba dentro de `variables` ya
 *     convertido en texto español.
 */

import { describe, expect, it, vi } from 'vitest';
import type { NotificationTerm, NotificationValue } from '@didacta/core-kernel';
import {
  HUB_TERMS,
  isNotificationValue,
  resolveHubTerm,
  resolveNotificationValue,
  resolveNotificationVariables,
} from '../src/modules/notifications/hub-values';
import { HUB_TEMPLATE_LANGS } from '../src/modules/notifications/email-template-catalog';
import { PrismaNotificationHubService } from '../src/modules/prisma-notification-hub.service';

const ES = 'es-ES';
const EN = 'en-US';

/**
 * Las DOS implementaciones que había cableadas en los emisores, copiadas tal
 * cual (locale `es-ES` incluido).
 *
 * La comparación se hace contra ellas y no contra un literal a mano porque el
 * literal exacto («a las» vs «,», el espacio fino antes del €) depende de la
 * versión de ICU del Node que ejecute los tests: fijarlo a mano volvería el
 * test frágil en la dimensión equivocada. Lo que este PR promete es que el
 * español NO CAMBIA respecto a lo que había, y eso es exactamente esto.
 */
const legacyZoomBridgeStartsAt = (iso: string, timezone: string) =>
  new Intl.DateTimeFormat('es-ES', {
    timeZone: timezone || 'UTC',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

const legacyReminderStartsAt = (iso: string, timezone: string) =>
  new Intl.DateTimeFormat('es-ES', {
    timeZone: timezone || 'UTC',
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

const legacyReferralsAmount = (cents: number, currency: string) =>
  new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);

describe('hub-values · fechas', () => {
  const iso = '2026-03-14T17:00:00.000Z';

  it('`datetime` (confirmación y cancelación de clase) rinde el ES de siempre', () => {
    const value: NotificationValue = {
      hubValue: 'date',
      iso,
      timeZone: 'Europe/Madrid',
      format: 'datetime',
    };
    // Byte a byte lo que producía `zoom-live-notifications.bridge.ts`.
    expect(resolveNotificationValue(value, ES)).toBe(
      legacyZoomBridgeStartsAt(iso, 'Europe/Madrid'),
    );
    expect(resolveNotificationValue(value, ES)).toContain('14 de marzo de 2026');
    // Y en inglés: mes en inglés, orden inglés, reloj de 12 h.
    const english = resolveNotificationValue(value, EN);
    expect(english).toContain('March 14, 2026');
    expect(english).toContain('06:00 PM');
    expect(english).not.toContain('marzo');
  });

  it('`weekday_datetime` (recordatorio 2 h antes) rinde el ES de siempre', () => {
    const value: NotificationValue = {
      hubValue: 'date',
      iso,
      timeZone: 'Europe/Madrid',
      format: 'weekday_datetime',
    };
    expect(resolveNotificationValue(value, ES)).toBe(legacyReminderStartsAt(iso, 'Europe/Madrid'));
    expect(resolveNotificationValue(value, ES)).toContain('sábado');
    const english = resolveNotificationValue(value, EN);
    expect(english).toContain('Saturday, March 14');
    expect(english).not.toContain('sábado');
  });

  it('la zona horaria manda: la misma fecha en dos zonas da dos horas', () => {
    const madrid: NotificationValue = {
      hubValue: 'date',
      iso,
      timeZone: 'Europe/Madrid',
      format: 'datetime',
    };
    const bogota: NotificationValue = {
      hubValue: 'date',
      iso,
      timeZone: 'America/Bogota',
      format: 'datetime',
    };
    expect(resolveNotificationValue(madrid, ES)).toContain('18:00');
    expect(resolveNotificationValue(bogota, ES)).toContain('12:00');
  });

  it('sin timeZone cae a UTC (mismo default que tenían los emisores)', () => {
    const value: NotificationValue = { hubValue: 'date', iso, format: 'datetime' };
    expect(resolveNotificationValue(value, ES)).toBe(legacyZoomBridgeStartsAt(iso, ''));
    expect(resolveNotificationValue(value, ES)).toContain('17:00');
  });

  it('un locale sin catálogo (pt-BR, alcanzable HOY) cae al de referencia', () => {
    // `ALLOWED_LOCALES` de me.controller.ts admite pt-BR pero no hay catálogo:
    // se formatea en español, igual que el resto del producto.
    const value: NotificationValue = {
      hubValue: 'date',
      iso,
      timeZone: 'Europe/Madrid',
      format: 'datetime',
    };
    expect(resolveNotificationValue(value, 'pt-BR')).toBe(resolveNotificationValue(value, ES));
  });

  it('CAMINO DEGRADADO: ISO ilegible → se manda tal cual, no se pierde el aviso', () => {
    const value: NotificationValue = { hubValue: 'date', iso: 'no-es-una-fecha', format: 'datetime' }; // prettier-ignore
    expect(resolveNotificationValue(value, ES)).toBe('no-es-una-fecha');
  });

  it('CAMINO DEGRADADO: timeZone que Intl rechaza → ISO 8601 en UTC', () => {
    const value: NotificationValue = {
      hubValue: 'date',
      iso,
      timeZone: 'Marte/Olympus',
      format: 'datetime',
    };
    // Es el mismo fallback que ya tenían los dos emisores (`catch { return
    // date.toISOString() }`): una hora fea es peor que no avisar, no al revés.
    expect(resolveNotificationValue(value, ES)).toBe(iso);
  });
});

describe('hub-values · importes', () => {
  it('rinde el ES de siempre y el EN con separadores ingleses', () => {
    const value: NotificationValue = { hubValue: 'money', cents: 123450, currency: 'eur' };
    // Byte a byte lo que producía `referrals-notifications.bridge.ts`.
    expect(resolveNotificationValue(value, ES)).toBe(legacyReferralsAmount(123450, 'eur'));
    // Coma decimal y símbolo detrás en español; punto decimal, coma de miles y
    // símbolo delante en inglés. Es el bug: el referente anglófono leía
    // «You earned a commission of 1.234,50 €!».
    expect(resolveNotificationValue(value, ES)).toContain('1234,50');
    expect(resolveNotificationValue(value, EN)).toBe('€1,234.50');
  });

  it('la moneda se normaliza a mayúsculas (el evento la trae en minúsculas)', () => {
    const lower: NotificationValue = { hubValue: 'money', cents: 1000, currency: 'usd' };
    const upper: NotificationValue = { hubValue: 'money', cents: 1000, currency: 'USD' };
    expect(resolveNotificationValue(lower, ES)).toBe(resolveNotificationValue(upper, ES));
  });

  it('CAMINO DEGRADADO: moneda que Intl no reconoce → importe + código', () => {
    const value: NotificationValue = { hubValue: 'money', cents: 4200, currency: 'xyzzy' };
    expect(resolveNotificationValue(value, ES)).toBe('42.00 XYZZY');
  });
});

describe('hub-values · términos', () => {
  it('los dos idiomas declaran EXACTAMENTE los mismos términos', () => {
    expect(Object.keys(HUB_TERMS.en).sort()).toEqual(Object.keys(HUB_TERMS.es).sort());
    expect(Object.keys(HUB_TERMS)).toEqual([...HUB_TEMPLATE_LANGS]);
  });

  it('ningún término está vacío ni repite el texto del otro idioma sin querer', () => {
    for (const lang of HUB_TEMPLATE_LANGS) {
      for (const [term, text] of Object.entries(HUB_TERMS[lang])) {
        expect(text.trim(), `${lang}/${term} vacío`).not.toBe('');
      }
    }
  });

  it('los dos idiomas interpolan los MISMOS placeholders', () => {
    // Un término inglés que pierda `{{perkTitle}}` deja el email sin el nombre
    // del beneficio y nadie lo ve hasta que alguien lo lee en inglés.
    const vars = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    for (const term of Object.keys(HUB_TERMS.es) as NotificationTerm[]) {
      expect(vars(HUB_TERMS.en[term]), `${term}`).toEqual(vars(HUB_TERMS.es[term]));
    }
  });

  it('los textos ES son LOS MISMOS que estaban incrustados en cada emisor', () => {
    // Se movieron de sitio, no se reescribieron. Si alguien «mejora» uno, el
    // español cambia para todo el mundo y este test lo dice.
    const ESPERADO: Record<NotificationTerm, string> = {
      'quiz.result.passed': 'aprobado',
      'quiz.result.not_passed': 'no aprobado',
      'gamification.perk.approved':
        'Hemos aprobado tu solicitud de "{{perkTitle}}". Te escribimos para cuadrarlo.',
      'gamification.perk.done':
        'Tu solicitud de "{{perkTitle}}" ya está hecha. ¡Esperamos que te haya servido!',
      'gamification.perk.rejected':
        'Esta vez no hemos podido atender tu solicitud de "{{perkTitle}}".',
      'gamification.staff.challenge_submitted': 'Nueva entrega de reto pendiente de revisar.',
      'gamification.staff.perk_requested': 'Alguien ha pedido un beneficio de su nivel.',
      'community.actor.unknown': 'Alguien',
      'learning.course.unknown': 'tu curso',
    };
    expect(HUB_TERMS.es).toEqual(ESPERADO);
  });

  it('un término con vars se interpola en el idioma del destinatario', () => {
    const value: NotificationValue = {
      hubValue: 'term',
      term: 'gamification.perk.approved',
      vars: { perkTitle: 'Sesión 1:1' },
    };
    expect(resolveNotificationValue(value, ES)).toBe(
      'Hemos aprobado tu solicitud de "Sesión 1:1". Te escribimos para cuadrarlo.',
    );
    const english = resolveNotificationValue(value, EN);
    expect(english).toContain('Sesión 1:1');
    expect(english).not.toContain('Hemos aprobado');
  });

  it('resolveHubTerm sin vars devuelve el texto tal cual', () => {
    expect(resolveHubTerm('quiz.result.passed', ES)).toBe('aprobado');
    expect(resolveHubTerm('quiz.result.passed', EN)).toBe('passed');
  });
});

describe('hub-values · resolución del mapa de variables', () => {
  it('resuelve solo los descriptores y deja lo demás intacto', () => {
    const resuelto = resolveNotificationVariables(
      {
        quiz: 'q1',
        scorePercent: 75,
        result: { hubValue: 'term', term: 'quiz.result.passed' },
        amount: { hubValue: 'money', cents: 500, currency: 'eur' },
      },
      EN,
    );
    expect(resuelto).toEqual({
      quiz: 'q1',
      scorePercent: 75,
      result: 'passed',
      amount: '€5.00',
    });
  });

  it('sin ningún descriptor devuelve el MISMO objeto (no reserializa)', () => {
    const original = { course: 'TS', number: 'LS-1' };
    expect(resolveNotificationVariables(original, ES)).toBe(original);
  });

  it('isNotificationValue no confunde un objeto cualquiera con un descriptor', () => {
    expect(isNotificationValue({ hubValue: 'term', term: 'quiz.result.passed' })).toBe(true);
    for (const impostor of [null, undefined, 'texto', 42, [], {}, { hubValue: 'otra-cosa' }]) {
      expect(isNotificationValue(impostor), JSON.stringify(impostor)).toBe(false);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// De punta a punta por el hub real: es lo único que demuestra que el idioma
// que se usa es el del DESTINATARIO y no el del emisor.
// ────────────────────────────────────────────────────────────────────────────

interface FakeRow {
  id: string;
  templateKey: string;
  subject: string | null;
  body: string;
  metadata: Record<string, unknown>;
}

function makePrisma(users: Array<{ id: string; locale: string }>) {
  const rows: FakeRow[] = [];
  let next = 1;
  return {
    userNotificationPreference: { async findUnique() { return null; } }, // prettier-ignore
    notification: {
      async create(args: { data: Partial<FakeRow> }) {
        const row = {
          id: `n-${next++}`,
          templateKey: '',
          subject: null,
          body: '',
          metadata: {},
          ...args.data,
        } as FakeRow;
        rows.push(row);
        return { ...row, createdAt: new Date('2026-03-01T00:00:00.000Z') };
      },
      async update() { return null; }, // prettier-ignore
    },
    user: {
      async findUnique(args: { where: { id: string } }) {
        const u = users.find((x) => x.id === args.where.id);
        return u ? { ...u, tenantId: 't1' } : null;
      },
    },
    notificationTemplate: { async findUnique() { return null; } }, // prettier-ignore
    tenant: { async findUnique() { return { name: 'Acme' }; } }, // prettier-ignore
    modThemingTenantTheme: { async findUnique() { return null; } }, // prettier-ignore
    _rows: rows,
  };
}

const noopLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe('el hub formatea con el idioma del DESTINATARIO, no con el del emisor', () => {
  async function sendTo(locale: string) {
    const prisma = makePrisma([{ id: 'u1', locale }]);
    const svc = new PrismaNotificationHubService(prisma as never, noopLogger);
    await svc.send({
      tenantId: 't1',
      channel: 'in-app',
      templateKey: 'attempt.graded',
      to: 'u1',
      // Sin `locale`: el hub lo resuelve del destinatario. Es EL caso real —
      // un mismo evento se despacha a N personas con N idiomas.
      variables: {
        quiz: 'Quiz final',
        scorePercent: 82,
        result: { hubValue: 'term', term: 'quiz.result.passed' },
      },
    });
    return prisma._rows[0]!;
  }

  it('un destinatario es-ES recibe exactamente lo de siempre', async () => {
    const row = await sendTo('es-ES');
    expect(row.body).toBe(
      'Tu intento del quiz "Quiz final" fue corregido manualmente. Resultado: 82% (aprobado).',
    );
  });

  it('un destinatario en-US recibe la frase Y el dato en inglés', async () => {
    const row = await sendTo('en-US');
    expect(row.body).toBe(
      'Your attempt at the quiz "Quiz final" was graded manually. Result: 82% (passed).',
    );
    // El bug exacto que cierra MUST-FIX 37.
    expect(row.body).not.toContain('aprobado');
  });

  it('la fila persiste TEXTO, nunca el descriptor', async () => {
    // `metadata` la leen `notification-link.ts`, el toaster y el panel: un
    // objeto ahí sería un `[object Object]` en pantalla.
    const row = await sendTo('en-US');
    expect(row.metadata['result']).toBe('passed');
    expect(isNotificationValue(row.metadata['result'])).toBe(false);
  });

  it('el `locale` explícito del caller sigue mandando sobre el del destinatario', async () => {
    const prisma = makePrisma([{ id: 'u1', locale: 'es-ES' }]);
    const svc = new PrismaNotificationHubService(prisma as never, noopLogger);
    await svc.send({
      tenantId: 't1',
      channel: 'in-app',
      templateKey: 'attempt.graded',
      locale: 'en-US',
      to: 'u1',
      variables: {
        quiz: 'Q',
        scorePercent: 50,
        result: { hubValue: 'term', term: 'quiz.result.not_passed' },
      },
    });
    expect(prisma._rows[0]!.body).toContain('(not passed)');
  });

  it('el aviso masivo lleva el pie de baja en el idioma del miembro', async () => {
    // `community.broadcast` es passthrough para el cuerpo del admin, pero el
    // enlace a la publicación y la nota de baja son copy del producto: antes
    // los concatenaba el worker en español dentro de `body`.
    for (const [locale, esperado] of [
      ['es-ES', 'Para dejar de recibir avisos, entra aquí: https://u/unsub'],
      ['en-US', 'To stop receiving notices, go here: https://u/unsub'],
    ] as const) {
      const prisma = makePrisma([{ id: 'u1', locale }]);
      const svc = new PrismaNotificationHubService(prisma as never, noopLogger);
      await svc.send({
        tenantId: 't1',
        channel: 'email',
        templateKey: 'community.broadcast',
        to: 'u1',
        variables: {
          subject: 'Nos vemos el jueves',
          body: 'Cuerpo escrito por el admin.',
          postUrl: 'https://u/comunidad',
          unsubUrl: 'https://u/unsub',
        },
      });
      const body = prisma._rows[0]!.body;
      // El cuerpo del admin NO se traduce (es suyo) y va el primero.
      expect(body.startsWith('Cuerpo escrito por el admin.')).toBe(true);
      expect(body).toContain(esperado);
    }
  });

  it('sin `unsubUrl` (el aviso in-app) el pie de baja desaparece, como antes', async () => {
    const prisma = makePrisma([{ id: 'u1', locale: 'es-ES' }]);
    const svc = new PrismaNotificationHubService(prisma as never, noopLogger);
    await svc.send({
      tenantId: 't1',
      channel: 'in-app',
      templateKey: 'community.broadcast',
      to: 'u1',
      variables: { subject: 'S', body: 'Cuerpo.', postUrl: '' },
    });
    expect(prisma._rows[0]!.body).toBe('Cuerpo.');
  });
});
