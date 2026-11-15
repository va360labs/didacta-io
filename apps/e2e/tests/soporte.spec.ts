/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { mailById, mailsTo, smtpForMailpit, type MailpitFull } from '../helpers/mailpit';
import { fotoPngBase64 } from '../helpers/png';
import { aulaConCreador, alumno, notificaciones, type Auth } from '../helpers/retencion';
import { injectSession } from '../helpers/auth';
import { apiAs, type FreshTenant } from '../helpers/simple-tenant';

/**
 * «Ayuda y sugerencias» (mod.soporte) en Didacta Cloud, de punta a punta,
 * contra la API y la web reales y con el correo de verdad en el buzón de
 * pruebas (Mailpit).
 *
 * Lo que protege:
 *  - El módulo está ENCENDIDO en un aula nueva sin tocar nada (así nace en
 *    Cloud) y el botón sale en la cabecera del modo sencillo.
 *  - El miembro abre un «Algo no funciona» con captura y lo ve en «Tus
 *    tickets» como «Nuevo», con su captura.
 *  - El OPERADOR de la plataforma (`SUPPORT_OPERATOR_ALERT_EMAIL`) recibe el
 *    correo en el momento, en español, con el aula y su dominio, el tipo, el
 *    texto entero, quién lo abre, la captura y el enlace al ticket. Con el SMTP
 *    de la plataforma (como el pool) el aula no tiene SMTP propio; en un arnés
 *    sin él, se le pone al aula y el aviso sale por ahí.
 *  - El equipo lo encuentra en «Más» → «Tickets de soporte», lo pasa a
 *    «Resuelto» con una nota interna; el miembro ve «Resuelto», recibe su aviso
 *    (campana y correo) y nunca la nota.
 *  - Un alumno no ve la bandeja: la API responde 403 y la pantalla lo dice.
 *  - El tope de 5 al día aguanta envíos A LA VEZ (5 entran, el resto 429) y la
 *    captura de otro da 404; una página HTML que dice ser PNG, 400.
 *  - La interfaz y los avisos al equipo y al miembro van en el idioma del aula:
 *    un aula en inglés (móvil) y otra en portugués (escritorio).
 */

test.describe.configure({ mode: 'serial' });

const OPERADOR = process.env.SUPPORT_OPERATOR_ALERT_EMAIL ?? 'operador-soporte@didacta-e2e.test';
const BASE = '/api/v1/modules/soporte';
const STAMP = Date.now().toString(36);
const TEXTO = `El vídeo de la lección 2 no arranca (${STAMP})`;
const NOTA = `Nota interna: era su bloqueador de anuncios (${STAMP})`;
const PNG = Buffer.from(fotoPngBase64(16), 'base64');

/** Petición a la API del aula que devuelve el status en vez de lanzar. */
async function llamar(
  aula: FreshTenant,
  path: string,
  opts: { method?: string; body?: unknown; bearer: string },
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(`http://127.0.0.1:${process.env.API_PORT ?? 4000}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      Host: aula.host,
      'content-type': 'application/json',
      authorization: `Bearer ${opts.bearer}`,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: Record<string, unknown> | null;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/**
 * El SMTP de la plataforma manda en Cloud. Si el arnés no lo tiene, el aula
 * lleva su SMTP al buzón de pruebas para que los correos salgan igual.
 */
async function prepararCorreo(aula: FreshTenant, creador: Auth): Promise<boolean> {
  const salud = await apiAs<{ checks?: { smtp?: { globalFallback?: boolean } } }>(
    aula.host,
    '/api/v1/admin/system/health-detail',
    { bearer: creador.tokens.accessToken },
  );
  const plataforma = salud.checks?.smtp?.globalFallback === true;
  if (!plataforma) {
    await apiAs(aula.host, '/api/v1/admin/tenant-settings/smtp', {
      method: 'PUT',
      bearer: creador.tokens.accessToken,
      body: smtpForMailpit(`hola@${aula.slug}.example.com`, aula.slug),
    });
  }
  return plataforma;
}

/** El correo más reciente a `to` cuyo asunto cumple `asunto`, esperando hasta `ms`. */
async function correo(to: string, asunto: RegExp, ms = 20_000): Promise<MailpitFull> {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) {
    const m = (await mailsTo(to).catch(() => [])).find((x) => asunto.test(x.Subject));
    if (m) return mailById(m.ID);
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`No llegó a ${to} un correo con asunto ${asunto} en ${ms} ms`);
}

async function abrirComo(
  browser: Browser,
  aula: FreshTenant,
  auth: Auth,
  path: string,
  opts: { viewport?: { width: number; height: number }; locale?: string } = {},
): Promise<{ page: Page; close: () => Promise<void> }> {
  // Sin cookie de idioma: el idioma sale del aula y del perfil, como en Cloud.
  const ctx = await browser.newContext({
    locale: opts.locale ?? 'es-ES',
    viewport: opts.viewport ?? { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto(`${aula.base}/signin`);
  await injectSession(page, {
    accessToken: auth.tokens.accessToken,
    refreshToken: auth.tokens.refreshToken,
    user: { ...auth.user, onboardingCompletedAt: new Date().toISOString() },
  });
  const modulos = page.waitForResponse((r) => r.url().includes('/api/v1/me/modules'));
  await page.goto(`${aula.base}${path}`);
  await modulos;
  return { page, close: () => ctx.close() };
}

/** El botón «Ayuda y sugerencias» visible (en el móvil, el del cajón está oculto). */
const boton = (page: Page) => page.locator('[data-testid="soporte-abrir"]:visible');

// ─── Aula en español (modo sencillo, como en Cloud) ─────────────────────────

let aula: FreshTenant;
let creadora: Auth;
let ana: Auth;
let beto: Auth;
let ticketId: string;
let viaPlataforma = false;

/** Nombre del aula: único por pasada, porque el buzón de pruebas es compartido. */
const ACADEMIA = `Cerámica Soporte ${STAMP}`;

test.beforeAll(async () => {
  ({ aula, creador: creadora } = await aulaConCreador('sop', true));
  await apiAs(aula.host, '/api/v1/admin/tenant-settings/academy', {
    method: 'PUT',
    bearer: creadora.tokens.accessToken,
    body: { name: ACADEMIA, locale: 'es' },
  });
  ana = await alumno(aula, `ana-${STAMP}@${aula.slug}.test`, `Ana Soporte ${STAMP}`);
  beto = await alumno(aula, `beto-${STAMP}@${aula.slug}.test`, `Beto Soporte ${STAMP}`);
  viaPlataforma = await prepararCorreo(aula, creadora);
});

test('nace ENCENDIDO en un aula nueva, sin tocar Módulos', async () => {
  const mods = await apiAs<{ activeModules: string[] }>(aula.host, '/api/v1/me/modules', {
    bearer: ana.tokens.accessToken,
  });
  expect(mods.activeModules).toContain('mod.soporte');
});

test('el miembro abre un fallo con captura desde la cabecera y lo ve en «Tus tickets»', async ({
  browser,
}) => {
  const { page, close } = await abrirComo(browser, aula, ana, '/community');
  try {
    await expect(page.getByTestId('simple-shell')).toBeVisible();
    await expect(boton(page)).toHaveAttribute('aria-label', 'Ayuda y sugerencias');
    await boton(page).click();
    const dialogo = page.getByRole('dialog');
    await expect(dialogo.getByRole('heading', { name: 'Ayuda y sugerencias' })).toBeVisible();
    await expect(dialogo.getByRole('radio')).toHaveCount(3);
    await expect(dialogo.getByRole('radio', { name: 'Tengo una sugerencia' })).toBeChecked();
    await expect(dialogo.getByLabel('¿Qué mejorarías del aula?')).toBeVisible();
    await dialogo.getByRole('radio', { name: 'Algo no funciona' }).check();
    await dialogo.getByLabel('¿Qué ha pasado?').fill(TEXTO);
    await dialogo.getByTestId('soporte-captura-input').setInputFiles({
      name: 'pantalla.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await expect(dialogo.getByTestId('soporte-preview')).toBeVisible();
    await expect(
      dialogo.getByText('Se enviará también: la página, el navegador y la hora.'),
    ).toBeVisible();

    const alta = page.waitForResponse(
      (r) => r.url().endsWith(`${BASE}/tickets`) && r.request().method() === 'POST',
    );
    await dialogo.getByTestId('soporte-enviar').click();
    expect((await alta).status()).toBe(201);
    await expect(dialogo.getByTestId('soporte-enviado')).toBeVisible();

    await dialogo.getByTestId('soporte-ver-tickets').click();
    await expect(page).toHaveURL(/\/support$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Tus tickets' })).toBeVisible();
    const ticket = page.getByTestId('soporte-ticket').filter({ hasText: TEXTO });
    await expect(ticket).toHaveCount(1);
    await expect(ticket.getByText('Algo no funciona')).toBeVisible();
    await expect(ticket.getByTestId('soporte-estado')).toHaveText('Nuevo');
    await expect(ticket.getByRole('img', { name: 'Captura del ticket' })).toBeVisible();
  } finally {
    await close();
  }

  const mios = await apiAs<Array<{ id: string; texto: string; tieneCaptura: boolean }>>(
    aula.host,
    `${BASE}/tickets/mios`,
    { bearer: ana.tokens.accessToken },
  );
  const creado = mios.find((t) => t.texto === TEXTO);
  expect(creado?.tieneCaptura).toBe(true);
  ticketId = creado!.id;
});

test('el operador recibe el correo EN EL MOMENTO, en español y con todo lo necesario', async () => {
  const m = await correo(OPERADOR, new RegExp(`^\\[Soporte\\] ${ACADEMIA}:`), 15_000);
  expect(m.Subject).toBe(`[Soporte] ${ACADEMIA}: algo no funciona — Ana Soporte ${STAMP}`);
  for (const trozo of [
    `Ticket nuevo en «${ACADEMIA}»`,
    TEXTO,
    aula.host,
    'Algo no funciona',
    `Ana Soporte ${STAMP} <${ana.user.email}>`,
    'Sí (se ve en el ticket)',
    `/admin/support?ticket=${ticketId}`,
  ]) {
    expect(m.Text, trozo).toContain(trozo);
  }
  if (viaPlataforma) {
    // Con el SMTP de la plataforma (el pool), el aula no tiene SMTP propio y
    // sale igual, firmado por la plataforma.
    expect(m.From).toMatchObject({
      Name: 'Didacta soporte',
      Address: 'plataforma@didacta-e2e.test',
    });
  } else {
    // Sin SMTP de plataforma sale por el del aula, con el remitente que el
    // aula configuró (io no reescribe el de un SMTP propio).
    expect(m.From.Address).toBe(`hola@${aula.slug}.example.com`);
  }
  // Y quien administra el aula recibe SU aviso, en el idioma del aula.
  const equipo = await correo(aula.creatorEmail, /^Ticket de soporte: /);
  expect(equipo.Subject).toBe(
    `Ticket de soporte: Ana Soporte ${STAMP} avisa de que algo no funciona`,
  );
  expect(equipo.Text).toContain(`«${TEXTO}»`);
  expect(equipo.Text).toContain(`/admin/support?ticket=${ticketId}`);
});

test('el equipo lo encuentra en «Más», ve contexto y captura, y lo resuelve con una nota', async ({
  browser,
}) => {
  const { page, close } = await abrirComo(browser, aula, creadora, '/start');
  try {
    await page.getByRole('button', { name: 'Más' }).click();
    const enlace = page.getByRole('link', { name: 'Tickets de soporte', exact: true });
    await expect(enlace).toHaveCount(1);
    await enlace.click();
    await expect(page).toHaveURL(/\/admin\/support$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Tickets de soporte' })).toBeVisible();
    await page
      .locator(`[data-testid="soporte-admin-ticket"][data-ticket-id="${ticketId}"]`)
      .click();

    const detalle = page.getByTestId('soporte-admin-detalle');
    await expect(detalle).toHaveAttribute('data-ticket-id', ticketId);
    await expect(detalle.getByTestId('soporte-texto')).toHaveText(TEXTO);
    await expect(detalle.getByTestId('soporte-autor')).toHaveText(`Ana Soporte ${STAMP}`);
    const contexto = detalle.getByTestId('soporte-contexto');
    await expect(contexto.getByRole('link', { name: /\/community/ })).toBeVisible();
    await expect(contexto).toContainText(/\d+x\d+/);
    await expect(detalle.getByRole('img', { name: 'Captura del ticket' })).toBeVisible();
    await expect(detalle.getByText('Solo la ve el equipo')).toBeVisible();

    await detalle.getByTestId('soporte-admin-estado').selectOption('RESUELTO');
    await detalle.getByTestId('soporte-admin-nota').fill(NOTA);
    await detalle.getByTestId('soporte-admin-guardar').click();
    await expect(detalle.getByTestId('soporte-admin-guardado')).toHaveText('Guardado.');
  } finally {
    await close();
  }
  const t = await apiAs<{ estado: string; notaInterna: string | null }>(
    aula.host,
    `${BASE}/admin/tickets/${ticketId}`,
    { bearer: creadora.tokens.accessToken },
  );
  expect(t).toMatchObject({ estado: 'RESUELTO', notaInterna: NOTA });
});

test('el miembro ve «Resuelto», recibe su aviso y nunca la nota interna', async ({ browser }) => {
  const { page, close } = await abrirComo(browser, aula, ana, `/support?ticket=${ticketId}`);
  try {
    const ticket = page.locator(`[data-testid="soporte-ticket"][data-ticket-id="${ticketId}"]`);
    await expect(ticket).toHaveAttribute('aria-current', 'true');
    await expect(ticket.getByTestId('soporte-estado')).toHaveText('Resuelto');
    await expect(page.getByText(NOTA)).toHaveCount(0);
  } finally {
    await close();
  }
  const mios = await llamar(aula, `${BASE}/tickets/mios`, { bearer: ana.tokens.accessToken });
  expect(JSON.stringify(mios.body)).not.toContain(NOTA);
  expect(JSON.stringify(mios.body)).not.toContain('notaInterna');

  const aviso = await correo(ana.user.email, /^Tu ticket de soporte está resuelto$/);
  expect(aviso.Text).toContain('ha pasado a «Resuelto»');
  expect(aviso.Text).toContain(`/support?ticket=${ticketId}`);
  expect(aviso.Text).not.toContain('bloqueador');
  const campana = (await notificaciones(aula, ana)).filter(
    (n) => n.templateKey === 'soporte.ticket.estado',
  );
  expect(campana).toHaveLength(1);
  expect(campana[0]!.metadata?.['ticketId']).toBe(ticketId);
});

test('un alumno no ve la bandeja: 403 en la API, pantalla sin acceso y nada en «Más»', async ({
  browser,
}) => {
  const lista = await llamar(aula, `${BASE}/admin/tickets`, { bearer: beto.tokens.accessToken });
  expect(lista.status).toBe(403);
  expect(lista.body?.['code']).toBe('SOPORTE_SIN_PERMISO');
  const uno = await llamar(aula, `${BASE}/admin/tickets/${ticketId}`, {
    bearer: beto.tokens.accessToken,
  });
  expect(uno.status).toBe(403);
  // Control: el mismo endpoint con la creadora, 200.
  expect(
    (await llamar(aula, `${BASE}/admin/tickets`, { bearer: creadora.tokens.accessToken })).status,
  ).toBe(200);

  const { page, close } = await abrirComo(browser, aula, beto, '/admin/support');
  try {
    await expect(page.getByTestId('soporte-sin-acceso')).toBeVisible();
    await page.getByRole('button', { name: 'Más' }).click();
    await expect(page.getByRole('link', { name: 'Tickets de soporte' })).toHaveCount(0);
    // El botón «Ayuda y sugerencias» sí lo tiene: es para todos.
    await expect(boton(page)).toHaveCount(1);
  } finally {
    await close();
  }
});

test('la captura solo para su autor y el equipo (404 al resto); el tipo de imagen se comprueba', async () => {
  const ruta = `${BASE}/tickets/${ticketId}/captura`;
  expect((await llamar(aula, ruta, { bearer: ana.tokens.accessToken })).status).toBe(200);
  expect((await llamar(aula, ruta, { bearer: creadora.tokens.accessToken })).status).toBe(200);
  expect((await llamar(aula, ruta, { bearer: beto.tokens.accessToken })).status).toBe(404);

  const falsa = await llamar(aula, `${BASE}/tickets`, {
    method: 'POST',
    bearer: beto.tokens.accessToken,
    body: {
      tipo: 'FALLO',
      texto: 'Una página que dice ser PNG',
      captura: {
        data: Buffer.from('<html><script>alert(1)</script></html>').toString('base64'),
        filename: 'x.png',
        contentType: 'image/png',
      },
    },
  });
  expect(falsa.status).toBe(400);
  expect(falsa.body?.['code']).toBe('SOPORTE_CAPTURA_NO_CASA');
});

test('tope de 5 al día con envíos A LA VEZ: entran 5 y el resto 429', async () => {
  const r = await Promise.all(
    Array.from({ length: 7 }, (_, i) =>
      llamar(aula, `${BASE}/tickets`, {
        method: 'POST',
        bearer: beto.tokens.accessToken,
        body: { tipo: 'MEJORA', texto: `Sugerencia a la vez número ${i}` },
      }),
    ),
  );
  expect(r.filter((x) => x.status === 201)).toHaveLength(5);
  const no = r.filter((x) => x.status !== 201);
  expect(no).toHaveLength(2);
  for (const x of no) {
    expect(x.status).toBe(429);
    expect(x.body?.['code']).toBe('SOPORTE_LIMITE_DIARIO');
  }
});

test('apagado desde Módulos: 403 en la API y el botón no sale; al encenderlo, vuelve', async ({
  browser,
}) => {
  const interruptor = (estado: 'enable' | 'disable') =>
    apiAs(aula.host, `/api/v1/admin/modules/mod.soporte/${estado}`, {
      method: 'POST',
      bearer: creadora.tokens.accessToken,
      body: {},
    });
  await interruptor('disable');
  try {
    const alta = await llamar(aula, `${BASE}/tickets`, {
      method: 'POST',
      bearer: ana.tokens.accessToken,
      body: { tipo: 'FALLO', texto: 'Esto no debería entrar' },
    });
    expect(alta.status).toBe(403);
    const { page, close } = await abrirComo(browser, aula, ana, '/community');
    try {
      await expect(page.getByTestId('simple-shell')).toBeVisible();
      await expect(page.locator('[data-testid="soporte-abrir"]')).toHaveCount(0);
    } finally {
      await close();
    }
  } finally {
    await interruptor('enable');
  }
  // Control: encendido otra vez, el mismo alta entra (Ana aún no llegó a 5).
  const otra = await llamar(aula, `${BASE}/tickets`, {
    method: 'POST',
    bearer: ana.tokens.accessToken,
    body: { tipo: 'MEJORA', texto: 'Ahora sí debería entrar' },
  });
  expect(otra.status).toBe(201);
});

// ─── Aula en inglés (móvil) y en portugués de Brasil (escritorio) ───────────

/** Un aula en otro idioma, como la deja Cloud al aprovisionarla con `locale`. */
async function aulaEn(
  prefix: string,
  locale: 'en' | 'pt',
): Promise<{ aula: FreshTenant; creador: Auth; miembro: Auth; plataforma: boolean }> {
  const r = await aulaConCreador(prefix, true);
  await apiAs(r.aula.host, '/api/v1/admin/tenant-settings/academy', {
    method: 'PUT',
    bearer: r.creador.tokens.accessToken,
    body: { name: r.aula.slug, locale },
  });
  // Quien administra un aula de Cloud nace en su idioma (aprovisionamiento).
  await apiAs(r.aula.host, '/api/v1/me/profile', {
    method: 'PATCH',
    bearer: r.creador.tokens.accessToken,
    body: { locale: locale === 'en' ? 'en-US' : 'pt-BR' },
  });
  const miembro = await alumno(r.aula, `m-${STAMP}@${r.aula.slug}.test`, `Member ${STAMP}`);
  const plataforma = await prepararCorreo(r.aula, r.creador);
  return { ...r, miembro, plataforma };
}

test('aula en inglés, en el móvil: botón, ventana, «Your tickets», bandeja y avisos en inglés', async ({
  browser,
}) => {
  const en = await aulaEn('sopen', 'en');
  const texto = `The quiz page is blank on my phone (${STAMP})`;
  const movil = { viewport: { width: 390, height: 844 }, locale: 'en-US' };

  const m = await abrirComo(browser, en.aula, en.miembro, '/community', movil);
  try {
    await expect(boton(m.page)).toHaveAttribute('aria-label', 'Help & feedback');
    await boton(m.page).click();
    const dialogo = m.page.getByRole('dialog');
    await expect(dialogo.getByRole('heading', { name: 'Help & feedback' })).toBeVisible();
    await expect(dialogo.getByRole('radio', { name: 'I have a suggestion' })).toBeChecked();
    await dialogo.getByRole('radio', { name: 'Something is not working' }).check();
    await dialogo.getByLabel('What happened?').fill(texto);
    await dialogo.getByTestId('soporte-enviar').click();
    await expect(dialogo.getByRole('heading', { name: 'Received, thank you' })).toBeVisible();
    await dialogo.getByTestId('soporte-ver-tickets').click();
    await expect(m.page.getByRole('heading', { level: 1, name: 'Your tickets' })).toBeVisible();
    const ticket = m.page.getByTestId('soporte-ticket').filter({ hasText: texto });
    await expect(ticket.getByTestId('soporte-estado')).toHaveText('New');
    await expect(ticket.getByText('Something is not working')).toBeVisible();
    // Ni una palabra del español en la pantalla.
    await expect(m.page.locator('body')).not.toContainText(/Tus tickets|Algo no funciona|Nuevo/);
  } finally {
    await m.close();
  }

  // El operador, en español (es para él); el equipo del aula, en inglés.
  const op = await correo(OPERADOR, new RegExp(`\\[Soporte\\] ${en.aula.slug}:`), 15_000);
  expect(op.Text).toContain(texto);
  const equipo = await correo(en.aula.creatorEmail, /^Support ticket: /);
  expect(equipo.Subject).toBe(
    `Support ticket: Member ${STAMP} reports that something is not working`,
  );
  expect(equipo.Text).toContain('opened a ticket in "Help & feedback"');

  const id = (
    await apiAs<Array<{ id: string; texto: string }>>(en.aula.host, `${BASE}/tickets/mios`, {
      bearer: en.miembro.tokens.accessToken,
    })
  ).find((t) => t.texto === texto)!.id;
  const a = await abrirComo(browser, en.aula, en.creador, `/admin/support?ticket=${id}`, movil);
  try {
    await expect(a.page.getByRole('heading', { level: 1, name: 'Support tickets' })).toBeVisible();
    const detalle = a.page.getByTestId('soporte-admin-detalle');
    await expect(detalle.getByText('Only the team sees it')).toBeVisible();
    await detalle.getByTestId('soporte-admin-estado').selectOption('RESUELTO');
    await detalle.getByTestId('soporte-admin-guardar').click();
    await expect(detalle.getByTestId('soporte-admin-guardado')).toHaveText('Saved.');
  } finally {
    await a.close();
  }
  const aviso = await correo(en.miembro.user.email, /^Your support ticket is resolved$/);
  expect(aviso.Text).toContain('is now "Resolved"');
});

test('aula en portugués de Brasil: ventana, «Seus tickets» y aviso al equipo en portugués', async ({
  browser,
}) => {
  const pt = await aulaEn('soppt', 'pt');
  const texto = `Não consigo baixar o certificado (${STAMP})`;
  const m = await abrirComo(browser, pt.aula, pt.miembro, '/community', { locale: 'pt-BR' });
  try {
    await expect(boton(m.page)).toHaveAttribute('aria-label', 'Ajuda e sugestões');
    await boton(m.page).click();
    const dialogo = m.page.getByRole('dialog');
    await expect(dialogo.getByRole('radio', { name: 'Tenho uma sugestão' })).toBeChecked();
    await expect(dialogo.getByLabel('O que você melhoraria na escola?')).toBeVisible();
    await dialogo.getByRole('radio', { name: 'Estou com um problema' }).check();
    await dialogo.getByLabel('O que aconteceu?').fill(texto);
    await dialogo.getByTestId('soporte-enviar').click();
    await expect(dialogo.getByRole('heading', { name: 'Recebido, obrigado' })).toBeVisible();
    await dialogo.getByTestId('soporte-ver-tickets').click();
    await expect(m.page.getByRole('heading', { level: 1, name: 'Seus tickets' })).toBeVisible();
    const ticket = m.page.getByTestId('soporte-ticket').filter({ hasText: texto });
    await expect(ticket.getByTestId('soporte-estado')).toHaveText('Novo');
  } finally {
    await m.close();
  }
  const equipo = await correo(pt.aula.creatorEmail, /^Ticket de suporte: /);
  expect(equipo.Subject).toBe(`Ticket de suporte: Member ${STAMP} está com um problema`);
  expect(equipo.Text).toContain('abriu um ticket em "Ajuda e sugestões"');
});
