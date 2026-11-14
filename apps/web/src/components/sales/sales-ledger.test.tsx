// @vitest-environment jsdom

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * «Todas tus ventas» pintado de verdad (react-dom a pelo, como
 * `start-here.test.tsx`): solo se sustituye la red. Lo que pedía Valentín:
 * ver quién compró (nombre y correo), poder abrir cada venta y exportar con
 * los filtros puestos; y que se refresque sola al volver a la pestaña.
 */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/i18n/messages/en';
import es from '@/i18n/messages/es';
import pt from '@/i18n/messages/pt';
import { SalesLedger } from './sales-ledger';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SALE = {
  id: 'order:7b0c3f6e-1d2a-4c55-9a0e-2f3b4c5d6e7f',
  kind: 'order',
  at: '2026-11-14T12:05:00.000Z',
  buyer: {
    userId: 'u-1',
    name: 'Ana Prueba',
    email: 'ana@example.com',
    checkoutEmail: null,
    country: 'PT',
    deleted: false,
  },
  product: {
    kind: 'course',
    ref: 'course:c1',
    title: 'Torno para principiantes',
    option: null,
    intervalMonths: null,
  },
  amount: 4900,
  currency: 'eur',
  coupon: null,
  referralCredit: null,
  referral: {
    referrerUserId: 'u-2',
    referrerName: 'Bea Alumna',
    code: 'bea',
    commission: 1470,
    commissionCurrency: 'eur',
    commissionStatus: 'PENDING',
  },
  settlement: {
    currency: 'eur',
    gross: 4900,
    cardFee: 179,
    platformFee: 245,
    net: 4476,
    debtNetted: 0,
    refunded: 0,
  },
  status: 'transferred',
  refundState: 'none',
  payoutSaleId: 'p-1',
};

const PAGE = {
  items: [SALE],
  page: 1,
  pageSize: 25,
  total: 1,
  totals: [{ currency: 'eur', count: 1, amount: 4900 }],
  products: [{ ref: 'course:c1', kind: 'course', title: 'Torno para principiantes' }],
  platform: { operatorName: 'Didacta', feeBps: 500 },
};

const DETAIL = {
  sale: SALE,
  payout: null,
  events: [
    { type: 'paid', at: SALE.at, amount: 4900, currency: 'eur' },
    { type: 'transferred', at: '2026-11-15T09:00:00.000Z', amount: 4476, currency: 'eur' },
  ],
  hostedInvoiceUrl: null,
  period: null,
  platform: { operatorName: 'Didacta', feeBps: 500 },
};

let calls: string[] = [];
const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function stubApi() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/admin/sales/export')) {
        return new Response(`${String.fromCharCode(0xfeff)}Fecha`, {
          status: 200,
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="ventas-2026-11-14.csv"',
          },
        });
      }
      const body = url.includes('/admin/sales/order%3A') ? DETAIL : PAGE;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

const CATALOGS = { es, en, pt } as const;
const LOCALES = { es: 'es-ES', en: 'en-US', pt: 'pt-BR' } as const;

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(locale: keyof typeof CATALOGS): Promise<HTMLElement> {
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
        <SalesLedger />
      </NextIntlClientProvider>,
    );
  });
  await settle();
  return container;
}

beforeEach(() => {
  localStorage.setItem('didacta.access_token', 'token-de-prueba');
  stubApi();
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

const listCalls = () => calls.filter((u) => /\/api\/v1\/admin\/sales\?/.test(u));

describe('«Todas tus ventas»', () => {
  it('cada venta con nombre, correo, país, producto, referido, neto y estado', async () => {
    const c = await render('es');
    const fila = c.querySelector('[data-testid="venta-fila"]')!;
    expect(fila.textContent).toContain('Ana Prueba');
    expect(fila.textContent).toContain('ana@example.com');
    expect(fila.textContent).toContain('Portugal');
    expect(fila.textContent).toContain('Torno para principiantes');
    expect(fila.textContent).toContain('Traída por Bea Alumna');
    expect(fila.textContent).toMatch(/44,76\s€/);
    expect(fila.textContent).toMatch(/Tarjeta 1,79\s€ · Didacta 2,45\s€/);
    expect(fila.textContent).toContain('Transferida');
    expect(c.querySelector('[data-testid="ventas-total"]')!.textContent).toMatch(
      /1 venta · 49,00\s€/,
    );
  });

  it('al pulsar una venta se abre su recibo con lo que le llega y cómo escribirle', async () => {
    const c = await render('es');
    await act(async () => {
      (c.querySelector('[data-testid="venta-comprador"]') as HTMLButtonElement).click();
    });
    await settle();
    expect(
      calls.some((u) =>
        u.endsWith('/api/v1/admin/sales/order%3A7b0c3f6e-1d2a-4c55-9a0e-2f3b4c5d6e7f'),
      ),
    ).toBe(true);
    const detalle = document.querySelector('[data-testid="venta-detalle"]')!;
    expect(detalle.querySelector('[data-testid="detalle-nombre"]')!.textContent).toBe('Ana Prueba');
    expect(detalle.querySelector('[data-testid="detalle-neto"]')!.textContent).toMatch(/44,76\s€/);
    const escribir = detalle.querySelector('[data-testid="detalle-escribir"]')!;
    expect(escribir.getAttribute('href')).toMatch(
      /^mailto:ana@example\.com\?subject=Tu%20compra%20de%20Torno/,
    );
    expect(detalle.querySelector('[data-testid="detalle-ver-alumno"]')!.getAttribute('href')).toBe(
      '/u/u-1',
    );
    // Sin venta de la plataforma no hay botón de reembolsar (lo explica).
    expect(detalle.querySelector('[data-testid="detalle-reembolsar"]')).toBeNull();
  });

  it('filtrar por estado vuelve a pedir con el filtro, y exportar lleva los mismos filtros', async () => {
    const c = await render('es');
    const select = c.querySelector('[data-testid="ventas-estado"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'refunded';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(listCalls().at(-1)).toContain('status=refunded');

    const createObjectURL = vi.fn(() => 'blob:ventas');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    await act(async () => {
      (c.querySelector('[data-testid="exportar-csv"]') as HTMLButtonElement).click();
    });
    await settle();
    const exp = calls.find((u) => u.includes('/admin/sales/export'))!;
    expect(exp).toContain('format=csv');
    expect(exp).toContain('view=sales');
    expect(exp).toContain('status=refunded');
    expect(createObjectURL).toHaveBeenCalled();
  });

  it('se refresca sola al volver a la pestaña', async () => {
    await render('es');
    const before = listCalls().length;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await settle();
    expect(listCalls().length).toBe(before + 1);
  });

  it('en portugués: «Vendas», sin una palabra en español', async () => {
    const c = await render('pt');
    const text = c.textContent ?? '';
    expect(text).toContain('Todas as suas vendas');
    expect(text).toContain('Transferida');
    expect(text).toContain('Indicada por Bea Alumna');
    for (const es of ['Ventas', 'Te llega', 'Estado', 'Buscar por nombre', 'Traída']) {
      expect(text).not.toContain(es);
    }
  });

  it('en inglés', async () => {
    const c = await render('en');
    expect(c.textContent).toContain('All your sales');
    expect(c.textContent).toContain('Referred by Bea Alumna');
  });
});
