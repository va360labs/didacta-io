/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Recorrido visual 2 — «notificaciones y ventas». Genera las 18 capturas de
 * `didacta-docs/docs/assets/notificaciones-y-pagos/`.
 *
 * Continúa donde termina `01-recorrido-visual.spec.ts`: da por hecho el tenant
 * `academia-demo`, su administrador y el curso publicado. Por eso el fichero
 * lleva el prefijo `02-` (Playwright ejecuta los ficheros en orden alfabético
 * con `workers: 1`).
 *
 * El correo de prueba sale de verdad: la instancia apunta al Mailpit del stack
 * y la captura de la bandeja es su interfaz web, no una simulación. Las claves
 * de Stripe son inventadas a propósito — una de las capturas documenta
 * justamente el error con el que Stripe rechaza una clave inválida.
 */

import { expect, test, type Page } from '@playwright/test';
import { newShotContext, newShotPage } from './lib/browser';
import { injectSession, mailpitClear, setProfileLocale, signin } from './lib/api';
import { annotationLabel, DEMO, LOCALE, MAILPIT_URL } from './lib/config';
import { t } from './lib/i18n';
import { assertLocale, setSwitch, shot } from './lib/shot';

const WALKTHROUGH = 'notificaciones-y-pagos';

/** Abre `/admin/configuracion` en la pestaña pedida. No hay parámetro de URL. */
async function openConfigTab(page: Page, tabKey: 'notifications' | 'pagos'): Promise<void> {
  if (!page.url().includes('/admin/configuracion')) {
    await page.goto('/admin/configuracion');
  }
  await expect(page.getByRole('heading', { name: t('adminMarca', 'config.title') })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('tab', { name: t('adminMarca', `configTabs.${tabKey}`) }).click();
}

test('notificaciones y pagos · 18 capturas', async ({ browser }) => {
  const adminCtx = await newShotContext(browser);
  const admin = await newShotPage(adminCtx);

  const session = await signin({
    tenantSlug: DEMO.org.slug,
    email: DEMO.admin.email,
    password: DEMO.admin.password,
  });
  const bearer = session.tokens.accessToken;
  await setProfileLocale(bearer);

  await admin.goto('/signin');
  await injectSession(admin, {
    accessToken: bearer,
    refreshToken: session.tokens.refreshToken,
    user: { ...session.user, onboardingCompletedAt: new Date().toISOString() },
  });

  // ─────────────────────────────────────────────────────── 1 · SMTP ──
  await openConfigTab(admin, 'notifications');
  await expect(admin.getByTestId('smtp-banner-none')).toBeVisible({ timeout: 30_000 });
  await assertLocale(admin, LOCALE);
  await shot(admin, WALKTHROUGH, '01-smtp-vacio');

  await admin.locator('#smtp-host').fill(DEMO.smtp.host);
  await admin.locator('#smtp-port').fill(DEMO.smtp.port);
  // Mailpit escucha sin cifrar: con TLS encendido (el valor por defecto) la
  // conexión falla en el handshake. Es el detalle que la documentación subraya.
  await setSwitch(admin.locator('#smtp-secure'), false);
  await admin.locator('#smtp-username').fill(DEMO.smtp.username);
  await admin.locator('#smtp-password').fill(DEMO.smtp.password);
  await admin.locator('#smtp-from-email').fill(DEMO.smtp.fromEmail);
  await admin.locator('#smtp-from-name').fill(DEMO.smtp.fromName);
  await shot(admin, WALKTHROUGH, '02-smtp-form');

  await admin.getByRole('button', { name: t('adminSso', 'smtp.saveButton') }).click();
  await expect(admin.getByTestId('smtp-banner-unverified')).toBeVisible({ timeout: 30_000 });
  await shot(admin, WALKTHROUGH, '03-smtp-guardado');

  await mailpitClear();
  await admin.getByRole('button', { name: t('adminSso', 'smtp.testButton') }).click();
  await expect(admin.locator('#smtp-test-email')).toBeVisible({ timeout: 15_000 });
  await shot(admin, WALKTHROUGH, '04-smtp-modal-prueba');

  await admin.getByRole('button', { name: t('adminSso', 'smtp.sendButton'), exact: true }).click();
  await expect(admin.getByTestId('smtp-banner-verified')).toBeVisible({ timeout: 60_000 });
  await shot(admin, WALKTHROUGH, '05-smtp-verificado');

  // Bandeja real de Mailpit. Su interfaz es solo inglesa (no la traduce
  // Didacta); lo que sí cambia de idioma es el CONTENIDO del correo, que lo
  // genera la plataforma en el idioma del destinatario.
  const mail = await newShotPage(adminCtx);
  await mail.goto(MAILPIT_URL);
  await mail.getByText(DEMO.admin.email).first().click();
  // Mailpit renderiza la vista HTML dentro de un iframe; esperar a él es la
  // señal de que el mensaje ya está abierto y pintado.
  await expect(mail.locator('iframe').first()).toBeVisible({ timeout: 30_000 });
  await shot(mail, WALKTHROUGH, '06-mailpit-bandeja');
  await mail.close();

  // ─────────────────────────────────────────────────────── 2 · Pagos ──
  await openConfigTab(admin, 'pagos');
  await expect(admin.getByTestId('stripe-banner-none')).toBeVisible({ timeout: 30_000 });
  await shot(admin, WALKTHROUGH, '07-pagos-vacio');

  await admin.goto('/admin/membresia');
  const stripeWarning = admin.getByText(
    t('adminMonetizacion', 'membership.stripeWarning')
      .replace(/<\/?link>/g, '')
      .slice(0, 60),
  );
  await expect(stripeWarning).toBeVisible({ timeout: 30_000 });
  await shot(admin, WALKTHROUGH, '08-membresia-aviso-stripe');

  await admin.goto('/admin/billing/products');
  await expect(admin.locator('#courseId')).toBeVisible({ timeout: 30_000 });
  await admin.locator('#courseId').selectOption({ index: 1 });
  await admin.locator('#stripePriceId').fill('price_0000000000000000000000');
  await admin.getByRole('button', { name: t('adminPagos', 'billing.linkCta') }).click();
  await expect(
    admin.getByRole('link', { name: t('adminPagos', 'billing.stripeMissingCta') }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await shot(admin, WALKTHROUGH, '09-billing-cta-sin-stripe');

  await openConfigTab(admin, 'pagos');
  await expect(admin.locator('#stripe-secret-key')).toBeVisible({ timeout: 30_000 });
  await admin.locator('#stripe-secret-key').fill(DEMO.stripe.secretKey);
  await admin.locator('#stripe-webhook-secret').fill(DEMO.stripe.webhookSecret);
  await shot(admin, WALKTHROUGH, '10-pagos-form-relleno');

  await admin.getByRole('button', { name: t('adminPagos', 'stripe.saveCta') }).click();
  await expect(admin.getByTestId('stripe-banner-unverified')).toBeVisible({ timeout: 30_000 });
  await shot(admin, WALKTHROUGH, '11-pagos-guardado-sin-verificar');

  // Llamada REAL a la API de Stripe (`balance.retrieve`, solo lectura). Con una
  // clave inventada responde con su propio mensaje de error: la señal de que la
  // validación no es cosmética.
  await admin.getByRole('button', { name: t('adminPagos', 'stripe.testCta') }).click();
  const stripeToast = admin.getByTestId('stripe-toast');
  await expect(stripeToast).toBeVisible({ timeout: 60_000 });
  await expect(stripeToast).toContainText(/stripe|api key|invalid/i, { timeout: 60_000 });
  await shot(admin, WALKTHROUGH, '12-pagos-probar-conexion-error', {
    annotations: [{ target: stripeToast, label: annotationLabel('stripeError') }],
  });

  // ────────────────────────────────────────────────── 3 · Membresía ──
  await admin.goto('/admin/grupos-acceso');
  await expect(admin.locator('#ag-name')).toBeVisible({ timeout: 30_000 });
  await admin.locator('#ag-name').fill(DEMO.accessGroup.name);
  await admin.locator('#ag-kind').selectOption('ALL_COURSES');
  const createGroup = admin.getByRole('button', { name: t('adminUsuarios', 'groups.create') });
  await shot(admin, WALKTHROUGH, '13-grupo-acceso', {
    annotations: [{ target: createGroup, label: t('adminUsuarios', 'groups.create') }],
  });
  await createGroup.click();
  await expect(admin.getByText(DEMO.accessGroup.name).first()).toBeVisible({ timeout: 30_000 });

  await admin.goto('/admin/membresia');
  await expect(admin.locator('#plan-name')).toBeVisible({ timeout: 30_000 });
  await admin.locator('#plan-name').fill(DEMO.plan.name);
  await admin.locator('#plan-amount').fill(DEMO.plan.price);
  await admin.locator('#plan-compare').fill(DEMO.plan.compareAtPrice);
  await admin.locator('#plan-trial').fill(DEMO.plan.trialDays);
  await setSwitch(admin.locator('#plan-featured'), true);
  const createPlan = admin.getByRole('button', {
    name: t('adminMonetizacion', 'membership.createPlan'),
  });
  await shot(admin, WALKTHROUGH, '14-membresia-plan-form', {
    scrollTo: admin.locator('#plan-name'),
    annotations: [{ target: createPlan, label: t('adminMonetizacion', 'membership.createPlan') }],
  });

  await createPlan.click();
  await expect(admin.getByText(DEMO.plan.name).first()).toBeVisible({ timeout: 30_000 });
  await shot(admin, WALKTHROUGH, '15-membresia-plan-creado', {
    scrollTo: admin.getByText(DEMO.plan.name).first(),
  });

  // ───────────────────────────────────────── 4 · página pública /unete ──
  // Recarga obligatoria: al crear el plan, la página vuelve a pedir la config
  // y `applyConfig()` reescribe el estado del formulario. Si se teclea encima
  // sin esperar, la respuesta llega a mitad y borra lo escrito — que es
  // exactamente el fallo que dejaba la captura 16 con los campos vacíos.
  await admin.reload();
  const pageActive = admin.locator('#page-active');
  await expect(pageActive).toBeVisible({ timeout: 30_000 });
  await pageActive.scrollIntoViewIfNeeded();
  await setSwitch(pageActive, true);
  await admin.locator('#cfg-headline').fill(DEMO.unete.title);
  await admin.locator('#cfg-sub').fill(DEMO.unete.subtitle);
  await admin.locator('#cfg-group').selectOption({ label: DEMO.accessGroup.name });
  await setSwitch(admin.locator('#cfg-courses'), true);
  const saveConfig = admin.getByRole('button', {
    name: t('adminMonetizacion', 'membership.saveConfig'),
  });
  await shot(admin, WALKTHROUGH, '16-unete-config', {
    scrollTo: admin.locator('#cfg-headline'),
    annotations: [{ target: saveConfig, label: t('adminMonetizacion', 'membership.saveConfig') }],
  });

  await saveConfig.click();
  await expect(admin.getByText(t('adminMonetizacion', 'membership.badgeActive'))).toBeVisible({
    timeout: 30_000,
  });
  await shot(admin, WALKTHROUGH, '17-unete-config-guardada', {
    scrollTo: admin.locator('#cfg-headline'),
  });

  const publicCtx = await newShotContext(browser);
  const publicPage = await newShotPage(publicCtx);
  await publicPage.goto('/unete');
  await expect(publicPage.getByText(DEMO.unete.title)).toBeVisible({ timeout: 30_000 });
  await assertLocale(publicPage, LOCALE);
  await shot(publicPage, WALKTHROUGH, '18-unete-publico');

  await publicCtx.close();
  await adminCtx.close();
});
