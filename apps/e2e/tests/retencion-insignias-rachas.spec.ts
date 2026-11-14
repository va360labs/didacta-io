/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test } from '@playwright/test';
import { GAMIF, abrir, alumno, aulaConCreador, hasta, type Auth } from '../helpers/retencion';
import { apiAs, sql, type FreshTenant } from '../helpers/simple-tenant';

/**
 * Rachas e insignias, en un aula NUEVA en modo sencillo:
 *
 *  - Publicar da la insignia «Primera publicación» (se gana sola) y cuenta el
 *    día para la racha; la racha son días SEGUIDOS en la zona de la persona.
 *  - Se ven en su perfil (`/u/[id]`), en la tarjeta de miembro (la lista de
 *    «Alumnos» de quien administra) y en /challenges.
 *  - Quien administra renombra y desactiva insignias (UI): el perfil lo
 *    refleja. La persona puede ocultar su racha (UI) y deja de verse (control).
 */

let aula: FreshTenant;
let creador: Auth;
let irene: Auth;

test.describe.configure({ mode: 'serial' });

test.describe('Rachas e insignias', () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    ({ aula, creador } = await aulaConCreador('insignia', true));
    irene = await alumno(aula, `irene.${aula.slug}@example.com`, 'Irene Soler');
    // Ayer y anteayer ya estuvo activa (en su zona horaria); hoy publica.
    const tid = sql(`SELECT id FROM tenant WHERE slug = '${aula.slug}'`);
    sql(
      `INSERT INTO mod_gamification_activity_day (id, tenant_id, user_id, day) VALUES ` +
        `(gen_random_uuid(), '${tid}', '${irene.user.id}', (now() AT TIME ZONE 'UTC')::date - 1), ` +
        `(gen_random_uuid(), '${tid}', '${irene.user.id}', (now() AT TIME ZONE 'UTC')::date - 2)`,
    );
  });

  test('publicar da la insignia y suma el día a la racha', async () => {
    await apiAs(aula.host, '/api/v1/modules/community/posts', {
      method: 'POST',
      bearer: irene.tokens.accessToken,
      body: {
        title: 'Mi primera taza',
        body: 'Hoy he sacado mi primer espresso decente.',
        tags: ['general'],
      },
    });
    const mio = await hasta(
      () =>
        apiAs<{
          badges: Array<{ key: string }>;
          streak: { currentDays: number; activeToday: boolean };
        }>(aula.host, `${GAMIF}/me/retention`, { bearer: irene.tokens.accessToken }),
      (r) => r.badges.some((b) => b.key === 'first_post') && r.streak.activeToday,
    );
    expect(mio.badges.map((b) => b.key)).toContain('first_post');
    expect(mio.streak.currentDays).toBe(3);
    // Control: no ha comentado nunca → sin «Primer comentario».
    expect(mio.badges.map((b) => b.key)).not.toContain('first_comment');
    // El aviso de la insignia llega a la campana.
    const avisos = await hasta(
      () =>
        apiAs<Array<{ templateKey: string; metadata: Record<string, unknown> }>>(
          aula.host,
          '/api/v1/me/notifications',
          { bearer: irene.tokens.accessToken },
        ),
      (l) => l.some((n) => n.templateKey === 'gamification.badge.earned'),
    );
    expect(
      avisos.find((n) => n.templateKey === 'gamification.badge.earned')?.metadata['badgeName'],
    ).toBe('Primera publicación');
  });

  test('se ven en el perfil, en /challenges y en la tarjeta de miembro', async ({ browser }) => {
    const perfil = await abrir(browser, aula, irene, `/u/${irene.user.id}`);
    await expect(perfil.page.getByTestId('perfil-insignias')).toContainText('Primera publicación');
    await expect(perfil.page.getByTestId('perfil-racha')).toHaveText('Racha de 3 días');
    await perfil.close();

    const retos = await abrir(browser, aula, irene, '/challenges');
    await expect(retos.page.getByTestId('mi-racha')).toContainText('3 días seguidos');
    await expect(retos.page.getByTestId('mis-insignias')).toContainText('Primera publicación');
    await expect(retos.page.getByTestId('mis-insignias')).toContainText('Por conseguir');
    await retos.close();

    // En el modo sencillo, la lista de miembros de quien administra es «Alumnos».
    const alumnos = await abrir(browser, aula, creador, '/admin/users');
    const fila = alumnos.page.locator('li', { hasText: 'Irene Soler' }).first();
    await expect(fila.getByTestId('tarjeta-logros')).toBeVisible();
    await expect(fila.getByTestId('perfil-insignias').locator('li')).toHaveCount(1);
    await alumnos.close();
  });

  test('quien administra renombra y desactiva insignias; la persona oculta su racha', async ({
    browser,
  }) => {
    const ajustes = await abrir(browser, aula, creador, '/admin/settings');
    const lista = ajustes.page.getByTestId('premios-insignias');
    const fila = lista.locator('li', { has: ajustes.page.getByPlaceholder('Primera publicación') });
    await fila.getByRole('textbox').fill('Rompehielos');
    await fila.getByRole('button', { name: 'Guardar' }).click();
    await expect(fila.getByRole('textbox')).toHaveValue('Rompehielos');
    const comentario = lista.locator('li', {
      has: ajustes.page.getByPlaceholder('Primer comentario'),
    });
    await comentario.getByRole('switch').click();
    await expect(comentario.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await ajustes.close();

    const retos = await abrir(browser, aula, irene, '/challenges');
    await expect(retos.page.getByTestId('mis-insignias')).toContainText('Rompehielos');
    // Desactivada → ya no está en su catálogo.
    await expect(retos.page.getByTestId('mis-insignias')).not.toContainText('Primer comentario');
    const pref = retos.page.getByRole('switch', { name: 'Mostrar mi racha en mi perfil' });
    await pref.click();
    await expect(pref).toHaveAttribute('aria-checked', 'false');
    await retos.close();

    const perfil = await abrir(browser, aula, creador, `/u/${irene.user.id}`);
    await expect(perfil.page.getByTestId('perfil-insignias')).toContainText('Rompehielos');
    // Control: la racha existe (la ve ella en /challenges) pero no se enseña.
    await expect(perfil.page.getByTestId('perfil-racha')).toHaveCount(0);
    await perfil.close();
  });
});
