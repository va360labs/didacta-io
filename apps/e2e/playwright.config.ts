import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3010';

export default defineConfig({
  testDir: './tests',
  // Verifica que el stack está entero ANTES de correr nada y deja el entorno
  // en el estado que los specs dan por supuesto (onboarding cerrado, espacios
  // de sistema sembrados, Redis y cupo de rate limit con margen). Ver el
  // comentario largo en global-setup.ts: cada comprobación de ahí corresponde
  // a una degradación que antes fallaba en silencio.
  globalSetup: require.resolve('./global-setup'),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
