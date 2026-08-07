/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Preferencias de formato del usuario activo (locale + timezone IANA del
 * perfil). Singleton de módulo poblado por `LocaleSync` en CLIENTE.
 *
 * En server queda vacío A PROPÓSITO (estado de módulo compartido entre
 * requests sería un bug de tenant-bleed): los RSC pasan `{ locale }` explícito
 * a los helpers de `format.ts` — obtenido con `await getLocale()` — y
 * `timeZone` explícita cuando el dato es sensible a zona horaria.
 */

export interface UserFormatPrefs {
  locale?: string;
  timeZone?: string;
}

let prefs: UserFormatPrefs = {};

export function setUserFormatPrefs(next: UserFormatPrefs): void {
  prefs = { ...prefs, ...next };
}

export function getUserFormatPrefs(): UserFormatPrefs {
  return prefs;
}

/** Solo para tests: vuelve al estado inicial. */
export function resetUserFormatPrefs(): void {
  prefs = {};
}

/**
 * Timezone del navegador — ÚNICO sitio permitido para `Intl.*` fuera de los
 * helpers de formato (el guardarraíl de ESLint exime `lib/i18n/**`).
 */
export function getBrowserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
