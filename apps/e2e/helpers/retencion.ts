/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { Browser, Page } from '@playwright/test';
import { injectSession } from './auth';
import { apiAs, freshTenant, type FreshTenant } from './simple-tenant';

/**
 * Utilidades de los specs de retención (desbloqueo por nivel, rachas,
 * insignias, premios y celebraciones). Cada spec trabaja en un aula NUEVA para
 * que sus niveles, celebraciones y premios no se crucen con los de otros.
 */

export interface Auth {
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

export const STUDENT_PASSWORD = 'E2eTestPassword123!';
export const GAMIF = '/api/v1/modules/gamification';

export async function signinAs(t: FreshTenant, email: string, password: string): Promise<Auth> {
  return apiAs<Auth>(t.host, '/api/v1/auth/signin', {
    method: 'POST',
    body: { tenantSlug: t.slug, email, password },
  });
}

/** Aula nueva (sencilla o completa) con la sesión de quien la administra. */
export async function aulaConCreador(
  prefix: string,
  simple: boolean,
): Promise<{ aula: FreshTenant; creador: Auth }> {
  const aula = await freshTenant(`${prefix}${Date.now().toString(36)}`, simple);
  // La creadora (tenant_admin), no la cuenta del operador (super_admin): es
  // quien lleva el aula en Didacta Cloud y quien firma las celebraciones.
  await apiAs(aula.host, '/api/v1/auth/reset-password', {
    method: 'POST',
    body: {
      token: new URL(aula.setPasswordUrl).searchParams.get('token'),
      newPassword: aula.password,
    },
  });
  const creador = await signinAs(aula, aula.creatorEmail, aula.password);
  // La academia ya tiene nombre y está revisada: sin esto, el modo sencillo
  // manda a quien administra al alta («Tu academia») antes que a Ajustes.
  await apiAs(aula.host, '/api/v1/admin/tenant-settings/academy', {
    method: 'PUT',
    bearer: creador.tokens.accessToken,
    body: { name: 'Primer Sorbo', locale: 'es' },
  });
  if (simple) {
    await apiAs(aula.host, '/api/v1/admin/simple-mode/academy/confirm', {
      method: 'POST',
      bearer: creador.tokens.accessToken,
    });
  }
  // El asistente de la academia, cerrado (lo que deja el alta real).
  await apiAs(aula.host, '/api/v1/tenant-settings/onboarding/academy', {
    method: 'PUT',
    bearer: creador.tokens.accessToken,
    body: {
      value: {
        step: 'resumen',
        done: ['nombre', 'marca'],
        skipped: ['curso', 'alumnos', 'cobros', 'correo'],
        completedAt: new Date().toISOString(),
      },
      isSecret: false,
    },
  });
  return { aula, creador };
}

export async function alumno(t: FreshTenant, email: string, name: string): Promise<Auth> {
  const a = await apiAs<Auth>(t.host, '/api/v1/auth/signup', {
    method: 'POST',
    body: { tenantSlug: t.slug, email, password: STUDENT_PASSWORD, name },
  });
  await apiAs(t.host, '/api/v1/me/onboarding/complete', {
    method: 'POST',
    bearer: a.tokens.accessToken,
    body: {},
  }).catch(() => undefined);
  return a;
}

export interface CursoSembrado {
  id: string;
  slug: string;
  title: string;
  modules: Array<{ id: string; title: string; lessons: Array<{ id: string; title: string }> }>;
}

/** Curso publicado con dos secciones de una lección de texto cada una. */
export async function cursoPublicado(
  t: FreshTenant,
  bearer: string,
  title: string,
  opts: { thumbnailUrl?: string } = {},
): Promise<CursoSembrado> {
  const slug = `${title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`;
  const course = await apiAs<{ id: string }>(t.host, '/api/v1/modules/courses', {
    method: 'POST',
    bearer,
    body: {
      title,
      slug,
      description: `${title}: un curso corto y práctico.`,
      ...(opts.thumbnailUrl ? { thumbnailUrl: opts.thumbnailUrl } : {}),
    },
  });
  for (const [i, sec] of ['Lo esencial', 'Para ir más lejos'].entries()) {
    const m = await apiAs<{ id: string }>(t.host, `/api/v1/modules/courses/${course.id}/modules`, {
      method: 'POST',
      bearer,
      body: { title: sec, orderIndex: i },
    });
    await apiAs(t.host, `/api/v1/modules/courses/modules/${m.id}/lessons`, {
      method: 'POST',
      bearer,
      body: {
        title: i === 0 ? 'Primeros pasos' : 'Un paso más',
        type: 'TEXT',
        orderIndex: 0,
        content: { text: 'Contenido real de la lección.' },
        durationSec: 60,
      },
    });
  }
  await apiAs(t.host, `/api/v1/modules/courses/${course.id}/publish`, { method: 'POST', bearer });
  const detail = await apiAs<CursoSembrado>(t.host, `/api/v1/modules/courses/${course.id}`, {
    bearer,
  });
  return { ...detail, slug, title };
}

export async function matricular(t: FreshTenant, bearer: string, userId: string, courseId: string) {
  await apiAs(t.host, '/api/v1/modules/learning/enrollments', {
    method: 'POST',
    bearer,
    body: { userId, courseId },
  });
}

/**
 * Da `points` puntos de verdad: un reto abierto sin prueba obligatoria que el
 * alumno entrega y quien administra aprueba (el mismo camino que en el aula).
 */
export async function sumarPuntos(
  t: FreshTenant,
  creador: Auth,
  alumnoAuth: Auth,
  points: number,
  title = `Reto de ${points} puntos ${Date.now().toString(36)}`,
): Promise<void> {
  const reto = await apiAs<{ id: string }>(t.host, `${GAMIF}/admin/challenges`, {
    method: 'POST',
    bearer: creador.tokens.accessToken,
    body: { title, points, proofRequired: false, status: 'OPEN' },
  });
  const entrega = await apiAs<{ id: string }>(t.host, `${GAMIF}/challenges/${reto.id}/submit`, {
    method: 'POST',
    bearer: alumnoAuth.tokens.accessToken,
    body: { note: 'Hecho.' },
  });
  await apiAs(t.host, `${GAMIF}/admin/submissions/${entrega.id}/review`, {
    method: 'POST',
    bearer: creador.tokens.accessToken,
    body: { approve: true },
  });
}

/** Espera a que una condición asíncrona (el bus de eventos) se cumpla. */
export async function hasta<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  ms = 20_000,
): Promise<T> {
  const start = Date.now();
  let last: T = await fn();
  while (!ok(last)) {
    if (Date.now() - start > ms) return last;
    await new Promise((r) => setTimeout(r, 400));
    last = await fn();
  }
  return last;
}

export async function abrir(
  browser: Browser,
  t: FreshTenant,
  auth: Auth,
  path: string,
  viewport = { width: 1280, height: 900 },
): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ locale: 'es-ES', viewport });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: t.base }]);
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

export async function notificaciones(
  t: FreshTenant,
  auth: Auth,
): Promise<Array<{ templateKey: string; metadata: Record<string, unknown> | null }>> {
  const res = await apiAs<
    | Array<{ templateKey: string; metadata: Record<string, unknown> | null }>
    | { items: Array<{ templateKey: string; metadata: Record<string, unknown> | null }> }
  >(t.host, '/api/v1/me/notifications?limit=50', { bearer: auth.tokens.accessToken });
  return Array.isArray(res) ? res : res.items;
}
