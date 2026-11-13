'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Puerta de suscripción del aula, lado navegador.
///
/// La verdad la tiene la API (`apps/api/src/tenancy/subscription-gate.ts`):
/// con el aula en pausa contesta 402 a todo el contenido, pinte el navegador lo
/// que pinte. Esto solo decide QUÉ pantalla enseñar, con tres fuentes:
///
///  - `/auth/tenant-context` dice a cualquiera si el aula está en pausa;
///  - `/me/modules` le da al administrador la prueba, su fecha y el enlace de
///    pago (a nadie más);
///  - cualquier 402 `SUBSCRIPTION_LOCKED` que reciba `apiFetch` cierra la
///    pantalla al momento, para la prueba que vence con la pestaña abierta.

import { SUBSCRIPTION_LOCKED_EVENT } from './api-client';
import { meApi, type MySubscriptionGate } from './me';

export { SUBSCRIPTION_LOCKED_EVENT };

const ADMIN_ROLES = ['super_admin', 'tenant_admin'];

/** ¿Administra la academia? Solo ellos ven la prueba y el enlace de pago. */
export function administraAcademia(roles: readonly string[] | undefined): boolean {
  return (roles ?? []).some((r) => ADMIN_ROLES.includes(r));
}

const DIA_MS = 86_400_000;

/**
 * Días de prueba que quedan, redondeando hacia ARRIBA: con 30 horas por
 * delante quedan «2 días», no «1». 0 si ya terminó.
 */
export function trialDaysLeft(trialEndsAt: string, now = Date.now()): number {
  const fin = Date.parse(trialEndsAt);
  if (Number.isNaN(fin)) return 0;
  const ms = fin - now;
  return ms <= 0 ? 0 : Math.ceil(ms / DIA_MS);
}

/**
 * Rutas que siguen abiertas con el aula en pausa: las de entrar. Sin ellas el
 * administrador no podría iniciar sesión para pagar. El resto de pantallas
 * —también las públicas: catálogo, sitio, alta— enseñan la pausa.
 */
const RUTAS_LIBRES = [
  '/signin',
  '/forgot-password',
  '/reset-password',
  '/mfa',
  '/auth',
  '/support',
  '/setup',
];

export function isGateFreePath(pathname: string | null | undefined): boolean {
  const path = pathname ?? '/';
  return RUTAS_LIBRES.some((r) => path === r || path.startsWith(`${r}/`));
}

/** Solo se acepta un enlace https: es lo único que la API deja guardar. */
export function safeActionUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

const TTL_MS = 60_000;
let cache: { token: string; at: number; promise: Promise<MySubscriptionGate | null> } | null = null;

/**
 * La puerta tal y como la ve el usuario con sesión. La franja y la pantalla de
 * pausa la piden a la vez: se comparte una sola petición por minuto.
 * `null` si la API es anterior a la puerta o la petición falla.
 */
export function fetchMyGate(token: string): Promise<MySubscriptionGate | null> {
  const now = Date.now();
  if (cache && cache.token === token && now - cache.at < TTL_MS) return cache.promise;
  const promise = meApi
    .getMyModules(token)
    .then((res) => res.subscriptionGate ?? null)
    .catch(() => null);
  cache = { token, at: now, promise };
  return promise;
}

export function forgetMyGate(): void {
  cache = null;
}

/**
 * Pista de la pestaña: «la última vez que miré, el aula estaba en pausa». Evita
 * que al recargar se vea un instante el aula antes de la pantalla de pausa. No
 * decide nada por sí sola: en cuanto la API contesta, manda la API.
 */
const PISTA = 'didacta:aula-en-pausa';

export const lockedHint = {
  read(): boolean {
    try {
      return window.sessionStorage.getItem(PISTA) === '1';
    } catch {
      return false;
    }
  },
  write(locked: boolean): void {
    try {
      if (locked) window.sessionStorage.setItem(PISTA, '1');
      else window.sessionStorage.removeItem(PISTA);
    } catch {
      /* almacenamiento no disponible */
    }
  },
};
