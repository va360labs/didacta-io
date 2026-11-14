/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test } from '@playwright/test';
import {
  GAMIF,
  abrir,
  alumno,
  aulaConCreador,
  hasta,
  notificaciones,
  sumarPuntos,
  type Auth,
} from '../helpers/retencion';
import { apiAs, type FreshTenant } from '../helpers/simple-tenant';

/**
 * Premios automáticos por puntos o por nivel, definidos por el creador:
 *
 *  - Se crean desde «Premios y niveles» (UI): un código de descuento que el
 *    creador ha creado en su pasarela (Didacta no inventa cupones) y un
 *    mensaje con enlace (p. ej. el directo privado del nivel 2).
 *  - Antes de llegar, la alumna ve lo que le falta, pero NO el código.
 *  - Al llegar se entrega SOLO (aviso + «Tus premios») y queda registrado.
 *  - Una vez: más puntos no lo vuelven a entregar. Ya entregado no se borra.
 *  - El mismo panel está en el modo completo (Puntos y retos → pestaña).
 */

let aula: FreshTenant;
let creador: Auth;
let irene: Auth;

test.describe.configure({ mode: 'serial' });

test.describe('Premios automáticos', () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    ({ aula, creador } = await aulaConCreador('premio', true));
    const T = creador.tokens.accessToken;
    for (const [key, name, minPoints] of [
      ['aprendiz', 'Aprendiz', 0],
      ['barista', 'Barista', 100],
    ] as const) {
      await apiAs(aula.host, `${GAMIF}/admin/levels`, {
        method: 'POST',
        bearer: T,
        body: { key, name, minPoints },
      });
    }
    irene = await alumno(aula, `irene.${aula.slug}@example.com`, 'Irene Soler');
  });

  test('quien administra crea un código por puntos y un mensaje por nivel (UI)', async ({
    browser,
  }) => {
    const { page, close } = await abrir(browser, aula, creador, '/admin/settings');
    const s = page.getByTestId('ajustes-premios');

    await s.getByLabel('Nombre del premio').fill('20 % en tu próximo curso');
    await s.getByLabel('Se entrega al llegar a').selectOption('POINTS');
    await s.getByLabel('Puntos', { exact: true }).fill('80');
    await s.getByLabel('Qué recibe').selectOption('CODE');
    // Se avisa donde se decide: el código lo crea el creador en su pasarela.
    await expect(s.getByText('Didacta no crea cupones')).toBeVisible();
    await s.getByLabel('Código', { exact: true }).fill('SORBO20');
    await s.getByLabel('Mensaje', { exact: true }).fill('Úsalo al pagar cualquier curso.');
    await s.getByRole('button', { name: 'Crear premio' }).click();
    await expect(s.getByTestId('premios-lista')).toContainText('20 % en tu próximo curso');
    await expect(s.getByTestId('premios-lista')).toContainText('Al llegar a 80 puntos');

    await s.getByLabel('Nombre del premio').fill('Directo privado de latte art');
    await s.getByLabel('Se entrega al llegar a').selectOption('LEVEL');
    await s.getByLabel('Nivel', { exact: true }).selectOption({ label: 'Nivel 2 · Barista' });
    await s.getByLabel('Qué recibe').selectOption('MESSAGE');
    await s
      .getByLabel('Mensaje', { exact: true })
      .fill('Jueves a las 19:00, solo para el nivel Barista.');
    await s.getByLabel('Enlace (opcional)').fill('https://meet.example.com/latte-privado');
    await s.getByRole('button', { name: 'Crear premio' }).click();
    await expect(s.getByTestId('premios-lista')).toContainText('Al llegar al nivel 2 (Barista)');
    await close();
  });

  test('antes de llegar ve lo que le falta, pero no el código', async ({ browser }) => {
    const { page, close } = await abrir(browser, aula, irene, '/challenges');
    const premios = page.getByTestId('mis-premios');
    await expect(premios).toContainText('20 % en tu próximo curso');
    await expect(premios).toContainText('Te faltan 80 puntos');
    await expect(page.getByText('SORBO20')).toHaveCount(0);
    await close();
    const mios = await apiAs<{ earned: unknown[]; upcoming: unknown[] }>(
      aula.host,
      `${GAMIF}/me/rewards`,
      {
        bearer: irene.tokens.accessToken,
      },
    );
    expect(mios.earned).toHaveLength(0);
    expect(JSON.stringify(mios)).not.toContain('SORBO20');
  });

  test('al llegar se entrega solo, una vez, con aviso y registro', async ({ browser }) => {
    test.setTimeout(120_000);
    await sumarPuntos(aula, creador, irene, 120, 'Tu primer latte con foto');
    const avisos = await hasta(
      () => notificaciones(aula, irene),
      (l) => l.filter((n) => n.templateKey === 'gamification.reward.granted').length >= 2,
    );
    const premios = avisos.filter((n) => n.templateKey === 'gamification.reward.granted');
    expect(premios.map((n) => n.metadata?.['rewardTitle']).sort()).toEqual([
      '20 % en tu próximo curso',
      'Directo privado de latte art',
    ]);
    expect(premios.find((n) => n.metadata?.['rewardCode'] === 'SORBO20')).toBeTruthy();

    // Más puntos no lo vuelven a entregar.
    await sumarPuntos(aula, creador, irene, 30, 'Segundo reto');
    await new Promise((r) => setTimeout(r, 2500));
    const mios = await apiAs<{ earned: Array<{ delivered: { title: string } }> }>(
      aula.host,
      `${GAMIF}/me/rewards`,
      { bearer: irene.tokens.accessToken },
    );
    expect(mios.earned).toHaveLength(2);

    const { page, close } = await abrir(browser, aula, irene, '/challenges');
    const recibido = page
      .getByTestId('premio-recibido')
      .filter({ hasText: '20 % en tu próximo curso' });
    await expect(recibido.locator('code')).toHaveText('SORBO20');
    const directo = page.getByTestId('premio-recibido').filter({ hasText: 'Directo privado' });
    await expect(directo.getByRole('link', { name: 'Abrir enlace' })).toHaveAttribute(
      'href',
      'https://meet.example.com/latte-privado',
    );
    await close();

    // Registro del creador, con el nombre de quien lo recibió.
    const ajustes = await abrir(browser, aula, creador, '/admin/settings');
    const registro = ajustes.page.getByTestId('premios-registro');
    await registro.locator('summary').click();
    await expect(registro).toContainText('Irene Soler · 20 % en tu próximo curso');
    // Ya entregado: no se ofrece borrarlo (y la API lo impide).
    const fila = ajustes.page.getByTestId('premios-lista').locator('li', { hasText: '20 %' });
    await expect(fila.getByRole('button', { name: 'Borrar' })).toHaveCount(0);
    await ajustes.close();
    const lista = await apiAs<{ rewards: Array<{ id: string; title: string }> }>(
      aula.host,
      `${GAMIF}/admin/rewards`,
      { bearer: creador.tokens.accessToken },
    );
    const id = lista.rewards.find((r) => r.title.startsWith('20 %'))!.id;
    await expect(
      apiAs(aula.host, `${GAMIF}/admin/rewards/${id}`, {
        method: 'DELETE',
        bearer: creador.tokens.accessToken,
      }),
    ).rejects.toThrow(/409/);
  });

  test('modo completo: el mismo panel en Puntos y retos → «Premios y desbloqueos»', async ({
    browser,
  }) => {
    const completo = await aulaConCreador('premiocompleto', false);
    const { page, close } = await abrir(
      browser,
      completo.aula,
      completo.creador,
      '/admin/gamification',
    );
    await page.getByRole('tab', { name: 'Premios y desbloqueos' }).click();
    await expect(page.getByTestId('premios-y-niveles')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Premios automáticos' })).toBeVisible();
    // Los niveles tienen su propia pestaña: aquí no se repiten.
    await expect(
      page.getByTestId('premios-y-niveles').getByRole('heading', { name: 'Niveles' }),
    ).toHaveCount(0);
    await close();
  });
});
