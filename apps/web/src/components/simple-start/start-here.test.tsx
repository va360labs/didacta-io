// @vitest-environment jsdom

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * «Empieza aquí» pintado de verdad (react-dom a pelo, como
 * `simple-video.test.tsx`): solo se sustituye la red (`fetch`) y el idioma del
 * navegador. Entre el componente y la respuesta corre el código real (hooks,
 * `apiFetch`, `payoutsStepView`, i18n con los catálogos de verdad).
 *
 * Lo que fallaba: el paso «Conecta tus cobros» mandaba a cualquiera a la
 * tarjeta de cobros, y un creador con el banco en Brasil acababa en un alta de
 * Stripe para España que iba a fallar. Ahora, si su país no se admite, el paso
 * lo dice ahí mismo y le deja ir a elegir otro país.
 */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/i18n/messages/en';
import es from '@/i18n/messages/es';
import pt from '@/i18n/messages/pt';
import { payoutsNavigation } from '@/components/admin/payouts-redirect';
import { StartHere } from './start-here';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/start',
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Curso con lección y precio hechos: el paso abierto es el de los cobros. */
function startHere(paymentsSetupPath = '/admin/payments') {
  return {
    academyName: 'Escola de Aquarela',
    quickStartDone: true,
    offer: {
      kind: 'course',
      courseId: 'c1',
      planId: null,
      amountCents: 4900,
      currency: 'eur',
      courseTitle: 'Aquarela do zero',
      courseSlug: 'aquarela-do-zero',
      courseCoverUrl: null,
    },
    firstCourseId: 'c1',
    steps: [
      { id: 'academy', done: true },
      { id: 'course', done: true },
      { id: 'price', done: true },
      { id: 'payments', done: false },
      { id: 'publish', done: false },
      { id: 'invite', done: false },
    ],
    salePath: null,
    sales: { count: 0, firstSaleAt: null },
    students: 0,
    nextLive: null,
    paymentsSetupPath,
  };
}

function payoutsStatus(
  account: { country: string } | null = null,
  declaredCountry: string | null = null,
) {
  return {
    platform: true,
    operatorName: 'Didacta',
    mode: 'platform',
    ready: false,
    reason: 'not_connected',
    account: account
      ? {
          status: 'ONBOARDING',
          stripeAccountId: 'acct_1',
          country: account.country,
          entityType: 'individual',
          defaultCurrency: null,
          payoutsEnabled: false,
          pendingRequirement: 'bank_account',
          requirementsDeadline: null,
          disabledReason: null,
          payoutSchedule: null,
          readyAt: null,
          lastSyncedAt: null,
        }
      : null,
    supportedCountries: ['ES', 'FR', 'DE', 'PT', 'GB', 'US'],
    declaredCountry,
    feeBps: 500,
  };
}

type Answer = { status: number; body: unknown };
type Handler = (url: string) => Answer | undefined;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
let calls: string[] = [];

function stubApi(handler: Handler) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const answer = handler(url) ?? { status: 404, body: { message: 'no' } };
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

const CATALOGS = { es, en, pt } as const;
const LOCALES = { es: 'es-ES', en: 'en-US', pt: 'pt-BR' } as const;

async function render(
  locale: keyof typeof CATALOGS,
  browserLanguage: string,
): Promise<HTMLElement> {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(browserLanguage);
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
        <StartHere />
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return container;
}

const paymentsStep = (c: HTMLElement) => c.querySelector('[data-step="payments"]')!;
const connectButton = (c: HTMLElement) =>
  c.querySelector<HTMLButtonElement>('[data-testid="conectar-cobros"]');
const notice = (c: HTMLElement) => c.querySelector('[data-testid="cobros-pais-no-admitido"]');
/** Solo el texto del aviso (sin el enlace que va debajo). */
const noticeText = (c: HTMLElement) => notice(c)?.querySelector('[role="status"]')?.textContent;
const links = (el: Element) =>
  [...el.querySelectorAll('a')].map((a) => ({
    text: a.textContent?.trim(),
    href: a.getAttribute('href'),
  }));

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

describe('«Empieza aquí»: el paso de cobros según el país del creador', () => {
  it('banco en Brasil (navegador pt-BR, sin cuenta): el aviso en el paso, sin botón de conectar', async () => {
    stubApi((url) => {
      if (url.endsWith('/admin/simple-mode/start-here')) return { status: 200, body: startHere() };
      if (url.endsWith('/modules/payouts/status')) return { status: 200, body: payoutsStatus() };
      return undefined;
    });
    const c = await render('pt', 'pt-BR');
    const step = paymentsStep(c);
    expect(step.getAttribute('aria-current')).toBe('step');
    expect(notice(c)?.getAttribute('data-country')).toBe('BR');
    expect(notice(c)?.textContent).toContain(
      'Ainda não conseguimos pagar criadores com banco neste país (Brasil).',
    );
    expect(notice(c)?.textContent).toContain('sua escola e sua comunidade');
    // El único enlace del paso es el secundario, a la tarjeta (allí elige otro país).
    expect(links(step)).toEqual([
      { text: 'Seu banco está em outro país?', href: '/admin/payments' },
    ]);
    expect(step.textContent).not.toContain('Conectar recebimentos');
  });

  it('con cuenta abierta manda el país de la cuenta: México aunque el navegador diga España', async () => {
    stubApi((url) => {
      if (url.endsWith('/admin/simple-mode/start-here')) return { status: 200, body: startHere() };
      if (url.endsWith('/modules/payouts/status'))
        return { status: 200, body: payoutsStatus({ country: 'MX' }) };
      return undefined;
    });
    const c = await render('es', 'es-ES');
    expect(notice(c)?.textContent).toContain(
      'Todavía no podemos pagar a creadores con el banco en México.',
    );
    expect(notice(c)?.textContent).toContain(
      'Mientras tanto puedes montar tu academia y tu comunidad',
    );
    expect(links(paymentsStep(c))).toEqual([
      { text: '¿Tu banco está en otro país?', href: '/admin/payments' },
    ]);
  });

  it('declaró «Otro país» en el alta: el aviso sin nombre de país y «Elegir el país de mi banco»', async () => {
    stubApi((url) => {
      if (url.endsWith('/admin/simple-mode/start-here')) return { status: 200, body: startHere() };
      if (url.endsWith('/modules/payouts/status'))
        return { status: 200, body: payoutsStatus(null, 'OTHER') };
      return undefined;
    });
    // Navegador en España: lo declarado manda.
    const c = await render('es', 'es-ES');
    expect(notice(c)?.getAttribute('data-country')).toBe('OTHER');
    expect(noticeText(c)).toBe(
      'Al darte de alta nos dijiste que tu banco está en otro país, y todavía no podemos pagar a creadores con el banco fuera de los países admitidos. Mientras tanto puedes montar tu academia y tu comunidad.',
    );
    expect(links(paymentsStep(c))).toEqual([
      { text: 'Elegir el país de mi banco', href: '/admin/payments' },
    ]);
  });

  it('declaró Brasil en el alta: el aviso con Brasil aunque el navegador diga España', async () => {
    stubApi((url) => {
      if (url.endsWith('/admin/simple-mode/start-here')) return { status: 200, body: startHere() };
      if (url.endsWith('/modules/payouts/status'))
        return { status: 200, body: payoutsStatus(null, 'BR') };
      return undefined;
    });
    const c = await render('es', 'es-ES');
    expect(noticeText(c)).toBe(
      'Todavía no podemos pagar a creadores con el banco en Brasil. Mientras tanto puedes montar tu academia y tu comunidad.',
    );
  });

  it('declaró España en el alta: el botón, aunque el navegador diga Brasil', async () => {
    stubApi((url) => {
      if (url.endsWith('/admin/simple-mode/start-here')) return { status: 200, body: startHere() };
      if (url.endsWith('/modules/payouts/status'))
        return { status: 200, body: payoutsStatus(null, 'ES') };
      return undefined;
    });
    const c = await render('pt', 'pt-BR');
    expect(notice(c)).toBeNull();
    // El botón abre el alta aquí mismo (ya no lleva a Ventas); el único
    // enlace es el secundario para quien tenga el banco en otro país.
    expect(connectButton(c)?.textContent).toBe('Conectar recebimentos');
    expect(links(paymentsStep(c))).toEqual([
      { text: 'Seu banco está em outro país?', href: '/admin/payments' },
    ]);
  });

  it('país admitido: el botón que abre Stripe, sin enlace a Ventas', async () => {
    stubApi((url) => {
      if (url.endsWith('/admin/simple-mode/start-here')) return { status: 200, body: startHere() };
      if (url.endsWith('/modules/payouts/status')) return { status: 200, body: payoutsStatus() };
      return undefined;
    });
    const c = await render('en', 'en-GB');
    expect(notice(c)).toBeNull();
    expect(connectButton(c)?.textContent).toBe('Connect payouts');
    expect(links(paymentsStep(c)).map((l) => l.text)).not.toContain('Connect payouts');
  });

  it('si el estado de cobros falla, el paso se pinta como siempre (con botón)', async () => {
    stubApi((url) => {
      if (url.endsWith('/admin/simple-mode/start-here')) return { status: 200, body: startHere() };
      if (url.endsWith('/modules/payouts/status'))
        return { status: 500, body: { message: 'boom' } };
      return undefined;
    });
    const c = await render('pt', 'pt-BR');
    expect(calls.some((u) => u.endsWith('/modules/payouts/status'))).toBe(true);
    expect(notice(c)).toBeNull();
    expect(links(paymentsStep(c))).toEqual([
      { text: 'Conectar recebimentos', href: '/admin/payments' },
    ]);
  });

  it('sin modo plataforma (la ruta no existe): el botón de siempre, a los ajustes de cobro', async () => {
    stubApi((url) => {
      if (url.endsWith('/admin/simple-mode/start-here'))
        return { status: 200, body: startHere('/admin/settings?tab=payments') };
      return undefined; // /modules/payouts/status → 404
    });
    const c = await render('pt', 'pt-BR');
    expect(notice(c)).toBeNull();
    expect(links(paymentsStep(c))).toEqual([
      { text: 'Conectar recebimentos', href: '/admin/settings?tab=payments' },
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Prueba real del 14-nov-2026: «Empieza aquí» llevaba a Ventas, donde había
// otro formulario con otro botón igual, y «Abriendo Stripe…» tardaba 8 s sin
// más señal. Ahora el paso abre el alta él solo, con el estado de carga visible
// y sin una segunda petición por un doble clic.
// ────────────────────────────────────────────────────────────────────────────

type Sent = { url: string; method: string; body: unknown };
let sent: Sent[] = [];

function stubFetch(handler: (url: string, method: string) => Answer | Promise<Answer> | undefined) {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const answer = (await handler(url, method)) ?? { status: 404, body: { message: 'no' } };
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const posts = (path: string) => sent.filter((s) => s.method === 'POST' && s.url.endsWith(path));
const CONNECTED = {
  account: payoutsStatus({ country: 'ES' }).account,
  onboardingUrl: 'https://connect.stripe.test/setup/e/acct_1',
};

describe('«Empieza aquí»: un solo botón abre el alta de Stripe', () => {
  it('manda país y tipo, enseña que está trabajando, ignora el doble clic y va a Stripe', async () => {
    const go = vi.spyOn(payoutsNavigation, 'go').mockImplementation(() => undefined);
    const pending = deferred<Answer>();
    stubFetch((url, method) => {
      if (url.endsWith('/admin/simple-mode/start-here')) return { status: 200, body: startHere() };
      if (url.endsWith('/modules/payouts/status')) return { status: 200, body: payoutsStatus() };
      if (method === 'POST' && url.endsWith('/modules/payouts/connect')) return pending.promise;
      return undefined;
    });
    const c = await render('es', 'es-ES');
    const button = connectButton(c)!;
    expect(button.disabled).toBe(false);
    // El aviso del teléfono de atención, antes de ir a Stripe.
    expect(c.querySelector('[data-testid="aviso-telefono"]')?.textContent).toContain(
      'Si no quieres dar tu móvil personal, pon uno de trabajo.',
    );

    await act(async () => {
      button.click();
      button.click();
    });
    await flush();

    expect(posts('/modules/payouts/connect')).toHaveLength(1);
    expect(posts('/modules/payouts/connect')[0]!.body).toEqual({
      country: 'ES',
      entityType: 'individual',
    });
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Abriendo Stripe…');
    expect(button.querySelector('[data-testid="payouts-spinner"]')).not.toBeNull();
    expect(c.querySelector('[data-testid="cobros-alta-espera"]')?.textContent).toBe(
      'Estamos preparando tu alta en Stripe. Puede tardar unos segundos: no cierres esta página.',
    );

    await act(async () => {
      pending.resolve({ status: 200, body: CONNECTED });
    });
    await flush();
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith('https://connect.stripe.test/setup/e/acct_1');
    expect(posts('/modules/payouts/connect')).toHaveLength(1);
  });

  it('«Empresa» se pregunta una vez, aquí, y viaja en la petición', async () => {
    vi.spyOn(payoutsNavigation, 'go').mockImplementation(() => undefined);
    stubFetch((url, method) => {
      if (url.endsWith('/admin/simple-mode/start-here')) return { status: 200, body: startHere() };
      if (url.endsWith('/modules/payouts/status')) return { status: 200, body: payoutsStatus() };
      if (method === 'POST' && url.endsWith('/modules/payouts/connect'))
        return { status: 200, body: CONNECTED };
      return undefined;
    });
    const c = await render('en', 'en-GB');
    const company = c.querySelector<HTMLInputElement>(
      'input[name="cobros-titular"][value="company"]',
    )!;
    expect(company.closest('label')?.textContent).toBe('Company');
    await act(async () => company.click());
    await act(async () => connectButton(c)!.click());
    await flush();
    expect(posts('/modules/payouts/connect')[0]!.body).toEqual({
      country: 'GB',
      entityType: 'company',
    });
  });

  it('alta ya empezada: el mismo botón la retoma (enlace nuevo), sin volver a preguntar nada', async () => {
    const go = vi.spyOn(payoutsNavigation, 'go').mockImplementation(() => undefined);
    stubFetch((url, method) => {
      if (url.endsWith('/admin/simple-mode/start-here')) return { status: 200, body: startHere() };
      if (url.endsWith('/modules/payouts/status'))
        return { status: 200, body: payoutsStatus({ country: 'ES' }) };
      if (method === 'POST' && url.endsWith('/modules/payouts/connect/link'))
        return { status: 200, body: { url: 'https://connect.stripe.test/setup/e/acct_1b' } };
      return undefined;
    });
    const c = await render('es', 'es-ES');
    expect(connectButton(c)).toBeNull();
    expect(c.querySelector('input[name="cobros-titular"]')).toBeNull();
    const resume = c.querySelector<HTMLButtonElement>('[data-testid="seguir-alta-stripe"]')!;
    expect(resume.textContent).toBe('Seguir con el alta en Stripe');
    await act(async () => resume.click());
    await flush();
    expect(posts('/modules/payouts/connect/link')).toHaveLength(1);
    expect(posts('/modules/payouts/connect')).toHaveLength(0);
    expect(go).toHaveBeenCalledWith('https://connect.stripe.test/setup/e/acct_1b');
  });

  it('si falla, lo dice y el botón vuelve a funcionar (el cerrojo se suelta)', async () => {
    const go = vi.spyOn(payoutsNavigation, 'go').mockImplementation(() => undefined);
    let attempt = 0;
    stubFetch((url, method) => {
      if (url.endsWith('/admin/simple-mode/start-here')) return { status: 200, body: startHere() };
      if (url.endsWith('/modules/payouts/status')) return { status: 200, body: payoutsStatus() };
      if (method === 'POST' && url.endsWith('/modules/payouts/connect')) {
        attempt += 1;
        return attempt === 1
          ? { status: 502, body: { message: 'Stripe no responde' } }
          : { status: 200, body: CONNECTED };
      }
      return undefined;
    });
    const c = await render('es', 'es-ES');
    await act(async () => connectButton(c)!.click());
    await flush();
    expect(paymentsStep(c).querySelector('[role="alert"]')).not.toBeNull();
    expect(connectButton(c)!.disabled).toBe(false);
    expect(go).not.toHaveBeenCalled();
    await act(async () => connectButton(c)!.click());
    await flush();
    expect(posts('/modules/payouts/connect')).toHaveLength(2);
    expect(go).toHaveBeenCalledTimes(1);
  });
});
