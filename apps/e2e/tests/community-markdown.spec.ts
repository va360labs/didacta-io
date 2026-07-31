import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signup } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Render de Markdown en los posts de la comunidad (RichBody).
 *
 * El caso real que lo motivó: el digest semanal publicado por API (bot n8n)
 * usa `## títulos`, `- listas` y `**negritas**` que se mostraban en crudo.
 * Verifica que en el detalle del post (modal) y en la tarjeta del feed:
 *  - los títulos `##` se renderizan como heading (sin `##` visible),
 *  - las `**negritas**` se renderizan como <strong> (sin asteriscos visibles),
 *  - las listas `- ` se renderizan como <li>,
 *  - los enlaces markdown dentro de un ítem siguen siendo clicables.
 */

const TENANT_SLUG = process.env.E2E_TENANT_SLUG ?? 'demo';

const MARKDOWN_BODY = [
  '¡Buenas familia! Arrancamos con el repaso.',
  '',
  '## Inteligencia Artificial E2E',
  '',
  '- **OpenAI frito:** la caída global dejó a medio grupo ([ver mensaje](https://example.test/m/1))',
  '- **Claude Opus 5:** el hype encendió el grupo',
  '',
  'Usa `pnpm build` antes de subir.',
  '',
  '¡A darle caña!',
].join('\n');

test.describe('mod.community · markdown en posts', () => {
  test('el detalle renderiza títulos, negritas, listas y enlaces (sin marcas en crudo)', async ({
    page,
  }) => {
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(TENANT_SLUG);
    const created = await fetch(`${API_URL}/api/v1/modules/community/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `Digest markdown E2E ${stamp}`,
        body: MARKDOWN_BODY,
        tags: [],
      }),
    });
    expect(created.ok).toBe(true);
    const post = (await created.json()) as { id: string };

    const alumno = await signup({
      tenantSlug: TENANT_SLUG,
      email: `e2e-md-${stamp}@example.test`,
      password: 'E2eMarkdown123!',
      name: 'Alumno Markdown',
    });
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: alumno.tokens.accessToken,
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

    await page.goto(`/comunidad/${post.id}`);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: `Digest markdown E2E ${stamp}` })).toBeVisible(
      { timeout: 15_000 },
    );

    // Título ## → heading real, sin '##' en crudo.
    await expect(
      dialog.getByRole('heading', { name: 'Inteligencia Artificial E2E' }),
    ).toBeVisible();
    await expect(dialog.getByText('## Inteligencia Artificial')).toBeHidden();

    // **negrita** → <strong> sin asteriscos.
    await expect(dialog.locator('strong', { hasText: 'OpenAI frito:' })).toBeVisible();
    await expect(dialog.getByText('**OpenAI frito:**')).toBeHidden();

    // - item → <li> (los dos ítems agrupados en la misma lista).
    await expect(dialog.locator('li', { hasText: 'OpenAI frito:' })).toBeVisible();
    await expect(dialog.locator('li', { hasText: 'Claude Opus 5:' })).toBeVisible();

    // Enlace markdown dentro del ítem → <a> clicable con el label como texto.
    const link = dialog.getByRole('link', { name: 'ver mensaje' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://example.test/m/1');

    // `código` inline → <code> sin backticks.
    await expect(dialog.locator('code', { hasText: 'pnpm build' })).toBeVisible();
  });

  test('la tarjeta del feed también renderiza el markdown del preview', async ({ page }) => {
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(TENANT_SLUG);
    const created = await fetch(`${API_URL}/api/v1/modules/community/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `Card markdown E2E ${stamp}`,
        body: '- **Punto clave:** resumen del feed',
        tags: [],
      }),
    });
    expect(created.ok).toBe(true);

    const alumno = await signup({
      tenantSlug: TENANT_SLUG,
      email: `e2e-mdcard-${stamp}@example.test`,
      password: 'E2eMarkdown123!',
      name: 'Alumno Markdown Card',
    });
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: alumno.tokens.accessToken,
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

    await page.goto('/comunidad');
    await expect(page.getByText(`Card markdown E2E ${stamp}`)).toBeVisible({ timeout: 15_000 });
    // La card muestra el <strong> renderizado, no los asteriscos.
    await expect(page.locator('strong', { hasText: 'Punto clave:' }).first()).toBeVisible();
    await expect(page.getByText('**Punto clave:**')).toBeHidden();
  });
});
