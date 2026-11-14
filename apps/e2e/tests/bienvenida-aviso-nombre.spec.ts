/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { injectSession } from '../helpers/auth';
import { apiAs, freshTenant, sql } from '../helpers/simple-tenant';

/**
 * El paso 1 del asistente de bienvenida (modo completo) avisa cuando la
 * academia aún tiene un nombre autogenerado. Decía «que salió de tu correo al
 * comprar» también en una instalación PROPIA, donde no hubo compra: ese texto
 * solo es de Didacta Cloud (cobros de plataforma). El arnés corre sin modo
 * plataforma, como un self-host: aviso neutro.
 */
test('instalación propia: el aviso del nombre no habla de una compra', async ({ browser }) => {
  test.setTimeout(120_000);
  // El aula se llama como su slug: el nombre «autogenerado» que dispara el aviso.
  const tenant = await freshTenant(`avisonom${Date.now().toString(36)}`, false);

  // La creadora entra con contraseña y su perfil ya hecho (el paso que importa
  // es el de la academia).
  const token = randomBytes(24).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  sql(
    `INSERT INTO password_reset_token (id, user_id, tenant_id, token_hash, expires_at, created_at) ` +
      `SELECT gen_random_uuid(), u.id, u.tenant_id, '${hash}', now() + interval '1 day', now() ` +
      `FROM "user" u WHERE u.email = '${tenant.creatorEmail}'`,
  );
  await apiAs(tenant.host, '/api/v1/auth/reset-password', {
    method: 'POST',
    body: { token, newPassword: tenant.password },
  });
  const auth = await apiAs<{
    tokens: { accessToken: string; refreshToken: string };
    user: Parameters<typeof injectSession>[1]['user'];
  }>(tenant.host, '/api/v1/auth/signin', {
    method: 'POST',
    body: { tenantSlug: tenant.slug, email: tenant.creatorEmail, password: tenant.password },
  });
  await apiAs(tenant.host, '/api/v1/me/profile', {
    method: 'PATCH',
    bearer: auth.tokens.accessToken,
    body: { name: 'Clara Creadora', avatarUrl: '/api/v1/storage/file/avatars/e2e-harness.png' },
  });
  await apiAs(tenant.host, '/api/v1/me/onboarding/complete', {
    method: 'POST',
    bearer: auth.tokens.accessToken,
  });

  const ctx = await browser.newContext({ locale: 'es-ES', viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
  const page = await ctx.newPage();
  await page.goto(`${tenant.base}/signin`);
  await injectSession(page, {
    accessToken: auth.tokens.accessToken,
    refreshToken: auth.tokens.refreshToken,
    user: { ...auth.user, onboardingCompletedAt: new Date().toISOString() },
  });
  await page.goto(`${tenant.base}/welcome`);
  await page.getByRole('button', { name: 'Empezar' }).click();
  await expect(page.getByRole('heading', { name: '¿Cómo se llama tu academia?' })).toBeVisible();

  const aviso = page.getByText(`Ahora mismo se llama «${tenant.slug}»`);
  await expect(aviso).toBeVisible();
  await expect(aviso).toContainText('un nombre provisional');
  await expect(page.getByText('salió de tu correo al comprar')).toHaveCount(0);
  await ctx.close();
});
