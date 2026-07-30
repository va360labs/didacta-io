import { expect, test, type Page } from '@playwright/test';
import { API_URL, signup } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * E2E del chat flotante (PRD `chat-flotante`):
 *  1. La píldora sustituye al icono del header y vive en todas las páginas.
 *  2. Con datos reales: cara del último autor y frase con la conversación.
 *  3. «Está escribiendo» en vivo (ADR-019) y su expiración.
 *  4. Presencia real en el panel.
 *  5. Responder desde el panel sin abandonar la página.
 *  6. Persistencia del panel abierto entre navegaciones y recargas.
 *  7. Móvil: píldora colapsada sin tapar el tab bar y panel a pantalla completa.
 *
 * Requiere API con REDIS_URL (sin Redis el realtime degrada a polling de 60 s y
 * presencia/typing no llegan) y el seed del tenant va360.
 */

const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';

type E2eUser = Awaited<ReturnType<typeof signup>>;

/** Llamada autenticada a la API de mensajería (montar hilos sin pasar por la UI). */
async function messagingApi<T>(
  user: E2eUser,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${API_URL}/api/v1/modules/messaging${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user.tokens.accessToken}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

function openDm(user: E2eUser, userId: string) {
  return messagingApi<{ conversationId: string }>(user, '/dm', { userId });
}

function sendMessage(user: E2eUser, conversationId: string, body: string) {
  return messagingApi(user, `/conversations/${conversationId}/messages`, { body });
}

async function signInAs(page: Page, user: E2eUser, path = '/comunidad') {
  await page.goto('/signin');
  await injectSession(page, {
    accessToken: user.tokens.accessToken,
    user: { ...user.user, onboardingCompletedAt: new Date().toISOString() },
  });
  await page.goto(path);
}

test.describe('chat flotante', () => {
  test('la píldora sustituye al icono del header y acompaña en toda el aula', async ({ page }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    const user = await signup({
      tenantSlug,
      email: `e2e-pill-${stamp}@example.test`,
      password: 'E2ePill123!aa',
      name: `E2E Pildora ${stamp}`,
    });

    await signInAs(page, user);
    await expect(page.getByTestId('chat-pill')).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByTestId('messages-header-link'),
      'el icono de mensajes del header ya no existe',
    ).toHaveCount(0);

    // Sigue presente en otra sección del shell.
    await page.goto('/cursos');
    await expect(page.getByTestId('chat-pill')).toBeVisible({ timeout: 20_000 });
  });

  test('píldora con cara real y frase concreta; el panel abre la lista', async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    const userA = await signup({
      tenantSlug,
      email: `e2e-fc-a-${stamp}@example.test`,
      password: 'E2eFcA123!aa',
      name: `E2E Flotante A ${stamp}`,
    });
    const userB = await signup({
      tenantSlug,
      email: `e2e-fc-b-${stamp}@example.test`,
      password: 'E2eFcB123!aa',
      name: `E2E Flotante B ${stamp}`,
    });

    // A abre un DM con B desde /mensajes y escribe.
    await signInAs(page, userA, '/mensajes');
    await expect(page.getByTestId('mensajes-page')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('new-dm-button').click();
    await page.getByTestId('new-dm-search').fill(`E2E Flotante B ${stamp}`);
    const memberRow = page.getByTestId('new-dm-member').first();
    await expect(memberRow).toBeVisible({ timeout: 20_000 });
    await memberRow.click();

    const hola = `Hola B, soy A (${stamp})`;
    await page.getByTestId('chat-composer-input').first().fill(hola);
    await page.getByTestId('chat-send').first().click();
    await expect(page.getByTestId('chat-messages')).toContainText(hola, { timeout: 20_000 });

    // B entra en una página cualquiera del aula: la píldora ya le cuenta qué pasa.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signInAs(pageB, userB);

    const pill = pageB.getByTestId('chat-pill');
    await expect(pill).toBeVisible({ timeout: 20_000 });
    await expect(pill, 'la frase nombra la conversación, no un número').toContainText(
      '1 mensaje nuevo de',
      { timeout: 25_000 },
    );
    await expect(pill).toContainText(`E2E Flotante A ${stamp}`, { timeout: 25_000 });
    await expect(
      pill.getByTestId('chat-pill-avatar').first(),
      'la cara del último autor es real, no un marcador',
    ).toBeVisible();

    // Al desplegar, la misma lista agrupada de /mensajes.
    await pill.click();
    const panel = pageB.getByTestId('chat-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('conversation-item-dm').first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(panel.getByTestId('chat-panel-see-all')).toBeVisible();

    await ctxB.close();
  });

  test('«está escribiendo» llega en vivo y expira solo', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    const userA = await signup({
      tenantSlug,
      email: `e2e-typ-a-${stamp}@example.test`,
      password: 'E2eTypA123!aa',
      name: `E2E Typing A ${stamp}`,
    });
    const userB = await signup({
      tenantSlug,
      email: `e2e-typ-b-${stamp}@example.test`,
      password: 'E2eTypB123!aa',
      name: `E2E Typing B ${stamp}`,
    });

    await signInAs(page, userA, '/mensajes');
    await page.getByTestId('new-dm-button').click();
    await page.getByTestId('new-dm-search').fill(`E2E Typing B ${stamp}`);
    await page.getByTestId('new-dm-member').first().click();
    const primero = `Primer mensaje ${stamp}`;
    await page.getByTestId('chat-composer-input').first().fill(primero);
    await page.getByTestId('chat-send').first().click();
    await expect(page.getByTestId('chat-messages')).toContainText(primero, { timeout: 20_000 });

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signInAs(pageB, userB);
    const pill = pageB.getByTestId('chat-pill');
    await expect(pill).toContainText('1 mensaje nuevo', { timeout: 25_000 });

    // El composer acelera los avisos a uno cada TYPING_THROTTLE_MS (3 s, ADR-019)
    // y A ya gastó el suyo al escribir el primer mensaje. Sin esta espera, la
    // siguiente pulsación se traga el aviso y el test falla por diseño, no por bug.
    await page.waitForTimeout(3_200);

    // A teclea (sin enviar): B lo ve en su píldora.
    await page.getByTestId('chat-composer-input').first().fill('estoy escribiendo…');
    await expect(pill, 'la píldora anuncia quién escribe, no un contador').toContainText(
      `${`E2E Typing A ${stamp}`} te escribe`,
      { timeout: 20_000 },
    );

    // Sin más actividad, la señal caduca sola y vuelve el resumen de no-leídos.
    await expect(pill, 'el indicador expira sin evento de "ha parado"').not.toContainText(
      'te escribe',
      { timeout: 30_000 },
    );

    await ctxB.close();
  });

  test('presencia real en el panel', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    const userA = await signup({
      tenantSlug,
      email: `e2e-pres-a-${stamp}@example.test`,
      password: 'E2ePresA123!aa',
      name: `E2E Presencia A ${stamp}`,
    });
    const userB = await signup({
      tenantSlug,
      email: `e2e-pres-b-${stamp}@example.test`,
      password: 'E2ePresB123!aa',
      name: `E2E Presencia B ${stamp}`,
    });

    await signInAs(page, userA);
    await expect(page.getByTestId('chat-pill')).toBeVisible({ timeout: 20_000 });

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signInAs(pageB, userB);
    await pageB.getByTestId('chat-pill').click();

    const panel = pageB.getByTestId('chat-panel');
    await expect(panel, 'el panel cuenta a los demás conectados, no a uno mismo').toContainText(
      /person(a|as) activ(a|as) ahora/,
      { timeout: 25_000 },
    );

    await ctxB.close();
  });

  test('se responde desde el panel sin abandonar la página', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    const userA = await signup({
      tenantSlug,
      email: `e2e-resp-a-${stamp}@example.test`,
      password: 'E2eRespA123!aa',
      name: `E2E Responde A ${stamp}`,
    });
    const userB = await signup({
      tenantSlug,
      email: `e2e-resp-b-${stamp}@example.test`,
      password: 'E2eRespB123!aa',
      name: `E2E Responde B ${stamp}`,
    });

    await signInAs(page, userA, '/mensajes');
    await page.getByTestId('new-dm-button').click();
    await page.getByTestId('new-dm-search').fill(`E2E Responde B ${stamp}`);
    await page.getByTestId('new-dm-member').first().click();
    const pregunta = `¿Me lees? (${stamp})`;
    await page.getByTestId('chat-composer-input').first().fill(pregunta);
    await page.getByTestId('chat-send').first().click();
    await expect(page.getByTestId('chat-messages')).toContainText(pregunta, { timeout: 20_000 });

    // B está estudiando: abre el catálogo y contesta desde el panel.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signInAs(pageB, userB, '/cursos');
    const urlAntes = pageB.url();

    await pageB.getByTestId('chat-pill').click();
    const panel = pageB.getByTestId('chat-panel');
    const dmRow = panel.getByTestId('conversation-item-dm').first();
    await expect(dmRow).toBeVisible({ timeout: 25_000 });
    await dmRow.click();

    await expect(panel.getByTestId('chat-panel-messages')).toContainText(pregunta, {
      timeout: 20_000,
    });
    const respuesta = `Te leo perfectamente (${stamp})`;
    await panel.getByTestId('chat-composer-input').fill(respuesta);
    await panel.getByTestId('chat-send').click();

    await expect(
      page.getByTestId('chat-messages'),
      'la respuesta llega a A sin recargar',
    ).toContainText(respuesta, { timeout: 25_000 });
    expect(pageB.url(), 'B sigue en la misma página').toBe(urlAntes);

    await ctxB.close();
  });

  test('al reabrir el chat, la conversación aparece por el último mensaje', async ({ page }) => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    const userA = await signup({
      tenantSlug,
      email: `e2e-scr-a-${stamp}@example.test`,
      password: 'E2eScrA123!aa',
      name: `E2E Scroll A ${stamp}`,
    });
    const userB = await signup({
      tenantSlug,
      email: `e2e-scr-b-${stamp}@example.test`,
      password: 'E2eScrB123!aa',
      name: `E2E Scroll B ${stamp}`,
    });

    // Hilo largo: sin desbordar el contenedor no hay scroll que comprobar.
    const { conversationId } = await openDm(userA, userB.user.id);
    for (let i = 1; i <= 14; i += 1) {
      await sendMessage(userA, conversationId, `Mensaje ${i} del hilo largo ${stamp}`);
    }

    await signInAs(page, userB);
    await page.getByTestId('chat-pill').click();
    const panel = page.getByTestId('chat-panel');
    await panel.getByTestId('conversation-item-dm').first().click();
    const messages = panel.getByTestId('chat-panel-messages');
    await expect(messages).toContainText(`Mensaje 14 del hilo largo ${stamp}`, { timeout: 25_000 });

    const atBottom = async () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="chat-panel-messages"]');
        if (!el) return null;
        return {
          scrollable: el.scrollHeight > el.clientHeight + 20,
          distanceFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
        };
      });

    const initial = await atBottom();
    expect(initial?.scrollable, 'el hilo desborda, así que hay scroll real que comprobar').toBe(
      true,
    );

    // Plegar y volver a abrir: el contenedor se desmonta y renace en scrollTop 0
    // (el mensaje MÁS ANTIGUO) si nadie lo corrige.
    await page.getByTestId('chat-pill').click();
    await expect(panel).toHaveCount(0);
    await page.getByTestId('chat-pill').click();
    await expect(messages).toBeVisible();
    await page.waitForTimeout(600);

    const reopened = await atBottom();
    expect(
      reopened?.distanceFromBottom ?? 999,
      'al reabrir se ve el último mensaje, no el más antiguo',
    ).toBeLessThan(40);
    await expect(messages).toContainText(`Mensaje 14 del hilo largo ${stamp}`);
  });

  test('con el chat plegado, un mensaje nuevo avisa con toast y burbuja roja', async ({ page }) => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    const userA = await signup({
      tenantSlug,
      email: `e2e-avi-a-${stamp}@example.test`,
      password: 'E2eAviA123!aa',
      name: `E2E Aviso A ${stamp}`,
    });
    const userB = await signup({
      tenantSlug,
      email: `e2e-avi-b-${stamp}@example.test`,
      password: 'E2eAviB123!aa',
      name: `E2E Aviso B ${stamp}`,
    });
    const { conversationId } = await openDm(userA, userB.user.id);

    // B entra y deja el chat plegado (estado por defecto). Hay que esperar a que
    // su stream SSE esté abierto: el aviso es push, así que un mensaje enviado
    // antes de conectar no lo puede recibir nadie (el no-leído sí lo recoge la
    // carga inicial de la lista).
    const streamUp = page.waitForResponse(
      (r) => r.url().includes('/modules/messaging/stream'),
      { timeout: 40_000 },
    );
    await signInAs(page, userB);
    await expect(page.getByTestId('chat-pill')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('chat-panel')).toHaveCount(0);
    await streamUp;
    // La respuesta del SSE llega con las cabeceras; el EventSource del
    // navegador aún tiene que asentarse antes de que el push le encuentre.
    await page.waitForTimeout(1_500);

    const aviso = `Te escribo con el chat cerrado ${stamp}`;
    await sendMessage(userA, conversationId, aviso);

    const toast = page.getByTestId('chat-toast');
    await expect(toast, 'el aviso aparece sin abrir nada').toBeVisible({ timeout: 25_000 });
    await expect(toast).toContainText(`E2E Aviso A ${stamp}`);
    await expect(toast).toContainText(aviso);
    await expect(
      page.getByTestId('chat-pill').getByTestId('chat-pill-unread'),
      'y la píldora marca el no-leído en rojo',
    ).toHaveText('1');

    // Pulsar el aviso abre esa conversación en el panel.
    await page.getByTestId('chat-toast-open').first().click();
    const panel = page.getByTestId('chat-panel');
    await expect(panel.getByTestId('chat-panel-messages')).toContainText(aviso, {
      timeout: 20_000,
    });
    await expect(page.getByTestId('chat-toast')).toHaveCount(0);

    // El aviso sonoro se puede silenciar desde la propia cabecera.
    await panel.getByTestId('chat-panel-back').click();
    const soundToggle = panel.getByTestId('chat-sound-toggle');
    await expect(soundToggle).toHaveAttribute('aria-pressed', 'true');
    await soundToggle.click();
    await expect(soundToggle).toHaveAttribute('aria-pressed', 'false');
    await page.reload();
    await page.getByTestId('chat-pill').waitFor({ timeout: 25_000 });
    await expect(
      page.getByTestId('chat-sound-toggle'),
      'la preferencia sobrevive a la recarga',
    ).toHaveAttribute('aria-pressed', 'false');
  });

  test('el panel abierto sobrevive a navegar y recargar', async ({ page }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    const user = await signup({
      tenantSlug,
      email: `e2e-persist-${stamp}@example.test`,
      password: 'E2ePersist123!aa',
      name: `E2E Persiste ${stamp}`,
    });

    await signInAs(page, user);
    await page.getByTestId('chat-pill').click();
    await expect(page.getByTestId('chat-panel')).toBeVisible();

    await page.goto('/cursos');
    await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 20_000 });

    await page.reload();
    await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 20_000 });

    // Y se cierra con Esc, devolviendo el foco a la píldora.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('chat-panel')).toHaveCount(0);
  });

  test('móvil: píldora colapsada sobre el tab bar y panel a pantalla completa', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    const user = await signup({
      tenantSlug,
      email: `e2e-mob-${stamp}@example.test`,
      password: 'E2eMob123!aa',
      name: `E2E Movil ${stamp}`,
    });

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await signInAs(page, user);

    const pill = page.getByTestId('chat-pill');
    await expect(pill).toBeVisible({ timeout: 20_000 });

    // La píldora no se come el tab bar: su caja queda por encima de él.
    const tabBar = page.getByRole('navigation', { name: 'Navegación principal' });
    const pillBox = await pill.boundingBox();
    const tabBox = await tabBar.boundingBox();
    expect(pillBox && tabBox).toBeTruthy();
    expect(
      (pillBox?.y ?? 0) + (pillBox?.height ?? 0),
      'la píldora termina antes de donde empieza el tab bar',
    ).toBeLessThanOrEqual((tabBox?.y ?? 0) + 1);

    // Al abrir, el panel ocupa la pantalla.
    await pill.click();
    const panel = page.getByTestId('chat-panel');
    await expect(panel).toBeVisible();
    const panelBox = await panel.boundingBox();
    expect(panelBox?.width).toBeGreaterThanOrEqual(380);
    expect(panelBox?.height).toBeGreaterThanOrEqual(800);

    await ctx.close();
  });
});
