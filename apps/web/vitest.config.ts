import { defineConfig } from 'vitest/config';
import path from 'node:path';

/// Config mínima para que vitest resuelva el alias `@/` igual que Next/TS
/// y que los clients del módulo (`apps/web/src/modules/*/client.ts`)
/// puedan importar `@/lib/api-client` sin romper los tests unitarios.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
