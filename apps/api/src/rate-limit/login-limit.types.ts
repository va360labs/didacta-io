/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Limitador propio del ACCESO: login, alta, restablecer contraseña, MFA y el
 * canje del acceso de soporte.
 *
 * Antes solo los protegía el cupo público general (30/min por IP), que además
 * comparten con todo lo demás que pide una página sin sesión, y no había
 * bloqueo por cuenta: desde muchas IP se podía probar contraseñas contra la
 * misma cuenta sin freno. Con este limitador aparte, el cupo público general
 * puede subir sin abrir la puerta a la fuerza bruta.
 *
 * Dos contadores, con la ventana anclada al PRIMER intento (la clave caduca
 * `windowSeconds` después de crearse; no hay doble ráfaga en el cambio de
 * minuto como en el cupo general):
 *
 *   - por IP (todas las rutas de acceso juntas): RATE_LIMIT_LOGIN_IP_MAX
 *     intentos en RATE_LIMIT_LOGIN_IP_WINDOW_SECONDS. Default 30 / 60 s.
 *   - por cuenta: el correo normalizado (en el dominio por el que se entra)
 *     o, en MFA, el usuario de la sesión. RATE_LIMIT_LOGIN_ACCOUNT_MAX en
 *     RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SECONDS. Default 10 / 900 s (15 min).
 *
 * Qué cuenta como intento: los FALLIDOS (4xx) en login, alta, restablecer,
 * MFA y canje; TODOS en «olvidé mi contraseña» y en el reenvío del enlace, que
 * contestan 200 siempre (no revelan si la cuenta existe) y mandan un correo.
 * Un éxito no gasta cupo: una clase entera detrás de la misma IP puede entrar
 * a la vez. Un login correcto pone a cero los fallos de esa cuenta.
 *
 * Nada de esto depende de que la cuenta exista: el correo se cuenta igual, y
 * el 429 es el mismo. Averiguar si un correo está dado de alta por el
 * limitador no es posible.
 */

/** Cada ruta protegida, con su política. */
export type LoginLimitKind =
  | 'signin'
  | 'signup'
  | 'forgot-password'
  | 'reset-password'
  | 'reset-resend'
  | 'mfa'
  | 'support-redeem';

export interface LoginLimitPolicy {
  /** De dónde sale la cuenta: el `email` del cuerpo, el usuario de la sesión, o nada. */
  account: 'email' | 'user' | null;
  /** `failure`: solo cuentan los intentos fallidos; `always`: todos. */
  countOn: 'failure' | 'always';
  /** Un éxito pone a cero los fallos de la cuenta. */
  resetAccountOnSuccess: boolean;
}

export const LOGIN_LIMIT_POLICIES: Readonly<Record<LoginLimitKind, LoginLimitPolicy>> = {
  signin: { account: 'email', countOn: 'failure', resetAccountOnSuccess: true },
  signup: { account: 'email', countOn: 'failure', resetAccountOnSuccess: false },
  'forgot-password': { account: 'email', countOn: 'always', resetAccountOnSuccess: false },
  'reset-password': { account: null, countOn: 'failure', resetAccountOnSuccess: false },
  'reset-resend': { account: null, countOn: 'always', resetAccountOnSuccess: false },
  mfa: { account: 'user', countOn: 'failure', resetAccountOnSuccess: true },
  'support-redeem': { account: null, countOn: 'failure', resetAccountOnSuccess: false },
};

export interface LoginLimitConfig {
  ipMax: number;
  ipWindowSeconds: number;
  accountMax: number;
  accountWindowSeconds: number;
}

export const DEFAULT_LOGIN_LIMIT_CONFIG: LoginLimitConfig = {
  ipMax: 30,
  ipWindowSeconds: 60,
  accountMax: 10,
  accountWindowSeconds: 900,
};

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveLoginLimitConfig(): LoginLimitConfig {
  return {
    ipMax: positiveInt('RATE_LIMIT_LOGIN_IP_MAX', DEFAULT_LOGIN_LIMIT_CONFIG.ipMax),
    ipWindowSeconds: positiveInt(
      'RATE_LIMIT_LOGIN_IP_WINDOW_SECONDS',
      DEFAULT_LOGIN_LIMIT_CONFIG.ipWindowSeconds,
    ),
    accountMax: positiveInt('RATE_LIMIT_LOGIN_ACCOUNT_MAX', DEFAULT_LOGIN_LIMIT_CONFIG.accountMax),
    accountWindowSeconds: positiveInt(
      'RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SECONDS',
      DEFAULT_LOGIN_LIMIT_CONFIG.accountWindowSeconds,
    ),
  };
}

/** Código del 429 del acceso (lo traduce la web: es/en/pt). */
export const LOGIN_RATE_LIMITED_CODE = 'AUTH_RATE_LIMITED';
