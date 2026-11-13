/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Puerta de suscripción, lado navegador: la cuenta de días de la franja, las
 * rutas que siguen abiertas con el aula en pausa, el enlace de pago que se
 * acepta y el aviso que dispara cualquier 402 `SUBSCRIPTION_LOCKED`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, SUBSCRIPTION_LOCKED_EVENT } from './api-client';
import {
  administraAcademia,
  isGateFreePath,
  safeActionUrl,
  trialDaysLeft,
} from './subscription-gate';

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const HORA = 3_600_000;

describe('trialDaysLeft', () => {
  it('redondea hacia arriba: con 30 horas por delante quedan 2 días', () => {
    expect(trialDaysLeft(new Date(NOW + 30 * HORA).toISOString(), NOW)).toBe(2);
  });

  it('la última hora sigue siendo «1 día», no «0»', () => {
    expect(trialDaysLeft(new Date(NOW + HORA).toISOString(), NOW)).toBe(1);
  });

  it('siete días exactos son 7', () => {
    expect(trialDaysLeft(new Date(NOW + 7 * 24 * HORA).toISOString(), NOW)).toBe(7);
  });

  it('vencida o con una fecha ilegible: 0', () => {
    expect(trialDaysLeft(new Date(NOW).toISOString(), NOW)).toBe(0);
    expect(trialDaysLeft(new Date(NOW - HORA).toISOString(), NOW)).toBe(0);
    expect(trialDaysLeft('no-es-una-fecha', NOW)).toBe(0);
  });
});

describe('isGateFreePath — lo que sigue abierto con el aula en pausa', () => {
  it.each([
    '/signin',
    '/forgot-password',
    '/reset-password',
    '/mfa/verify',
    '/auth/callback',
    '/support/access',
  ])('%s sigue abierta (hay que poder entrar a pagar)', (path) => {
    expect(isGateFreePath(path)).toBe(true);
  });

  it.each([
    '/',
    '/home',
    '/courses/abc',
    '/admin',
    '/signup',
    '/catalog',
    '/join',
    '/site',
    '/signin-x',
  ])('%s enseña la pausa', (path) => {
    expect(isGateFreePath(path)).toBe(false);
  });
});

describe('safeActionUrl', () => {
  it('solo acepta https', () => {
    expect(safeActionUrl('https://didacta.io/es/pricing?upgrade=tok')).toBe(
      'https://didacta.io/es/pricing?upgrade=tok',
    );
    expect(safeActionUrl('http://didacta.io/es/pricing')).toBeNull();
    expect(safeActionUrl('javascript:alert(1)')).toBeNull();
    expect(safeActionUrl('no es una url')).toBeNull();
    expect(safeActionUrl(null)).toBeNull();
  });
});

describe('administraAcademia', () => {
  it('solo tenant_admin y super_admin', () => {
    expect(administraAcademia(['tenant_admin'])).toBe(true);
    expect(administraAcademia(['super_admin'])).toBe(true);
    expect(administraAcademia(['formador'])).toBe(false);
    expect(administraAcademia(['alumno'])).toBe(false);
    expect(administraAcademia(undefined)).toBe(false);
  });
});

describe('apiFetch ante un 402 SUBSCRIPTION_LOCKED', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubResponse(status: number, body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    const win = new EventTarget();
    const recibido = vi.fn();
    win.addEventListener(SUBSCRIPTION_LOCKED_EVENT, recibido);
    vi.stubGlobal('window', win);
    return recibido;
  }

  it('avisa a la pantalla de pausa y sigue lanzando el error al llamante', async () => {
    const recibido = stubResponse(402, { code: 'SUBSCRIPTION_LOCKED', message: 'en pausa' });
    const error = await apiFetch('/api/v1/modules/courses').catch((e: unknown) => e);
    expect(recibido).toHaveBeenCalledTimes(1);
    expect((error as { status?: number }).status).toBe(402);
  });

  it('un 402 de licencia (otra cosa) NO cierra el aula', async () => {
    const recibido = stubResponse(402, { capability: 'feat:scim', message: 'requiere EE' });
    await apiFetch('/api/v1/admin/scim/token').catch(() => undefined);
    expect(recibido).not.toHaveBeenCalled();
  });
});
