/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Versión del producto, DERIVADA — no se edita a mano.
///
/// `next.config.mjs` lee el `version` del package.json RAÍZ en build-time y lo
/// inyecta como `NEXT_PUBLIC_APP_VERSION` (inline en el bundle, no una lectura
/// de entorno en runtime). Ese `version` es la fuente de verdad real: lo bumpea
/// cada commit `chore(release): corte X` y sobre ese commit se pone el tag `vX`
/// que dispara `.github/workflows/release.yml`.
///
/// Antes esto era un literal que había que acordarse de tocar en cada release.
/// Nadie se acordó: se quedó en `0.0.1-alpha.88` mientras el producto iba por
/// `0.0.1-alpha.101` — 13 releases mintiéndole al operador.

/// Valor que se pinta cuando el build NO inyectó la versión (tests unitarios,
/// cualquier consumidor fuera del build de Next). Constante nombrada a
/// propósito, no un default implícito: `parseVersion()` lo acepta como semver,
/// así que el banner de actualización lo tratará como "muy vieja" y avisará —
/// exactamente lo que queremos que pase si un día el build se rompe, en vez de
/// fingir una versión concreta.
export const APP_VERSION_UNKNOWN = '0.0.0-unknown';

export const APP_VERSION: string = process.env.NEXT_PUBLIC_APP_VERSION || APP_VERSION_UNKNOWN;

/// Canal de release. Se deduce del pre-release de la propia versión en vez de
/// declararse aparte: dos constantes independientes se desincronizan (es
/// justo el fallo que tenía `APP_VERSION`).
export type AppChannel = 'alpha' | 'beta' | 'rc' | 'stable';

export function channelOf(version: string): AppChannel {
  const pre = version.split('-')[1] ?? '';
  if (pre.startsWith('alpha')) return 'alpha';
  if (pre.startsWith('beta')) return 'beta';
  if (pre.startsWith('rc')) return 'rc';
  return 'stable';
}

export const APP_CHANNEL: AppChannel = channelOf(APP_VERSION);
