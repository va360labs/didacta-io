/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { injectSession } from '../helpers/auth';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';

/**
 * Mensajes automáticos y miembros en riesgo (mod.retention) en un aula NUEVA
 * en modo sencillo, de punta a punta y por la UI:
 *
 *  1. Ajustes → «Mensajes automáticos»: la bienvenida se activa con un clic, se
 *     edita con vista previa (datos reales) y se le enciende la copia por
 *     correo. Una alumna que se da de alta recibe el mensaje directo firmado
 *     por quien administra, y el correo llega al buzón local (Mailpit). El
 *     barrido repetido NO lo duplica.
 *  2. Recuperación con inactividad SIMULADA (fechas movidas en la base): la
 *     alumna que cruza los 14 días recibe el mensaje; la que lleva meses sin
 *     entrar desde antes de activarlo, no (no hay envío masivo hacia atrás).
 *  3. Miembros en riesgo desde «Alumnos»: el motivo real, «Añadir a
 *     recuperación» y «Escribir» (mensaje directo con plantilla).
 *  4. Aislamiento: otra aula no ve nada de esta ni escribe a sus miembros.
 *
 * El correo se comprueba en Mailpit si `E2E_MAILPIT_URL` está definido (el
 * stack local lo tiene); si no, en la fila de `notification` que deja el hub.
 */

interface Auth {
  tokens: { accessToken: string; refreshToken: string };
  user: {
    id: string;
    email: string;
    name: string | null;
    tenantId: string;
    tenantSlug: string;
    roles: string[];
    mfaEnabled: boolean;
  };
}

interface Conversation {
  id: string | null;
  type: string;
  counterpart: { id: string; name: string | null } | null;
  lastMessage: { body: string; authorId: string } | null;
}

const PASSWORD = 'E2eTestPassword123!';
const MAILPIT = process.env.E2E_MAILPIT_URL;
const DAY = 24 * 3600 * 1000;

let aula: FreshTenant;
let creadora: Auth;
let stamp: string;

/** Una zona IANA donde ahora mismo es mediodía: el mensaje no espera a «su» mañana. */
function zonaDeDia(): string {
  const offset = 12 - new Date().getUTCHours();
  if (offset === 0) return 'Atlantic/Reykjavik';
  return `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
}

async function signinAs(t: FreshTenant, email: string, password: string): Promise<Auth> {
  return apiAs<Auth>(t.host, '/api/v1/auth/signin', {
    method: 'POST',
    body: { tenantSlug: t.slug, email, password },
  });
}

async function alumna(t: FreshTenant, key: string, name: string): Promise<Auth> {
  const a = await apiAs<Auth>(t.host, '/api/v1/auth/signup', {
    method: 'POST',
    body: { tenantSlug: t.slug, email: `${key}-${stamp}@example.com`, password: PASSWORD, name },
  });
  await apiAs(t.host, '/api/v1/me/profile', {
    method: 'PATCH',
    bearer: a.tokens.accessToken,
    body: { timezone: zonaDeDia() },
  });
  await apiAs(t.host, '/api/v1/me/onboarding/complete', {
    method: 'POST',
    bearer: a.tokens.accessToken,
    body: {},
  }).catch(() => undefined);
  return a;
}

function barrido(t: FreshTenant, auth: Auth) {
  return apiAs<{ sent: number; postponed: number; skipped: number }>(
    t.host,
    '/api/v1/modules/retention/admin/run',
    { method: 'POST', bearer: auth.tokens.accessToken, body: {} },
  );
}

async function abrir(
  browser: Browser,
  t: FreshTenant,
  auth: Auth,
  path: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${t.base}/signin`);
  await injectSession(page, {
    accessToken: auth.tokens.accessToken,
    refreshToken: auth.tokens.refreshToken,
    user: { ...auth.user, onboardingCompletedAt: new Date().toISOString() },
  });
  await page.goto(`${t.base}${path}`);
  return { page, close: () => ctx.close() };
}

async function directosDe(t: FreshTenant, auth: Auth): Promise<Conversation[]> {
  const res = await apiAs<{ conversations: Conversation[] }>(
    t.host,
    '/api/v1/modules/messaging/conversations',
    { bearer: auth.tokens.accessToken },
  );
  return res.conversations.filter((c) => c.type === 'DM');
}

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

async function correoPara(email: string): Promise<{ subject: string; text: string } | null> {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
  const body = (await res.json()) as { messages: MailpitMessage[] };
  const m = body.messages[0];
  if (!m) return null;
  const full = (await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()) as {
    Subject: string;
    Text: string;
  };
  return { subject: full.Subject, text: full.Text };
}

test.describe.configure({ mode: 'serial' });

test.describe('mensajes automáticos y miembros en riesgo (modo sencillo)', () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    stamp = Date.now().toString(36);
    aula = await freshTenant(`mensajes${stamp}`, true);
    // La creadora del aula (tenant_admin) entra por su enlace de «define tu
    // contraseña», como en Didacta Cloud: es quien firma los mensajes.
    const resetToken = new URL(aula.setPasswordUrl).searchParams.get('token')!;
    await apiAs(aula.host, '/api/v1/auth/reset-password', {
      method: 'POST',
      body: { token: resetToken, newPassword: aula.password },
    });
    creadora = await signinAs(aula, aula.creatorEmail, aula.password);
    const T = creadora.tokens.accessToken;
    await apiAs(aula.host, '/api/v1/admin/simple-mode/quick-start', {
      method: 'POST',
      bearer: T,
      body: {
        academyName: `Primer Sorbo ${stamp}`,
        offer: 'course',
        title: 'Cata de café desde cero',
        amountCents: 3500,
        currency: 'eur',
        locale: 'es',
      },
    });
    await apiAs(aula.host, '/api/v1/me/profile', {
      method: 'PATCH',
      bearer: T,
      body: { name: 'Clara Ruiz' },
    });
    await apiAs(aula.host, '/api/v1/me/onboarding/complete', {
      method: 'POST',
      bearer: T,
      body: {},
    }).catch(() => undefined);
  });

  test('bienvenida: se activa con un clic, llega como mensaje directo y por correo, y no se repite', async ({
    browser,
  }) => {
    const { page, close } = await abrir(browser, aula, creadora, '/admin/settings');
    const seccion = page.getByTestId('mensajes-automaticos');
    await expect(seccion).toBeVisible({ timeout: 30_000 });
    await expect(seccion.getByText('Los firma Clara Ruiz')).toBeVisible();

    // Un clic en la plantilla y queda activa en la lista.
    await seccion.getByTestId('plantilla-welcome').getByRole('button', { name: 'Activar' }).click();
    const fila = seccion.getByTestId('mensaje-welcome');
    await expect(fila).toBeVisible();
    await expect(fila.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await expect(seccion.getByTestId('plantilla-welcome')).toHaveCount(0);

    // Editar: vista previa con los datos de quien mira y copia por correo.
    await fila.getByRole('button', { name: 'Editar' }).click();
    const editor = seccion.getByTestId('editor-mensaje');
    await expect(editor.getByTestId('vista-previa')).toContainText('Así lo vería Clara Ruiz', {
      timeout: 15_000,
    });
    await expect(editor.getByTestId('vista-previa')).toContainText(
      `¡Hola, Clara! Te doy la bienvenida a Primer Sorbo ${stamp}`,
    );
    await expect(editor.getByTestId('vista-previa')).not.toContainText('{nombre}');
    // Una variable que no existe no se guarda.
    const texto = editor.getByLabel('Mensaje');
    const original = await texto.inputValue();
    await texto.fill(`${original}\n{fecha}`);
    await expect(editor.getByTestId('vista-previa')).toContainText('Variable desconocida: {fecha}');
    await texto.fill(original);
    await editor.getByRole('switch', { name: 'Enviar también por correo' }).click();
    await editor.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(fila.getByText('También por correo')).toBeVisible();
    await close();

    // Una alumna se da de alta y el barrido le escribe. (El barrido programado
    // de cada 5 minutos puede adelantarse al manual: se mira el resultado, no
    // quién lo hizo.)
    const ana = await alumna(aula, 'ana', 'Ana Pérez');
    await barrido(aula, creadora);
    const dms = await directosDe(aula, ana);
    expect(dms).toHaveLength(1);
    expect(dms[0]!.counterpart?.name).toBe('Clara Ruiz');
    expect(dms[0]!.lastMessage?.authorId).toBe(creadora.user.id);
    expect(dms[0]!.lastMessage?.body).toContain(
      `¡Hola, Ana! Te doy la bienvenida a Primer Sorbo ${stamp}`,
    );
    expect(dms[0]!.lastMessage?.body).toMatch(/\/(spaces\/general|community)/);
    expect(dms[0]!.lastMessage?.body).not.toMatch(/\{[a-z_]+\}/);

    // Lo ve en su bandeja, en el aula.
    const vista = await abrir(browser, aula, ana, '/messages');
    await expect(
      vista.page.getByText('Te doy la bienvenida a', { exact: false }).first(),
    ).toBeVisible({
      timeout: 30_000,
    });
    await vista.close();

    // El correo: en el buzón local, con el asunto y la baja.
    if (MAILPIT) {
      await expect
        .poll(async () => (await correoPara(ana.user.email))?.subject ?? null, { timeout: 30_000 })
        .toBe(`Te doy la bienvenida a Primer Sorbo ${stamp}`);
      const correo = (await correoPara(ana.user.email))!;
      expect(correo.text).toContain('¡Hola, Ana!');
      expect(correo.text).toContain('/api/v1/modules/community/unsubscribe?token=');
    } else {
      expect(
        sql(
          `SELECT count(*) FROM notification WHERE user_id='${ana.user.id}' AND template_key='retention.message'`,
        ),
      ).toBe('1');
    }

    // Idempotente: otro barrido no le vuelve a escribir.
    await barrido(aula, creadora);
    const mensajes = () =>
      sql(
        `SELECT count(*) FROM mod_messaging_message WHERE tenant_id='${creadora.user.tenantId}' AND author_id='${creadora.user.id}' AND body LIKE '%Hola, Ana!%'`,
      );
    expect(mensajes()).toBe('1');
    expect(
      sql(
        `SELECT status FROM mod_retention_delivery WHERE user_id='${ana.user.id}' AND occurrence_key='join'`,
      ),
    ).toBe('SENT');
  });

  test('recuperación con inactividad simulada: a quien cruza el umbral, no a los dormidos de antes', async () => {
    // Se apaga la bienvenida: así las altas de prueba de aquí en adelante no
    // reciben otra cosa (y el barrido programado no se adelanta con ella).
    const lista = await apiAs<{ automations: Array<{ id: string; templateKey: string | null }> }>(
      aula.host,
      '/api/v1/modules/retention/admin/automations',
      { bearer: creadora.tokens.accessToken },
    );
    const bienvenida = lista.automations.find((a) => a.templateKey === 'welcome')!;
    await apiAs(aula.host, `/api/v1/modules/retention/admin/automations/${bienvenida.id}`, {
      method: 'PATCH',
      bearer: creadora.tokens.accessToken,
      body: { enabled: false },
    });
    const act = await apiAs<{ automation: { id: string } }>(
      aula.host,
      '/api/v1/modules/retention/admin/templates/come_back/activate',
      { method: 'POST', bearer: creadora.tokens.accessToken, body: {} },
    );
    const bruno = await alumna(aula, 'bruno', 'Bruno Gil');
    const dormida = await alumna(aula, 'dormida', 'Dora Mar');
    // Simulación del paso del tiempo: el mensaje lleva activo 10 días; Bruno
    // dejó de entrar hace 20 (cruzó los 14 hace 6, ya con el mensaje activo);
    // Dora lleva 90 (cruzó los 14 mucho antes de activarlo).
    sql(
      `UPDATE mod_retention_automation SET activated_at = now() - interval '10 days' WHERE id='${act.automation.id}'`,
    );
    sql(
      `UPDATE "user" SET created_at = now() - interval '60 days', last_login_at = now() - interval '20 days', last_seen_at = now() - interval '20 days' WHERE id='${bruno.user.id}'`,
    );
    sql(
      `UPDATE "user" SET created_at = now() - interval '200 days', last_login_at = now() - interval '90 days', last_seen_at = now() - interval '90 days' WHERE id='${dormida.user.id}'`,
    );
    await barrido(aula, creadora);
    const aBruno = await directosDe(aula, bruno);
    expect(aBruno).toHaveLength(1);
    expect(aBruno[0]!.lastMessage?.body).toContain('Hola, Bruno. Hace unos días que no te veo');
    expect(await directosDe(aula, dormida)).toHaveLength(0);
  });

  test('miembros en riesgo: motivo real, «Añadir a recuperación» y «Escribir»', async ({
    browser,
  }) => {
    const carla = await alumna(aula, 'carla', 'Carla Sol');
    sql(
      `UPDATE "user" SET created_at = now() - interval '45 days', last_login_at = now() - interval '30 days', last_seen_at = now() - interval '30 days' WHERE id='${carla.user.id}'`,
    );
    const { page, close } = await abrir(browser, aula, creadora, '/admin/users');
    const tarjeta = page.getByTestId('enlace-riesgo');
    await expect(tarjeta).toContainText('Miembros en riesgo', { timeout: 30_000 });
    await tarjeta.click();
    await expect(page).toHaveURL(/\/admin\/users\/at-risk$/);
    const panel = page.getByTestId('miembros-en-riesgo');
    const filaCarla = panel.getByTestId(`riesgo-${carla.user.email}`);
    await expect(filaCarla).toContainText('Lleva 30 días sin entrar');
    // La dormida también está; quien administra, nunca.
    await expect(panel.getByTestId(`riesgo-dormida-${stamp}@example.com`)).toContainText(
      'Lleva 90 días sin entrar',
    );
    await expect(panel.getByTestId(`riesgo-${creadora.user.email}`)).toHaveCount(0);

    // Filtro por motivo: «A medias» no la incluye.
    await panel.getByTestId('filtro-stalled').click();
    await expect(filaCarla).toHaveCount(0);
    await panel.getByTestId('filtro-todos').click();

    // Añadir a recuperación → se pone en cola con las reglas de siempre.
    await filaCarla.getByRole('button', { name: 'Añadir a recuperación' }).click();
    await expect(panel.getByRole('status')).toContainText(
      'Carla Sol recibirá el mensaje de recuperación',
    );
    await expect(filaCarla).toContainText('En recuperación');
    await barrido(aula, creadora);
    expect((await directosDe(aula, carla))[0]!.lastMessage?.body).toContain('Hola, Carla.');

    // «Escribir» a la dormida: mensaje directo con plantilla, editable.
    const filaDora = panel.getByTestId(`riesgo-dormida-${stamp}@example.com`);
    await filaDora.getByRole('button', { name: 'Escribir' }).click();
    const dialogo = page.getByTestId('escribir-dialogo');
    const cuerpo = dialogo.getByLabel('Mensaje');
    await expect(cuerpo).toHaveValue(/Hola, Dora\./, { timeout: 15_000 });
    await cuerpo.fill('Hola, Dora. ¿Te apetece retomar la cata esta semana? Te guardo sitio.');
    await dialogo.getByRole('button', { name: 'Enviar mensaje' }).click();
    await expect(panel.getByRole('status')).toContainText('Mensaje enviado a Dora Mar');
    await close();
    const dora = await signinAs(aula, `dormida-${stamp}@example.com`, PASSWORD);
    expect((await directosDe(aula, dora))[0]!.lastMessage?.body).toContain('Te guardo sitio');
  });

  test('otra aula no ve nada de esta ni escribe a sus miembros', async () => {
    const otra = await freshTenant(`mensajesotra${stamp}`, true);
    const op2 = await signinAs(otra, `operador@${otra.slug}.test`, otra.password);
    const lista = await apiAs<{ automations: unknown[] }>(
      otra.host,
      '/api/v1/modules/retention/admin/automations',
      { bearer: op2.tokens.accessToken },
    );
    expect(lista.automations).toEqual([]);
    const riesgo = await apiAs<{ rows: Array<{ email: string }> }>(
      otra.host,
      '/api/v1/modules/retention/admin/at-risk',
      { bearer: op2.tokens.accessToken },
    );
    expect(riesgo.rows.some((r) => r.email.includes(stamp) && !r.email.includes('otra'))).toBe(
      false,
    );
    await apiAs(otra.host, '/api/v1/modules/retention/admin/templates/welcome/activate', {
      method: 'POST',
      bearer: op2.tokens.accessToken,
      body: {},
    });
    const antes = Number(
      sql(
        `SELECT count(*) FROM mod_retention_delivery WHERE tenant_id='${creadora.user.tenantId}'`,
      ),
    );
    await barrido(otra, op2);
    expect(
      Number(
        sql(
          `SELECT count(*) FROM mod_retention_delivery WHERE tenant_id='${creadora.user.tenantId}'`,
        ),
      ),
    ).toBe(antes);
    // Un alumno no puede tocar los mensajes del aula.
    const ana = await signinAs(aula, `ana-${stamp}@example.com`, PASSWORD);
    await expect(
      apiAs(aula.host, '/api/v1/modules/retention/admin/automations', {
        bearer: ana.tokens.accessToken,
      }),
    ).rejects.toThrow(/403/);
  });
});
