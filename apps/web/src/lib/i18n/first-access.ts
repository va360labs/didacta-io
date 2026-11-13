/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { toSupportedLocale, type SupportedLocale } from '@/i18n/config';

/**
 * Primer acceso: zona horaria e idioma del perfil a partir del navegador.
 *
 * Un alumno nuevo nace con los valores por defecto de la base (`UTC`, `es-ES`)
 * o, si lo creó el servidor (compra, invitación), con la zona del aula. Nadie
 * le ha preguntado todavía: en España un directo de las 19:00 se le pintaba a
 * las 18:00, y en un aula en inglés el perfil en español le cambiaba la
 * interfaz al español nada más entrar.
 *
 * Mientras no haya terminado el primer acceso (`onboardingCompletedAt` nulo),
 * se toma lo del navegador: su zona (si `Intl` la reconoce) y el idioma de la
 * cookie con el que está viendo el aula (solo si hay cookie: sin ella no hay
 * nada que adoptar). Después de eso manda lo que el usuario elija en su perfil
 * y aquí no se toca nada.
 */

export function isBrowserTimeZone(tz: string | undefined | null): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface FirstAccessInput {
  /** Ya terminó el primer acceso: lo del perfil es una elección suya. */
  onboarded: boolean;
  profileLocale: string;
  profileTimeZone: string;
  /** Cookie `didacta_locale` tal cual (null si no hay). */
  cookieLocale: string | null;
  browserTimeZone: string | undefined;
}

export interface FirstAccessPatch {
  locale?: SupportedLocale;
  timezone?: string;
}

export function firstAccessPatch(input: FirstAccessInput): FirstAccessPatch | null {
  if (input.onboarded) return null;
  const patch: FirstAccessPatch = {};
  if (isBrowserTimeZone(input.browserTimeZone) && input.browserTimeZone !== input.profileTimeZone) {
    patch.timezone = input.browserTimeZone;
  }
  if (input.cookieLocale) {
    const wanted = toSupportedLocale(input.cookieLocale);
    if (wanted !== toSupportedLocale(input.profileLocale)) patch.locale = wanted;
  }
  return patch.timezone || patch.locale ? patch : null;
}

/**
 * Zona con la que arranca el formulario del primer acceso: la del navegador si
 * la hay; si no, la que trae el perfil (la del aula, si lo creó el servidor).
 */
export function firstAccessTimeZone(
  profileTimeZone: string,
  browserTimeZone: string | undefined,
): string {
  return isBrowserTimeZone(browserTimeZone) ? browserTimeZone : profileTimeZone;
}
