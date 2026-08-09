/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Lo que no se ve en la captura, se hace por API.
 *
 * Cada pantallazo retrata UN estado; llegar hasta él pinchando por la interfaz
 * multiplicaría los puntos de fallo sin aportar nada a la imagen. Aquí viven
 * las llamadas de preparación (activar módulos, cambiar el idioma del perfil,
 * dejar el SMTP puesto o quitado) y la lectura del buzón de Mailpit.
 */

import { execFileSync } from 'node:child_process';
import type { BrowserContext, Page } from '@playwright/test';
import { API_URL, LOCALE, MAILPIT_URL, PG_CONTAINER, PG_DB, PG_USER } from './config';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  tenantId: string;
  tenantSlug: string;
  roles: string[];
  mfaEnabled: boolean;
}

export interface AuthResponse {
  tokens: { accessToken: string; refreshToken: string; expiresIn: number };
  mfaRequired: boolean;
  user: AuthUser;
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; bearer?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.bearer) headers['Authorization'] = `Bearer ${init.bearer}`;

  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'message' in body
        ? String((body as { message: unknown }).message)
        : res.statusText;
    throw new Error(`[shots] API ${init.method ?? 'GET'} ${path} → ${res.status}: ${message}`);
  }
  return body as T;
}

export async function signin(args: {
  tenantSlug: string;
  email: string;
  password: string;
}): Promise<AuthResponse> {
  return api<AuthResponse>('/api/v1/auth/signin', { method: 'POST', body: args });
}

/**
 * Fija el idioma del PERFIL, no solo la cookie.
 *
 * `LocaleSync` compara `GET /me/profile` con la cookie `didacta_locale` y, si
 * difieren, reescribe la cookie con lo que dice el perfil. Poner solo la
 * cookie a `en-US` hace que la página parpadee y vuelva a español; hay que
 * cambiar `user.locale`. Es el paso que se lleva por delante una tanda entera
 * de capturas si se olvida.
 */
export async function setProfileLocale(bearer: string, locale = LOCALE): Promise<void> {
  await api('/api/v1/me/profile', { method: 'PATCH', body: { locale }, bearer });
}

/** Cookie de idioma para que el PRIMER render del servidor ya salga bien. */
export async function setLocaleCookie(context: BrowserContext, url: string): Promise<void> {
  await context.addCookies([{ name: 'didacta_locale', value: LOCALE, url }]);
}

/**
 * Mete tokens y sesión en el web storage del origen ya cargado, igual que
 * `helpers/auth.ts` de los specs. `onboardingCompletedAt` evita que el gate de
 * `(app)/layout.tsx` desvíe cualquier ruta autenticada al wizard.
 */
export async function injectSession(
  page: Page,
  args: {
    accessToken: string;
    refreshToken?: string;
    user: AuthUser & { onboardingCompletedAt?: string | null };
  },
): Promise<void> {
  await page.evaluate((data) => {
    sessionStorage.setItem('didacta.access_token', data.accessToken);
    if (data.refreshToken) localStorage.setItem('didacta.refresh_token', data.refreshToken);
    sessionStorage.setItem(
      'didacta.session',
      JSON.stringify({ user: data.user, mfaRequired: false }),
    );
  }, args);
}

/** Activa un módulo para el tenant (`POST /admin/modules/:name/enable`). */
export async function enableModule(bearer: string, name: string): Promise<void> {
  await api(`/api/v1/admin/modules/${encodeURIComponent(name)}/enable`, {
    method: 'POST',
    body: {},
    bearer,
  }).catch((err: unknown) => {
    // Ya activo → el backend responde 409/400. Para el generador es un no-op.
    const message = err instanceof Error ? err.message : String(err);
    if (/40[09]/.test(message)) return;
    throw err;
  });
}

export interface SmtpPayload {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromEmail: string;
  fromName?: string;
}

/** Deja el SMTP del tenant puesto sin pasar por el formulario. */
export async function putTenantSmtp(bearer: string, payload: SmtpPayload): Promise<void> {
  await api('/api/v1/admin/tenant-settings/smtp', { method: 'PUT', body: payload, bearer });
}

/**
 * Borra la config SMTP del tenant (las dos rows: `smtp` y `smtp_meta`), para
 * que el recorrido de ventas arranque con la pestaña Notificaciones realmente
 * vacía.
 */
export async function deleteTenantSmtp(bearer: string): Promise<void> {
  for (const key of ['smtp', 'smtp_meta']) {
    await api(`/api/v1/tenant-settings/notifications/${key}`, { method: 'DELETE', bearer }).catch(
      () => undefined,
    );
  }
}

interface MailpitSummary {
  messages: Array<{ ID: string; Subject: string; To: Array<{ Address: string }> }>;
}

/** Vacía el buzón de Mailpit para que la captura de la bandeja tenga un solo correo. */
export async function mailpitClear(): Promise<void> {
  await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: 'DELETE' });
}

/** Devuelve los mensajes del buzón, del más reciente al más antiguo. */
export async function mailpitList(): Promise<MailpitSummary['messages']> {
  const res = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=50`);
  if (!res.ok) throw new Error(`[shots] Mailpit no responde (${res.status}) en ${MAILPIT_URL}`);
  const body = (await res.json()) as MailpitSummary;
  return body.messages ?? [];
}

/**
 * Espera a que llegue un correo para `to` y devuelve su cuerpo de texto.
 * Sondea el buzón porque el envío es asíncrono respecto de la petición HTTP
 * que lo dispara — no hay ningún estado en la UI al que engancharse.
 */
export async function mailpitWaitFor(to: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await mailpitList().catch(() => []);
    const found = messages.find((m) => m.To?.some((addr) => addr.Address === to));
    if (found) {
      const res = await fetch(`${MAILPIT_URL}/api/v1/message/${found.ID}`);
      const body = (await res.json()) as { Text?: string; HTML?: string };
      return `${body.Text ?? ''}\n${body.HTML ?? ''}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`[shots] No llegó ningún correo para ${to} en ${timeoutMs} ms`);
}

/** Saca el `?token=` de un enlace `/reset-password` dentro del cuerpo del email. */
export function extractResetToken(mailBody: string): string {
  const match = mailBody.match(/reset-password\?token=([A-Za-z0-9_%-]+)/);
  if (!match?.[1]) {
    throw new Error('[shots] El email no contiene ningún enlace /reset-password?token=');
  }
  return decodeURIComponent(match[1]);
}

/**
 * Aplica `packages/database/prisma/seed.sql` — los cuatro espacios de sistema
 * de mod.community para cada tenant existente. Es literalmente lo que hace
 * `infra/docker/entrypoint.sh` en cada arranque de la imagen, y hay que
 * repetirlo DESPUÉS de que el asistente cree el tenant (antes no hay a quién
 * asignárselos). Si `SHOTS_PG_CONTAINER` no está seteado, se salta.
 */
export function seedSystemSpaces(repoRoot: string): void {
  if (!PG_CONTAINER) return;
  const sql = require('node:fs').readFileSync(
    require('node:path').join(repoRoot, 'packages', 'database', 'prisma', 'seed.sql'),
    'utf8',
  ) as string;
  execFileSync(
    'docker',
    ['exec', '-i', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DB, '-v', 'ON_ERROR_STOP=1'],
    { input: sql, stdio: ['pipe', 'ignore', 'inherit'] },
  );
}
