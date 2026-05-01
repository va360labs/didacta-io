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
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
