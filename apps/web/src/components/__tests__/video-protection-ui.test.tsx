// @vitest-environment jsdom

/**
 * Protección de vídeo, pintada de verdad: el reproductor de la lección, los
 * vídeos incrustados a mano en una lección HTML y la tarjeta del panel.
 *
 * No hay React Testing Library en el repo, así que se monta con `react-dom` a
 * pelo. Lo que se mockea es SOLO la red (`fetch`): entre el componente y la
 * respuesta de la API corre el código real (hook, caché, `apiFetch`, i18n con
 * los catálogos de verdad en los dos idiomas).
 *
 * Identificadores inventados: no son de ninguna librería real de Bunny.
 */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoProtectionCard } from '@/components/admin/video-protection-card';
import { LessonHtmlWithVideos } from '@/components/lesson-html-videos';
import { VideoEmbed } from '@/components/video-embed';
import en from '@/i18n/messages/en';
import es from '@/i18n/messages/es';
import type {
  SignatureCheckOutcome,
  VideoProtectionState,
  videoProtectionApi,
} from '@/lib/video-protection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LIB = '100200';
const STUDENT = { id: '7c9e6679-7425-40de-944b-e07fc1f90ae7', email: 'alumna@example.com' };
let guidCounter = 0;
/** Un vídeo distinto por test: la caché de URLs es de la página entera. */
function nextGuid(): string {
  guidCounter += 1;
  return `0f1e2d3c-4b5a-4978-8a6b-${String(guidCounter).padStart(12, '0')}`;
}
const unsigned = (guid: string, lib = LIB) =>
  `https://iframe.mediadelivery.net/embed/${lib}/${guid}`;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

async function render(node: ReactNode, locale: 'es' | 'en' = 'es'): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <NextIntlClientProvider
        locale={locale === 'es' ? 'es-ES' : 'en-US'}
        messages={(locale === 'es' ? es : en) as never}
        timeZone="UTC"
      >
        {node}
      </NextIntlClientProvider>,
    );
  });
  return container;
}

/** Deja correr promesas y efectos pendientes. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

type FetchHandler = (url: string, init?: RequestInit) => { status: number; body: unknown } | Error;

function stubFetch(handler: FetchHandler) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const result = handler(url, init);
      if (result instanceof Error) throw result;
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

beforeEach(() => {
  localStorage.setItem('didacta.access_token', 'token-de-prueba');
  localStorage.setItem(
    'didacta.session',
    JSON.stringify({
      user: {
        ...STUDENT,
        name: 'Alumna',
        tenantId: 't1',
        tenantSlug: 'demo',
        roles: ['alumno'],
        mfaEnabled: false,
      },
      mfaRequired: false,
    }),
  );
});

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ─────────────────────────── reproductor de la lección ───────────────────────────

describe('VideoEmbed con un vídeo de Bunny', () => {
  it('academia protegida: monta el iframe con la URL FIRMADA y la marca de agua del alumno', async () => {
    const guid = nextGuid();
    const signed = `${unsigned(guid)}?token=abc123&expires=1900000000`;
    // La API tarda en contestar: así se ve qué hay en pantalla MIENTRAS tanto.
    let answer: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => (answer = resolve));
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) => pending);
    vi.stubGlobal('fetch', fetchMock);

    const container = await render(
      <VideoEmbed url={unsigned(guid)} title="Clase 1" resumeAt={95} />,
    );
    await settle();
    // Sin respuesta no hay iframe: la URL permanente no se monta nunca «de mientras».
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.innerHTML).not.toContain('mediadelivery.net');

    answer(
      new Response(
        JSON.stringify({
          url: signed,
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          protected: true,
          watermark: true,
        }),
        { status: 200 },
      ),
    );
    await settle();

    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      `/api/v1/video/bunny/${LIB}/${guid}/play-url`,
    ]);
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get('authorization')).toBe(
      'Bearer token-de-prueba',
    );

    const iframe = container.querySelector('iframe')!;
    const src = new URL(iframe.src);
    expect(src.searchParams.get('token')).toBe('abc123');
    expect(src.searchParams.get('expires')).toBe('1900000000');
    expect(src.searchParams.get('t')).toBe('95');
    expect(src.searchParams.get('autoplay')).toBe('false');
    expect(iframe.title).toBe('Clase 1');

    expect(container.querySelector('[data-testid="video-watermark"]')?.textContent).toBe(
      'alumna@example.com · 7c9e6679',
    );
    // Con marca de agua, ni pantalla completa nativa ni ventana flotante: el
    // vídeo saldría de la caja sin la marca.
    expect(iframe.getAttribute('allow')).not.toContain('fullscreen');
    expect(iframe.getAttribute('allow')).not.toContain('picture-in-picture');
    expect(iframe.hasAttribute('allowfullscreen')).toBe(false);
  });

  it('COMPATIBILIDAD: academia sin protección → el mismo iframe de siempre, sin marca de agua', async () => {
    const guid = nextGuid();
    stubFetch(() => ({
      status: 200,
      body: { url: unsigned(guid), expiresAt: null, protected: false, watermark: false },
    }));

    const container = await render(<VideoEmbed url={unsigned(guid)} title="Clase 1" />);
    await settle();

    const iframe = container.querySelector('iframe')!;
    expect(iframe.src).toBe(`${unsigned(guid)}?autoplay=false&preload=true&responsive=true`);
    expect(iframe.getAttribute('allow')).toBe(
      'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen',
    );
    expect(iframe.hasAttribute('allowfullscreen')).toBe(true);
    expect(container.querySelector('[data-testid="video-watermark"]')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('COMPATIBILIDAD: con la API caída el vídeo se monta igualmente con su URL de siempre', async () => {
    const guid = nextGuid();
    stubFetch(() => new TypeError('Failed to fetch'));

    const container = await render(<VideoEmbed url={unsigned(guid)} title="Clase 1" />);
    await settle();

    expect(container.querySelector('iframe')?.src).toBe(
      `${unsigned(guid)}?autoplay=false&preload=true&responsive=true`,
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    ['es', 'No tienes acceso a este vídeo.'],
    ['en', "You don't have access to this video."],
  ] as const)('sin derecho al vídeo (%s): un aviso, y NINGÚN iframe', async (locale, text) => {
    const guid = nextGuid();
    stubFetch(() => ({
      status: 403,
      body: { statusCode: 403, code: 'VIDEO_FORBIDDEN', message: 'No tienes acceso a este vídeo.' },
    }));

    const container = await render(<VideoEmbed url={unsigned(guid)} title="Clase 1" />, locale);
    await settle();

    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(text);
  });

  it('tope de vídeos superado: avisa y no monta el vídeo', async () => {
    const guid = nextGuid();
    stubFetch(() => ({
      status: 429,
      body: { statusCode: 429, code: 'VIDEO_RATE_LIMITED', message: 'x', retryAfterSeconds: 600 },
    }));

    const container = await render(<VideoEmbed url={unsigned(guid)} title="Clase 1" />);
    await settle();

    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Has abierto muchos vídeos en poco tiempo. Vuelve a intentarlo en un rato.',
    );
  });

  it('el PRIMER render (el HTML que manda el servidor) no lleva la URL permanente del vídeo', () => {
    // Sin efectos ni red: lo que hay en pantalla antes de que el reproductor
    // haya podido preguntar nada. Si aquí saliera el iframe con la URL de la
    // lección, una academia protegida vería parpadear el error de Bunny (y el
    // navegador pediría la URL sin firmar) en cada vídeo.
    const guid = nextGuid();
    const html = renderToString(
      <NextIntlClientProvider locale="es-ES" messages={es as never} timeZone="UTC">
        <VideoEmbed url={unsigned(guid)} title="Clase 1" />
      </NextIntlClientProvider>,
    );
    expect(html).toContain('data-testid="bunny-frame"');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('mediadelivery.net');
  });

  it('un vídeo de YouTube no pasa por la API de protección', async () => {
    const calls = stubFetch(() => ({ status: 500, body: {} }));
    const container = await render(
      <VideoEmbed url="https://www.youtube.com/watch?v=abc123XYZ" title="Clase 1" />,
    );
    await settle();
    expect(calls).toHaveLength(0);
    expect(container.querySelector('iframe')?.src).toContain(
      'youtube-nocookie.com/embed/abc123XYZ',
    );
  });

  it('la pantalla completa propia aparece solo con marca de agua y donde el navegador la soporta', async () => {
    const guid = nextGuid();
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
    try {
      stubFetch(() => ({
        status: 200,
        body: {
          url: `${unsigned(guid)}?token=a&expires=1900000000`,
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          protected: true,
          watermark: true,
        },
      }));
      const container = await render(<VideoEmbed url={unsigned(guid)} title="Clase 1" />);
      await settle();
      expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
        'Pantalla completa',
      );
    } finally {
      delete (document as { fullscreenEnabled?: boolean }).fullscreenEnabled;
    }
  });
});

// ─────────────────── vídeo incrustado a mano en una lección HTML ───────────────────

describe('LessonHtmlWithVideos', () => {
  it('el iframe de Bunny del HTML se monta con la URL firmada, conservando sus parámetros', async () => {
    const guid = nextGuid();
    const calls = stubFetch(() => ({
      status: 200,
      body: {
        url: `${unsigned(guid)}?token=abc123&expires=1900000000`,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        protected: true,
        watermark: true,
      },
    }));
    const html = `<p>Antes</p><iframe src="${unsigned(guid)}?autoplay=false&loop=true" title="Demo"></iframe><p>Después</p>`;

    const container = await render(<LessonHtmlWithVideos html={html} />);
    await settle();

    expect(calls.map((c) => c.url)).toEqual([`/api/v1/video/bunny/${LIB}/${guid}/play-url`]);
    const iframes = container.querySelectorAll('.lesson-prose iframe');
    expect(iframes).toHaveLength(1);
    const src = new URL((iframes[0] as HTMLIFrameElement).src);
    expect(src.searchParams.get('token')).toBe('abc123');
    expect(src.searchParams.get('loop')).toBe('true');
    expect(src.searchParams.get('autoplay')).toBe('false');
    expect((iframes[0] as HTMLIFrameElement).title).toBe('Demo');
    expect(container.querySelector('[data-testid="video-watermark"]')).not.toBeNull();
    expect(container.textContent).toContain('Antes');
    expect(container.textContent).toContain('Después');
  });

  it('sin derecho al vídeo, el hueco muestra el aviso y la URL permanente no llega al DOM', async () => {
    const guid = nextGuid();
    stubFetch(() => ({ status: 403, body: { code: 'VIDEO_FORBIDDEN', message: 'x' } }));

    const container = await render(
      <LessonHtmlWithVideos html={`<iframe src="${unsigned(guid)}"></iframe>`} />,
    );
    await settle();

    expect(container.querySelector('iframe')).toBeNull();
    expect(container.innerHTML).not.toContain(guid);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'No tienes acceso a este vídeo.',
    );
  });

  it('COMPATIBILIDAD: un HTML sin vídeos de Bunny se pinta tal cual y no llama a la API', async () => {
    const calls = stubFetch(() => ({ status: 500, body: {} }));
    const html =
      '<p>Texto</p><iframe src="https://www.youtube-nocookie.com/embed/abc123"></iframe>';

    const container = await render(<LessonHtmlWithVideos html={html} />);
    await settle();

    expect(container.querySelector('.lesson-prose')?.innerHTML).toBe(html);
    expect(calls).toHaveLength(0);
  });

  it('el reproductor del hueco sobrevive a los re-renders de la página (no se recarga)', async () => {
    const guid = nextGuid();
    stubFetch(() => ({
      status: 200,
      body: { url: unsigned(guid), expiresAt: null, protected: false, watermark: false },
    }));
    const html = `<iframe src="${unsigned(guid)}"></iframe>`;
    const container = await render(<LessonHtmlWithVideos html={html} />);
    await settle();
    const before = container.querySelector('iframe');
    expect(before).not.toBeNull();

    // Mismo `html`, árbol re-renderizado desde arriba (lo que hace cada reporte
    // de progreso): el nodo del iframe tiene que ser EL MISMO.
    const { root } = mounted[mounted.length - 1]!;
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        root.render(
          <NextIntlClientProvider locale="es-ES" messages={es as never} timeZone="UTC">
            <LessonHtmlWithVideos html={html} />
          </NextIntlClientProvider>,
        );
      });
    }
    expect(container.querySelector('iframe')).toBe(before);
  });
});

// ─────────────────────────────── tarjeta del panel ───────────────────────────────

const OFF: VideoProtectionState = {
  enabled: true,
  active: false,
  watermark: true,
  limits: { perHour: 30, perDay: 100 },
  libraries: [{ libraryId: LIB, configured: false, inUse: true, lastCheck: null }],
};

function configured(outcome?: SignatureCheckOutcome, enabled = true): VideoProtectionState {
  return {
    ...OFF,
    enabled,
    active: enabled,
    libraries: [
      {
        libraryId: LIB,
        configured: true,
        inUse: true,
        lastCheck: outcome ? { outcome, checkedAt: '2030-01-01T10:00:00.000Z' } : null,
      },
    ],
  };
}

function fakeApi(initial: VideoProtectionState) {
  let state = initial;
  const api = {
    playUrl: vi.fn(),
    getAdmin: vi.fn(async () => state),
    saveTokenKey: vi.fn(async (_libraryId: string, _tokenKey: string) => (state = configured())),
    saveSettings: vi.fn(async (patch: { enabled?: boolean }) => {
      state = { ...state, enabled: patch.enabled ?? state.enabled };
      return state;
    }),
    check: vi.fn(async (libraryId: string) => {
      state = configured('ok');
      return {
        libraryId,
        outcome: 'ok' as SignatureCheckOutcome,
        checkedAt: '2030-01-01T10:00:00.000Z',
        signedStatus: 200,
        unsignedStatus: 200,
      };
    }),
  };
  return api as unknown as typeof videoProtectionApi & typeof api;
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}

describe('VideoProtectionCard', () => {
  it('sin clave: dice que está APAGADA y cómo encenderla, incluido lo que hay que activar en Bunny', async () => {
    const container = await render(<VideoProtectionCard api={fakeApi(OFF)} />);
    await settle();

    expect(
      container.querySelector('[data-testid="video-protection-status-off"]')?.textContent,
    ).toMatch(/^Apagada\./);
    const steps = Array.from(container.querySelectorAll('ol li')).map((li) => li.textContent ?? '');
    expect(steps).toHaveLength(5);
    expect(steps.join(' ')).toContain('«Token authentication key»');
    expect(steps.join(' ')).toContain('«Embed view token authentication»');
    expect(steps.join(' ')).toContain('*/original*');
    expect(container.textContent).toContain(`Librería ${LIB}`);
    expect(container.textContent).toContain('Sin clave');
  });

  it('la misma tarjeta en inglés', async () => {
    const container = await render(<VideoProtectionCard api={fakeApi(OFF)} />, 'en');
    await settle();

    expect(
      container.querySelector('[data-testid="video-protection-status-off"]')?.textContent,
    ).toMatch(/^Off\./);
    expect(container.textContent).toContain('Video protection');
    expect(container.textContent).toContain('“Embed view token authentication”');
    expect(container.textContent).toContain(`Library ${LIB}`);
    expect(container.textContent).toContain('Save key');
    // Ni una key cruda ni un resto en español.
    expect(container.textContent).not.toContain('videoProtection.');
    expect(container.textContent).not.toContain('Guardar');
  });

  it('guardar la clave: va a la API recortada, el campo se vacía y la clave NO queda en pantalla', async () => {
    const api = fakeApi(OFF);
    const container = await render(<VideoProtectionCard api={api} />);
    await settle();

    const form = container.querySelector<HTMLFormElement>(
      `[data-testid="video-protection-library-${LIB}"]`,
    )!;
    const input = form.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(input.autocomplete).toBe('off');
    await act(async () => typeInto(input, '  clave-secreta-de-bunny  '));
    await submit(form);

    expect(api.saveTokenKey).toHaveBeenCalledWith(LIB, 'clave-secreta-de-bunny');
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('');
    expect(container.innerHTML).not.toContain('clave-secreta-de-bunny');
    expect(container.textContent).toContain('Clave guardada');
    expect(
      container.querySelector('[data-testid="video-protection-status-unverified"]'),
    ).not.toBeNull();
  });

  it('comprobar: llama a la API y enseña lo que dijo Bunny', async () => {
    const api = fakeApi(configured());
    const container = await render(<VideoProtectionCard api={api} />);
    await settle();
    expect(container.textContent).toContain('Sin comprobar todavía.');

    const checkButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Comprobar',
    )!;
    await act(async () => checkButton.click());
    await settle();

    expect(api.check).toHaveBeenCalledWith(LIB);
    expect(
      container.querySelector('[data-testid="video-protection-check-ok"]')?.textContent,
    ).toContain('Bunny exige token y acepta la firma del aula');
    expect(container.querySelector('[data-testid="video-protection-status-on"]')).not.toBeNull();
  });

  it.each([
    ['rejected', 'tus alumnos NO pueden ver los vídeos'],
    ['not_enforced', 'Bunny todavía NO exige token'],
  ] as const)(
    'una comprobación «%s» deja la tarjeta en «hay algo que revisar»',
    async (outcome, text) => {
      const container = await render(<VideoProtectionCard api={fakeApi(configured(outcome))} />);
      await settle();
      expect(
        container.querySelector('[data-testid="video-protection-status-attention"]'),
      ).not.toBeNull();
      expect(container.textContent).toContain(text);
    },
  );

  it('sin clave no se puede comprobar', async () => {
    const container = await render(<VideoProtectionCard api={fakeApi(OFF)} />);
    await settle();
    const checkButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Comprobar',
    )!;
    expect(checkButton.disabled).toBe(true);
  });

  it('desactivar: manda enabled=false y la tarjeta pasa a «Desactivada»', async () => {
    const api = fakeApi(configured('ok'));
    const container = await render(<VideoProtectionCard api={api} />);
    await settle();

    const toggle = container.querySelector<HTMLInputElement>('#video-protection-enabled')!;
    expect(toggle.checked).toBe(true);
    await act(async () => toggle.click());
    await submit(
      container.querySelector<HTMLFormElement>('[data-testid="video-protection-settings"]')!,
    );

    expect(api.saveSettings).toHaveBeenCalledWith({
      enabled: false,
      watermark: true,
      maxVideosPerHour: 30,
      maxVideosPerDay: 100,
    });
    expect(
      container.querySelector('[data-testid="video-protection-status-disabled"]')?.textContent,
    ).toMatch(/^Desactivada\./);
  });

  it('un tope diario menor que el horario no se envía', async () => {
    const api = fakeApi(configured('ok'));
    const container = await render(<VideoProtectionCard api={api} />);
    await settle();

    const perDay = container.querySelector<HTMLInputElement>('#video-protection-per-day')!;
    await act(async () => typeInto(perDay, '5'));
    await submit(
      container.querySelector<HTMLFormElement>('[data-testid="video-protection-settings"]')!,
    );

    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'El tope diario no puede ser menor que el tope por hora.',
    );
  });

  it('si la API no deja (403), enseña el motivo traducido y no pinta formularios', async () => {
    const { ApiHttpError } = await import('@/lib/api-client');
    const api = fakeApi(OFF);
    api.getAdmin.mockRejectedValue(
      new ApiHttpError({
        message: 'Solo super_admin o tenant_admin pueden gestionar la protección de vídeo.',
        status: 403,
        code: 'ADMIN_VIDEO_PROTECTION_FORBIDDEN',
      }),
    );
    const container = await render(<VideoProtectionCard api={api} />, 'en');
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Only super_admin or tenant_admin can manage video protection.',
    );
    expect(container.querySelector('form')).toBeNull();
  });
});
