import { expect, test, type Page } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signup } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * URL única y compartible por post de la comunidad.
 *
 * Cubre:
 *  1. Abrir un post desde el feed cambia la URL a /comunidad/<id> (compartible)
 *     y "Copiar enlace" copia esa URL al portapapeles; cerrar restaura /comunidad.
 *  2. Deep-link logueado: entrar directo a /comunidad/<id> abre el post en modal
 *     sobre el feed; cerrarlo deja la URL del feed sin apilar historial.
 *  3. Deep-link anónimo: pide login y, tras autenticarse, abre el post.
 *  4. Espacios: abrir un post desde /espacios/<slug> también muestra la URL
 *     canónica y cerrar devuelve al espacio.
 *  5. Back/forward del navegador cierran y reabren el modal (estado derivado
 *     de la URL).
 */

const TENANT_SLUG = process.env.E2E_TENANT_SLUG ?? 'va360';
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3010';

interface CreatedPost {
  id: string;
  title: string;
}

async function createPost(args: {
  adminToken: string;
  title: string;
  tags?: string[];
}): Promise<CreatedPost> {
  const res = await fetch(`${API_URL}/api/v1/modules/community/posts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: args.title,
      body: 'Contenido E2E para enlace directo',
      tags: args.tags ?? [],
    }),
  });
  expect(res.ok, 'crear post por API').toBe(true);
  return (await res.json()) as CreatedPost;
}

/** Alumno con onboarding completado (para que el gate no secuestre el deep-link). */
async function createOnboardedAlumno(stamp: number) {
  const email = `e2e-postlink-${stamp}@example.test`;
  const password = 'E2ePostLink123!';
  const alumno = await signup({ tenantSlug: TENANT_SLUG, email, password, name: 'Alumno Enlace' });
  const bearer = alumno.tokens.accessToken;
  const patch = await fetch(`${API_URL}/api/v1/me/profile`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatarUrl: 'https://example.test/avatar-e2e.png' }),
  });
  expect(patch.ok, 'avatar para completar onboarding').toBe(true);
  const complete = await fetch(`${API_URL}/api/v1/me/onboarding/complete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}` },
  });
  expect(complete.ok, 'completar onboarding por API').toBe(true);
  return { ...alumno, email, password };
}

async function injectAlumnoSession(
  page: Page,
  alumno: Awaited<ReturnType<typeof createOnboardedAlumno>>,
) {
  await page.goto('/signin');
  await injectSession(page, {
    accessToken: alumno.tokens.accessToken,
    refreshToken: alumno.tokens.refreshToken,
    user: {
      id: alumno.user.id,
      email: alumno.user.email,
      name: alumno.user.name,
      tenantId: alumno.user.tenantId,
      tenantSlug: TENANT_SLUG,
      roles: alumno.user.roles,
      mfaEnabled: false,
      onboardingCompletedAt: new Date().toISOString(),
    },
  });
}

test.describe('mod.community · URL única por post', () => {
  test('abrir desde el feed cambia la URL y "Copiar enlace" la copia', async ({
    page,
    context,
  }) => {
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(TENANT_SLUG);
    const post = await createPost({ adminToken, title: `Post enlace E2E ${stamp}` });
    const alumno = await createOnboardedAlumno(stamp);
    await injectAlumnoSession(page, alumno);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL });

    await page.goto('/comunidad');
    await expect(page.getByText(post.title).first()).toBeVisible({ timeout: 15_000 });
    await page.getByText(post.title).first().click();

    // Modal abierto + URL canónica compartible.
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: post.title })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page).toHaveURL(new RegExp(`/comunidad/${post.id}$`));

    // Copiar enlace directo.
    await dialog.getByRole('button', { name: 'Copiar enlace directo' }).click();
    await expect(dialog.getByText('Enlace copiado')).toBeVisible();
    // Forma string: el tsconfig de e2e no incluye lib DOM (lib=['ES2023']).
    const copied = await page.evaluate<string>('navigator.clipboard.readText()');
    expect(copied).toBe(`${BASE_URL}/comunidad/${post.id}`);

    // Cerrar restaura la URL del feed sin desmontar la página.
    await dialog.getByRole('button', { name: 'Cerrar' }).click();
    await expect(page).toHaveURL(new RegExp('/comunidad$'));
  });

  test('deep-link logueado abre el post en modal sobre el feed', async ({ page }) => {
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(TENANT_SLUG);
    const post = await createPost({ adminToken, title: `Post deeplink E2E ${stamp}` });
    const alumno = await createOnboardedAlumno(stamp);
    await injectAlumnoSession(page, alumno);

    await page.goto(`/comunidad/${post.id}`);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: post.title })).toBeVisible({
      timeout: 15_000,
    });
    // El feed queda detrás (misma experiencia que abrirlo desde /comunidad).
    await expect(page.getByRole('heading', { name: 'Comunidad' })).toBeVisible();

    // Cerrar tras el deep-link: la URL pasa a la del feed SIN apilar historial
    // (rama replaceState del hook — no hay entrada previa del feed que consumir).
    await dialog.getByRole('button', { name: 'Cerrar' }).click();
    await expect(page).toHaveURL(new RegExp('/comunidad$'));
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('back/forward del navegador cierran y reabren el modal', async ({ page }) => {
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(TENANT_SLUG);
    const post = await createPost({ adminToken, title: `Post historial E2E ${stamp}` });
    const alumno = await createOnboardedAlumno(stamp);
    await injectAlumnoSession(page, alumno);

    await page.goto('/comunidad');
    await expect(page.getByText(post.title).first()).toBeVisible({ timeout: 15_000 });
    await page.getByText(post.title).first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: post.title })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page).toHaveURL(new RegExp(`/comunidad/${post.id}$`));

    // Atrás: vuelve a la URL del feed y el modal se cierra (estado ← URL).
    await page.goBack();
    await expect(page).toHaveURL(new RegExp('/comunidad$'));
    await expect(page.getByRole('dialog')).toBeHidden();

    // Adelante: la URL del post reabre el modal.
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/comunidad/${post.id}$`));
    await expect(page.getByRole('dialog').getByRole('heading', { name: post.title })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('deep-link anónimo pide login y después abre el post', async ({ page }) => {
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(TENANT_SLUG);
    const post = await createPost({ adminToken, title: `Post anon E2E ${stamp}` });
    const alumno = await createOnboardedAlumno(stamp);

    // Sin sesión: la ruta protegida manda a /signin…
    await page.goto(`/comunidad/${post.id}`);
    await expect(page).toHaveURL(/\/signin/, { timeout: 15_000 });

    // …y tras el login vuelve al post compartido.
    await page.getByLabel(/Email/).fill(alumno.email);
    await page.getByLabel(/Contraseña/).fill(alumno.password);
    await page.getByRole('button', { name: 'Entrar' }).click();

    await expect(page).toHaveURL(new RegExp(`/comunidad/${post.id}$`), { timeout: 15_000 });
    await expect(page.getByRole('dialog').getByRole('heading', { name: post.title })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('desde un espacio: URL canónica al abrir y vuelta al espacio al cerrar', async ({
    page,
  }) => {
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(TENANT_SLUG);
    const post = await createPost({
      adminToken,
      title: `Post espacio E2E ${stamp}`,
      tags: ['general'],
    });
    const alumno = await createOnboardedAlumno(stamp);
    await injectAlumnoSession(page, alumno);

    await page.goto('/espacios/general');
    await expect(page.getByText(post.title).first()).toBeVisible({ timeout: 15_000 });
    await page.getByText(post.title).first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: post.title })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page).toHaveURL(new RegExp(`/comunidad/${post.id}$`));

    await dialog.getByRole('button', { name: 'Cerrar' }).click();
    await expect(page).toHaveURL(new RegExp('/espacios/general$'));
  });
});
