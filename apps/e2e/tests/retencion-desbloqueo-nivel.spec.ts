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
  cursoPublicado,
  hasta,
  matricular,
  notificaciones,
  sumarPuntos,
  type Auth,
  type CursoSembrado,
} from '../helpers/retencion';
import { apiAs, type FreshTenant } from '../helpers/simple-tenant';

/**
 * «Se desbloquea en el nivel N» (lo más característico de Skool), de punta a
 * punta en un aula NUEVA en modo sencillo:
 *
 *  1. Quien administra crea los niveles y cierra contenido desde Ajustes →
 *     «Premios y niveles» (UI): un curso gratis en el que la alumna está, otro
 *     gratis en el que no, y uno DE PAGO (sin regalarlo).
 *  2. La alumna ve el candado «Se desbloquea en el nivel 2 — te faltan 50
 *     puntos» en el catálogo y el muro en el curso; la API le niega el progreso.
 *  3. Suma puntos de verdad (reto aprobado) → sube de nivel → los cursos se
 *     abren SOLOS y con aviso; el gratis en el que no estaba la matricula sola.
 *  4. Controles: el de pago NO se regala (sigue sin matrícula); antes de subir
 *     el progreso daba 403 y después no; una alumna no toca el panel.
 */

let aula: FreshTenant;
let creador: Auth;
let irene: Auth;
let espresso: CursoSembrado;
let filtrado: CursoSembrado;
let pagoId: string;

test.describe.configure({ mode: 'serial' });

test.describe('Desbloqueo de contenido por nivel (modo sencillo)', () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    ({ aula, creador } = await aulaConCreador('nivel', true));
    const T = creador.tokens.accessToken;
    // Un curso DE PAGO (se vende en una página externa): el nivel no lo regala.
    const pago = await cursoPublicado(aula, T, 'Latte art desde cero');
    await apiAs(aula.host, `/api/v1/modules/courses/${pago.id}`, {
      method: 'PUT',
      bearer: T,
      body: { externalPurchaseUrl: 'https://tienda.example.com/latte-art' },
    });
    pagoId = pago.id;
    espresso = await cursoPublicado(aula, T, 'Espresso en casa');
    filtrado = await cursoPublicado(aula, T, 'Filtrado básico');
    irene = await alumno(aula, `irene.soler.${aula.slug}@example.com`, 'Irene Soler');
    await matricular(aula, T, irene.user.id, espresso.id);
  });

  test('quien administra crea niveles y cierra cursos desde «Premios y niveles»', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const { page, close } = await abrir(browser, aula, creador, '/admin/settings');
    const seccion = page.getByTestId('ajustes-premios');
    await expect(seccion.getByRole('heading', { name: 'Premios y niveles' })).toBeVisible();
    // La regla de los cursos de pago se explica donde se decide.
    await expect(seccion.getByText('llegar al nivel no lo regala')).toBeVisible();

    for (const [nombre, puntos] of [
      ['Aprendiz', '0'],
      ['Barista', '50'],
    ] as const) {
      await seccion.getByLabel('Nombre del nivel').fill(nombre);
      await seccion.getByLabel('Puntos para llegar').fill(puntos);
      await seccion.getByRole('button', { name: 'Añadir nivel' }).click();
      await expect(seccion.getByTestId('premios-niveles')).toContainText(nombre);
    }
    await expect(seccion.getByTestId('premios-niveles')).toContainText(
      'Nivel 2 · Barista · 50 puntos',
    );

    for (const titulo of ['Espresso en casa', 'Filtrado básico', 'Latte art desde cero']) {
      await seccion.getByLabel('Curso', { exact: true }).selectOption({ label: titulo });
      await seccion
        .getByLabel('Se desbloquea en')
        .first()
        .selectOption({ label: 'Nivel 2 · Barista' });
      if (titulo === 'Latte art desde cero') {
        // De pago: aparece la casilla de regalarlo, y NO se marca.
        await expect(seccion.getByText('Regalarlo al llegar al nivel')).toBeVisible();
      }
      await seccion.getByRole('button', { name: 'Cerrar hasta ese nivel' }).click();
      await expect(seccion.getByTestId('premios-cierres')).toContainText(titulo);
    }
    const filaPago = seccion.getByTestId('premios-cierres').locator('li', { hasText: 'Latte art' });
    await expect(filaPago).toContainText('De pago');
    await close();
  });

  test('la alumna ve el candado con lo que le falta y la API no le deja avanzar', async ({
    browser,
  }) => {
    const { page, close } = await abrir(browser, aula, irene, '/courses');
    const tarjeta = page.locator('a', { hasText: 'Espresso en casa' });
    await expect(tarjeta.getByTestId('candado-nivel')).toHaveText(
      'Se desbloquea en el nivel 2 — te faltan 50 puntos',
    );
    await tarjeta.click();
    await expect(page.getByTestId('candado-nivel-tarjeta')).toContainText(
      'Este curso se desbloquea en el nivel 2',
    );
    await expect(page.getByText('Contenido real de la lección.')).toHaveCount(0);
    await close();

    // El candado es del servidor, no de la pantalla: registrar progreso → 403.
    const mias = await apiAs<Array<{ id: string; courseId: string }>>(
      aula.host,
      '/api/v1/modules/learning/me/enrollments',
      { bearer: irene.tokens.accessToken },
    );
    const matricula = mias.find((e) => e.courseId === espresso.id)!;
    await expect(
      apiAs(aula.host, '/api/v1/modules/learning/progress', {
        method: 'POST',
        bearer: irene.tokens.accessToken,
        body: {
          enrollmentId: matricula.id,
          lessonId: espresso.modules[0]!.lessons[0]!.id,
          watchedSeconds: 60,
          completed: true,
        },
      }),
    ).rejects.toThrow(/403 .*LEVEL_CONTENT_LOCKED/);

    // Y el panel de premios es solo de quien administra.
    await expect(
      apiAs(aula.host, `${GAMIF}/admin/locks`, { bearer: irene.tokens.accessToken }),
    ).rejects.toThrow(/403/);
  });

  test('al llegar al nivel se abre solo y con aviso; lo de pago no se regala', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    await sumarPuntos(aula, creador, irene, 60, 'Tu primer espresso, con foto');

    // El aviso llega por el bus (asíncrono): se espera a él.
    const avisos = await hasta(
      () => notificaciones(aula, irene),
      (list) => list.filter((n) => n.templateKey === 'gamification.content.unlocked').length >= 2,
    );
    const abiertos = avisos
      .filter((n) => n.templateKey === 'gamification.content.unlocked')
      .map((n) => n.metadata?.['courseTitle']);
    expect(abiertos.sort()).toEqual(['Espresso en casa', 'Filtrado básico']);

    const mias = await apiAs<Array<{ courseId: string; status: string }>>(
      aula.host,
      '/api/v1/modules/learning/me/enrollments',
      { bearer: irene.tokens.accessToken },
    );
    // El gratis en el que no estaba: matriculada sola al llegar al nivel.
    expect(mias.some((e) => e.courseId === filtrado.id)).toBe(true);
    // Control: el de pago NO se regala (no se marcó «Regalarlo»).
    expect(mias.some((e) => e.courseId === pagoId)).toBe(false);

    const { page, close } = await abrir(browser, aula, irene, '/courses');
    await expect(
      page.locator('a', { hasText: 'Espresso en casa' }).getByTestId('candado-nivel'),
    ).toHaveCount(0);
    await page.locator('a', { hasText: 'Espresso en casa' }).click();
    await expect(page.getByText('Contenido real de la lección.')).toBeVisible();
    await expect(page.getByTestId('candado-nivel-tarjeta')).toHaveCount(0);
    await close();
  });
});
