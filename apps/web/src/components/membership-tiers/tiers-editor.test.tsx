// @vitest-environment jsdom

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Editor de NIVELES de la membresía pintado de verdad (react-dom, catálogos
 * reales): solo se sustituye la red. Fija lo que ve el creador (niveles en su
 * orden, lo que incluye cada uno, cuánta gente tiene, sus precios), lo que se
 * manda a la API al crear y cambiar niveles y precios, el 409 de borrar un
 * nivel con gente, los `data-testid` de las E2E en los dos modos y que en
 * inglés y portugués no se cuela español.
 */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/i18n/messages/en';
import es from '@/i18n/messages/es';
import pt from '@/i18n/messages/pt';
import type {
  MembershipAdminPlan,
  MembershipAdminTier,
  MembershipAdminTiers,
} from '@/lib/membership';
import { TiersEditor } from './tiers-editor';
import type { TiersVariant } from './tier-ui';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Datos de prueba (solo en tests) ─────────────────────────────────────────

const COURSES = [
  { id: 'c1', title: 'Torno para principiantes' },
  { id: 'c2', title: 'Esmaltes' },
  { id: 'c3', title: 'Hornos de leña' },
];

function plan(overrides: Partial<MembershipAdminPlan> = {}): MembershipAdminPlan {
  return {
    id: 'plan-basico-mensual',
    name: 'Básico · Mensual',
    tierId: 'tier-basico',
    intervalMonths: 1,
    amountCents: 1900,
    currency: 'eur',
    compareAtCents: 2500,
    trialDays: 7,
    isFeatured: false,
    active: true,
    sortOrder: 0,
    stripePriceId: null,
    currencyOptions: null,
    createdAt: '2026-11-20T10:00:00.000Z',
    updatedAt: '2026-11-20T10:00:00.000Z',
    ...overrides,
  };
}

function tier(overrides: Partial<MembershipAdminTier>): MembershipAdminTier {
  return {
    id: 'tier-x',
    name: 'X',
    description: null,
    isFree: false,
    sortOrder: 0,
    active: true,
    accessGroupId: 'g-x',
    allCourses: false,
    courseIds: [],
    plans: [],
    members: 0,
    ...overrides,
  };
}

function threeTiers(): MembershipAdminTiers {
  return {
    tiers: [
      tier({
        id: 'tier-basico',
        name: 'Básico',
        description: 'Lo esencial para empezar.',
        courseIds: ['c1', 'c2'],
        plans: [plan()],
        members: 3,
      }),
      tier({ id: 'tier-pro', name: 'Pro', sortOrder: 1, allCourses: true, members: 1 }),
      tier({
        id: 'tier-gratis',
        name: 'Gratis',
        sortOrder: 2,
        isFree: true,
        courseIds: ['c1'],
        members: 12,
      }),
    ],
    legacyPlanCount: 0,
    freeSignup: { moduleEnabled: true, open: true },
  };
}

// ── Red simulada ────────────────────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let server: {
  tiers: MembershipAdminTiers;
  tiersStatus: number;
  deleteConflict: boolean;
};
let calls: Call[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
      calls.push({ method, path: url.pathname, body });
      const path = url.pathname;
      const tiersBase = '/api/v1/membership/admin/tiers';

      if (path === '/api/v1/modules/courses') return json(COURSES);
      if (path === '/api/v1/admin/simple-mode/currencies') {
        return json({
          currencies: ['eur', 'usd'],
          settlementCurrency: 'eur',
          fees: { platformFeeBps: 500, operatorName: 'Didacta', cardFeeBps: 150, cardFeeFixed: 25 },
        });
      }
      if (path === tiersBase && method === 'GET') {
        return server.tiersStatus === 200
          ? json(server.tiers)
          : json({ message: 'Not Found' }, server.tiersStatus);
      }
      if (path === tiersBase && method === 'POST') {
        const b = body as {
          name: string;
          isFree?: boolean;
          allCourses?: boolean;
          courseIds?: string[];
        };
        const created = tier({
          id: `tier-nuevo-${server.tiers.tiers.length}`,
          name: b.name,
          isFree: b.isFree ?? false,
          allCourses: b.allCourses ?? false,
          courseIds: b.courseIds ?? [],
          sortOrder: server.tiers.tiers.length,
        });
        server.tiers.tiers.push(created);
        return json(created, 201);
      }
      if (path === `${tiersBase}/order` && method === 'PUT') {
        const ids = (body as { tierIds: string[] }).tierIds;
        server.tiers.tiers.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
        return json(server.tiers);
      }
      const tierMatch = path.match(/^\/api\/v1\/membership\/admin\/tiers\/([^/]+)$/);
      if (tierMatch) {
        const target = server.tiers.tiers.find((x) => x.id === tierMatch[1])!;
        if (method === 'DELETE') {
          if (server.deleteConflict) {
            return json(
              {
                message: 'El nivel tiene alumnos.',
                code: 'MEMBERSHIP_TIER_IN_USE',
                statusCode: 409,
              },
              409,
            );
          }
          server.tiers.tiers = server.tiers.tiers.filter((x) => x.id !== target.id);
          return json({ ok: true });
        }
        if (method === 'PATCH') {
          Object.assign(target, body);
          return json(target);
        }
      }
      if (path === '/api/v1/membership/admin/plans' && method === 'POST') {
        const b = body as MembershipAdminPlan;
        const created = plan({ ...b, id: 'plan-nuevo' });
        server.tiers.tiers.find((x) => x.id === b.tierId)!.plans.push(created);
        return json(created, 201);
      }
      return json({ message: 'Not Found' }, 404);
    }),
  );
}

// ── Montaje ─────────────────────────────────────────────────────────────────

const CATALOGS = { es, en, pt } as const;
const LOCALES = { es: 'es-ES', en: 'en-US', pt: 'pt-BR' } as const;
const mounted: Array<{ root: Root; container: HTMLElement }> = [];

async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(
  opts: {
    locale?: keyof typeof CATALOGS;
    variant?: TiersVariant;
    onData?: (d: MembershipAdminTiers) => void;
    onMutated?: () => void;
  } = {},
): Promise<HTMLElement> {
  const locale = opts.locale ?? 'es';
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
        <TiersEditor
          variant={opts.variant ?? 'full'}
          onData={opts.onData}
          onMutated={opts.onMutated}
        />
      </NextIntlClientProvider>,
    );
  });
  await settle();
  return container;
}

const byTestId = <T extends HTMLElement = HTMLElement>(c: ParentNode, id: string) =>
  c.querySelector(`[data-testid="${id}"]`) as T | null;

async function click(el: Element | null) {
  expect(el, 'elemento a pulsar').not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

async function type(el: Element | null, value: string) {
  expect(el, 'campo a rellenar').not.toBeNull();
  const field = el as HTMLInputElement | HTMLTextAreaElement;
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(el: Element | null, value: string) {
  expect(el, 'selector').not.toBeNull();
  const select = el as HTMLSelectElement;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const sent = (method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

beforeEach(() => {
  localStorage.setItem('didacta.access_token', 'token-de-prueba');
  server = { tiers: threeTiers(), tiersStatus: 200, deleteConflict: false };
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

// ── Pruebas ─────────────────────────────────────────────────────────────────

describe('Niveles de la membresía (modo completo)', () => {
  it('pinta los niveles en su orden con lo que incluyen, la gente y sus precios', async () => {
    const onData = vi.fn();
    const c = await render({ onData });
    expect(byTestId(c, 'niveles-editor')).not.toBeNull();
    expect(onData).toHaveBeenCalledWith(expect.objectContaining({ legacyPlanCount: 0 }));

    const names = [...c.querySelectorAll('[data-tier-name]')].map((el) =>
      el.getAttribute('data-tier-name'),
    );
    expect(names).toEqual(['Básico', 'Pro', 'Gratis']);

    const basico = byTestId(c, 'nivel-tier-basico')!;
    expect(basico.textContent).toContain('Lo esencial para empezar.');
    expect(byTestId(c, 'nivel-incluye-tier-basico')!.textContent).toBe(
      'Incluye: Torno para principiantes y Esmaltes',
    );
    expect(basico.textContent).toContain('3 personas dentro');
    const precio = byTestId(basico, 'nivel-plan-plan-basico-mensual')!;
    expect(precio.textContent).toContain('Básico · Mensual');
    expect(precio.textContent).toMatch(/Mensual · 25\s€ 19\s€ · 7 días gratis/);

    const pro = byTestId(c, 'nivel-tier-pro')!;
    expect(pro.textContent).toContain('Incluye todos los cursos');
    expect(pro.textContent).toContain('1 persona dentro');
    expect(pro.textContent).toContain('Aún no tiene precio');

    // El gratis: sin precios, con el estado del registro gratis.
    const gratis = byTestId(c, 'nivel-tier-gratis')!;
    expect(byTestId(gratis, 'nivel-plan-nuevo-tier-gratis')).toBeNull();
    const registro = byTestId(gratis, 'nivel-gratis-registro')!;
    expect(registro.getAttribute('data-open')).toBe('true');
    expect(registro.textContent).toContain('El registro gratis está abierto');
    expect(registro.querySelector('a')!.getAttribute('href')).toBe(
      '/admin/settings?tab=registration',
    );
    // Ya hay nivel gratis: no se ofrece otro.
    expect(byTestId(c, 'nivel-gratis-nuevo')).toBeNull();

    // Controles de cada nivel; subir/bajar apagados en los extremos.
    for (const id of ['tier-basico', 'tier-pro', 'tier-gratis']) {
      for (const k of ['editar', 'subir', 'bajar', 'activo', 'borrar']) {
        expect(byTestId(c, `nivel-${k}-${id}`), `nivel-${k}-${id}`).not.toBeNull();
      }
    }
    expect(byTestId<HTMLButtonElement>(c, 'nivel-subir-tier-basico')!.disabled).toBe(true);
    expect(byTestId<HTMLButtonElement>(c, 'nivel-bajar-tier-basico')!.disabled).toBe(false);
    expect(byTestId<HTMLButtonElement>(c, 'nivel-bajar-tier-gratis')!.disabled).toBe(true);
  });

  it('crear un nivel con cursos elegidos: avisa de los precios de siempre y manda lo que pide la API', async () => {
    server.tiers = {
      tiers: [],
      legacyPlanCount: 2,
      freeSignup: { moduleEnabled: false, open: false },
    };
    const onMutated = vi.fn();
    const c = await render({ onMutated });
    expect(c.textContent).toContain('Aún no tienes niveles');

    await click(byTestId(c, 'nivel-nuevo'));
    expect(byTestId(c, 'nivel-aviso-precios')!.textContent).toBe(
      'Tus precios de ahora pasarán a este nivel; quien ya paga no nota nada.',
    );
    // De pago: por defecto, todos los cursos.
    expect(byTestId<HTMLInputElement>(c, 'nivel-todos-los-cursos')!.checked).toBe(true);

    // Sin nombre no se guarda.
    await click(byTestId(c, 'nivel-guardar'));
    expect(c.textContent).toContain('Ponle un nombre al nivel.');
    expect(sent('POST', '/api/v1/membership/admin/tiers')).toHaveLength(0);

    await type(c.querySelector('#nivel-nombre'), 'Pro');
    await type(c.querySelector('#nivel-descripcion'), 'Todo el taller.');
    await click(byTestId(c, 'nivel-elegir-cursos'));
    // Elegir cursos sin marcar ninguno tampoco vale.
    await click(byTestId(c, 'nivel-guardar'));
    expect(c.textContent).toContain('Elige al menos un curso');
    await click(byTestId(c, 'nivel-curso-c2'));
    await click(byTestId(c, 'nivel-curso-c3'));
    await click(byTestId(c, 'nivel-guardar'));

    expect(sent('POST', '/api/v1/membership/admin/tiers').map((x) => x.body)).toEqual([
      {
        name: 'Pro',
        description: 'Todo el taller.',
        isFree: false,
        allCourses: false,
        courseIds: ['c2', 'c3'],
      },
    ]);
    const card = byTestId(c, 'nivel-tier-nuevo-0')!;
    expect(card.getAttribute('data-tier-name')).toBe('Pro');
    expect(card.textContent).toContain('Incluye: Esmaltes y Hornos de leña');
    expect(byTestId(c, 'niveles-aviso')!.textContent).toBe(
      'Nivel «Pro» creado. Ahora ponle precio.',
    );
    expect(c.querySelector('#nivel-nombre')).toBeNull();
    expect(onMutated).toHaveBeenCalledTimes(1);
  });

  it('añadir un precio: el nombre sigue a la periodicidad y el cuerpo lleva el nivel', async () => {
    const c = await render();
    await click(byTestId(c, 'nivel-plan-nuevo-tier-basico'));

    // Ya tiene el mensual: se propone el trimestral, con su nombre.
    const nombre = c.querySelector<HTMLInputElement>('#nivel-plan-nombre')!;
    const intervalo = c.querySelector<HTMLSelectElement>('#nivel-plan-intervalo')!;
    expect(intervalo.value).toBe('3');
    expect([...intervalo.options].map((o) => o.value)).toEqual(['1', '3', '6', '12']);
    expect(nombre.value).toBe('Básico · Trimestral');
    await choose(intervalo, '12');
    expect(nombre.value).toBe('Básico · Anual');

    // Sin precio no se guarda.
    await click(byTestId(c, 'nivel-plan-guardar'));
    expect(c.textContent).toContain('Escribe un precio mayor que cero');
    expect(sent('POST', '/api/v1/membership/admin/plans')).toHaveLength(0);

    await type(c.querySelector('#nivel-plan-precio'), '190');
    await type(c.querySelector('#nivel-plan-tachado'), '228');
    await type(c.querySelector('#nivel-plan-prueba'), '14');
    const recomendado = byTestId(c, 'nivel-plan-recomendado')!;
    await click(recomendado);
    expect(recomendado.getAttribute('aria-checked')).toBe('true');
    await click(byTestId(c, 'nivel-plan-guardar'));

    expect(sent('POST', '/api/v1/membership/admin/plans').map((x) => x.body)).toEqual([
      {
        name: 'Básico · Anual',
        intervalMonths: 12,
        currency: 'eur',
        amountCents: 19000,
        compareAtCents: 22800,
        trialDays: 14,
        isFeatured: true,
        tierId: 'tier-basico',
      },
    ]);
    expect(byTestId(c, 'nivel-plan-plan-nuevo')).not.toBeNull();
    expect(byTestId(c, 'niveles-aviso')!.textContent).toBe('Precio añadido.');
  });

  it('borrar un nivel con gente dentro: se explica el 409 y se ofrece apagarlo', async () => {
    server.deleteConflict = true;
    const c = await render();
    await click(byTestId(c, 'nivel-borrar-tier-basico'));
    const error = byTestId(c, 'nivel-error-tier-basico')!;
    expect(error.textContent).toContain('Este nivel ya tiene alumnos: no se puede borrar.');
    await click(
      [...error.querySelectorAll('button')].find((b) => b.textContent === 'Apagarlo') ?? null,
    );
    expect(sent('PATCH', '/api/v1/membership/admin/tiers/tier-basico').map((x) => x.body)).toEqual([
      { active: false },
    ]);
    const basico = byTestId(c, 'nivel-tier-basico')!;
    expect(basico.textContent).toContain('Apagado');
    expect(byTestId(c, 'nivel-activo-tier-basico')!.textContent).toBe('Encender');
  });

  it('bajar un nivel guarda el nuevo orden', async () => {
    const c = await render();
    await click(byTestId(c, 'nivel-bajar-tier-basico'));
    expect(sent('PUT', '/api/v1/membership/admin/tiers/order').map((x) => x.body)).toEqual([
      { tierIds: ['tier-pro', 'tier-basico', 'tier-gratis'] },
    ]);
    const names = [...c.querySelectorAll('[data-tier-name]')].map((el) =>
      el.getAttribute('data-tier-name'),
    );
    expect(names).toEqual(['Pro', 'Básico', 'Gratis']);
  });

  it('editar un nivel cambia nombre y cursos; el tipo «todos/elegidos» no se toca', async () => {
    const c = await render();
    await click(byTestId(c, 'nivel-editar-tier-basico'));
    expect(byTestId<HTMLInputElement>(c, 'nivel-elegir-cursos')!.disabled).toBe(true);
    expect(byTestId<HTMLInputElement>(c, 'nivel-curso-c1')!.checked).toBe(true);
    await type(c.querySelector('#nivel-nombre'), 'Esencial');
    await click(byTestId(c, 'nivel-curso-c1'));
    await click(byTestId(c, 'nivel-guardar'));
    expect(sent('PATCH', '/api/v1/membership/admin/tiers/tier-basico').map((x) => x.body)).toEqual([
      { name: 'Esencial', description: 'Lo esencial para empezar.', courseIds: ['c2'] },
    ]);

    // «Todos los cursos» no manda lista.
    await click(byTestId(c, 'nivel-editar-tier-pro'));
    await click(byTestId(c, 'nivel-guardar'));
    expect(sent('PATCH', '/api/v1/membership/admin/tiers/tier-pro').map((x) => x.body)).toEqual([
      { name: 'Pro', description: null },
    ]);
  });

  it('nivel gratis: se crea sin precios, con los cursos elegidos', async () => {
    server.tiers.tiers = server.tiers.tiers.filter((x) => !x.isFree);
    const c = await render();
    await click(byTestId(c, 'nivel-gratis-nuevo'));
    expect(c.querySelector<HTMLInputElement>('#nivel-nombre')!.value).toBe('Gratis');
    expect(byTestId<HTMLInputElement>(c, 'nivel-elegir-cursos')!.checked).toBe(true);
    expect(c.textContent).toContain('abrimos el registro gratis');
    await click(byTestId(c, 'nivel-curso-c1'));
    await click(byTestId(c, 'nivel-guardar'));
    expect(sent('POST', '/api/v1/membership/admin/tiers').map((x) => x.body)).toEqual([
      { name: 'Gratis', description: null, isFree: true, allCourses: false, courseIds: ['c1'] },
    ]);
    expect(byTestId(c, 'niveles-aviso')!.textContent).toBe('Nivel gratis creado.');
    expect(byTestId(c, 'nivel-gratis-nuevo')).toBeNull();
  });

  it('si la API no ofrece niveles (módulo apagado), no pinta nada', async () => {
    server.tiersStatus = 404;
    const c = await render();
    expect(c.innerHTML).toBe('');
  });
});

describe('Niveles en «Ventas» del modo sencillo', () => {
  it('mismos testids, con el texto llano de «Ventas» y «lo que te llega» al poner precio', async () => {
    const c = await render({ variant: 'simple' });
    const editor = byTestId(c, 'niveles-editor')!;
    expect(editor.tagName).toBe('SECTION');
    expect(editor.textContent).toContain('¿Quieres vender varios niveles?');
    expect(byTestId(c, 'nivel-tier-pro')).not.toBeNull();
    expect(byTestId(c, 'nivel-gratis-registro')).not.toBeNull();
    await click(byTestId(c, 'nivel-plan-nuevo-tier-pro'));
    expect(c.querySelector<HTMLInputElement>('#nivel-plan-nombre')!.value).toBe('Pro · Mensual');
    const moneda = c.querySelector<HTMLSelectElement>('#nivel-plan-moneda')!;
    expect([...moneda.options].map((o) => o.value)).toEqual(['eur', 'usd']);
    expect(byTestId(c, 'te-llega')).toBeNull();
    await type(c.querySelector('#nivel-plan-precio'), '29');
    // 29 € − tarjeta (1,5 % + 0,25 € = 0,69 €) − 5 % de la plataforma (1,45 €).
    expect(byTestId(c, 'te-llega')!.textContent).toMatch(/Con 29\s€ te llegan ~26,86\s€/);
  });
});

describe('Idiomas', () => {
  it('en inglés y portugués no se cuela español', async () => {
    const enC = await render({ locale: 'en' });
    const enText = enC.textContent ?? '';
    expect(enText).toContain('Levels');
    expect(enText).toContain('3 people in');
    expect(enText).toContain('Includes: Torno para principiantes and Esmaltes');
    expect(enText).toContain('Free sign-up is open');

    const ptC = await render({ locale: 'pt' });
    const ptText = ptC.textContent ?? '';
    expect(ptText).toContain('Níveis');
    expect(ptText).toContain('3 pessoas dentro');
    expect(ptText).toContain('O cadastro grátis está aberto');
    for (const text of [enText, ptText]) {
      for (const word of ['Incluye', 'personas', 'Añadir', 'Borrar', 'Encender', 'Aún no']) {
        expect(text, word).not.toContain(word);
      }
    }
  });

  it('los dos modos tienen las mismas claves en los tres idiomas', () => {
    const keys = (obj: object, prefix = ''): string[] =>
      Object.entries(obj).flatMap(([k, v]) =>
        typeof v === 'object' && v !== null
          ? keys(v as object, `${prefix}${k}.`)
          : [`${prefix}${k}`],
      );
    for (const catalog of [es, en, pt]) {
      const { page: _page, ...full } = catalog.adminMonetizacion.membership.tiers;
      expect(keys(full).sort()).toEqual(keys(catalog.modoSencilloVentas.niveles).sort());
    }
  });
});
