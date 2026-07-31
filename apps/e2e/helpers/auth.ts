import type { Page } from '@playwright/test';

/**
 * Inyecta tokens y sesión directamente en sessionStorage/localStorage del
 * navegador, replicando lo que hace `authStorage` en `apps/web/src/lib/auth-storage.ts`.
 *
 * Hay que llamarlo DESPUÉS de un `page.goto()` inicial, porque el web storage
 * está scoped al origin que ya cargó. Después se navega al destino real.
 */
export async function injectSession(
  page: Page,
  args: {
    accessToken: string;
    refreshToken?: string;
    user: {
      id: string;
      email: string;
      name: string | null;
      tenantId: string;
      tenantSlug: string;
      roles: string[];
      mfaEnabled: boolean;
      /** Si se setea, evita el gate de onboarding de primera vez en el web. */
      onboardingCompletedAt?: string | null;
    };
  },
): Promise<void> {
  await page.evaluate((data) => {
    sessionStorage.setItem('didacta.access_token', data.accessToken);
    if (data.refreshToken) localStorage.setItem('didacta.refresh_token', data.refreshToken);
    sessionStorage.setItem(
      'didacta.session',
      JSON.stringify({ user: data.user, mfaRequired: false }),
    );
  }, args);
}
