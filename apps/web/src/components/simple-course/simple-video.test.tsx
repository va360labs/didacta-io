// @vitest-environment jsdom

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * La lección de VÍDEO del modo sencillo, pintada de verdad (react-dom a pelo,
 * como `video-protection-ui.test.tsx`): solo se sustituye la red (`fetch`) y el
 * router de Next. Entre el componente y la respuesta corre el código real
 * (hooks, `apiFetch`, i18n con los catálogos de los dos idiomas).
 *
 * Lo que fallaba: sin subida de vídeo en el aula (la API da 404) el campo de
 * subida no se pintaba y quedaba solo el enlace, mientras el selector prometía
 * «Súbelo o pega un enlace»; y al pulsar «Vídeo» se creaba una lección vacía
 * que se quedaba en el curso aunque se cancelase.
 */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/i18n/messages/en';
import es from '@/i18n/messages/es';
import { VideoUploadField } from '@/components/video-upload-field';
import { SimpleCourseEditor, titleFromFileName } from './simple-course-editor';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COURSE = '11111111-2222-4333-8444-555555555555';
const MODULE = '22222222-3333-4444-8555-666666666666';
const LESSON = '33333333-4444-4555-8666-777777777777';
const ASSET = '44444444-5555-4666-8777-888888888888';
const GUID = '0f1e2d3c-4b5a-4978-8a6b-000000000001';
const EMBED = `https://iframe.mediadelivery.net/embed/100200/${GUID}`;

const QUOTA = {
  tier: 'pre_sale',
  maxResolution: '720p',
  stored: { usedSeconds: 0, limitSeconds: 5 * 3600, bonusSeconds: 0 },
  watched: { month: '2026-11', usedSeconds: 0, limitSeconds: 100 * 3600 },
  maxFileBytes: 2 * 1024 ** 3,
  maxFileSeconds: 2 * 3600,
  postSaleStoredSeconds: 50 * 3600,
};

function course(lessons: unknown[] = []) {
  return {
    id: COURSE,
    slug: 'espresso-at-home',
    title: 'Espresso at Home',
    status: 'DRAFT',
    modules: [{ id: MODULE, courseId: COURSE, title: 'Lessons', position: 0, lessons }],
  };
}

type Answer = { status: number; body: unknown } | Error;
type Handler = (method: string, url: string) => Answer | undefined;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
let calls: Array<{ method: string; url: string }> = [];

function stubApi(handler: Handler) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url });
      const answer = handler(method, url) ?? { status: 404, body: { message: 'no' } };
      if (answer instanceof Error) throw answer;
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

async function render(node: ReactNode, locale: 'es' | 'en' = 'en'): Promise<HTMLElement> {
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
  await settle();
  return container;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function click(el: Element | null | undefined) {
  if (!el) throw new Error('no está en pantalla');
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

const byTestId = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);
const button = (c: HTMLElement, text: string) =>
  [...c.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

const lessonWrites = () =>
  calls.filter((x) => x.method !== 'GET' && x.url.includes('/modules/courses/'));

beforeEach(() => {
  localStorage.setItem('didacta.access_token', 'token-de-prueba');
});

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('lección de vídeo en el modo sencillo', () => {
  it('aula SIN subida de vídeo: lo dice y ofrece el enlace (nada escondido)', async () => {
    stubApi((method, url) => {
      if (url.endsWith(`/modules/courses/${COURSE}`)) return { status: 200, body: course() };
      if (url.endsWith('/video/uploads/quota')) return { status: 404, body: { message: 'no' } };
      return undefined;
    });
    const c = await render(<SimpleCourseEditor courseId={COURSE} />);
    await click(byTestId(c, 'anadir-leccion'));

    // El selector ya no promete «súbelo» si no se puede.
    const videoOption = byTestId(c, 'tipo-VIDEO')!;
    expect(videoOption.textContent).toContain('Paste a YouTube or Vimeo link');
    expect(videoOption.textContent).not.toContain('Upload');

    await click(videoOption);
    const notice = byTestId(c, 'video-sin-subida');
    expect(notice?.textContent).toContain("Uploading videos isn't available in this academy");
    expect(c.querySelector('label[for="leccion-video"]')?.textContent).toBe(
      'Video link (YouTube, Vimeo…)',
    );
    expect(c.querySelector('input[type="file"]')).toBeNull();
    // Elegir «Vídeo» ya no crea una lección.
    expect(lessonWrites()).toEqual([]);
  });

  it('aula CON subida: «Sube tu vídeo» primero, el enlace como alternativa, y sin lección fantasma', async () => {
    stubApi((method, url) => {
      if (url.endsWith(`/modules/courses/${COURSE}`)) return { status: 200, body: course() };
      if (url.endsWith('/video/uploads/quota')) return { status: 200, body: QUOTA };
      return undefined;
    });
    const c = await render(<SimpleCourseEditor courseId={COURSE} />, 'es');
    await click(byTestId(c, 'anadir-leccion'));
    expect(byTestId(c, 'tipo-VIDEO')!.textContent).toContain('Súbelo o pega un enlace');
    await click(byTestId(c, 'tipo-VIDEO'));

    const drop = byTestId(c, 'video-soltar');
    expect(drop?.textContent).toContain('Sube tu vídeo');
    expect(drop?.textContent).toContain('Elegir vídeo');
    expect(drop?.textContent).toContain('Hasta 2 GB y 2 h por vídeo');
    expect(byTestId(c, 'video-fichero')).not.toBeNull();
    expect(c.querySelector('label[for="leccion-video"]')?.textContent).toBe(
      'O pega el enlace del vídeo (YouTube, Vimeo…)',
    );

    await click(button(c, 'Cancelar'));
    expect(byTestId(c, 'form-leccion')).toBeNull();
    expect(lessonWrites()).toEqual([]);
  });

  it('si no se ha podido preguntar, ofrece volver a probar (no lo da por apagado)', async () => {
    let quotaUp = false;
    stubApi((method, url) => {
      if (url.endsWith(`/modules/courses/${COURSE}`)) return { status: 200, body: course() };
      if (url.endsWith('/video/uploads/quota')) {
        return quotaUp ? { status: 200, body: QUOTA } : { status: 503, body: { message: 'caída' } };
      }
      return undefined;
    });
    const c = await render(<SimpleCourseEditor courseId={COURSE} />);
    await click(byTestId(c, 'anadir-leccion'));
    await click(byTestId(c, 'tipo-VIDEO'));
    expect(byTestId(c, 'video-error-espacio')?.textContent).toContain(
      "We couldn't check your video space",
    );
    quotaUp = true;
    await click(button(c, 'Try again'));
    expect(byTestId(c, 'video-error-espacio')).toBeNull();
    expect(byTestId(c, 'video-soltar')?.textContent).toContain('Upload your video');
  });

  it('lección con vídeo subido y listo: miniatura y «guardado», sin la URL técnica a la vista', async () => {
    const lesson = {
      id: LESSON,
      moduleId: MODULE,
      type: 'VIDEO',
      title: 'Pulling the perfect shot',
      position: 0,
      durationMinutes: 1,
      content: { videoUrl: EMBED },
    };
    stubApi((method, url) => {
      if (url.endsWith(`/modules/courses/${COURSE}`))
        return { status: 200, body: course([lesson]) };
      if (url.endsWith('/video/uploads/quota')) return { status: 200, body: QUOTA };
      if (url.includes(`/video/uploads?lessonId=${LESSON}`)) {
        return {
          status: 200,
          body: [
            {
              id: ASSET,
              lessonId: LESSON,
              title: 'pulling-the-perfect-shot',
              status: 'READY',
              failureReason: null,
              durationSeconds: 12,
              maxResolution: '720p',
              embedUrl: EMBED,
              thumbnailUrl: 'https://cdn.example.com/thumb.jpg?token=x',
              createdAt: '2026-11-13T10:00:00.000Z',
            },
          ],
        };
      }
      return undefined;
    });
    const c = await render(<SimpleCourseEditor courseId={COURSE} />);
    await click(button(c, 'Edit'));
    const card = byTestId(c, 'video-listo');
    expect(card?.textContent).toContain('Ready');
    expect(card?.textContent).toContain('Saved in the lesson. Your students can watch it now.');
    expect(card?.querySelector('img')?.getAttribute('src')).toContain('thumb.jpg');
    expect(c.innerHTML).not.toContain('mediadelivery.net');
    expect(c.querySelector('#leccion-video')).toBeNull();
  });
});

describe('editor del modo completo (sin cambios)', () => {
  it('sin subida en la instalación no pinta nada; con subida, la zona de arrastre', async () => {
    stubApi((method, url) =>
      url.endsWith('/video/uploads/quota') ? { status: 404, body: {} } : undefined,
    );
    const off = await render(
      <VideoUploadField lessonId={LESSON} videoUrl="" savedVideoUrl="" onVideoUrl={() => {}} />,
    );
    expect(off.innerHTML).toBe('');

    stubApi((method, url) =>
      url.endsWith('/video/uploads/quota')
        ? { status: 200, body: QUOTA }
        : { status: 200, body: [] },
    );
    const on = await render(
      <VideoUploadField lessonId={LESSON} videoUrl="" savedVideoUrl="" onVideoUrl={() => {}} />,
    );
    expect(byTestId(on, 'video-upload')?.textContent).toContain('Upload the video for this lesson');
  });
});

describe('título desde el nombre del fichero', () => {
  it('quita la extensión y los guiones', () => {
    expect(titleFromFileName('pulling-the-perfect-shot.mp4')).toBe('pulling the perfect shot');
    expect(titleFromFileName('Espresso_basics  final.MOV')).toBe('Espresso basics final');
    expect(titleFromFileName('clase 1.webm')).toBe('clase 1');
    expect(titleFromFileName('.mp4')).toBe('.mp4');
  });
});
