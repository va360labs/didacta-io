/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Contextos de navegador para las capturas.
 *
 * `browser.newContext()` NO hereda el bloque `use` de la config, así que el
 * viewport se pasa aquí explícitamente: si se olvida, la tanda inglesa sale a
 * 1280x720 y deja de ser comparable con la española.
 */

import type { Browser, BrowserContext, Page } from '@playwright/test';
import { BASE_URL, LOCALE } from './config';
import { freeze } from './shot';

export const VIEWPORT = { width: 1440, height: 900 } as const;

/**
 * Contexto nuevo con el viewport fijo y la cookie de idioma ya puesta, para que
 * el PRIMER render del servidor salga en el idioma bueno y no haya un flash de
 * español en la captura.
 */
export async function newShotContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { ...VIEWPORT },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: LOCALE,
    timezoneId: 'Europe/Madrid',
  });
  await context.addCookies([{ name: 'didacta_locale', value: LOCALE, url: BASE_URL }]);
  // Techo por acción: sin esto un selector que no resuelve se come el timeout
  // del recorrido entero y el error final no dice dónde se atascó.
  context.setDefaultTimeout(30_000);
  return context;
}

/** Página del contexto con las animaciones ya congeladas en cada navegación. */
export async function newShotPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.on('load', () => {
    void freeze(page);
  });
  return page;
}

/**
 * Lee el access token que la app guardó al iniciar sesión. `authStorage` elige
 * `localStorage` o `sessionStorage` según el "mantener la sesión abierta", así
 * que hay que mirar en los dos.
 */
export async function readAccessToken(page: Page): Promise<string> {
  const token = await page.evaluate(
    () =>
      localStorage.getItem('didacta.access_token') ??
      sessionStorage.getItem('didacta.access_token'),
  );
  if (!token) throw new Error('[shots] La página no tiene sesión iniciada (sin access token)');
  return token;
}
