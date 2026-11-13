/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Puerta de suscripción del tenant.
///
/// ## Lo que ESTO es
///
/// Una dimensión aparte del estado del tenant. `tenant.status` dice si el aula
/// existe y se sirve (ACTIVE / SUSPENDED / ARCHIVED); la puerta dice si, además,
/// su contenido está abierto, en prueba o en pausa. Un aula con la prueba
/// terminada sigue ACTIVE a propósito: su administrador tiene que poder entrar,
/// ver que está en pausa y pagar. Suspenderla le cerraría hasta el login.
///
/// | estado   | contenido | qué ve el aula                                    |
/// |----------|-----------|---------------------------------------------------|
/// | `OPEN`   | se sirve  | nada                                              |
/// | `TRIAL`  | se sirve  | franja «Prueba gratis» solo para administradores  |
/// | `LOCKED` | 402       | pantalla de pausa para todos; el login sigue vivo |
///
/// ## Lo que ESTO no es
///
/// **No es una política.** El núcleo no cuenta días, no mira planes ni licencias
/// y no cierra a nadie por su cuenta. Quien mueve la puerta es el plano de
/// control del SaaS (`PUT /admin/tenants/:id/subscription-gate`) o un
/// super_admin. Una instalación self-hosted nunca recibe esa llamada y se queda
/// en `OPEN` para siempre, que es el valor por defecto de la columna.
///
/// La única lectura propia es defensiva: una prueba cuya fecha ya pasó se trata
/// como cerrada aunque el plano de control todavía no haya llamado (su tarea
/// periódica puede ir con retraso). Esa fecha la puso él; el núcleo solo la
/// respeta.

/** Código estable de la respuesta 402. Contrato con el aula y con Cloud: no se cambia. */
export const SUBSCRIPTION_LOCKED_CODE = 'SUBSCRIPTION_LOCKED';

export const SUBSCRIPTION_GATE_STATES = ['OPEN', 'TRIAL', 'LOCKED'] as const;
export type GateState = (typeof SUBSCRIPTION_GATE_STATES)[number];

/** Lo mínimo que hace falta leer del tenant. */
export interface GateRow {
  subscriptionGateState: GateState;
  subscriptionTrialEndsAt: Date | null;
  subscriptionActionUrl: string | null;
}

export interface EffectiveGate {
  state: GateState;
  trialEndsAt: Date | null;
  actionUrl: string | null;
}

export const OPEN_GATE: EffectiveGate = { state: 'OPEN', trialEndsAt: null, actionUrl: null };

/**
 * Estado que se aplica AHORA. `TRIAL` con la fecha ya pasada es `LOCKED`: el
 * cron de Cloud puede llegar tarde, y la prueba no se alarga por eso.
 */
export function effectiveGate(row: GateRow | null | undefined, now = Date.now()): EffectiveGate {
  if (!row) return OPEN_GATE;
  const trialEndsAt = row.subscriptionTrialEndsAt;
  const actionUrl = row.subscriptionActionUrl;
  if (row.subscriptionGateState === 'OPEN') return OPEN_GATE;
  if (
    row.subscriptionGateState === 'TRIAL' &&
    trialEndsAt !== null &&
    trialEndsAt.getTime() <= now
  ) {
    return { state: 'LOCKED', trialEndsAt, actionUrl };
  }
  return { state: row.subscriptionGateState, trialEndsAt, actionUrl };
}

/**
 * Rutas que siguen respondiendo con la puerta cerrada. Es la lista MÍNIMA que
 * pide el contrato: autenticarse, saber quién eres, pintar la marca del aula y
 * leer el estado de la puerta. Más tres grupos que no son contenido del aula:
 *
 *  - las sondas y metadatos de la instancia (salud, licencia, setup);
 *  - las rutas de super_admin sobre tenants, que operan la instalación entera
 *    (sin ellas no se podría ni reabrir el aula desde el panel);
 *  - los webhooks entrantes de pasarelas y de Zoom: no sirven nada a nadie, y
 *    rechazarlos haría que el proveedor reintentase hasta rendirse y que el
 *    aula reabriese con su estado de cobros desincronizado.
 *
 * Rutas relativas al prefijo `api/v1` (las que lo excluyen, tal cual).
 * `method: '*'` vale para cualquier verbo.
 */
interface ExemptRule {
  method: 'GET' | 'POST' | '*';
  /** Ruta exacta, o prefijo si termina en `/`. */
  path: string;
}

export const SUBSCRIPTION_GATE_EXEMPT: readonly ExemptRule[] = [
  // Instancia: sondas, licencia, documentación y estado del asistente.
  { method: 'GET', path: '/healthz' },
  { method: 'GET', path: '/readyz' },
  { method: 'GET', path: '/livez' },
  { method: 'GET', path: '/metrics' },
  { method: 'GET', path: '/api/license' },
  { method: 'GET', path: '/api/docs/' },
  { method: 'GET', path: '/setup/status' },
  { method: 'GET', path: '/tenancy/resolve' },

  // Autenticarse. `signup` NO está: dar de alta a alguien nuevo es contenido.
  { method: 'GET', path: '/auth/tenant-context' },
  { method: 'POST', path: '/auth/signin' },
  { method: 'POST', path: '/auth/refresh' },
  { method: 'POST', path: '/auth/forgot-password' },
  { method: 'POST', path: '/auth/reset-password' },
  { method: '*', path: '/auth/mfa/' },
  { method: '*', path: '/auth/oidc/' },
  { method: '*', path: '/auth/saml/' },
  { method: 'GET', path: '/modules/wp-sso/' },
  { method: '*', path: '/auth/support-access/' },

  // Saber quién eres y leer el estado de la puerta (`/me/modules` lo lleva
  // para el administrador, con el enlace de pago).
  { method: 'GET', path: '/me/profile' },
  { method: 'GET', path: '/me/modules' },

  // Pintar la marca del aula.
  { method: 'GET', path: '/modules/theming/me' },
  { method: 'GET', path: '/modules/theming/tenants/' },

  // Operación de la instalación (super_admin o credencial de provisioning).
  { method: '*', path: '/admin/tenants' },
  { method: '*', path: '/admin/tenants/' },

  // Webhooks entrantes.
  { method: 'POST', path: '/modules/billing/webhook' },
  { method: 'POST', path: '/modules/subscriptions/webhook' },
  { method: 'POST', path: '/modules/payment-connections/woo-webhook' },
  { method: 'POST', path: '/webhooks/zoom' },
  { method: 'POST', path: '/video/bunny/webhook' },
];

const API_PREFIX = '/api/v1';

/** Ruta de la petición sin query, sin barra final y sin el prefijo `api/v1`. */
export function gatePath(rawUrl: string | undefined): string {
  let path = (rawUrl ?? '/').split('?', 1)[0] ?? '/';
  if (path.startsWith(API_PREFIX + '/') || path === API_PREFIX) {
    path = path.slice(API_PREFIX.length) || '/';
  }
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

/** ¿Esta petición sigue respondiendo aunque la puerta esté cerrada? */
export function isGateExempt(method: string | undefined, rawUrl: string | undefined): boolean {
  const verb = (method ?? 'GET').toUpperCase();
  const path = gatePath(rawUrl);
  return SUBSCRIPTION_GATE_EXEMPT.some((rule) => {
    // HEAD y OPTIONS no sirven contenido: se tratan como el GET de la misma ruta.
    const verbMatches =
      rule.method === '*' ||
      rule.method === verb ||
      (rule.method === 'GET' && (verb === 'HEAD' || verb === 'OPTIONS'));
    if (!verbMatches) return false;
    return rule.path.endsWith('/') ? path.startsWith(rule.path) : path === rule.path;
  });
}
