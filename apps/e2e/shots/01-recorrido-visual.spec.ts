/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Recorrido visual 1 — «del asistente de configuración al primer certificado».
 * Genera las 22 capturas de `didacta-docs/docs/assets/recorrido-visual/`.
 *
 * Precondición: instancia VIRGEN (cero tenants) y token de setup a mano.
 * Lánzalo siempre después de `shots/reset-instance.sh`; ver `shots/README.md`.
 *
 * Es un único `test` a propósito: las 22 capturas son un mismo recorrido con
 * estado acumulado (el curso de la 11 es el que se publicó en la 10, el código
 * de la 17 es el que se generó en la 12). Partirlo en 22 tests daría 22
 * contextos de navegador sin nada que compartir.
 */

import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { encodePng } from '../helpers/png';
import { newShotContext, newShotPage, readAccessToken } from './lib/browser';
import {
  api,
  deleteTenantSmtp,
  extractResetToken,
  injectSession,
  mailpitClear,
  mailpitWaitFor,
  putTenantSmtp,
  seedSystemSpaces,
  setProfileLocale,
  signin,
} from './lib/api';
import { annotationLabel, DEMO, LOCALE, SETUP_TOKEN } from './lib/config';
import { t } from './lib/i18n';
import { assertLocale, setRange, shot } from './lib/shot';

const WALKTHROUGH = 'recorrido-visual';
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Imágenes generadas en memoria (degradado suave) para la foto de perfil y el
 * logo del tenant. Así no hay binarios en el repo y las capturas no dependen
 * de la marca de nadie — un degradado es un marcador de posición neutro.
 */
function gradientPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      raw[i] = 46 + Math.round((x * 80) / width);
      raw[i + 1] = 125 + Math.round((y * 60) / height);
      raw[i + 2] = 206;
      raw[i + 3] = 255;
    }
  }
  return encodePng(raw, width, height);
}

const AVATAR_PNG = gradientPng(512, 512);
const LOGO_PNG = gradientPng(320, 96);

/**
 * Sube un fichero por el diálogo del navegador, que es como lo hace una
 * persona. Más fiable que `setInputFiles` sobre el `<input type="file">`
 * oculto: en varias de estas pantallas el input vive dentro de un componente
 * que se monta al vuelo.
 */
async function uploadThrough(
  page: Page,
  trigger: Locator,
  file: { name: string; buffer: Buffer },
): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), trigger.click()]);
  await chooser.setFiles({ name: file.name, mimeType: 'image/png', buffer: file.buffer });
}

test('recorrido visual · 22 capturas', async ({ browser }) => {
  test.skip(!SETUP_TOKEN, 'Falta SHOTS_SETUP_TOKEN — corre antes shots/reset-instance.sh');

  const adminCtx = await newShotContext(browser);
  const admin = await newShotPage(adminCtx);

  // ───────────────────────────────────────────────────────────── 1 · setup ──
  await admin.goto(`/setup?token=${encodeURIComponent(SETUP_TOKEN)}`);
  await expect(admin.getByRole('heading', { name: t('auth', 'setup.welcomeTitle') })).toBeVisible({
    timeout: 30_000,
  });
  await assertLocale(admin, LOCALE);

  const welcomeCta = admin.getByRole('button', { name: t('auth', 'setup.welcomeCta') });
  await shot(admin, WALKTHROUGH, '01-setup-intro', {
    annotations: [{ target: welcomeCta, label: t('auth', 'setup.welcomeCta') }],
  });

  await welcomeCta.click();
  await admin.locator('#orgName').fill(DEMO.org.name);
  // `window.location.host` trae el puerto y `HOSTNAME_RE` del backend no acepta
  // ":". Hay que sobreescribirlo: vaciarlo no vale, un effect lo repuebla.
  await admin.locator('#hostname').fill(DEMO.org.hostname);
  const continueCta = admin.getByRole('button', { name: t('auth', 'setup.continue') });
  await shot(admin, WALKTHROUGH, '02-setup-organizacion', {
    annotations: [{ target: continueCta, label: t('auth', 'setup.continue') }],
  });

  await continueCta.click();
  await expect(admin.getByRole('heading', { name: t('auth', 'setup.modulesTitle') })).toBeVisible();
  await admin.getByRole('button', { name: t('auth', 'setup.continue') }).click();

  await expect(admin.getByRole('heading', { name: t('auth', 'setup.adminTitle') })).toBeVisible();
  await admin.locator('#adminName').fill(DEMO.admin.name);
  await admin.locator('#adminEmail').fill(DEMO.admin.email);
  await admin.locator('#adminPassword').fill(DEMO.admin.password);
  await admin.locator('#adminPasswordConfirm').fill(DEMO.admin.password);
  const createCta = admin.getByRole('button', { name: t('auth', 'setup.submit') });
  await shot(admin, WALKTHROUGH, '03-setup-admin', {
    annotations: [{ target: createCta, label: t('auth', 'setup.submit') }],
  });

  await createCta.click();
  await expect(admin.getByRole('heading', { name: t('auth', 'setup.tourTitle') })).toBeVisible({
    timeout: 30_000,
  });
  await shot(admin, WALKTHROUGH, '04-setup-listo');

  // El tenant ya existe: ahora sí se pueden sembrar los espacios de sistema,
  // igual que hace `infra/docker/entrypoint.sh` en cada arranque de la imagen.
  seedSystemSpaces(REPO_ROOT);

  // ⚠️ Idioma del PERFIL antes de entrar a ninguna ruta autenticada. `LocaleSync`
  // compara `/me/profile` con la cookie y, si el perfil no dice nada, devuelve
  // la UI a español. Sin esta línea la tanda inglesa sale en español entera.
  const adminToken = await readAccessToken(admin);
  await setProfileLocale(adminToken);

  // ──────────────────────────────────────────────────────── 2 · onboarding ──
  await admin.getByRole('button', { name: t('auth', 'setup.tourCta') }).click();
  await admin.waitForURL(/\/onboarding/, { timeout: 30_000 });
  await expect(
    admin.getByRole('heading', { name: t('auth', 'onboarding.photoTitle') }),
  ).toBeVisible({ timeout: 30_000 });
  await assertLocale(admin, LOCALE);

  await uploadThrough(
    admin,
    admin.getByRole('button', { name: t('cuentaComponentes', 'avatar.upload') }),
    { name: 'foto-de-perfil.png', buffer: AVATAR_PNG },
  );
  // El botón pasa de "Subir foto" a "Cambiar foto" cuando la subida termina.
  await expect(
    admin.getByRole('button', { name: t('cuentaComponentes', 'avatar.change') }),
  ).toBeVisible({ timeout: 30_000 });

  await shot(admin, WALKTHROUGH, '05-onboarding-foto');

  // Terminamos el onboarding (no se retrata): sin él, el gate de
  // `(app)/layout.tsx` desvía cualquier ruta autenticada de vuelta al wizard.
  for (let i = 0; i < 3; i++) {
    await admin.getByRole('button', { name: t('auth', 'onboarding.continue') }).click();
  }
  await admin.getByRole('button', { name: t('auth', 'onboarding.submit') }).click();
  await admin.waitForURL((url) => !url.pathname.startsWith('/onboarding'), { timeout: 30_000 });

  // ───────────────────────────────────────────────────────────── 3 · login ──
  // Pantalla pública: contexto sin sesión, manda la cookie de idioma.
  const publicCtx = await newShotContext(browser);
  const publicPage = await newShotPage(publicCtx);
  await publicPage.goto('/signin');
  await expect(publicPage.locator('#email')).toBeVisible({ timeout: 30_000 });
  await assertLocale(publicPage, LOCALE);
  await publicPage.locator('#email').fill(DEMO.admin.email);
  await publicPage.locator('#password').fill(DEMO.admin.password);
  const signinCta = publicPage.locator('form button[type="submit"]').first();
  await shot(publicPage, WALKTHROUGH, '06-signin', {
    annotations: [{ target: signinCta, label: await signinCta.innerText() }],
  });

  // ──────────────────────────────────────────────────────────── 4 · marca ──
  await admin.goto('/admin/branding');
  await expect(admin.locator('#brandHue')).toBeVisible({ timeout: 30_000 });
  await assertLocale(admin, LOCALE);
  // Aquí el disparador NO es un botón sino un `<label>` con el input dentro en
  // `sr-only`, así que no hay diálogo de fichero que interceptar: se le pasan
  // los ficheros al input directamente, acotado por el texto del label para no
  // pillar el uploader de otra tarjeta de la misma página.
  await admin
    .locator('label', { hasText: t('adminMarca', 'branding.uploadCta') })
    .locator('input[type="file"]')
    .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: LOGO_PNG });
  await expect(admin.getByAltText(t('adminMarca', 'branding.uploadedAlt'))).toBeVisible({
    timeout: 30_000,
  });
  await setRange(admin, '#brandHue', 212);
  const brandingSave = admin.getByRole('button', {
    name: t('adminMarca', 'branding.saveButton'),
  });
  await shot(admin, WALKTHROUGH, '07-branding', {
    scrollTo: brandingSave,
    annotations: [{ target: brandingSave, label: t('adminMarca', 'branding.saveButton') }],
  });
  await brandingSave.click();

  // ───────────────────────────────────────────────────────────── 5 · curso ──
  await admin.goto('/formador/cursos/nuevo');
  await expect(admin.locator('#title')).toBeVisible({ timeout: 30_000 });
  await admin.locator('#title').fill(DEMO.course.title);
  await admin.locator('#category').fill(DEMO.course.category);
  const description = admin.getByLabel(t('playersContenido', 'newCourse.descriptionAriaLabel'));
  await description.click();
  await description.fill(DEMO.course.description);
  await shot(admin, WALKTHROUGH, '08-curso-nuevo');

  await admin.getByRole('button', { name: t('playersContenido', 'newCourse.submit') }).click();
  await admin.waitForURL(/\/formador\/cursos\/[0-9a-f-]{10,}/, { timeout: 30_000 });
  const courseId = admin.url().split('/').pop()!;

  // Sección + lección por la interfaz: la 09 retrata justo el alta de la lección.
  await admin.getByRole('button', { name: t('formadorCursos', 'addModule') }).click();
  await admin.locator('input[name="title"]').fill(DEMO.course.section);
  await admin.getByRole('button', { name: t('formadorCursos', 'createModule') }).click();
  await expect(admin.getByText(DEMO.course.section)).toBeVisible({ timeout: 15_000 });

  await admin.getByRole('button', { name: t('formadorCursos', 'addLesson') }).click();
  await admin
    .getByPlaceholder(t('formadorCursos', 'lessonTitlePlaceholder'))
    .fill(DEMO.course.lesson);
  // `exact` obligatorio: "Crear" es subcadena de "Crear sección" y "Crear curso".
  const createLesson = admin.getByRole('button', {
    name: t('formadorCursos', 'create'),
    exact: true,
  });
  await shot(admin, WALKTHROUGH, '09-curso-leccion-alta', {
    annotations: [{ target: createLesson, label: t('formadorCursos', 'create') }],
  });
  await createLesson.click();
  await expect(admin.getByText(DEMO.course.lesson)).toBeVisible({ timeout: 15_000 });

  // Contenido real de la lección — se ve en las capturas 19 y 20.
  const detail = await api<{
    modules: Array<{ id: string; lessons: Array<{ id: string; title: string }> }>;
  }>(`/api/v1/modules/courses/${courseId}`, { bearer: adminToken });
  const lessonId = detail.modules[0]?.lessons[0]?.id;
  if (!lessonId) throw new Error('[shots] La lección no se creó');
  await api(`/api/v1/modules/courses/lessons/${lessonId}`, {
    method: 'PUT',
    body: { content: { text: DEMO.course.lessonText }, durationSec: 300 },
    bearer: adminToken,
  });

  await admin.reload();
  const publishCta = admin.getByRole('button', { name: t('formadorCursos', 'publish') });
  await expect(publishCta).toBeVisible({ timeout: 30_000 });
  await shot(admin, WALKTHROUGH, '10-curso-listo-publicar', {
    annotations: [{ target: publishCta, label: t('formadorCursos', 'publish') }],
  });

  await publishCta.click();
  await expect(admin.getByRole('button', { name: t('formadorCursos', 'archive') })).toBeVisible({
    timeout: 30_000,
  });
  await admin.mouse.wheel(0, -2000);
  await shot(admin, WALKTHROUGH, '11-curso-publicado');

  // ─────────────────────────────────────────────────────── 6 · invitación ──
  const generate = admin.getByRole('button', { name: t('formadorCursos', 'generate') });
  await generate.scrollIntoViewIfNeeded();
  await generate.click();
  await expect(admin.getByText(t('formadorCursos', 'codeGenerated'))).toBeVisible({
    timeout: 15_000,
  });
  const codeNode = admin.getByText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/).first();
  const invitationCode = (await codeNode.innerText()).trim();
  await shot(admin, WALKTHROUGH, '12-curso-invitacion-generada', {
    annotations: [{ target: codeNode, label: annotationLabel('invitationCode') }],
  });

  // Catálogo público de venta: el curso no tiene precio, así que está vacío.
  await publicPage.goto('/catalogo');
  await assertLocale(publicPage, LOCALE);
  await shot(publicPage, WALKTHROUGH, '13-catalogo-publico');

  // ─────────────────────────────────────────────── 7 · alta de la alumna ──
  // El enlace de "define tu contraseña" viaja por email: hace falta SMTP. Se
  // pone por API (no por UI) y se quita al terminar, para que el recorrido de
  // ventas arranque con la pestaña Notificaciones realmente vacía.
  await putTenantSmtp(adminToken, {
    host: DEMO.smtp.host,
    port: Number(DEMO.smtp.port),
    secure: false,
    username: DEMO.smtp.username,
    password: DEMO.smtp.password,
    fromEmail: DEMO.smtp.fromEmail,
    fromName: DEMO.smtp.fromName,
  });
  await mailpitClear();

  await admin.goto('/admin/usuarios/invitar');
  await expect(admin.locator('#email')).toBeVisible({ timeout: 30_000 });
  await admin.locator('#email').fill(DEMO.alumna.email);
  await admin.locator('#name').fill(DEMO.alumna.name);
  const inviteCta = admin.getByRole('button', { name: t('adminUsuarios', 'invite.submit') });
  await shot(admin, WALKTHROUGH, '14-admin-invitar-alumna', {
    annotations: [{ target: inviteCta, label: t('adminUsuarios', 'invite.submit') }],
  });
  await inviteCta.click();
  await admin.waitForURL(/\/admin\/usuarios/, { timeout: 30_000 });

  const inviteMail = await mailpitWaitFor(DEMO.alumna.email);
  const resetToken = extractResetToken(inviteMail);

  const alumnaCtx = await newShotContext(browser);
  const alumna = await newShotPage(alumnaCtx);
  await alumna.goto(`/reset-password?token=${encodeURIComponent(resetToken)}`);
  await expect(alumna.locator('#newPassword')).toBeVisible({ timeout: 30_000 });
  await assertLocale(alumna, LOCALE);
  await alumna.locator('#newPassword').fill(DEMO.alumna.password);
  await alumna.locator('#confirm').fill(DEMO.alumna.password);
  await shot(alumna, WALKTHROUGH, '15-alumna-definir-password');
  await alumna.locator('form button[type="submit"]').first().click();
  await expect(alumna.getByText(t('auth', 'reset.doneTitle'))).toBeVisible({ timeout: 30_000 });

  // SMTP fuera: la pestaña Notificaciones vuelve a estar sin configurar.
  await deleteTenantSmtp(adminToken);

  // ──────────────────────────────────────────── 7bis · la alumna entra ──
  const alumnaSession = await signin({
    tenantSlug: DEMO.org.slug,
    email: DEMO.alumna.email,
    password: DEMO.alumna.password,
  });
  await setProfileLocale(alumnaSession.tokens.accessToken);
  await alumna.goto('/signin');
  await injectSession(alumna, {
    accessToken: alumnaSession.tokens.accessToken,
    refreshToken: alumnaSession.tokens.refreshToken,
    user: { ...alumnaSession.user, onboardingCompletedAt: new Date().toISOString() },
  });
  // El onboarding de la alumna se completa por API: no se retrata y el gate
  // solo mira el flag.
  await api('/api/v1/me/onboarding/complete', {
    method: 'POST',
    body: {},
    bearer: alumnaSession.tokens.accessToken,
  }).catch(() => undefined);

  await alumna.goto('/cursos');
  await expect(alumna.getByText(DEMO.course.title)).toBeVisible({ timeout: 30_000 });
  await assertLocale(alumna, LOCALE);
  await shot(alumna, WALKTHROUGH, '16-alumna-catalogo');

  await alumna.goto(`/cursos/${DEMO.course.slug}`);
  const codeInput = alumna.locator('#code');
  await expect(codeInput).toBeVisible({ timeout: 30_000 });
  await codeInput.fill(invitationCode);
  const redeemCta = alumna.getByRole('button', {
    name: t('alumnoAprendizaje', 'redeemCode'),
  });
  await shot(alumna, WALKTHROUGH, '17-alumna-canjear-codigo', {
    annotations: [{ target: redeemCta, label: t('alumnoAprendizaje', 'redeemCode') }],
  });

  await redeemCta.click();
  await expect(alumna.getByText(t('alumnoAprendizaje', 'yourProgress'))).toBeVisible({
    timeout: 30_000,
  });
  // Arriba del todo: el panel de progreso que describe la documentación.
  await alumna.mouse.wheel(0, -2000);
  await shot(alumna, WALKTHROUGH, '18-alumna-matriculada');

  // ─────────────────────────────────────── 8 · lección y certificado ──
  // La primera lección queda seleccionada sola al entrar; basta con traer el
  // reproductor a la vista.
  const lessonBody = alumna.getByText(DEMO.course.lessonText.slice(0, 40));
  await expect(lessonBody).toBeVisible({ timeout: 30_000 });
  const markCompleted = alumna.getByRole('button', {
    name: t('playersContenido', 'lesson.markCompleted'),
  });
  // El curso de ejemplo cabe entero en el viewport, así que la 18 y la 19
  // encuadran lo mismo: lo que las distingue es qué señala cada una — la 18, el
  // panel de progreso; la 19, el botón de completar del reproductor, que es de
  // lo que habla la documentación.
  await shot(alumna, WALKTHROUGH, '19-alumna-leccion', {
    scrollTo: lessonBody,
    annotations: [{ target: markCompleted, label: t('playersContenido', 'lesson.markCompleted') }],
  });

  await markCompleted.click();
  const downloadCert = alumna.getByRole('button', {
    name: t('alumnoAprendizaje', 'downloadCertificate'),
  });
  await expect(downloadCert).toBeVisible({ timeout: 60_000 });
  await alumna.mouse.wheel(0, -2000);
  await shot(alumna, WALKTHROUGH, '20-alumna-curso-completado', {
    annotations: [{ target: downloadCert, label: t('alumnoAprendizaje', 'downloadCertificate') }],
  });

  await alumna.goto('/mis-certificados');
  const certNumber = alumna.getByText(/^[A-Z]{2}-\d{4}-\d{6}$/).first();
  await expect(certNumber).toBeVisible({ timeout: 30_000 });
  await shot(alumna, WALKTHROUGH, '21-alumna-mis-certificados', {
    annotations: [{ target: certNumber, label: annotationLabel('certificateNumber') }],
  });

  // ──────────────────────────────────────────────────────── 9 · licencia ──
  await admin.goto('/admin/licencia');
  await expect(admin.getByTestId('license-status-banner')).toBeVisible({ timeout: 30_000 });
  await assertLocale(admin, LOCALE);
  await shot(admin, WALKTHROUGH, '22-admin-licencia');

  await adminCtx.close();
  await publicCtx.close();
  await alumnaCtx.close();
});
