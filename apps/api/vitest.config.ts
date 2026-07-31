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
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Los tests de integración (`*.integration.test.ts`) requieren Postgres
    // levantado vía `docker-compose.test.yml` y se corren con
    // `vitest.integration.config.ts`. Aquí los excluimos para que `pnpm test`
    // siga pasando en local sin docker y en CI ligera.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/integration/**',
      '**/*.integration.test.ts',
    ],
  },
});
