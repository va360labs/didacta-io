// @vitest-environment jsdom

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Tarjetas de nivel de /join pintadas de verdad (react-dom, catálogos reales):
 * qué incluye cada nivel, su selector de periodicidad, el botón que abre el
 * pago con el plan elegido y el nivel gratis con su «Entrar gratis». Más las
 * cuentas puras que usa la página (planes de un nivel, plan marcado de
 * entrada y catálogo del nivel).
 */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '@/i18n/messages/en';
import es from '@/i18n/messages/es';
import pt from '@/i18n/messages/pt';
import type { MembershipCourse, MembershipPage, MembershipPublicTier } from '@/lib/membership';
import {
  TierCards,
  TierIncludesExtra,
  defaultPlanId,
  hasTiers,
  plansOfTier,
  tierCatalog,
} from './tier-cards';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function course(
  id: string,
  title: string,
  extra: Partial<MembershipCourse> = {},
): MembershipCourse {
  return {
    id,
    title,
    description: null,
    thumbnailUrl: null,
    estimatedMinutes: null,
    category: null,
    moduleCount: 0,
    moduleTitles: [],
    teacherName: null,
    amountCents: null,
    ...extra,
  };
}

const FREE: MembershipPublicTier = {
  id: 'tier-free',
  name: 'Comunidad',
  description: 'Para empezar sin pagar.',
  isFree: true,
  sortOrder: 0,
  accessGroupId: 'g-free',
  includes: {
    allCourses: false,
    courses: [{ id: 'c1', title: 'Acuarela básica', thumbnailUrl: null }],
  },
  planIds: [],
};
const BASIC: MembershipPublicTier = {
  id: 'tier-basic',
  name: 'Básico',
  description: null,
  isFree: false,
  sortOrder: 1,
  accessGroupId: 'g-basic',
  includes: {
    allCourses: false,
    courses: [
      { id: 'c1', title: 'Acuarela básica', thumbnailUrl: null },
      { id: 'c2', title: 'Óleo paso a paso', thumbnailUrl: null },
    ],
  },
  planIds: ['p-basic-m', 'p-basic-y'],
};
const PRO: MembershipPublicTier = {
  id: 'tier-pro',
  name: 'Pro',
  description: 'Todo, con directos.',
  isFree: false,
  sortOrder: 2,
  accessGroupId: 'g-pro',
  includes: {
    allCourses: true,
    courses: [
      { id: 'c1', title: 'Acuarela básica', thumbnailUrl: null },
      { id: 'c2', title: 'Óleo paso a paso', thumbnailUrl: null },
      { id: 'c3', title: 'Retrato', thumbnailUrl: null },
    ],
  },
  planIds: ['p-pro-m'],
};

const PAGE: MembershipPage = {
  headline: null,
  subheadline: null,
  plans: [
    {
      id: 'p-basic-m',
      name: 'Básico mensual',
      tierId: BASIC.id,
      intervalMonths: 1,
      amountCents: 1900,
      currency: 'eur',
      compareAtCents: null,
      trialDays: 7,
      isFeatured: false,
    },
    {
      id: 'p-basic-y',
      name: 'Básico anual',
      tierId: BASIC.id,
      intervalMonths: 12,
      amountCents: 19000,
      currency: 'eur',
      compareAtCents: 22800,
      trialDays: 0,
      isFeatured: true,
    },
    {
      id: 'p-pro-m',
      name: 'Pro mensual',
      tierId: PRO.id,
      intervalMonths: 1,
      amountCents: 4900,
      currency: 'eur',
      compareAtCents: null,
      trialDays: 0,
      isFeatured: false,
    },
  ],
  tiers: [FREE, BASIC, PRO],
  freeSignupPath: '/member-registration',
  courses: [
    course('c1', 'Acuarela básica', { estimatedMinutes: 120, amountCents: 3000 }),
    course('c2', 'Óleo paso a paso', { estimatedMinutes: 60 }),
    course('c3', 'Retrato', { estimatedMinutes: 30, amountCents: 5000 }),
  ],
  standaloneTotalCents: 8000,
  stats: { activeMembers: 12, totalMinutes: 210 },
  testimonial: null,
  trialLessonLimit: 0,
};

const CATALOGS = { es, en, pt } as const;
const LOCALES = { es: 'es-ES', en: 'en-US', pt: 'pt-BR' } as const;
const mounted: Array<{ root: Root; container: HTMLElement }> = [];

async function render(
  locale: keyof typeof CATALOGS,
  props: Partial<Parameters<typeof TierCards>[0]> = {},
) {
  const onPeriodChange = vi.fn();
  const onChoose = vi.fn();
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
        <TierCards
          page={PAGE}
          tiers={PAGE.tiers!}
          periodByTier={{ [BASIC.id]: 'p-basic-y', [PRO.id]: 'p-pro-m' }}
          onPeriodChange={onPeriodChange}
          onChoose={onChoose}
          freeSignupPath="/member-registration"
          {...props}
        />
      </NextIntlClientProvider>,
    );
  });
  return { onPeriodChange, onChoose };
}

const q = (sel: string) => document.body.querySelector<HTMLElement>(sel);
const byTestId = (id: string) => q(`[data-testid="${id}"]`);

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

describe('cuentas de los niveles', () => {
  it('hasTiers: sin `tiers` o vacío, la página es la de siempre', () => {
    expect(hasTiers({ ...PAGE, tiers: undefined })).toBe(false);
    expect(hasTiers({ ...PAGE, tiers: [] })).toBe(false);
    expect(hasTiers(PAGE)).toBe(true);
  });

  it('plansOfTier: los planes del nivel en su orden; sin cobros conectados, ninguno', () => {
    expect(plansOfTier(PAGE, BASIC).map((p) => p.id)).toEqual(['p-basic-m', 'p-basic-y']);
    expect(plansOfTier(PAGE, FREE)).toEqual([]);
    // Con `reason` (cobros sin conectar) la API manda `plans` vacío.
    expect(plansOfTier({ ...PAGE, plans: [] }, BASIC)).toEqual([]);
  });

  it('defaultPlanId: el «mejor valor», si no el último, y null sin planes', () => {
    expect(defaultPlanId(plansOfTier(PAGE, BASIC))).toBe('p-basic-y');
    expect(defaultPlanId(plansOfTier(PAGE, PRO))).toBe('p-pro-m');
    expect(defaultPlanId([])).toBeNull();
  });

  it('tierCatalog: el nivel con todos los cursos usa las cuentas de la página', () => {
    expect(tierCatalog(PAGE, PRO)).toEqual({
      courses: PAGE.courses,
      totalMinutes: 210,
      standaloneTotalCents: 8000,
    });
  });

  it('tierCatalog: un nivel con algunos cursos suma solo los suyos', () => {
    const cat = tierCatalog(PAGE, BASIC);
    expect(cat.courses.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(cat.totalMinutes).toBe(180);
    // Solo c1 tiene precio suelto.
    expect(cat.standaloneTotalCents).toBe(3000);
    // Sin ninguno con precio, no hay comparación que hacer.
    expect(tierCatalog(PAGE, { ...BASIC, includes: { allCourses: false, courses: [] } })).toEqual({
      courses: [],
      totalMinutes: 0,
      standaloneTotalCents: null,
    });
  });
});

describe('Tarjetas de nivel', () => {
  it('una tarjeta por nivel, en su orden, con lo que incluye', async () => {
    await render('es');
    const grid = byTestId('niveles-join')!;
    const cards = [...grid.querySelectorAll('[data-testid^="nivel-card-"]')].map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(cards).toEqual(['nivel-card-tier-free', 'nivel-card-tier-basic', 'nivel-card-tier-pro']);
    expect(byTestId('nivel-incluye-tier-basic')!.textContent).toContain('Óleo paso a paso');
    expect(byTestId('nivel-incluye-tier-pro')!.textContent).toContain(
      'Todos los cursos, también los nuevos',
    );
    expect(byTestId('nivel-incluye-tier-pro')!.textContent).toContain('Hoy hay 3 cursos');
    expect(byTestId('nivel-card-tier-pro')!.textContent).toContain('Todo, con directos.');
  });

  it('periodicidades del nivel: precio, tachado, prueba gratis y «mejor valor» marcado', async () => {
    const { onPeriodChange } = await render('es');
    const mensual = byTestId('nivel-periodo-p-basic-m')!;
    const anual = byTestId('nivel-periodo-p-basic-y')!;
    expect(anual.getAttribute('aria-checked')).toBe('true');
    expect(mensual.getAttribute('aria-checked')).toBe('false');
    expect(mensual.textContent).toMatch(/19\s€\/mes/);
    expect(mensual.textContent).toContain('7 días de prueba gratis');
    expect(anual.textContent).toMatch(/228\s€/);
    expect(anual.textContent).toContain('Mejor valor');
    await act(async () => mensual.click());
    expect(onPeriodChange).toHaveBeenCalledWith('tier-basic', 'p-basic-m');
  });

  it('el botón del nivel abre el pago con el plan marcado', async () => {
    const { onChoose } = await render('es');
    const comprar = byTestId('nivel-comprar-tier-basic') as HTMLButtonElement;
    expect(comprar.textContent).toBe('Elegir Básico');
    await act(async () => comprar.click());
    expect(onChoose).toHaveBeenCalledWith('tier-basic', 'p-basic-y');
  });

  it('sin cobros conectados: el nivel se ve, pero no se vende', async () => {
    const { onChoose } = await render('es', { page: { ...PAGE, plans: [] } });
    expect(byTestId('nivel-periodo-p-basic-m')).toBeNull();
    expect(byTestId('nivel-card-tier-basic')!.textContent).toContain(
      'Este plan todavía no está a la venta.',
    );
    const comprar = byTestId('nivel-comprar-tier-basic') as HTMLButtonElement;
    expect(comprar.disabled).toBe(true);
    await act(async () => comprar.click());
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('nivel gratis: «Entrar gratis» lleva al registro gratis', async () => {
    await render('es');
    const entrar = byTestId('nivel-gratis-entrar')!;
    expect(entrar.tagName).toBe('A');
    expect(entrar.getAttribute('href')).toBe('/member-registration');
    expect(entrar.textContent).toBe('Entrar gratis');
    expect(byTestId('nivel-card-tier-free')!.textContent).toContain('Gratis');
    expect(byTestId('nivel-comprar-tier-free')).toBeNull();
  });

  it('nivel gratis con el registro cerrado: sin botón, y lo dice', async () => {
    await render('es', { freeSignupPath: null });
    expect(byTestId('nivel-gratis-entrar')).toBeNull();
    expect(byTestId('nivel-card-tier-free')!.textContent).toContain(
      'Ahora mismo no se admiten altas gratis.',
    );
  });

  it('muchos cursos: se ven 6 y el resto a un clic', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `m${i}`,
      title: `Curso ${i + 1}`,
      thumbnailUrl: null,
    }));
    const tier = { ...BASIC, includes: { allCourses: false, courses: many } };
    await render('es', { tiers: [tier] });
    const list = byTestId('nivel-incluye-tier-basic')!;
    expect(list.querySelectorAll('li')).toHaveLength(6);
    const more = [...document.body.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Ver 2 cursos más'),
    )!;
    await act(async () => more.click());
    expect(list.querySelectorAll('li')).toHaveLength(8);
  });

  it('sin espacios ni directos propios, el nivel no pinta nada más', async () => {
    await render('es');
    expect(byTestId(`nivel-incluye-extra-${PRO.id}`)).toBeNull();
  });

  it('nombra los espacios y los próximos directos del nivel (solo nombre y fecha)', async () => {
    const conExtras: MembershipPublicTier = {
      ...PRO,
      includes: {
        ...PRO.includes,
        spaces: [{ name: 'Sala Pro' }],
        lives: [{ title: 'Directo de retrato', startTime: '2026-12-01T18:00:00.000Z' }],
      },
    };
    await render('es', { tiers: [FREE, BASIC, conExtras] });
    expect(byTestId(`nivel-espacios-${PRO.id}`)!.textContent).toBe('Sala Pro');
    const directo = byTestId(`nivel-directos-${PRO.id}`)!.textContent ?? '';
    expect(directo).toContain('Directo de retrato');
    expect(directo).toMatch(/1 dic 2026/);
    expect(byTestId(`nivel-incluye-extra-${PRO.id}`)!.querySelector('a')).toBeNull();
    // El nivel sin extras no enseña nada de esto.
    expect(byTestId(`nivel-incluye-extra-${BASIC.id}`)).toBeNull();
    expect(TierIncludesExtra).toBeTypeOf('function');
  });

  it('en portugués y en inglés no se cuela español', async () => {
    for (const locale of ['pt', 'en'] as const) {
      await render(locale);
      const text = byTestId('niveles-join')!.textContent ?? '';
      expect(text).not.toMatch(
        /Elegir|Entrar gratis|Qué incluye|también los nuevos|al mes|academia/,
      );
      for (const { root, container } of mounted.splice(0)) {
        await act(async () => root.unmount());
        container.remove();
      }
    }
  });
});
