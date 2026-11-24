import { expect, test, type Page } from '@playwright/test';
import {
  adminSessionForBootstrap,
  API_URL,
  E2E_USER_PASSWORD,
  signupOnboarded,
} from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Espacios de la comunidad y directos restringidos por nivel de membresía
 * (cada nivel es un grupo de acceso).
 *
 * Un atacante con una cuenta de nivel bajo («básico») intenta leer por la API
 * TODOS los caminos de un espacio y una clase del nivel «Pro», y al lado va el
 * control: la cuenta «pro» los ve. Después, la experiencia en el navegador
 * (candado + «Disponible en» + botón a /join para el básico; el contenido para
 * el pro) y la del creador, en modo completo y en modo sencillo.
 */

const TENANT = process.env.E2E_TENANT_SLUG ?? 'demo';

interface Res<T = unknown> {
  status: number;
  body: T;
}

async function call<T = unknown>(
  method: string,
  path: string,
  bearer: string,
  body?: unknown,
): Promise<Res<T>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

async function ok<T = unknown>(
  method: string,
  path: string,
  bearer: string,
  body?: unknown,
): Promise<T> {
  const r = await call<T>(method, path, bearer, body);
  expect(r.status, `${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
}

type Session = Awaited<ReturnType<typeof signupOnboarded>>;

interface World {
  stamp: number;
  admin: { accessToken: string; user: Session['user'] };
  pro: Session;
  basico: Session;
  groupPro: { id: string; name: string };
  groupBasico: { id: string; name: string };
  slug: string;
  postId: string;
  commentId: string;
  sessionId: string;
}

let w: World;

async function signedIn(page: Page, s: { accessToken: string; user: Session['user'] }) {
  await page.goto('/signin');
  await injectSession(page, { accessToken: s.accessToken, user: s.user });
}

test.describe('Espacios y directos por nivel de membresía', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    const stamp = Date.now();
    const admin = await adminSessionForBootstrap(TENANT);
    const tk = admin.accessToken;
    // Dos niveles (= grupos de acceso sin cursos, para no matricular a nadie).
    const groupPro = await ok<{ id: string; name: string }>('POST', '/modules/access-groups', tk, {
      name: `Pro ${stamp}`,
      kind: 'MULTI_COURSE',
    });
    const groupBasico = await ok<{ id: string; name: string }>(
      'POST',
      '/modules/access-groups',
      tk,
      { name: `Básico ${stamp}`, kind: 'MULTI_COURSE' },
    );
    const pro = await signupOnboarded({
      tenantSlug: TENANT,
      email: `nivel-pro-${stamp}@example.test`,
      password: E2E_USER_PASSWORD,
      name: 'Pro E2E',
    });
    const basico = await signupOnboarded({
      tenantSlug: TENANT,
      email: `nivel-basico-${stamp}@example.test`,
      password: E2E_USER_PASSWORD,
      name: 'Basico E2E',
    });
    await ok('POST', `/modules/access-groups/${groupPro.id}/members`, tk, {
      userIds: [pro.user.id],
    });
    await ok('POST', `/modules/access-groups/${groupBasico.id}/members`, tk, {
      userIds: [basico.user.id],
    });

    // Espacio «Pro» y su contenido: un post con adjunto y mención al básico, y
    // un comentario del de Pro.
    const slug = `sala-pro-${stamp}`;
    await ok('POST', '/modules/community/spaces', tk, {
      slug,
      title: `Sala Pro ${stamp}`,
      description: 'Descripción solo para Pro',
      accessGroupIds: [groupPro.id],
    });
    const handleBasico = `nivel-basico-${stamp}`;
    const post = await ok<{ id: string }>('POST', '/modules/community/posts', tk, {
      title: `Estrategia secreta ${stamp}`,
      body: `Contenido Pro para @${handleBasico}\n<!--didacta-attachments:{"images":[{"url":"/api/v1/storage/file/pro-${stamp}.png","name":"pro.png"}],"files":[]}-->`,
      tags: [slug],
    });
    const comment = await ok<{ id: string }>(
      'POST',
      `/modules/community/posts/${post.id}/comments`,
      pro.tokens.accessToken,
      { body: `Comentario Pro ${stamp}` },
    );

    // Clase «Pro» con enlace propio (sin Zoom) y agenda privada.
    const session = await ok<{ id: string }>('POST', '/modules/zoom-live/sessions', tk, {
      topic: `Masterclass Pro ${stamp}`,
      description: 'Agenda privada de la masterclass',
      startTime: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      durationMinutes: 60,
      timezone: 'Europe/Madrid',
      hostEmail: admin.user.email,
      externalJoinUrl: `https://meet.example.com/sala-pro-${stamp}`,
      accessGroupIds: [groupPro.id],
    });

    w = {
      stamp,
      admin,
      pro,
      basico,
      groupPro,
      groupBasico,
      slug,
      postId: post.id,
      commentId: comment.id,
      sessionId: session.id,
    };
  });

  test('API: sin el nivel no se ve nada por ningún camino; con él, sí', async () => {
    const b = w.basico.tokens.accessToken;
    const p = w.pro.tokens.accessToken;

    // Espacios: cerrado (sin descripción) y con el nivel que lo abre.
    const espaciosB = await ok<Array<Record<string, unknown>>>(
      'GET',
      '/modules/community/spaces',
      b,
    );
    expect(espaciosB.find((s) => s['slug'] === w.slug)).toMatchObject({
      locked: true,
      description: null,
      accessLevels: [{ id: w.groupPro.id, name: w.groupPro.name }],
    });
    const espaciosP = await ok<Array<Record<string, unknown>>>(
      'GET',
      '/modules/community/spaces',
      p,
    );
    expect(espaciosP.find((s) => s['slug'] === w.slug)).toMatchObject({
      locked: false,
      description: 'Descripción solo para Pro',
    });

    // Feed por espacio y vista «todo».
    const ids = (r: Array<{ id: string }>) => r.map((x) => x.id);
    expect(await ok<unknown[]>('GET', `/modules/community/posts?tag=${w.slug}`, b)).toEqual([]);
    expect(ids(await ok('GET', `/modules/community/posts?tag=${w.slug}`, p))).toContain(w.postId);
    expect(ids(await ok('GET', '/modules/community/posts?limit=100', b))).not.toContain(w.postId);
    expect(ids(await ok('GET', '/modules/community/posts?limit=100', p))).toContain(w.postId);

    // Detalle: 404 (como si no existiera).
    expect((await call('GET', `/modules/community/posts/${w.postId}`, b)).status).toBe(404);
    expect((await call('GET', `/modules/community/posts/${w.postId}`, p)).status).toBe(200);

    // Galería de adjuntos.
    const adjB = await ok<Array<{ postId: string }>>('GET', '/modules/community/attachments', b);
    expect(adjB.map((a) => a.postId)).not.toContain(w.postId);
    const adjP = await ok<Array<{ postId: string }>>('GET', '/modules/community/attachments', p);
    expect(adjP.map((a) => a.postId)).toContain(w.postId);

    // Comentar y reaccionar.
    expect(
      (await call('POST', `/modules/community/posts/${w.postId}/comments`, b, { body: 'x' }))
        .status,
    ).toBe(404);
    expect(
      (await call('POST', '/modules/community/reactions', b, { postId: w.postId, emoji: '👍' }))
        .status,
    ).toBe(404);
    expect(
      (
        await call('POST', '/modules/community/reactions', b, {
          commentId: w.commentId,
          emoji: '👍',
        })
      ).status,
    ).toBe(404);
    expect(
      (await call('POST', '/modules/community/reactions', p, { postId: w.postId, emoji: '🔥' }))
        .status,
    ).toBeLessThan(300);

    // Publicar en el espacio cerrado.
    const colar = await call<{ code: string }>('POST', '/modules/community/posts', b, {
      title: 'Me cuelo',
      body: 'x',
      tags: [w.slug],
    });
    expect(colar.status).toBe(403);
    expect(colar.body.code).toBe('COMMUNITY_SPACE_LOCKED');

    // Barra lateral (últimos comentarios) y menciones.
    const barraB = await ok<{ recentComments: Array<{ postId: string }> }>(
      'GET',
      '/modules/community/sidebar',
      b,
    );
    expect(barraB.recentComments.map((c) => c.postId)).not.toContain(w.postId);
    const barraP = await ok<{ recentComments: Array<{ postId: string }> }>(
      'GET',
      '/modules/community/sidebar',
      p,
    );
    expect(barraP.recentComments.map((c) => c.postId)).toContain(w.postId);
    const mencionesB = await ok<Array<{ postId: string | null }>>(
      'GET',
      '/modules/community/mentions/me',
      b,
    );
    expect(mencionesB.map((m) => m.postId)).not.toContain(w.postId);

    // Sala de chat del espacio.
    expect((await call('POST', `/modules/messaging/spaces/${w.slug}/open`, b)).status).toBe(404);
    expect((await call('POST', `/modules/messaging/spaces/${w.slug}/open`, p)).status).toBeLessThan(
      300,
    );

    // Directo: listado y detalle cerrados, sin descripción, enlace ni grabación.
    const claseB = await ok<Record<string, unknown>>(
      'GET',
      `/modules/zoom-live/sessions/${w.sessionId}`,
      b,
    );
    expect(claseB).toMatchObject({
      locked: true,
      description: null,
      joinUrl: null,
      recordingUrl: null,
      accessLevels: [{ id: w.groupPro.id, name: w.groupPro.name }],
    });
    expect(JSON.stringify(claseB)).not.toContain('meet.example.com');
    const listaB = await ok<Array<Record<string, unknown>>>(
      'GET',
      '/modules/zoom-live/sessions',
      b,
    );
    expect(listaB.find((s) => s['id'] === w.sessionId)).toMatchObject({ locked: true });
    // Inscribirse y pedir el enlace: 403.
    const inscribir = await call<{ code: string }>(
      'POST',
      `/modules/zoom-live/sessions/${w.sessionId}/register`,
      b,
    );
    expect(inscribir.status).toBe(403);
    expect(inscribir.body.code).toBe('ZOOM_SESSION_LOCKED');
    expect((await call('POST', `/modules/zoom-live/sessions/${w.sessionId}/join`, b)).status).toBe(
      403,
    );
    // La encuesta de la clase no existe para él.
    const encuesta = await ok<{ survey: unknown }>(
      'GET',
      `/modules/surveys/sessions/${w.sessionId}`,
      b,
    );
    expect(encuesta.survey).toBeNull();
    // Control: el de Pro la ve, se inscribe y recibe el enlace.
    const claseP = await ok<Record<string, unknown>>(
      'POST',
      `/modules/zoom-live/sessions/${w.sessionId}/register`,
      p,
    );
    expect(claseP).toMatchObject({
      locked: false,
      description: 'Agenda privada de la masterclass',
      joinUrl: `https://meet.example.com/sala-pro-${w.stamp}`,
    });

    // Las opciones de «Quién puede verlo» son para el creador, no para miembros.
    expect((await call('GET', '/modules/access-groups/options', b)).status).toBe(403);
    const opciones = await ok<Array<{ id: string; name: string }>>(
      'GET',
      '/modules/access-groups/options',
      w.admin.accessToken,
    );
    expect(opciones).toEqual(
      expect.arrayContaining([
        { id: w.groupPro.id, name: w.groupPro.name },
        { id: w.groupBasico.id, name: w.groupBasico.name },
      ]),
    );
  });

  test('UI: el básico ve el candado del espacio y de la clase; el pro, el contenido', async ({
    page,
  }) => {
    await signedIn(page, { accessToken: w.basico.tokens.accessToken, user: w.basico.user });
    await page.goto(`/spaces/${w.slug}`);
    const bloqueado = page.getByTestId('bloqueado-space');
    await expect(bloqueado).toBeVisible();
    await expect(bloqueado).toContainText(`Sala Pro ${w.stamp}`);
    await expect(bloqueado.getByTestId('disponible-en')).toHaveText(
      `Disponible en: ${w.groupPro.name}`,
    );
    await expect(bloqueado.getByRole('link', { name: 'Ver planes' })).toHaveAttribute(
      'href',
      '/join',
    );
    await expect(page.getByText(`Estrategia secreta ${w.stamp}`)).toHaveCount(0);
    await expect(page.getByText('Descripción solo para Pro')).toHaveCount(0);

    await page.goto(`/live/${w.sessionId}`);
    const clase = page.getByTestId('bloqueado-live');
    await expect(clase).toBeVisible();
    await expect(clase).toContainText(`Masterclass Pro ${w.stamp}`);
    await expect(clase.getByTestId('disponible-en')).toHaveText(
      `Disponible en: ${w.groupPro.name}`,
    );
    await expect(page.getByText('Agenda privada de la masterclass')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Inscribirme/i })).toHaveCount(0);

    // Control: el de Pro ve el post en el espacio y la agenda de la clase.
    await signedIn(page, { accessToken: w.pro.tokens.accessToken, user: w.pro.user });
    await page.goto(`/spaces/${w.slug}`);
    await expect(page.getByText(`Estrategia secreta ${w.stamp}`).first()).toBeVisible();
    await expect(page.getByTestId('bloqueado-space')).toHaveCount(0);
    await page.goto(`/live/${w.sessionId}`);
    await expect(page.getByText('Agenda privada de la masterclass')).toBeVisible();
    await expect(page.getByTestId('bloqueado-live')).toHaveCount(0);
  });

  test('UI del creador (modo completo): «Solo estos niveles» en un espacio y en una clase', async ({
    page,
  }) => {
    const tk = w.admin.accessToken;
    await signedIn(page, w.admin);

    // Espacio: /admin/community/spaces.
    await page.goto('/admin/community/spaces');
    const nombre = `Nivel UI ${w.stamp}`;
    await page.locator('#space-title').fill(nombre);
    await page.locator('#space-niveles').check();
    // Al pasar a «Solo estos niveles» salen TODOS marcados (un nivel no
    // incluye a otro), con la nota que lo explica. Se deja solo Pro.
    const casillasEspacio = page.locator('[data-testid="space-quien"] input[type="checkbox"]');
    await expect(casillasEspacio.first()).toBeChecked();
    for (const casilla of await casillasEspacio.all()) await expect(casilla).toBeChecked();
    await expect(page.getByTestId('space-nota-niveles')).toBeVisible();
    for (const casilla of await casillasEspacio.all()) {
      if ((await casilla.getAttribute('id')) !== `space-nivel-${w.groupPro.id}`) {
        await casilla.uncheck();
      }
    }
    await page.getByRole('button', { name: 'Crear espacio' }).click();
    // La fila del espacio nuevo, con su marca de nivel (no la de «Sala Pro»).
    const fila = page.locator('li', { hasText: nombre });
    await expect(fila).toBeVisible();
    await expect(fila.getByTestId('con-nivel')).toHaveText(`Solo para: ${w.groupPro.name}`);
    const espacios = await ok<Array<Record<string, unknown>>>(
      'GET',
      '/modules/community/spaces',
      tk,
    );
    expect(espacios.find((s) => s['title'] === nombre)).toMatchObject({
      accessGroupIds: [w.groupPro.id],
    });

    // Clase: /studio/live.
    await page.goto('/studio/live');
    await page.getByRole('button', { name: 'Nueva sesión' }).click();
    const tema = `Clase nivel UI ${w.stamp}`;
    await page.locator('#topic').fill(tema);
    await page.locator('#startTime').fill('2027-03-10T18:00');
    await page.locator('#clase-niveles').check();
    const casillasClase = page.locator('[data-testid="clase-quien"] input[type="checkbox"]');
    for (const casilla of await casillasClase.all()) await expect(casilla).toBeChecked();
    for (const casilla of await casillasClase.all()) {
      if ((await casilla.getAttribute('id')) !== `clase-nivel-${w.groupPro.id}`) {
        await casilla.uncheck();
      }
    }
    await page.getByRole('button', { name: 'Crear sesión' }).click();
    await expect(page.getByText(tema)).toBeVisible();
    const clases = await ok<Array<Record<string, unknown>>>(
      'GET',
      '/modules/zoom-live/sessions',
      tk,
    );
    expect(clases.find((s) => s['topic'] === tema)).toMatchObject({
      accessGroupIds: [w.groupPro.id],
    });
  });

  test('UI del creador (modo sencillo): «Solo estos niveles» en una clase', async ({ page }) => {
    const tk = w.admin.accessToken;
    await ok('PUT', '/admin/simple-mode', tk, { enabled: true });
    try {
      await signedIn(page, w.admin);
      await page.goto('/studio/live');
      await expect(page.getByTestId('directos-sencillo')).toBeVisible();
      const nueva = page.getByRole('button', { name: /Nueva clase|Programar mi primera clase/ });
      await nueva.first().click();
      const tema = `Clase sencilla nivel ${w.stamp}`;
      await page.locator('#directo-titulo').fill(tema);
      await page.locator('#directo-fecha').fill('2027-03-11');
      await page.locator('#directo-hora').fill('19:00');
      const enlace = page.locator('#directo-enlace');
      if (await enlace.isVisible())
        await enlace.fill(`https://meet.example.com/sencilla-${w.stamp}`);
      // Al pasar a «Solo estos niveles» salen todos marcados; sin ninguno no
      // deja guardar.
      await page.locator('#directo-niveles').check();
      const casillas = page.locator('[data-testid="directo-quien"] input[type="checkbox"]');
      for (const casilla of await casillas.all()) await expect(casilla).toBeChecked();
      await expect(page.getByTestId('directo-nota-niveles')).toBeVisible();
      for (const casilla of await casillas.all()) await casilla.uncheck();
      await page.getByRole('button', { name: 'Crear clase' }).click();
      await expect(page.getByText('Marca al menos un nivel.')).toBeVisible();
      await page.locator(`#directo-nivel-${w.groupBasico.id}`).check();
      await page.getByRole('button', { name: 'Crear clase' }).click();
      await expect(page.getByTestId('form-directo')).toHaveCount(0);
      const clases = await ok<Array<Record<string, unknown>>>(
        'GET',
        '/modules/zoom-live/sessions',
        tk,
      );
      expect(clases.find((s) => s['topic'] === tema)).toMatchObject({
        accessGroupIds: [w.groupBasico.id],
      });
      // Y el de Pro (sin el nivel Básico) la ve cerrada.
      const vista = await ok<Array<Record<string, unknown>>>(
        'GET',
        '/modules/zoom-live/sessions',
        w.pro.tokens.accessToken,
      );
      expect(vista.find((s) => s['topic'] === tema)).toMatchObject({ locked: true });
    } finally {
      await ok('PUT', '/admin/simple-mode', tk, { enabled: false });
    }
  });
});
