// @vitest-environment jsdom

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * «Darme de baja» pintado de verdad (react-dom, catálogos reales): solo se
 * sustituye la red. Fija el recorrido (motivo → oferta o confirmación → hecho),
 * lo que se manda a la API y que en portugués e inglés no se cuela español.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/i18n/messages/en';
import es from '@/i18n/messages/es';
import pt from '@/i18n/messages/pt';
import type { LeaveOffer, SubscriptionRow } from '@/modules/subscriptions';
import { LeaveSubscriptionDialog } from './leave-subscription-dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUB = {
  id: '5b1c8f0e-3c2a-4d8e-9f10-2a3b4c5d6e7f',
  planId: 'p1',
  courseId: null,
  status: 'ACTIVE',
  unitAmount: 2900,
  currency: 'eur',
  interval: 'month',
  currentPeriodEnd: '2026-12-14T17:29:11.000Z',
  cancelAtPeriodEnd: false,
} as unknown as SubscriptionRow;

const OFFER: LeaveOffer = {
  subscriptionId: SUB.id,
  canLeave: true,
  reasons: [
    'too_expensive',
    'no_time',
    'not_expected',
    'learned_enough',
    'missing_topics',
    'other',
  ],
  accessEndsAt: '2026-12-14T17:29:11.000Z',
  pause: {
    months: [1, 2, 3],
    startsAt: '2026-12-14T17:29:11.000Z',
    endsAtByMonths: {
      '1': '2027-01-14T17:29:11.000Z',
      '2': '2027-02-14T17:29:11.000Z',
      '3': '2027-03-14T17:29:11.000Z',
    },
  },
  discount: {
    percent: 30,
    months: 3,
    duration: 'repeating',
    amountCents: 2900,
    discountedAmountCents: 2030,
    currency: 'eur',
    nextChargeAt: '2026-12-14T17:29:11.000Z',
  },
};

const NO_OFFER: LeaveOffer = { ...OFFER, pause: null, discount: null };

const CATALOGS = { es, en, pt } as const;
const LOCALES = { es: 'es-ES', en: 'en-US', pt: 'pt-BR' } as const;
const mounted: Array<{ root: Root; container: HTMLElement }> = [];
let posted: unknown[] = [];

function stubApi(offer: LeaveOffer, outcome: 'PAUSED' | 'DISCOUNTED' | 'CANCELED') {
  posted = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/me/${SUB.id}/leave`) && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify(offer), { status: 200 });
      }
      if (url.endsWith(`/me/${SUB.id}/leave`) && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)));
        const row =
          outcome === 'PAUSED'
            ? {
                ...SUB,
                pauseStartsAt: '2026-12-14T17:29:11.000Z',
                pauseEndsAt: '2027-02-14T17:29:11.000Z',
              }
            : outcome === 'CANCELED'
              ? { ...SUB, cancelAtPeriodEnd: true }
              : SUB;
        return new Response(JSON.stringify({ outcome, subscription: row }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }),
  );
}

async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render(locale: keyof typeof CATALOGS, onDone = vi.fn()) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <NextIntlClientProvider
        locale={LOCALES[locale]}
        messages={CATALOGS[locale] as never}
        timeZone="UTC"
      >
        <LeaveSubscriptionDialog
          sub={SUB}
          itemName="Mensual"
          open
          onOpenChange={() => undefined}
          onDone={onDone}
        />
      </NextIntlClientProvider>,
    );
  });
  await settle();
  return onDone;
}

const q = (sel: string) => document.body.querySelector<HTMLElement>(sel);
async function click(sel: string) {
  const el = q(sel);
  if (!el) throw new Error(`no está ${sel}`);
  await act(async () => el.click());
  await settle();
}
async function pickReason(reason: string) {
  const input = q(`[data-testid="baja-motivo-${reason}"] input`) as HTMLInputElement;
  await act(async () => input.click());
}

beforeEach(() => {
  localStorage.setItem('didacta.access_token', 'token-de-prueba');
});

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('«Darme de baja»', () => {
  it('pide el motivo antes de seguir; con oferta, pausa los meses elegidos', async () => {
    stubApi(OFFER, 'PAUSED');
    const onDone = await render('es');
    const dialog = q('[data-testid="baja-dialogo"]')!;
    expect(dialog.textContent).toContain('¿Por qué te quieres ir?');
    expect(dialog.querySelectorAll('input[type="radio"]')).toHaveLength(6);
    expect((q('[data-testid="baja-seguir"]') as HTMLButtonElement).disabled).toBe(true);
    await pickReason('no_time');
    await click('[data-testid="baja-seguir"]');
    const pausa = q('[data-testid="baja-oferta-pausa"]')!;
    expect(pausa.textContent).toContain('Lo que ya pagaste sigue hasta el 14 de diciembre de 2026');
    expect(q('[data-testid="baja-oferta-descuento"]')!.textContent).toMatch(
      /Tus próximos 3 pagos serán de 20,30\s€ en vez de 29,00\s€/,
    );
    // La baja de siempre sigue a la vista, con hasta cuándo hay acceso.
    expect(q('[data-testid="baja-dialogo"]')!.textContent).toContain(
      'sigues teniendo acceso hasta el 14 de diciembre de 2026',
    );
    await click('[data-testid="baja-pausa-2"]');
    await click('[data-testid="baja-pausar"]');
    expect(posted).toEqual([
      { reason: 'no_time', reasonText: null, choice: 'pause', pauseMonths: 2 },
    ]);
    expect(q('[data-testid="baja-listo"]')!.textContent).toContain(
      'del 14 de diciembre de 2026 al 14 de febrero de 2027',
    );
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ id: SUB.id }), 'PAUSED');
  });

  it('descuento: manda el motivo y el texto libre', async () => {
    stubApi(OFFER, 'DISCOUNTED');
    await render('es');
    await pickReason('too_expensive');
    const textarea = q('#baja-texto') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, '  Ahora mismo no llego  ');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('[data-testid="baja-seguir"]');
    await click('[data-testid="baja-descuento"]');
    expect(posted).toEqual([
      { reason: 'too_expensive', reasonText: 'Ahora mismo no llego', choice: 'discount' },
    ]);
    expect(q('[data-testid="baja-listo"]')!.textContent).toContain('30 % de descuento');
  });

  it('sin nada que ofrecer: confirmar la baja directamente', async () => {
    stubApi(NO_OFFER, 'CANCELED');
    await render('es');
    await pickReason('learned_enough');
    await click('[data-testid="baja-seguir"]');
    expect(q('[data-testid="baja-oferta-pausa"]')).toBeNull();
    await click('[data-testid="baja-confirmar"]');
    expect(posted).toEqual([{ reason: 'learned_enough', reasonText: null, choice: 'cancel' }]);
    expect(q('[data-testid="baja-listo"]')!.textContent).toContain('Tu baja está confirmada');
  });

  it('en portugués y en inglés no se cuela español', async () => {
    for (const locale of ['pt', 'en'] as const) {
      stubApi(OFFER, 'PAUSED');
      await render(locale);
      await pickReason('no_time');
      await click('[data-testid="baja-seguir"]');
      const text = q('[data-testid="baja-dialogo"]')!.textContent ?? '';
      expect(text).not.toMatch(
        /Darme de baja|suscripción|pausa tu|descuento|cuota|diciembre|enero|quédate/i,
      );
      for (const { root, container } of mounted.splice(0)) {
        await act(async () => root.unmount());
        container.remove();
      }
    }
  });
});
