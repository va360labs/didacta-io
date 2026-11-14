/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import http from 'node:http';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { injectSession } from '../helpers/auth';
import { applySeedSql } from '../helpers/aula-sembrada';
import { aulaConCreador, alumno, matricular, type Auth } from '../helpers/retencion';
import { apiAs, type FreshTenant } from '../helpers/simple-tenant';

/**
 * Una clase en directo: N alumnos con sesión en la MISMA aula, navegando a la
 * vez (comunidad, la lección con el vídeo, el chat, las notificaciones).
 *
 * Hasta la beta.21 toda el aula compartía UN cubo de rate limit (100/min en
 * Community, sin variables en el pool de Didacta Cloud): diez alumnos a la vez
 * lo agotaban y el aula entera —profesor incluido— recibía 429. Ahora cada
 * usuario tiene su cubo, con un tope por aula alto encima.
 *
 * Corre en su propia tanda (`e2e-stack.sh limits-start` + `limits-run`), con
 * los límites de Cloud: 600/min por usuario y 12.000/min por aula. La tanda
 * general sube todos los límites a 100.000 (todo el arnés sale de una misma
 * IP) y aquí no probaría nada; por eso el test exige ver un límite por usuario
 * real antes de empezar.
 *
 * Además de no ver ningún 429, mide lo que consume de verdad cada alumno (pico
 * de peticiones a la API en cualquier ventana de 60 s) y lo deja en la salida.
 */

const API_PORT = Number(process.env.API_PORT ?? 4000);
const ALUMNOS = Number(process.env.E2E_CLASE_ALUMNOS ?? 12);
const DURACION_MS = Number(process.env.E2E_CLASE_DURACION_MS ?? 75_000);

/**
 * Tres maneras de estar en clase. Casi todos navegan por los enlaces (la app
 * no se recarga: es lo que hace quien usa el menú); dos van deprisa, y uno
 * recarga la página entera cada vez (F5, o abrir cada pantalla en una pestaña
 * nueva), que es lo más caro: cada carga completa vuelve a pedir el armazón.
 */
type Perfil = 'normal' | 'rápido' | 'recargas';
const PERFILES: Record<Perfil, { pausaMs: number; recarga: boolean }> = {
  normal: { pausaMs: 4_000, recarga: false },
  rápido: { pausaMs: 1_500, recarga: false },
  recargas: { pausaMs: 4_000, recarga: true },
};
const perfilDe = (i: number): Perfil => (i === 0 ? 'recargas' : i <= 2 ? 'rápido' : 'normal');

const VIDEO = 'https://www.youtube-nocookie.com/embed/e2eClaseEnDirecto';

interface Respuesta {
  at: number;
  status: number;
  url: string;
  /** `X-RateLimit-Limit` de la respuesta: dice en qué cubo contó. */
  limit: string | undefined;
}

/** Curso publicado cuya primera lección es el vídeo de la clase. */
async function cursoConVideo(
  t: FreshTenant,
  bearer: string,
): Promise<{ id: string; slug: string }> {
  const slug = `clase-en-directo-${Date.now().toString(36)}`;
  const course = await apiAs<{ id: string }>(t.host, '/api/v1/modules/courses', {
    method: 'POST',
    bearer,
    body: { title: 'Clase en directo', slug, description: 'La clase de hoy, con su vídeo.' },
  });
  const m = await apiAs<{ id: string }>(t.host, `/api/v1/modules/courses/${course.id}/modules`, {
    method: 'POST',
    bearer,
    body: { title: 'Hoy', orderIndex: 0 },
  });
  await apiAs(t.host, `/api/v1/modules/courses/modules/${m.id}/lessons`, {
    method: 'POST',
    bearer,
    body: {
      title: 'El vídeo de la clase',
      type: 'HTML',
      orderIndex: 0,
      content: {
        html: `<p>Hoy vemos esto:</p><iframe src="${VIDEO}" title="vídeo de la clase" width="640" height="360"></iframe>`,
      },
    },
  });
  await apiAs(t.host, `/api/v1/modules/courses/modules/${m.id}/lessons`, {
    method: 'POST',
    bearer,
    body: {
      title: 'Ejercicio',
      type: 'TEXT',
      orderIndex: 1,
      content: { text: 'Repite el ejercicio del vídeo.' },
      durationSec: 60,
    },
  });
  await apiAs(t.host, `/api/v1/modules/courses/${course.id}/publish`, { method: 'POST', bearer });
  return { id: course.id, slug };
}

/** GET directo a la API con el Host del aula (la cabecera que hace falta ver). */
function rawGet(
  host: string,
  path: string,
  bearer: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: API_PORT,
        path,
        method: 'GET',
        headers: { Host: host, authorization: `Bearer ${bearer}` },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Pico de peticiones en cualquier ventana de 60 s. */
function picoPorMinuto(marcas: number[]): number {
  const t = [...marcas].sort((a, b) => a - b);
  let pico = 0;
  let i = 0;
  for (let j = 0; j < t.length; j += 1) {
    while (t[j]! - t[i]! >= 60_000) i += 1;
    pico = Math.max(pico, j - i + 1);
  }
  return pico;
}

async function entrar(browser: Browser, t: FreshTenant, auth: Auth) {
  const ctx = await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: t.base }]);
  const page = await ctx.newPage();
  const respuestas: Respuesta[] = [];
  page.on('response', (r) => {
    if (!r.url().includes('/api/')) return;
    respuestas.push({
      at: Date.now(),
      status: r.status(),
      url: r.url(),
      limit: r.headers()['x-ratelimit-limit'],
    });
  });
  await page.goto(`${t.base}/signin`);
  await injectSession(page, {
    accessToken: auth.tokens.accessToken,
    refreshToken: auth.tokens.refreshToken,
    user: { ...auth.user, onboardingCompletedAt: new Date().toISOString() },
  });
  await page.goto(`${t.base}/community`, { waitUntil: 'domcontentloaded' });
  return { page, respuestas, close: () => ctx.close() };
}

/** A una pantalla: por su enlace si está a la vista (la app no se recarga) o con F5. */
async function irA(page: Page, t: FreshTenant, path: string, recarga: boolean): Promise<void> {
  if (!recarga) {
    const enlace = page.locator(`a[href="${path}"]`).first();
    if ((await enlace.count()) > 0 && (await enlace.isVisible().catch(() => false))) {
      await enlace.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForURL(`**${path}`, { timeout: 10_000 }).catch(() => undefined);
      return;
    }
  }
  await page.goto(`${t.base}${path}`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
}

/** Un alumno en clase: la comunidad, el curso con el vídeo, el chat, el calendario… */
async function navegar(page: Page, t: FreshTenant, slug: string, perfil: Perfil, hasta: number) {
  const { pausaMs, recarga } = PERFILES[perfil];
  const ruta = ['/courses', `/courses/${slug}`, '/messages', '/community', '/calendar', '/members'];
  let n = 0;
  while (Date.now() < hasta) {
    await irA(page, t, ruta[n % ruta.length]!, recarga);
    n += 1;
    await page.waitForTimeout(pausaMs);
  }
}

test.describe('Limites en clase · N alumnos con sesion a la vez', () => {
  test.setTimeout(DURACION_MS + 240_000);

  test('la clase navega sin un solo 429 y quien abusa solo se frena a sí mismo', async ({
    browser,
  }) => {
    // ── El aula, su curso con vídeo y la clase ────────────────────────────
    const { aula, creador } = await aulaConCreador('clase', false);
    applySeedSql(); // espacios de la comunidad del aula nueva
    const bearer = creador.tokens.accessToken;
    const curso = await cursoConVideo(aula, bearer);

    const stamp = Date.now().toString(36);
    const alumnos: Auth[] = [];
    for (let i = 0; i < ALUMNOS + 1; i += 1) {
      const a = await alumno(aula, `alumno${i}-${stamp}@${aula.slug}.test`, `Alumno ${i}`);
      await matricular(aula, bearer, a.user.id, curso.id);
      alumnos.push(a);
    }
    const desbocado = alumnos.pop()!;

    // ── La API tiene que estar con un límite POR USUARIO real ──────────────
    const sonda = await rawGet(
      aula.host,
      '/api/v1/me/notifications?limit=1',
      alumnos[0]!.tokens.accessToken,
    );
    const limite = Number(sonda.headers['x-ratelimit-limit']);
    expect(
      Number.isFinite(limite) && limite > 0 && limite <= 1000,
      `X-RateLimit-Limit con sesión = ${String(sonda.headers['x-ratelimit-limit'])}: ` +
        'esta tanda necesita la API con los límites de Cloud (e2e-stack.sh limits-start).',
    ).toBe(true);

    // ── La clase, todos a la vez ──────────────────────────────────────────
    const sesiones = await Promise.all(alumnos.map((a) => entrar(browser, aula, a)));
    const hasta = Date.now() + DURACION_MS;
    const clase = Promise.all(
      sesiones.map((s, i) => navegar(s.page, aula, curso.slug, perfilDe(i), hasta)),
    );

    // A mitad de clase, alguien se desboca contra la API con su sesión.
    await new Promise((r) => setTimeout(r, 10_000));
    const rafaga: number[] = [];
    for (let lote = 0; lote < Math.ceil((limite + 40) / 20); lote += 1) {
      const r = await Promise.all(
        Array.from({ length: 20 }, () =>
          rawGet(aula.host, '/api/v1/me/notifications?limit=1', desbocado.tokens.accessToken),
        ),
      );
      rafaga.push(...r.map((x) => x.status));
    }
    const corte = await rawGet(
      aula.host,
      '/api/v1/me/notifications?limit=1',
      desbocado.tokens.accessToken,
    );

    await clase;

    // ── Lo que pasó ───────────────────────────────────────────────────────
    // Solo lo que cuenta en SU cubo (las imágenes y lo público van por IP).
    const consumo = sesiones.map((s, i) => {
      const suyas = s.respuestas.filter((r) => r.limit === String(limite));
      return {
        perfil: perfilDe(i),
        peticiones: suyas.length,
        picoPorMinuto: picoPorMinuto(suyas.map((r) => r.at)),
        r429: s.respuestas.filter((r) => r.status === 429).map((r) => r.url),
      };
    });
    const pico = (perfil: Perfil) =>
      Math.max(...consumo.filter((c) => c.perfil === perfil).map((c) => c.picoPorMinuto));
    const mediana = (perfil: Perfil) => {
      const v = consumo
        .filter((c) => c.perfil === perfil)
        .map((c) => c.picoPorMinuto)
        .sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)] ?? 0;
    };
    // eslint-disable-next-line no-console
    console.log(
      `[clase] ${ALUMNOS} alumnos, ${Math.round(DURACION_MS / 1000)} s · límite por usuario ${limite}/min · ` +
        `peticiones con sesión por alumno, pico en 60 s: normal ${mediana('normal')} (máx ${pico('normal')}), ` +
        `rápido ${pico('rápido')}, recargando ${pico('recargas')} · ` +
        `ráfaga del desbocado: ${rafaga.filter((s) => s === 200).length} OK / ${rafaga.filter((s) => s === 429).length} 429`,
    );

    // Ningún alumno de la clase vio un 429.
    expect(consumo.flatMap((c) => c.r429)).toEqual([]);
    // La clase hizo trabajo de verdad (si no, «sin 429» no dice nada).
    expect(consumo.every((c) => c.peticiones > 20)).toBe(true);
    // Ni quien recarga la página entera se acerca a su límite.
    expect(pico('recargas')).toBeLessThan(limite);

    // Al desbocado, en cambio, sí se le corta… y solo a él.
    expect(rafaga.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(rafaga.filter((s) => s === 200).length).toBeLessThanOrEqual(limite);
    expect(corte.status).toBe(429);
    expect(JSON.parse(corte.body)).toMatchObject({ code: 'rate_limit_exceeded', scope: 'user' });
    expect(Number(corte.headers['retry-after'])).toBeGreaterThan(0);

    await Promise.all(sesiones.map((s) => s.close()));
  });
});
