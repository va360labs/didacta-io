import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { authenticator } from 'otplib';
import { signin } from '../helpers/api';
import { injectSession } from '../helpers/auth';

const PG_CONTAINER = process.env.E2E_PG_CONTAINER ?? 'didacta-postgres-test';
const PG_USER = process.env.E2E_PG_USER ?? 'didacta_test';
const PG_DB = process.env.E2E_PG_DB ?? 'didacta_test';

/** SQL directo contra el Postgres efímero (superuser del compose → sin RLS). */
function sql(query: string): string {
  return execFileSync(
    'docker',
    ['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DB, '-t', '-A', '-c', query],
    { encoding: 'utf8' },
  ).trim();
}

/**
 * Deja al admin como recién sembrado: sin MFA configurada.
 *
 * Es el ESTADO INICIAL que este spec ejercita —el alta de primera vez—, y sin
 * establecerlo el spec sólo pasa la primera vez que se corre sobre una base
 * recién sembrada. La segunda falla a los 15 s diciendo que no encuentra el
 * título del formulario, que es de las pistas más falsas posibles, porque el
 * navegador ni siquiera está en /mfa/setup:
 *
 *   1. El shell pide `GET /modules/theming/me` en CADA página, también en las
 *      de auth. Ese endpoint no está marcado `@MfaExempt`, así que con la
 *      política activa responde 403 `mfa_required` mientras la sesión no esté
 *      verificada. Verificado en los logs del arnés.
 *   2. Ante ese 403 el cliente deriva al flujo MFA por su cuenta
 *      (apps/web/src/lib/api-client.ts:260) y elige destino con el
 *      `mfaEnabled` de la sesión guardada: /mfa/verify si ya la tiene,
 *      /mfa/setup si no.
 *
 * O sea que con MFA ya activada el navegador se va a /mfa/verify (a veces con
 * un `net::ERR_ABORTED` en el propio goto), y con MFA sin activar el destino
 * coincide con la página actual y no se mueve nadie. De ahí que el spec
 * alternara pasa/falla/pasa/falla al repetirlo sobre el mismo stack.
 *
 * No hay endpoint de producto para desactivar MFA (`mfa.controller.ts` sólo
 * expone setup/enable/verify), así que se limpia la fila por el mismo camino
 * que ya usan `catalogo-publico` y `arnes-contrato`.
 */
function resetAdminMfa(email: string): void {
  sql(
    `UPDATE "user" SET mfa_enabled = false, mfa_secret = NULL, mfa_recovery_codes = '{}' ` +
      `WHERE email = '${email.replace(/'/g, "''")}'`,
  );
}

/**
 * Flujo MFA del admin: setup + enable end-to-end vía UI.
 *
 * Idempotente de verdad: `resetAdminMfa` devuelve al admin al estado sin MFA
 * antes de empezar, así que se puede correr N veces seguidas y da igual el
 * orden respecto a `mfa-enforcement.spec.ts`, que deja al mismo admin con MFA
 * activada.
 *
 * El flujo:
 * 1. Signin del admin via API → obtiene token (mfaRequired=true).
 * 2. Inyecta sesión en el browser.
 * 3. Navega a /mfa/setup → la página llama POST /mfa/setup → muestra QR + URL otpauth.
 * 4. Extrae el secret del otpauthUrl visible en el page (dentro de <details>).
 * 5. Genera código TOTP con otplib + el secret extraído.
 * 6. Rellena el input + click "Confirmar y activar MFA".
 * 7. POST /mfa/enable → success → redirect a /.
 */
test.describe('Auth · MFA admin', () => {
  test('admin completa setup MFA → enable con código TOTP → sesión queda mfaVerified', async ({
    page,
  }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const adminEmail = process.env.E2E_ADMIN_EMAIL;
    const adminPassword = process.env.E2E_ADMIN_PASSWORD;
    if (!adminEmail || !adminPassword) {
      throw new Error('E2E_ADMIN_EMAIL y E2E_ADMIN_PASSWORD requeridos para el spec de MFA');
    }

    // 0) Estado inicial: admin sin MFA configurada (el porqué, en resetAdminMfa)
    resetAdminMfa(adminEmail);

    // 1) Signin admin → mfaRequired=true
    const session = await signin({ tenantSlug, email: adminEmail, password: adminPassword });
    expect(session.mfaRequired, 'admin debe requerir MFA').toBe(true);
    expect(
      session.user.mfaEnabled,
      'y no la tiene configurada todavía: lo que se ejercita aquí es el ALTA',
    ).toBe(false);

    // 2) Inyectar sesión (todavía sin mfaVerified)
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: session.tokens.accessToken,
      user: session.user,
    });

    // 3) Navegar al setup
    await page.goto('/mfa/setup');
    await expect(page.getByText(/Tu rol exige autenticación en dos pasos/)).toBeVisible({
      timeout: 15_000,
    });

    // 4) Extraer secret del otpauthUrl visible (dentro del <details>)
    // El elemento <code> está en el DOM aunque <details> esté colapsado.
    const otpauthUrlText = await page.locator('code').first().textContent({ timeout: 15_000 });
    expect(otpauthUrlText, 'otpauthUrl debe estar visible').toBeTruthy();
    const secretMatch = otpauthUrlText!.match(/[?&]secret=([A-Z2-7]+)/);
    expect(secretMatch, 'secret debe poder extraerse del otpauthUrl').toBeTruthy();
    const secret = secretMatch![1]!;

    // 5) Generar código TOTP
    const code = authenticator.generate(secret);
    expect(code).toMatch(/^\d{6}$/);

    // 6) Rellenar y enviar
    await page.getByLabel(/Código de la app/).fill(code);
    await page.getByRole('button', { name: /Confirmar y activar MFA/ }).click();

    // 7) Con el enable resuelto, el flujo sale de /mfa/setup a "/" (no hay
    //    deep link pendiente que consumir). Ahí NO se queda: el admin de este
    //    stack tiene el onboarding abierto —con la política activa el arranque
    //    no puede cerrarlo, `PATCH /me/profile` no está exento— y el layout de
    //    (app) lo manda a /onboarding acto seguido. Lo que se afirma aquí es
    //    el salto, que es lo que prueba que el enable fue bien.
    await page.waitForURL(/\/$/, { timeout: 20_000 });
  });
});
