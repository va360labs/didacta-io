import { defineConfig } from 'vitest/config';
import path from 'node:path';

/// Config mínima para que vitest resuelva el alias `@/` igual que Next/TS
/// y que los clients del módulo (`apps/web/src/modules/*/client.ts`)
/// puedan importar `@/lib/api-client` sin romper los tests unitarios.
///
/// Coverage: scopeado a la lógica del andamiaje i18n (regla 6 del repo, 70%
/// mínimo en lógica de negocio) sin imponer umbral al resto del suite de web,
/// que nunca lo tuvo.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/i18n/**', 'src/lib/i18n/**'],
      exclude: ['**/*.d.ts', '**/messages/**'],
      thresholds: { lines: 70, functions: 70, branches: 70, statements: 70 },
    },
  },
});
