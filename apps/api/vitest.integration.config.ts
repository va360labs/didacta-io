/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Vitest config separada para tests de integración (MIG-034).
 *
 * - Solo recoge `tests/integration/**\/*.integration.test.ts` (los unit
 *   se quedan en `vitest.config.ts`).
 * - `globalSetup` aplica el schema Prisma al Postgres del compose ANTES de
 *   que arranquen los tests.
 * - Aumenta timeouts: el bootstrap de NestFastify + la conexión a Postgres
 *   real toman más que un unit test.
 * - Single-fork: evita race conditions en process.env entre tests
 *   (varios tests cambian NODE_ENV).
 */

import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { decoratorMetadata: true, legacyDecorator: true },
      },
    }),
  ],
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/integration/**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**'],
    globalSetup: ['tests/integration/helpers/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // Un fichero detrás de otro. Vitest 4 quitó `poolOptions.forks.singleFork`
    // (lo ignora con un aviso) y con él los ficheros corrían en paralelo sobre
    // la MISMA base: `rls.sql` aplicado a la vez por varios psql y el
    // `process.env` de un test pisando el de otro. `maxWorkers: 1` es su
    // sustituto.
    maxWorkers: 1,
  },
});
