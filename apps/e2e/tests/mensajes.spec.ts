import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, signup } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * E2E de mod.messaging (US-M1..M3 del PRD `mensajes`):
 *  1. DM entre dos miembros con entrega en tiempo real (SSE) en ambos sentidos.
 *  2. Sala de un espacio de la comunidad: materialización lazy + histórico
 *     visible para otro miembro.
 *  3. Canal alumno↔profesores: auto-provisión para el alumno, bandeja de
 *     consultas para el staff y respuesta del profesor en tiempo real.
 *
 * Requiere API con REDIS_URL (el realtime degrada a polling sin Redis y los
 * asserts "sin recargar" fallarían) y el seed del tenant demo.
 */

const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';

test.describe('mod.messaging · mensajes', () => {
  test('DM en tiempo real entre dos miembros', async ({ page, browser }) => {
    test.setTimeout(150_000);
    const stamp = Date.now();

    const userA = await signup({
      tenantSlug,
      email: `e2e-msg-a-${stamp}@example.test`,
      password: 'E2eMsgA123!aa',
      name: `E2E Emisor ${stamp}`,
    });
    const userB = await signup({
      tenantSlug,
      email: `e2e-msg-b-${stamp}@example.test`,
      password: 'E2eMsgB123!aa',
      name: `E2E Receptor ${stamp}`,
    });

    await page.goto('/signin');
    await injectSession(page, {
      accessToken: userA.tokens.accessToken,
      user: { ...userA.user, onboardingCompletedAt: new Date().toISOString() },
    });
    await page.goto('/mensajes');
    await expect(page.getByTestId('mensajes-page')).toBeVisible({ timeout: 15_000 });

    // A abre un DM con B desde el buscador de miembros.
    await page.getByTestId('new-dm-button').click();
    await page.getByTestId('new-dm-search').fill(`E2E Receptor ${stamp}`);
    const memberRow = page.getByTestId('new-dm-member').first();
    await expect(memberRow, 'la búsqueda server-side encuentra a B').toBeVisible({
      timeout: 15_000,
    });
    await memberRow.click();
    await expect(page.getByTestId('chat-title')).toHaveText(`E2E Receptor ${stamp}`, {
      timeout: 15_000,
    });

    const helloText = `Hola B, soy A (${stamp})`;
    await page.getByTestId('chat-composer-input').fill(helloText);
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-messages')).toContainText(helloText, { timeout: 15_000 });

    // B entra en otro contexto: ve el DM con no-leídos y el mensaje de A.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await pageB.goto('/signin');
    await injectSession(pageB, {
      accessToken: userB.tokens.accessToken,
      user: { ...userB.user, onboardingCompletedAt: new Date().toISOString() },
    });
    await pageB.goto('/mensajes');

    const dmItemB = pageB
      .getByTestId('conversation-item-dm')
      .filter({ hasText: `E2E Emisor ${stamp}` });
    await expect(dmItemB, 'B ve el directo de A en su lista').toBeVisible({ timeout: 20_000 });
    await expect(
      dmItemB.getByTestId('conversation-unread'),
      'el directo llega con contador de no-leídos',
    ).toHaveText('1', { timeout: 15_000 });
    await dmItemB.click();
    await expect(pageB.getByTestId('chat-messages')).toContainText(helloText, { timeout: 15_000 });

    // B responde y A lo ve SIN recargar (push SSE).
    const replyText = `Recibido A, soy B (${stamp})`;
    await pageB.getByTestId('chat-composer-input').fill(replyText);
    await pageB.getByTestId('chat-send').click();
    await expect(
      page.getByTestId('chat-messages'),
      'la respuesta de B aparece en la pestaña de A sin reload',
    ).toContainText(replyText, { timeout: 20_000 });

    await ctxB.close();
  });

  test('sala de espacio: materialización lazy e histórico compartido', async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);
    const stamp = Date.now();

    const userA = await signup({
      tenantSlug,
      email: `e2e-sala-a-${stamp}@example.test`,
      password: 'E2eSalaA123!aa',
      name: `E2E Sala A ${stamp}`,
    });
    const userB = await signup({
      tenantSlug,
      email: `e2e-sala-b-${stamp}@example.test`,
      password: 'E2eSalaB123!aa',
      name: `E2E Sala B ${stamp}`,
    });

    await page.goto('/signin');
    await injectSession(page, {
      accessToken: userA.tokens.accessToken,
      user: { ...userA.user, onboardingCompletedAt: new Date().toISOString() },
    });
    await page.goto('/mensajes');

    // Las salas espejan los espacios reales de la comunidad (seed: "General").
    const sala = page.getByTestId('conversation-item-space').first();
    await expect(sala, 'hay al menos una sala de espacio').toBeVisible({ timeout: 15_000 });
    const salaTitle = (await sala.locator('span.truncate').first().textContent()) ?? '';
    await sala.click();
    await expect(page.getByTestId('chat-title')).toHaveText(salaTitle.trim(), { timeout: 15_000 });

    const salaMsg = `Mensaje en sala ${stamp}`;
    await page.getByTestId('chat-composer-input').fill(salaMsg);
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-messages')).toContainText(salaMsg, { timeout: 15_000 });

    // Otro miembro ve la misma sala con el histórico.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await pageB.goto('/signin');
    await injectSession(pageB, {
      accessToken: userB.tokens.accessToken,
      user: { ...userB.user, onboardingCompletedAt: new Date().toISOString() },
    });
    await pageB.goto('/mensajes');
    const salaB = pageB
      .getByTestId('conversation-item-space')
      .filter({ hasText: salaTitle.trim() })
      .first();
    await expect(salaB).toBeVisible({ timeout: 15_000 });
    await expect(salaB, 'la sala muestra el último mensaje real').toContainText(salaMsg, {
      timeout: 15_000,
    });
    await salaB.click();
    await expect(pageB.getByTestId('chat-messages')).toContainText(salaMsg, { timeout: 15_000 });

    await ctxB.close();
  });

  test('canal alumno↔profesores: consulta del alumno y respuesta del staff en tiempo real', async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    const stamp = Date.now();

    const alumno = await signup({
      tenantSlug,
      email: `e2e-fac-alumno-${stamp}@example.test`,
      password: 'E2eFac123!aa',
      name: `E2E Alumno ${stamp}`,
    });

    await page.goto('/signin');
    await injectSession(page, {
      accessToken: alumno.tokens.accessToken,
      user: { ...alumno.user, onboardingCompletedAt: new Date().toISOString() },
    });
    await page.goto('/mensajes');

    // El canal "Profesores" existe sin que el alumno haga nada (auto-provisión).
    const facultyItem = page.getByTestId('conversation-item-faculty').first();
    await expect(facultyItem, 'el alumno siempre tiene su canal Profesores').toBeVisible({
      timeout: 15_000,
    });
    await expect(facultyItem).toContainText('Profesores');
    await facultyItem.click();

    const consulta = `Duda del alumno ${stamp}: ¿cómo funciona el drip?`;
    await page.getByTestId('chat-composer-input').fill(consulta);
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-messages')).toContainText(consulta, { timeout: 15_000 });

    // El staff (admin seed: super_admin+tenant_admin+formador) ve la consulta
    // en su bandeja, titulada con el nombre del alumno.
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const ctxStaff = await browser.newContext();
    const pageStaff = await ctxStaff.newPage();
    await pageStaff.goto('/signin');
    await injectSession(pageStaff, {
      accessToken: adminToken,
      user: {
        id: 'admin-stub',
        email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
        name: 'Staff E2E',
        tenantId: alumno.user.tenantId,
        tenantSlug,
        roles: ['super_admin', 'tenant_admin', 'formador'],
        mfaEnabled: true,
        onboardingCompletedAt: new Date().toISOString(),
      },
    });
    await pageStaff.goto('/mensajes');

    const consultaItem = pageStaff
      .getByTestId('conversation-item-faculty')
      .filter({ hasText: `E2E Alumno ${stamp}` });
    await expect(consultaItem, 'la bandeja del staff lista la consulta del alumno').toBeVisible({
      timeout: 20_000,
    });
    await consultaItem.click();
    await expect(pageStaff.getByTestId('chat-messages')).toContainText(consulta, {
      timeout: 15_000,
    });

    const respuesta = `Respuesta del profe ${stamp}: el drip libera lecciones por fecha.`;
    await pageStaff.getByTestId('chat-composer-input').fill(respuesta);
    await pageStaff.getByTestId('chat-send').click();

    // El alumno la ve sin recargar (push SSE).
    await expect(
      page.getByTestId('chat-messages'),
      'la respuesta del staff llega al alumno sin reload',
    ).toContainText(respuesta, { timeout: 20_000 });

    await ctxStaff.close();
  });
});
