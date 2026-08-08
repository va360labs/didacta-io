/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Config de Playwright para el generador de capturas de la documentación
 * (`shots/`). Es un proyecto aparte del `playwright.config.ts` de los specs
 * E2E porque:
 *
 *  - el viewport tiene que ser FIJO (1440x900, dsf 1) para que la tanda
 *    española y la inglesa sean comparables píxel a píxel;
 *  - los "tests" no aseveran nada de negocio: recorren la app y escriben PNGs,
 *    así que no deben mezclarse con el reporte de la suite;
 *  - el orden entre ficheros es significativo (el recorrido de ventas continúa
 *    donde acaba el de primeros pasos) → `workers: 1` y `fullyParallel: false`.
 *
 * Ver `shots/README.md` para qué hay que tener levantado y cómo se lanza.
 */

import { defineConfig } from '@playwright/test';

const BASE_URL = process.env.SHOTS_BASE_URL ?? process.env.E2E_BASE_URL ?? 'http://localhost:3010';

export default defineConfig({
  testDir: './shots',
  // Los ficheros se descubren y ejecutan en orden alfabético; el prefijo
  // numérico de cada spec (`01-…`, `02-…`) fija la secuencia del recorrido.
  testMatch: /\d\d-.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Cada spec es UN recorrido completo (20 pantallas encadenadas), no un test
  // suelto: el presupuesto es el del recorrido entero.
  timeout: 20 * 60 * 1000,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    // Mismo tamaño que las 40 capturas originales de la documentación.
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    // Determinista: las fechas relativas ("hace unos segundos") y los formatos
    // de fecha del servidor se calculan siempre en la misma zona.
    timezoneId: 'Europe/Madrid',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [{ name: 'shots' }],
});
