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
  sumarPuntos,
  type Auth,
  type CursoSembrado,
} from '../helpers/retencion';
import { apiAs, sql, type FreshTenant } from '../helpers/simple-tenant';

/**
 * Celebraciones automáticas en la comunidad (activables por el creador):
 * bienvenida cuando alguien se presenta, curso terminado, subida de nivel y
 * aniversario. Aula NUEVA en modo sencillo, en español.
 *
 *  - Nacen APAGADAS: sin encenderlas, nada se publica (control).
 *  - Se encienden desde Ajustes → «Premios y niveles» (UI).
 *  - Sin spam: si el mismo día hay varias del mismo tipo, sale UN post que
 *    las nombra a todas (se actualiza, no se duplica).
 *  - Idempotentes: participar otra vez no vuelve a dar la bienvenida.
 *  - Quien no quiere salir, no sale (preferencia en /challenges, UI).
 *  - Los posts de celebración no dan puntos a quien los firma.
 */

interface PostRow {
  id: string;
  title: string;
  body: string;
  authorId: string;
  source: string;
}

let aula: FreshTenant;
let creador: Auth;
let irene: Auth;
let marcos: Auth;
let nuria: Auth;
let curso: CursoSembrado;

async function posts(t: FreshTenant, auth: Auth): Promise<PostRow[]> {
  return apiAs<PostRow[]>(t.host, '/api/v1/modules/community/posts?limit=50', {
    bearer: auth.tokens.accessToken,
  });
}

const celebraciones = (list: PostRow[], prefijo: string) =>
  list.filter((p) => p.title.startsWith(prefijo) && p.body.includes('didacta-celebracion'));

async function terminarCurso(t: FreshTenant, a: Auth, c: CursoSembrado) {
  const mias = await apiAs<Array<{ id: string; courseId: string }>>(
    t.host,
    '/api/v1/modules/learning/me/enrollments',
    { bearer: a.tokens.accessToken },
  );
  const matricula = mias.find((e) => e.courseId === c.id)!;
  for (const m of c.modules) {
    for (const l of m.lessons) {
      await apiAs(t.host, '/api/v1/modules/learning/progress', {
        method: 'POST',
        bearer: a.tokens.accessToken,
        body: { enrollmentId: matricula.id, lessonId: l.id, watchedSeconds: 60, completed: true },
      });
    }
  }
}

test.describe.configure({ mode: 'serial' });

test.describe('Celebraciones en la comunidad', () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    ({ aula, creador } = await aulaConCreador('celebra', true));
    const T = creador.tokens.accessToken;
    await apiAs(aula.host, '/api/v1/admin/simple-mode/quick-start', {
      method: 'POST',
      bearer: T,
      body: {
        academyName: 'Primer Sorbo',
        offer: 'course',
        title: 'Latte art desde cero',
        amountCents: 4900,
        currency: 'eur',
        locale: 'es',
      },
    });
    curso = await cursoPublicado(aula, T, 'Espresso en casa');
    irene = await alumno(aula, `irene.${aula.slug}@example.com`, 'Irene Soler');
    marcos = await alumno(aula, `marcos.${aula.slug}@example.com`, 'Marcos Vidal');
    nuria = await alumno(aula, `nuria.${aula.slug}@example.com`, 'Nuria Pons');
    for (const a of [irene, marcos, nuria]) await matricular(aula, T, a.user.id, curso.id);
  });

  test('apagadas de serie: presentarse no publica nada', async () => {
    await apiAs(aula.host, '/api/v1/modules/community/posts', {
      method: 'POST',
      bearer: nuria.tokens.accessToken,
      body: {
        title: 'Hola, soy Nuria',
        body: 'Vengo a aprender a hacer espresso.',
        tags: ['general'],
      },
    });
    // Se da tiempo al bus y se comprueba que no hay ninguna celebración.
    await new Promise((r) => setTimeout(r, 2500));
    expect(celebraciones(await posts(aula, creador), '👋')).toHaveLength(0);
  });

  test('quien administra las enciende desde «Premios y niveles»', async ({ browser }) => {
    const { page, close } = await abrir(browser, aula, creador, '/admin/settings');
    const bloque = page.getByTestId('premios-celebraciones');
    for (const nombre of [
      'Cuando alguien termina un curso',
      'Bienvenida cuando alguien se presenta (su primera publicación o comentario)',
      'Aniversario de cada miembro en la comunidad',
      'Cuando alguien sube de nivel',
    ]) {
      const sw = bloque.getByRole('switch', { name: nombre });
      await expect(sw).toHaveAttribute('aria-checked', 'false');
      await sw.click();
      await expect(sw).toHaveAttribute('aria-checked', 'true');
    }
    await close();
    const s = await apiAs<Record<string, boolean>>(aula.host, `${GAMIF}/admin/retention/settings`, {
      bearer: creador.tokens.accessToken,
    });
    expect(s).toMatchObject({
      celebrateCourses: true,
      celebrateIntros: true,
      celebrateAnniversaries: true,
      celebrateLevels: true,
    });
  });

  test('bienvenida al presentarse: un solo post al día que nombra a todos; sin repetir', async () => {
    const bienvenida = (await posts(aula, creador)).find((p) => p.authorId === creador.user.id)!;
    await apiAs(aula.host, `/api/v1/modules/community/posts/${bienvenida.id}/comments`, {
      method: 'POST',
      bearer: irene.tokens.accessToken,
      body: { body: 'Hola, soy Irene y quiero sacar un buen espresso en casa.' },
    });
    const uno = await hasta(
      () => posts(aula, creador),
      (l) => celebraciones(l, '👋').length === 1,
    );
    const [post] = celebraciones(uno, '👋');
    expect(post!.title).toBe('👋 Te damos la bienvenida, Irene Soler');
    expect(post!.authorId).toBe(creador.user.id);
    expect(post!.source).toBe('api');

    // Marcos se presenta el mismo día → el MISMO post pasa a nombrar a los dos.
    await apiAs(aula.host, '/api/v1/modules/community/posts', {
      method: 'POST',
      bearer: marcos.tokens.accessToken,
      body: { title: 'Me presento', body: 'Soy Marcos, barista aficionado.', tags: ['general'] },
    });
    const dos = await hasta(
      () => posts(aula, creador),
      (l) => celebraciones(l, '👋').some((p) => p.title === '👋 Hoy se han presentado 2 personas'),
    );
    const intro = celebraciones(dos, '👋');
    expect(intro).toHaveLength(1);
    expect(intro[0]!.id).toBe(post!.id);
    expect(intro[0]!.body).toContain('**Irene Soler**');
    expect(intro[0]!.body).toContain('**Marcos Vidal**');

    // Irene vuelve a participar: no es su presentación, no se la vuelve a nombrar.
    await apiAs(aula.host, '/api/v1/modules/community/posts', {
      method: 'POST',
      bearer: irene.tokens.accessToken,
      body: { title: 'Duda de molienda', body: '¿Qué molienda para moka?', tags: ['general'] },
    });
    await new Promise((r) => setTimeout(r, 2500));
    const despues = celebraciones(await posts(aula, creador), '👋');
    expect(despues).toHaveLength(1);
    expect(despues[0]!.title).toBe('👋 Hoy se han presentado 2 personas');
  });

  test('curso terminado: se celebra; quien no quiere salir no sale', async ({ browser }) => {
    test.setTimeout(120_000);
    // Nuria decide no aparecer (preferencia en /challenges).
    const { page, close } = await abrir(browser, aula, nuria, '/challenges');
    const pref = page.getByRole('switch', {
      name: 'Aparecer en las celebraciones de la comunidad',
    });
    await expect(pref).toHaveAttribute('aria-checked', 'true');
    await pref.click();
    await expect(pref).toHaveAttribute('aria-checked', 'false');
    await close();

    await terminarCurso(aula, irene, curso);
    const uno = await hasta(
      () => posts(aula, creador),
      (l) => celebraciones(l, '🎓').length === 1,
    );
    expect(celebraciones(uno, '🎓')[0]!.title).toBe(
      '🎓 ¡Irene Soler ha terminado «Espresso en casa»!',
    );

    await terminarCurso(aula, nuria, curso);
    await terminarCurso(aula, marcos, curso);
    const dos = await hasta(
      () => posts(aula, creador),
      (l) => celebraciones(l, '🎓').some((p) => p.title.includes('2 personas')),
    );
    const cursos = celebraciones(dos, '🎓');
    expect(cursos).toHaveLength(1);
    expect(cursos[0]!.title).toBe('🎓 Hoy han terminado un curso 2 personas');
    expect(cursos[0]!.body).toContain('**Marcos Vidal**');
    // Control: Nuria terminó, pero eligió no salir.
    expect(cursos[0]!.body).not.toContain('Nuria');
  });

  test('subida de nivel y aniversario', async () => {
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
    // Marcos lleva 60 (presentarse 10 + curso 50): con 50 más cruza los 100.
    await sumarPuntos(aula, creador, marcos, 50, 'Comparte tu primera taza');
    const nivel = await hasta(
      () => posts(aula, creador),
      (l) => celebraciones(l, '⭐').length === 1,
    );
    expect(celebraciones(nivel, '⭐')[0]!.title).toBe('⭐ Marcos Vidal ha subido al nivel Barista');

    // Irene lleva un año en la comunidad (se adelanta su alta en la BD).
    sql(`UPDATE "user" SET created_at = now() - interval '1 year' WHERE id = '${irene.user.id}'`);
    await apiAs(aula.host, `${GAMIF}/admin/celebrations/anniversaries/run`, {
      method: 'POST',
      bearer: T,
    });
    // Repetirlo no duplica (idempotente).
    await apiAs(aula.host, `${GAMIF}/admin/celebrations/anniversaries/run`, {
      method: 'POST',
      bearer: T,
    });
    const anivs = celebraciones(await posts(aula, creador), '🎂');
    expect(anivs).toHaveLength(1);
    expect(anivs[0]!.title).toBe('🎂 Irene Soler cumple 1 año en la comunidad');

    // Ninguna celebración puntúa a quien la firma.
    const ids = celebraciones(await posts(aula, creador), '')
      .map((p) => `'community.post:${p.id}'`)
      .join(',');
    expect(
      sql(`SELECT count(*) FROM mod_gamification_ledger_entry WHERE source_key IN (${ids})`),
    ).toBe('0');
  });

  test('la alumna ve las celebraciones en la comunidad', async ({ browser }) => {
    const { page, close } = await abrir(browser, aula, irene, '/community');
    await expect(page.getByText('👋 Hoy se han presentado 2 personas').first()).toBeVisible();
    await expect(
      page.getByText('🎂 Irene Soler cumple 1 año en la comunidad').first(),
    ).toBeVisible();
    await close();
  });
});
