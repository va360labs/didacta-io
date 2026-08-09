/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Toma de la captura: anotación, estabilización y escritura del PNG.
 *
 * Determinismo: nada de `waitForTimeout`. Antes de disparar se espera a que no
 * queden esqueletos de carga, a que las imágenes hayan decodificado y a que el
 * DOM deje de mutar. Lo único que se congela por tiempo son las animaciones
 * CSS, y se hace desactivándolas, no esperándolas.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { CATALOG, OUT_DIR } from './config';

/** `recorrido-visual` | `notificaciones-y-pagos`. */
export type Walkthrough = 'recorrido-visual' | 'notificaciones-y-pagos';

/**
 * Directorio de salida del recorrido en el idioma activo.
 *
 * El español conserva la ruta histórica (`<out>/recorrido-visual/`) porque sus
 * PNGs sustituyen a los actuales de `didacta-docs` uno a uno; el inglés cuelga
 * de un subdirectorio `en/`, que es la convención que se usa en la doc.
 */
export function outputDir(walkthrough: Walkthrough): string {
  return CATALOG === 'en' ? path.join(OUT_DIR, walkthrough, 'en') : path.join(OUT_DIR, walkthrough);
}

const CSS_FREEZE = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  /* El cursor de texto parpadeante hace que dos capturas del mismo estado
     salgan distintas. */
`;

/** Inyecta el congelador de animaciones. Idempotente por página. */
export async function freeze(page: Page): Promise<void> {
  await page.addStyleTag({ content: CSS_FREEZE }).catch(() => {
    /* la página puede estar navegando; el siguiente intento lo pilla */
  });
}

/**
 * Espera a que la pantalla esté quieta.
 *
 * ⚠️ Nada de `waitForLoadState('networkidle')`: la app abre DOS canales SSE
 * (`/messaging/stream` y `/me/notifications/stream`) en cuanto hay sesión, así
 * que la red NUNCA queda ociosa y cada captura se comía los 30 s de timeout.
 * El criterio bueno es el DOM: sin esqueletos de carga, con las imágenes ya
 * decodificadas y sin mutaciones durante un rato.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page
    .waitForFunction(
      () => {
        const skeletons = document.querySelectorAll('[data-loading="true"], .animate-pulse');
        if (skeletons.length > 0) return false;
        return Array.from(document.images).every((img) => img.complete);
      },
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => {
      /* si algo sigue cargando, mejor una captura honesta que un fallo del
         generador: la revisión humana lo detecta */
    });
  await page
    .evaluate(
      ({ quietMs, capMs }) =>
        new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout>;
          const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(done, quietMs);
          });
          const done = () => {
            observer.disconnect();
            clearTimeout(cap);
            resolve();
          };
          const cap = setTimeout(done, capMs);
          timer = setTimeout(done, quietMs);
          observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        }),
      { quietMs: 400, capMs: 8_000 },
    )
    .catch(() => undefined);
  await freeze(page);
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);
}

export interface AnnotationSpec {
  /** Elemento a resaltar. */
  target: Locator;
  /** Texto de la etiqueta roja. Ya viene en el idioma activo. */
  label: string;
}

/**
 * Dibuja el marco rojo con etiqueta sobre uno o varios elementos, replicando la
 * anotación a mano de las capturas originales. Se pinta como overlay dentro de
 * la propia página, así que el PNG sale ya anotado y no hace falta post-proceso.
 */
export async function annotate(page: Page, specs: AnnotationSpec[]): Promise<void> {
  const boxes: Array<{ x: number; y: number; width: number; height: number; label: string }> = [];
  for (const spec of specs) {
    const box = await spec.target.first().boundingBox();
    if (!box) {
      throw new Error(`[shots] No se pudo medir el elemento a anotar ("${spec.label}")`);
    }
    boxes.push({ ...box, label: spec.label });
  }

  await page.evaluate((items) => {
    const previous = document.getElementById('didacta-shots-annotations');
    if (previous) previous.remove();

    const layer = document.createElement('div');
    layer.id = 'didacta-shots-annotations';
    layer.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;';

    for (const item of items) {
      const frame = document.createElement('div');
      frame.style.cssText = [
        'position:absolute',
        `left:${item.x - 5}px`,
        `top:${item.y - 5}px`,
        `width:${item.width + 10}px`,
        `height:${item.height + 10}px`,
        'border:3px solid #F5325B',
        'border-radius:12px',
        'box-shadow:0 0 0 3px #fff, 0 0 14px 5px rgba(245,50,91,.35)',
        'box-sizing:border-box',
      ].join(';');
      layer.appendChild(frame);

      const tag = document.createElement('span');
      tag.textContent = item.label;
      tag.style.cssText = [
        'position:absolute',
        `left:${item.x - 5}px`,
        `top:${item.y - 24}px`,
        'background:#F5325B',
        'color:#fff',
        'font-size:10px',
        'font-weight:700',
        'line-height:1',
        'padding:4px 7px',
        'border-radius:5px 5px 5px 0',
        'white-space:nowrap',
      ].join(';');
      layer.appendChild(tag);
    }

    document.body.appendChild(layer);
  }, boxes);
}

/**
 * Escribe un `<input type="range">` como lo haría un humano moviendo el
 * control. `locator.fill()` no vale con los range, y React ignora un
 * `element.value = …` a pelo: hay que llamar al setter nativo y disparar el
 * evento `input` para que el estado del componente se entere.
 */
export async function setRange(page: Page, selector: string, value: number): Promise<void> {
  await page.evaluate(
    ({ selector: sel, value: v }) => {
      const element = document.querySelector<HTMLInputElement>(sel);
      if (!element) throw new Error(`No existe ${sel}`);
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(element, String(v));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { selector, value },
  );
}

/**
 * Deja un `<Switch>` en el estado pedido, sea cual sea el de partida.
 *
 * El componente es un `<button role="switch" aria-checked>` propio (no Radix),
 * así que el estado se lee de `aria-checked`. Clicar a ciegas es un error
 * clásico: varios de estos toggles vienen encendidos de fábrica y el click los
 * apaga — y luego la captura contradice al texto de la documentación.
 */
export async function setSwitch(target: Locator, checked: boolean): Promise<void> {
  await target.waitFor({ state: 'visible' });
  const current = (await target.getAttribute('aria-checked')) === 'true';
  if (current !== checked) await target.click();
}

/** Quita el overlay de anotación (por si la misma página encadena capturas). */
export async function clearAnnotations(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById('didacta-shots-annotations')?.remove());
}

export interface ShotOptions {
  /** Elementos a resaltar en rojo, como en las capturas originales. */
  annotations?: AnnotationSpec[];
  /** Desplaza la página para que este elemento quede a la vista antes de disparar. */
  scrollTo?: Locator;
  /** Captura la página entera en vez del viewport. Por defecto, viewport. */
  fullPage?: boolean;
}

/**
 * Escribe `<out>/<recorrido>[/en]/<nombre>.png`.
 *
 * `name` es el nombre de fichero SIN extensión y se conserva entre idiomas:
 * la documentación referencia `01-setup-intro.png` en las dos.
 */
export async function shot(
  page: Page,
  walkthrough: Walkthrough,
  name: string,
  options: ShotOptions = {},
): Promise<string> {
  if (options.scrollTo) {
    await options.scrollTo.first().scrollIntoViewIfNeeded();
  }
  await settle(page);
  if (options.annotations?.length) {
    await annotate(page, options.annotations);
  }

  const dir = outputDir(walkthrough);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: options.fullPage ?? false });
  await clearAnnotations(page);
  // eslint-disable-next-line no-console
  console.log(`[shots] ${walkthrough}/${CATALOG === 'en' ? 'en/' : ''}${name}.png`);
  return file;
}

/**
 * Comprueba que la página está renderizada en el idioma que se está
 * capturando. `LocaleSync` puede reescribir la cookie con `profile.locale` y
 * devolver la UI a español sin avisar (ver `apps/web/src/components/locale-sync.tsx`);
 * si eso pasa la captura inglesa sale en español y nadie se entera hasta que
 * la mira un humano. Aquí revienta en el acto.
 */
export async function assertLocale(page: Page, expected: string): Promise<void> {
  const lang = await page.evaluate(() => document.documentElement.lang);
  if (lang !== expected) {
    throw new Error(
      `[shots] La página está renderizada en "${lang}" y se esperaba "${expected}". ` +
        'Revisa el locale del PERFIL (user.locale), no solo la cookie.',
    );
  }
}
