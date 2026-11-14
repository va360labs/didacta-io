// @vitest-environment jsdom

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * «Tus datos fiscales» pintado de verdad (react-dom a pelo, catálogos reales y
 * la API inyectada).
 *
 * Prueba real del 14-nov-2026:
 *  - «¿particular o empresa?» se preguntaba TRES veces (al conectar, en Stripe y
 *    aquí). Si ya se sabe (se eligió al conectar y Stripe lo propone, o los
 *    datos ya están guardados) aquí se enseña con «Cambiar», sin preguntar.
 *  - El texto hablaba de «normativa DAC7» y repetía lo de Stripe dos veces.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en';
import es from '@/i18n/messages/es';
import pt from '@/i18n/messages/pt';
import type { PayoutsTaxProfileDto, payoutsApi } from '@/lib/payouts';
import { PayoutsTaxProfileCard, entityKnown } from '../payouts-tax-profile-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CATALOGS = { es, en, pt } as const;
const LOCALES = { es: 'es-ES', en: 'en-US', pt: 'pt-BR' } as const;

/** Sin datos guardados, con lo que propone Stripe tras conectar como particular. */
function fromStripe(): PayoutsTaxProfileDto {
  return {
    status: 'missing',
    required: true,
    profile: null,
    prefill: {
      entityType: 'individual',
      legalName: 'Ana Prueba',
      country: 'ES',
      address: {
        line1: 'Calle Ancha 1',
        line2: null,
        postalCode: '11001',
        city: 'Cádiz',
        region: 'Cádiz',
      },
      birthDate: '1990-02-28',
    },
    missing: ['taxId'],
    heldSales: 0,
  };
}

/** Sin cuenta de Stripe ni datos: no hay nada que proponer. */
function empty(): PayoutsTaxProfileDto {
  return {
    status: 'missing',
    required: true,
    profile: null,
    prefill: null,
    missing: ['entityType', 'legalName', 'taxId'],
    heldSales: 0,
  };
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

async function render(locale: keyof typeof CATALOGS, dto: PayoutsTaxProfileDto) {
  const api = {
    taxProfile: async () => dto,
    saveTaxProfile: async () => dto,
  } as unknown as Pick<typeof payoutsApi, 'taxProfile' | 'saveTaxProfile'>;
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
        <PayoutsTaxProfileCard api={api} />
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return container;
}

const radios = (c: HTMLElement) => c.querySelectorAll('input[name="tax-entity"]');

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

describe('datos fiscales: particular o empresa, una sola vez', () => {
  it('ya elegido al conectar (Stripe lo propone): se enseña con «Cambiar», sin preguntar', async () => {
    const c = await render('es', fromStripe());
    expect(radios(c)).toHaveLength(0);
    const known = c.querySelector('[data-testid="tax-entity-known"]')!;
    expect(known.textContent).toContain('Particular o autónomo');
    const change = [...known.querySelectorAll('button')].find((b) => b.textContent === 'Cambiar')!;
    await act(async () => change.click());
    expect(radios(c)).toHaveLength(2);
    expect(c.querySelector('[data-testid="tax-entity-known"]')).toBeNull();
  });

  it('sin nada que proponer (aún no conectó cobros), sí se pregunta (control)', async () => {
    const c = await render('es', empty());
    expect(radios(c)).toHaveLength(2);
    expect(c.querySelector('[data-testid="tax-entity-known"]')).toBeNull();
  });

  it('entityKnown: lo guardado o lo propuesto cuenta; nada, no', () => {
    expect(entityKnown(fromStripe())).toBe(true);
    expect(entityKnown(empty())).toBe(false);
  });
});

describe('datos fiscales: el porqué en una frase llana', () => {
  it.each([
    ['es', 'La ley obliga a las plataformas a informar a Hacienda de lo que venden los creadores'],
    ['en', 'The law requires platforms to report what creators sell to the tax authorities'],
    ['pt', 'A lei obriga as plataformas a informar ao fisco o que os criadores vendem'],
  ] as const)('%s: sin «DAC7» y sin repetir lo de Stripe', async (locale, sentence) => {
    const intro = CATALOGS[locale].adminPagos.payouts.tax.intro;
    expect(intro).toContain(sentence);
    expect(intro).not.toMatch(/DAC ?7/i);
    expect(intro).not.toMatch(/Stripe/);
    // Lo de «lo que ya sabía Stripe» queda solo en la nota de la propuesta.
    const c = await render(locale, fromStripe());
    const text = c.textContent ?? '';
    expect(text).toContain(sentence);
    expect(text.match(/Stripe/g) ?? []).toHaveLength(1);
  });
});
