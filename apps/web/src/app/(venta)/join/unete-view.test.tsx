// @vitest-environment jsdom

/**
 * /join pintado de verdad (react-dom, catálogos reales, `apiFetch` real): solo
 * se sustituyen la red y los parámetros de la URL. Fija que:
 *   - un aula SIN niveles ve la página de siempre (selector de planes y
 *     «Continuar al pago seguro»), sin tarjetas;
 *   - con niveles, el botón de una tarjeta abre el pago de siempre con SOLO los
 *     planes de ese nivel y el elegido marcado, y el pago arranca con él;
 *   - un `?plan=` de un nivel entra directo a su pago, y «Cambiar» vuelve.
 */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import es from '@/i18n/messages/es';
import type { MembershipPage } from '@/lib/membership';
import { UneteView } from './unete-view';

const nav = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => nav.search }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLANS: MembershipPage['plans'] = [
  {
    id: 'p-basic-m',
    name: 'Básico mensual',
    tierId: 'tier-basic',
    intervalMonths: 1,
    amountCents: 1900,
    currency: 'eur',
    compareAtCents: null,
    trialDays: 0,
    isFeatured: false,
  },
  {
    id: 'p-basic-y',
    name: 'Básico anual',
    tierId: 'tier-basic',
    intervalMonths: 12,
    amountCents: 19000,
    currency: 'eur',
    compareAtCents: null,
    trialDays: 0,
    isFeatured: true,
  },
  {
    id: 'p-pro-m',
    name: 'Pro mensual',
    tierId: 'tier-pro',
    intervalMonths: 1,
    amountCents: 4900,
    currency: 'eur',
    compareAtCents: null,
    trialDays: 0,
    isFeatured: false,
  },
];

const BASE_PAGE: MembershipPage = {
  headline: 'Escuela de pintura',
  subheadline: null,
  plans: PLANS,
  courses: [
    {
      id: 'c1',
      title: 'Acuarela básica',
      description: null,
      thumbnailUrl: null,
      estimatedMinutes: 120,
      category: null,
      moduleCount: 0,
      moduleTitles: [],
      teacherName: null,
      amountCents: null,
    },
    {
      id: 'c2',
      title: 'Retrato al óleo',
      description: null,
      thumbnailUrl: null,
      estimatedMinutes: 60,
      category: null,
      moduleCount: 0,
      moduleTitles: [],
      teacherName: null,
      amountCents: null,
    },
  ],
  standaloneTotalCents: null,
  stats: { activeMembers: 0, totalMinutes: 180 },
  testimonial: null,
  trialLessonLimit: 0,
};

const TIERED_PAGE: MembershipPage = {
  ...BASE_PAGE,
  tiers: [
    {
      id: 'tier-basic',
      name: 'Básico',
      description: null,
      isFree: false,
      sortOrder: 0,
      accessGroupId: 'g-basic',
      includes: {
        allCourses: false,
        courses: [{ id: 'c1', title: 'Acuarela básica', thumbnailUrl: null }],
      },
      planIds: ['p-basic-m', 'p-basic-y'],
    },
    {
      id: 'tier-pro',
      name: 'Pro',
      description: null,
      isFree: false,
      sortOrder: 1,
      accessGroupId: 'g-pro',
      includes: {
        allCourses: true,
        courses: [
          { id: 'c1', title: 'Acuarela básica', thumbnailUrl: null },
          { id: 'c2', title: 'Retrato al óleo', thumbnailUrl: null },
        ],
      },
      planIds: ['p-pro-m'],
    },
  ],
  freeSignupPath: null,
};

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
let checkoutBodies: Array<Record<string, unknown>> = [];

function stubApi(page: MembershipPage) {
  checkoutBodies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/v1/membership/page')) {
        return new Response(JSON.stringify(page), { status: 200 });
      }
      if (url.includes('/api/v1/purchase-consent/withdrawal-waiver')) {
        return new Response(
          JSON.stringify({
            version: 'v1',
            locale: 'es',
            statement: 'Quiero empezar ya y renuncio a mi derecho de desistimiento.',
            sellerLine: 'Vende: Escuela de pintura.',
            sellerName: 'Escuela de pintura',
          }),
          { status: 200 },
        );
      }
      if (url.includes('/api/v1/auth/tenant-context')) {
        return new Response(JSON.stringify({ tenant: null, host: null }), { status: 200 });
      }
      if (url.includes('/api/v1/membership/checkout') && init?.method === 'POST') {
        checkoutBodies.push(JSON.parse(String(init.body)));
        // Un fallo a propósito: la prueba mira con qué plan arranca, no navega.
        return new Response(JSON.stringify({ message: 'fallo de prueba' }), { status: 500 });
      }
      return new Response('{}', { status: 404 });
    }),
  );
}

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render(page: MembershipPage, search = '') {
  nav.search = new URLSearchParams(search);
  stubApi(page);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="es-ES" messages={es as never} timeZone="UTC">
        <UneteView />
      </NextIntlClientProvider>,
    );
  });
  await settle();
}

const q = (sel: string) => document.body.querySelector<HTMLElement>(sel);
const byTestId = (id: string) => q(`[data-testid="${id}"]`);
async function click(el: HTMLElement | null) {
  if (!el) throw new Error('no está el elemento');
  await act(async () => el.click());
  await settle();
}
/** Las opciones del selector de la columna de pago (el de siempre). */
function sidebarRadios(): HTMLElement[] {
  const group = q('[role="radiogroup"][aria-label="Planes"]');
  return group ? [...group.querySelectorAll<HTMLElement>('[role="radio"]')] : [];
}

beforeEach(() => {
  window.scrollTo = vi.fn() as never;
});

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('/join', () => {
  it('sin niveles: la página de siempre, sin tarjetas', async () => {
    await render(BASE_PAGE);
    expect(byTestId('niveles-join')).toBeNull();
    expect(byTestId('nivel-elegido')).toBeNull();
    const radios = sidebarRadios();
    expect(radios).toHaveLength(3);
    // El «mejor valor» sigue marcado de entrada.
    expect(radios[1]!.getAttribute('aria-checked')).toBe('true');
    expect(byTestId('unete-pagar')).not.toBeNull();
    expect(document.body.textContent).toContain('Todo lo que incluye tu membresía');
  });

  it('con niveles: la tarjeta abre el pago de siempre con los planes de su nivel', async () => {
    await render(TIERED_PAGE);
    expect(byTestId('niveles-join')).not.toBeNull();
    // Hasta elegir nivel no hay pago a la vista.
    expect(byTestId('unete-pagar')).toBeNull();
    expect(byTestId('nivel-periodo-p-basic-y')!.getAttribute('aria-checked')).toBe('true');

    await click(byTestId('nivel-periodo-p-basic-m'));
    expect(byTestId('nivel-periodo-p-basic-m')!.getAttribute('aria-checked')).toBe('true');
    await click(byTestId('nivel-comprar-tier-basic'));

    expect(byTestId('niveles-join')).toBeNull();
    expect(byTestId('nivel-elegido')!.textContent).toContain('Básico');
    const radios = sidebarRadios();
    expect(radios).toHaveLength(2);
    expect(radios[0]!.getAttribute('aria-checked')).toBe('true');
    expect(radios[0]!.textContent).toMatch(/19\s€\/mes/);
    // El catálogo es el del nivel: solo sus cursos.
    expect(document.body.textContent).toContain('Todo lo que incluye Básico');
    expect(document.body.textContent).toContain('Acuarela básica');
    expect(document.body.textContent).not.toContain('Retrato al óleo');

    // El pago de siempre: casilla de renuncia y «Continuar al pago seguro».
    const casilla = q('[data-testid="withdrawal-waiver"] input[type="checkbox"]')!;
    await click(casilla);
    await click(byTestId('unete-pagar'));
    expect(checkoutBodies).toHaveLength(1);
    expect(checkoutBodies[0]).toMatchObject({ planId: 'p-basic-m', uiMode: 'embedded' });
  });

  it('?plan= de un nivel entra directo a su pago; «Cambiar» vuelve a las tarjetas', async () => {
    await render(TIERED_PAGE, 'plan=p-pro-m');
    expect(byTestId('niveles-join')).toBeNull();
    expect(byTestId('nivel-elegido')!.textContent).toContain('Pro');
    expect(sidebarRadios()).toHaveLength(1);
    expect(document.body.textContent).toContain('Retrato al óleo');

    await click(byTestId('nivel-cambiar'));
    expect(byTestId('niveles-join')).not.toBeNull();
    expect(byTestId('nivel-periodo-p-pro-m')!.getAttribute('aria-checked')).toBe('true');
    // El otro nivel conserva su «mejor valor».
    expect(byTestId('nivel-periodo-p-basic-y')!.getAttribute('aria-checked')).toBe('true');
  });
});
