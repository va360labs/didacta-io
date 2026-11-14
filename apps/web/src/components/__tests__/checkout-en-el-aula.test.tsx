/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * El pago dentro del aula, en la web: cómo se lee la respuesta del checkout,
 * qué dice la pantalla de gracias según el pago, que la casilla explique por
 * qué no se puede pagar, y que el resumen enseñe el importe de la SESIÓN.
 *
 * @vitest-environment jsdom
 */

import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { AcademyCheckoutStep } from '@/components/checkout/academy-checkout-step';
import { PurchaseThanks } from '@/components/checkout/purchase-thanks';
import { WithdrawalWaiverCheckbox } from '@/components/withdrawal-waiver-checkbox';
import en from '@/i18n/messages/en';
import es from '@/i18n/messages/es';
import pt from '@/i18n/messages/pt';
import { checkoutOutcome, isCheckoutSessionId, normalizeCheckoutStart } from '@/lib/checkout';

function html(node: ReactNode, messages: Record<string, unknown> = es, locale = 'es-ES') {
  return renderToString(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Europe/Madrid">
      {node}
    </NextIntlClientProvider>,
  );
}

describe('normalizeCheckoutStart', () => {
  it('embebido: secreto, clave publicable e importe de la sesión', () => {
    expect(
      normalizeCheckoutStart({
        mode: 'embedded',
        sessionId: 'cs_test_1',
        url: null,
        clientSecret: 'cs_test_1_secret',
        publishableKey: 'pk_test_x',
        amountTotal: 100,
        currency: 'eur',
      }),
    ).toEqual({
      mode: 'embedded',
      sessionId: 'cs_test_1',
      clientSecret: 'cs_test_1_secret',
      publishableKey: 'pk_test_x',
      amountTotal: 100,
      currency: 'eur',
    });
  });

  it('una API anterior (solo url) o sin clave publicable es el redirect', () => {
    expect(normalizeCheckoutStart({ sessionId: 'cs_1', url: 'https://stripe/x' })).toEqual({
      mode: 'hosted',
      sessionId: 'cs_1',
      url: 'https://stripe/x',
    });
    expect(
      normalizeCheckoutStart({
        mode: 'embedded',
        sessionId: 'cs_1',
        clientSecret: 'cs_1_secret',
        url: 'https://stripe/x',
      }),
    ).toMatchObject({ mode: 'hosted' });
    expect(() => normalizeCheckoutStart({ sessionId: 'cs_1' })).toThrow();
  });
});

describe('vuelta del pago', () => {
  it('solo se dice «pagado» si consta el cobro', () => {
    const base = { amount: 100, currency: 'eur', at: null };
    expect(checkoutOutcome({ ...base, status: 'complete', paid: true })).toBe('paid');
    expect(checkoutOutcome({ ...base, status: 'complete', paid: false })).toBe('pending');
    expect(checkoutOutcome({ ...base, status: 'open', paid: false })).toBe('unpaid');
    expect(checkoutOutcome({ ...base, status: 'expired', paid: false })).toBe('unpaid');
    expect(checkoutOutcome(null)).toBe('unknown');
  });

  it('id de sesión: solo cs_test_/cs_live_', () => {
    expect(isCheckoutSessionId('cs_test_a1B2c3D4e5F6')).toBe(true);
    expect(isCheckoutSessionId('cs_live_a1B2c3D4e5F6')).toBe(true);
    expect(isCheckoutSessionId('{CHECKOUT_SESSION_ID}')).toBe(false);
    expect(isCheckoutSessionId('cs_test_../x')).toBe(false);
    expect(isCheckoutSessionId(null)).toBe(false);
  });

  it('pagado: qué, cuánto, cuándo y «Entrar al curso»; nunca el id de la sesión', () => {
    const out = html(
      <PurchaseThanks
        outcome="paid"
        summary={{
          kind: 'course',
          title: 'Espresso en casa',
          imageUrl: '/portada.jpg',
          amount: 100,
          currency: 'eur',
          at: '2026-11-14T10:00:00.000Z',
        }}
        signedIn={false}
        nextPath="/courses/espresso"
        retryHref="/catalog/espresso"
      />,
    );
    expect(out).toContain('¡Pago completado!');
    expect(out).toContain('Espresso en casa');
    expect(out).toContain('/portada.jpg');
    expect(out).toMatch(/>1\s€</);
    expect(out).toContain('14 de noviembre de 2026');
    expect(out).toContain('Entrar al curso');
    expect(out).not.toContain('cs_');
    expect(out).not.toContain('Referencia');
  });

  it('no pagado: lo dice y deja reintentar, sin «gracias»', () => {
    const out = html(
      <PurchaseThanks
        outcome="unpaid"
        summary={null}
        signedIn={false}
        nextPath="/courses/espresso"
        retryHref="/catalog/espresso"
      />,
    );
    expect(out).toContain('El pago no se ha completado');
    expect(out).toContain('/catalog/espresso');
    expect(out).not.toContain('¡Pago completado!');
  });

  it('en portugués habla de «escola», no de «aula» ni en español', () => {
    const out = html(
      <PurchaseThanks
        outcome="paid"
        summary={{
          kind: 'membership',
          title: 'Mensal',
          imageUrl: null,
          amount: 1900,
          currency: 'brl',
          at: null,
        }}
        signedIn
        nextPath="/courses"
        retryHref="/join"
      />,
      pt,
      'pt-BR',
    );
    expect(out).toContain('Entrar na escola');
    expect(out).not.toMatch(/academia|Pago completado/);
  });
});

describe('la casilla dice por qué no se puede pagar', () => {
  const waiver = {
    version: '2026-11-13',
    locale: 'es',
    statement: 'Quiero acceder ahora mismo.',
    sellerLine: 'Vende: Primer Sorbo.',
    sellerName: 'Primer Sorbo',
    text: 'Quiero acceder ahora mismo. Vende: Primer Sorbo.',
  } as never;

  it('sin marcar: el aviso está a la vista; señalada: resaltada y marcada como inválida', () => {
    const quiet = html(
      <WithdrawalWaiverCheckbox
        waiver={waiver}
        failed={false}
        checked={false}
        onCheckedChange={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(quiet).toContain('Marca la casilla para poder pagar.');
    expect(quiet).not.toContain('data-nudge');
    const nudged = html(
      <WithdrawalWaiverCheckbox
        waiver={waiver}
        failed={false}
        checked={false}
        onCheckedChange={() => {}}
        onRetry={() => {}}
        nudge
      />,
    );
    expect(nudged).toContain('data-nudge="true"');
    expect(nudged).toContain('aria-invalid="true"');
  });

  it('marcada: sin aviso', () => {
    const out = html(
      <WithdrawalWaiverCheckbox
        waiver={waiver}
        failed={false}
        checked
        onCheckedChange={() => {}}
        onRetry={() => {}}
        nudge
      />,
    );
    expect(out).not.toContain('Marca la casilla para poder');
    expect(out).not.toContain('data-nudge');
  });
});

describe('el paso de pago dentro del aula', () => {
  it('marca del aula, producto, quien lo imparte y el total DE LA SESIÓN («Precio final»)', () => {
    const out = html(
      <AcademyCheckoutStep
        academy={{ name: 'Primer Sorbo', logoUrl: '/logo.png', logoDisplayMode: 'logo_and_name' }}
        item={{ kind: 'course', title: 'Espresso en casa', detail: null, imageUrl: '/p.jpg' }}
        amount={100}
        currency="eur"
        totalNote={null}
        seller={{
          name: 'Primer Sorbo',
          creator: { name: 'Lucía Prieto', avatarUrl: null },
          contactEmail: 'hola@primersorbo.test',
        }}
        clientSecret="cs_test_1_secret"
        publishableKey="pk_test_x"
        onBack={() => {}}
        onUnavailable={() => {}}
      />,
      en,
      'en-US',
    );
    expect(out).toContain('Primer Sorbo');
    expect(out).toContain('/logo.png');
    expect(out).toContain('Espresso en casa');
    expect(out).toContain('Taught by Lucía Prieto');
    expect(out).toContain('>€1<');
    expect(out).toContain('Final price');
    expect(out).toContain('Secure payment with Stripe');
    expect(out).toContain('hola@primersorbo.test');
    // El secreto no se pinta en el HTML: solo lo usa Stripe.js.
    expect(out).not.toContain('cs_test_1_secret');
    expect(out).not.toContain('VAT');
  });
});
