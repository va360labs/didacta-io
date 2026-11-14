/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Correos de la oferta al darse de baja: textos (es/en/pt, con fechas e
 * importes concretos) y el puente que los envía en el idioma del alumno con
 * la marca del aula.
 */

import { describe, expect, it, vi } from 'vitest';
import { RetentionMailerBridge } from '../src/modules/subscriptions/retention-mailer.bridge';
import {
  cancelConfirmedTexts,
  discountAppliedTexts,
  pauseConfirmedTexts,
} from '../src/modules/subscriptions/retention-email-texts';

const START = new Date('2026-12-14T17:29:11Z');
const END = new Date('2027-02-14T17:29:11Z');
const common = { name: 'Lucía', academy: 'Primer Sorbo', item: 'Mensual' };

describe('textos', () => {
  it('pausa: hasta cuándo sigue igual, de cuándo a cuándo sin cobro ni acceso, y que vuelve sola', () => {
    const es = pauseConfirmedTexts({
      ...common,
      lang: 'es',
      startsAt: START,
      endsAt: END,
      months: 2,
    });
    expect(es.subject).toBe('Tu suscripción queda en pausa');
    expect(es.body).toContain('Hola, Lucía:');
    expect(es.body).toContain(
      'Del 14 de diciembre de 2026 al 14 de febrero de 2027 no se te cobrará nada',
    );
    expect(es.body).toContain('Tu cuenta, tu progreso y tus certificados se quedan como están');
    const en = pauseConfirmedTexts({
      ...common,
      lang: 'en',
      startsAt: START,
      endsAt: END,
      months: 2,
    });
    expect(en.body).toContain("From 14 December 2026 to 14 February 2027 you won't be charged");
    const pt = pauseConfirmedTexts({
      ...common,
      lang: 'pt',
      startsAt: START,
      endsAt: END,
      months: 2,
    });
    expect(pt.body).toContain(
      'De 14 de dezembro de 2026 a 14 de fevereiro de 2027 você não será cobrado',
    );
  });

  it('descuento: importes antes y después, N pagos o la siguiente renovación', () => {
    const es = discountAppliedTexts({
      ...common,
      lang: 'es',
      percent: 30,
      months: 3,
      amountCents: 2900,
      discountedAmountCents: 2030,
      currency: 'eur',
      nextChargeAt: START,
    });
    // Espacio duro entre el número y el %: nunca se parte en dos líneas.
    expect(es.subject).toBe('Te quedas con un 30 % de descuento');
    expect(es.body).toMatch(/Tus próximos 3 pagos serán de 20,30\s€ en vez de 29,00\s€/);
    const once = discountAppliedTexts({
      ...common,
      lang: 'en',
      percent: 30,
      months: null,
      amountCents: 29000,
      discountedAmountCents: 20300,
      currency: 'eur',
      nextChargeAt: START,
    });
    expect(once.body).toContain(
      'Your next renewal (14 December 2026) will be €203.00 instead of €290.00',
    );
    const pt = discountAppliedTexts({
      ...common,
      lang: 'pt',
      percent: 30,
      months: 1,
      amountCents: 2900,
      discountedAmountCents: 2030,
      currency: 'eur',
      nextChargeAt: START,
    });
    expect(pt.body).toContain('Seu próximo pagamento será de');
  });

  it('baja: hasta cuándo conserva el acceso', () => {
    const es = cancelConfirmedTexts({ ...common, lang: 'es', accessEndsAt: START });
    expect(es.subject).toBe('Tu baja está confirmada');
    expect(es.body).toContain('Sigues teniendo acceso hasta el 14 de diciembre de 2026');
    const pt = cancelConfirmedTexts({ ...common, lang: 'pt', accessEndsAt: null });
    expect(pt.body).not.toContain('mantém o acesso');
  });

  it('en portugués nunca «academia» ni «aula»; en inglés ni una palabra en español', () => {
    const all = [
      pauseConfirmedTexts({ ...common, lang: 'pt', startsAt: START, endsAt: END, months: 2 }),
      discountAppliedTexts({
        ...common,
        lang: 'pt',
        percent: 30,
        months: 3,
        amountCents: 2900,
        discountedAmountCents: 2030,
        currency: 'eur',
        nextChargeAt: START,
      }),
      cancelConfirmedTexts({ ...common, lang: 'pt', accessEndsAt: START }),
    ];
    for (const t of all) {
      expect(`${t.subject} ${t.title} ${t.body} ${t.cta}`).not.toMatch(/academia|\baula\b/i);
    }
    const en = cancelConfirmedTexts({ ...common, lang: 'en', accessEndsAt: START });
    expect(`${en.subject} ${en.body}`).not.toMatch(/suscripci|baja|cuota|tienes/i);
  });
});

describe('RetentionMailerBridge', () => {
  function build(opts: { smtp?: boolean; locale?: string | null } = {}) {
    const handlers = new Map<string, (e: unknown) => Promise<void>>();
    const send = vi.fn(async () => ({ ok: true }));
    const prisma = {
      user: {
        findFirst: vi.fn(async () => ({
          email: 'lucia@example.com',
          name: 'Lucía',
          locale: opts.locale === undefined ? 'en' : opts.locale,
        })),
      },
      modSubscriptionsPlan: { findFirst: vi.fn(async () => ({ name: 'Mensual' })) },
      modCoursesCourse: { findFirst: vi.fn(async () => null) },
      tenant: { findUnique: vi.fn(async () => ({ name: 'Primer Sorbo' })) },
      modThemingTenantTheme: { findUnique: vi.fn(async () => null) },
    };
    const bridge = new RetentionMailerBridge(
      { getEventBus: () => ({ subscribe: (n: string, h: never) => handlers.set(n, h) }) } as never,
      prisma as never,
      { resolveTenantWebBaseUrlForBackground: async () => 'https://primer-sorbo.test' } as never,
      { resolve: async () => (opts.smtp === false ? null : { config: { host: 'smtp' } }) } as never,
      { send } as never,
      { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    );
    bridge.onModuleInit();
    return { bridge, handlers, send, prisma };
  }

  const event = (name: string, data: Record<string, unknown>) => ({
    name,
    version: 1,
    data: { subscriptionId: 's1', userId: 'u1', planId: 'p1', ...data },
    metadata: { tenantId: 't1', timestamp: new Date().toISOString() },
  });

  it('escucha las tres decisiones', () => {
    const { handlers } = build();
    expect([...handlers.keys()].sort()).toEqual([
      'subscriptions.retention.canceled',
      'subscriptions.retention.discounted',
      'subscriptions.retention.paused',
    ]);
  });

  it('pausa: en el idioma del alumno, con su plan y el botón a su suscripción', async () => {
    const { handlers, send, prisma } = build({ locale: 'en' });
    await handlers.get('subscriptions.retention.paused')!(
      event('subscriptions.retention.paused', {
        months: 2,
        pauseStartsAt: START.toISOString(),
        pauseEndsAt: END.toISOString(),
      }),
    );
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u1', tenantId: 't1' } }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    const [, mail, fromName] = send.mock.calls[0] as unknown as [
      unknown,
      { to: string; subject: string; html: string; text: string },
      string,
    ];
    expect(mail.to).toBe('lucia@example.com');
    expect(mail.subject).toBe('Your subscription is on pause');
    expect(mail.text).toContain('Mensual');
    expect(mail.html).toContain('https://primer-sorbo.test/account?tab=subscription');
    expect(fromName).toBe('Primer Sorbo');
  });

  it('sin correo configurado en el aula no envía ni lanza', async () => {
    const { handlers, send } = build({ smtp: false });
    await expect(
      handlers.get('subscriptions.retention.canceled')!(
        event('subscriptions.retention.canceled', { accessEndsAt: START.toISOString() }),
      ),
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('si el envío revienta, no lanza (no se reintenta un correo que pudo salir)', async () => {
    const { handlers, send } = build();
    send.mockRejectedValueOnce(new Error('SMTP caído'));
    await expect(
      handlers.get('subscriptions.retention.discounted')!(
        event('subscriptions.retention.discounted', {
          percent: 30,
          months: 3,
          duration: 'repeating',
          amountCents: 2900,
          discountedAmountCents: 2030,
          currency: 'eur',
          nextChargeAt: START.toISOString(),
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
