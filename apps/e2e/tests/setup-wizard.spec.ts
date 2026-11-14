import { expect, test, type Page } from '@playwright/test';

/**
 * Cobertura E2E del wizard de primer arranque (`/setup`), protegido por el
 * token de un solo uso de `SetupTokenService` (backend). Requiere una
 * instancia SIN seedear: el job `setup-wizard` de `.github/workflows/e2e.yml`
 * arranca la API sin `db:seed`, extrae el token de los logs del contenedor
 * (el único lugar donde se imprime en plano) y lo pasa aquí vía
 * `E2E_SETUP_TOKEN`. No se puede correr contra el stack del golden path:
 * ese ya corrió el seed, así que la instancia ya tiene un tenant y el gate
 * de token nunca se activa.
 */

const SETUP_TOKEN = process.env.E2E_SETUP_TOKEN;
const API_DIRECT_URL = process.env.E2E_API_DIRECT_URL ?? 'http://localhost:4000';

test.describe('Wizard de setup — token de un solo uso', () => {
  test.skip(
    !SETUP_TOKEN,
    'Requiere E2E_SETUP_TOKEN (token de los logs del primer arranque). Ver job "setup-wizard" en .github/workflows/e2e.yml.',
  );

  test('sin token en la URL, el wizard rechaza la creación con 403 visible', async ({ page }) => {
    await page.goto('/setup');
    await fillWizardUpToSubmit(page, {
      orgName: 'Academia Sin Token',
      adminEmail: 'sin-token@example.test',
    });
    await page.getByRole('button', { name: 'Crear plataforma' }).click();

    // `getByRole('alert')` es ambiguo: Next.js monta su propio
    // `#__next-route-announcer__` con el mismo role. El mensaje real vive en
    // el div de error de StepAdmin — lo buscamos por texto.
    await expect(page.getByText('Falta el token de setup en la URL')).toBeVisible();
    // No hubo sesión: seguimos en el wizard, no en /courses.
    await expect(page).toHaveURL(/\/setup$/);
  });

  test('con el token de los logs, completa el wizard y entra autenticado', async ({ page }) => {
    await page.goto(`/setup?token=${SETUP_TOKEN}`);
    await fillWizardUpToSubmit(page, {
      orgName: 'Academia E2E',
      adminEmail: 'admin-e2e@example.test',
    });
    await page.getByRole('button', { name: 'Crear plataforma' }).click();

    await expect(page.getByRole('heading', { name: '¡Listo! Esto es lo que viene' })).toBeVisible({
      timeout: 15_000,
    });

    // El admin recién creado tiene por delante los dos asistentes de primer
    // acceso, y en un aula en modo completo —la que deja el wizard— va
    // PRIMERO el de la academia (`/welcome`) y después el de perfil
    // (`lib/first-access.ts`, regla 3). Antes iba al de perfil y este spec
    // seguía esperando `/onboarding`.
    await page.getByRole('button', { name: 'Empezar' }).click();
    await expect(page).toHaveURL(/\/welcome$/);

    // La sesión persiste tras un reload real (no es solo estado de React):
    // sin sesión, /welcome rebotaría a /signin.
    await page.reload();
    await expect(page).toHaveURL(/\/welcome$/);
  });

  test('reintentar con el mismo token tras el éxito no vuelve a emitir sesión', async () => {
    // El gate de token solo se evalúa mientras la instancia está virgen
    // (ver SetupService.init): tras el test anterior ya existe un tenant,
    // así que este segundo intento cae en 409 "ya inicializada" antes de
    // llegar a revisar el token — que de todos modos ya quedó invalidado
    // por el init exitoso. Cualquiera de los dos motivos certifica lo mismo:
    // el token de un solo uso no permite un segundo alta.
    const res = await fetch(`${API_DIRECT_URL}/api/v1/setup/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Setup-Token': SETUP_TOKEN ?? '' },
      body: JSON.stringify({
        organization: { name: 'Segundo intento', slug: 'segundo-intento' },
        admin: {
          name: 'Otro admin',
          email: 'otro-admin@example.test',
          password: 'OtraPasswordSegura123!',
        },
      }),
    });

    expect(res.status).toBe(409);
  });

  test('la academia queda con el idioma elegido en el asistente, como ajuste del aula', async () => {
    // El alta de arriba eligió «Español» en el asistente. La API lo guarda como
    // AJUSTE del aula (`academy/locale`) y la administradora nace en ese
    // idioma. Antes no se guardaba nada: el aula deducía el idioma del perfil
    // del admin, que nacía siempre en español, y una academia inglesa salía en
    // español en todo lo que el servidor escribe para todos.
    const signin = await fetch(`${API_DIRECT_URL}/api/v1/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantSlug: 'academia-e2e',
        email: 'admin-e2e@example.test',
        password: 'SetupWizardPass123!',
      }),
    });
    expect(signin.ok, `signin (${signin.status})`).toBe(true);
    const { tokens } = (await signin.json()) as { tokens: { accessToken: string } };
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const academia = (await (
      await fetch(`${API_DIRECT_URL}/api/v1/admin/tenant-settings/academy`, { headers: auth })
    ).json()) as { locale: string; localeSource: string };
    expect(academia).toMatchObject({ locale: 'es', localeSource: 'setting' });
    const perfil = (await (
      await fetch(`${API_DIRECT_URL}/api/v1/me/profile`, { headers: auth })
    ).json()) as { locale: string };
    expect(perfil.locale).toBe('es-ES');
  });
});

async function fillWizardUpToSubmit(
  page: Page,
  args: { orgName: string; adminEmail: string },
): Promise<void> {
  await page.getByRole('button', { name: 'Empezar configuración' }).click();

  await page.getByLabel('Nombre de la organización').fill(args.orgName);
  // El idioma de la academia viene propuesto con el del navegador; se elige a
  // mano para que el resto del recorrido (en español) no dependa del runner.
  await page.getByLabel('Idioma de la academia').selectOption('es');
  // window.location.host en el runner E2E incluye el puerto (localhost:3010),
  // que el backend rechaza como hostname inválido (HOSTNAME_RE no acepta
  // ":"). En producción tras un reverse proxy esto no ocurre porque el
  // origin nunca lleva puerto. Vaciar el campo no sirve: un effect en
  // SetupWizard lo repuebla desde window.location.host en cuanto queda
  // falsy — hay que sobreescribirlo con un hostname válido explícito.
  await page.getByLabel('Dominio público').fill('localhost');
  await page.getByRole('button', { name: 'Continuar' }).click();

  await page.getByRole('button', { name: 'Continuar' }).click();

  await page.getByLabel('Nombre completo').fill('Admin E2E');
  await page.getByLabel('Email').fill(args.adminEmail);
  await page.getByLabel(/^Contraseña/).fill('SetupWizardPass123!');
  await page.getByLabel(/Confirmar contraseña/).fill('SetupWizardPass123!');
}
