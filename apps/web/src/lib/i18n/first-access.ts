/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  academyUiLocale,
  toSupportedLocale,
  type AcademyLocale,
  type SupportedLocale,
} from '@/i18n/config';

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
 * se toma lo del navegador: su zona (si `Intl` la reconoce) y el idioma con el
 * que está viendo el aula (`viewingLocale`: su cookie o, sin ella, el idioma
 * del aula; si no se sabe ninguno, no hay nada que adoptar). Después de eso
 * manda lo que el usuario elija en su perfil y aquí no se toca nada.
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

/**
 * Idioma con el que alguien está viendo el aula: el de su cookie o, sin ella,
 * el del aula (con el que la web pinta a quien entra sin cookie). `null` si no
 * se sabe ninguno: entonces no hay nada que adoptar en el primer acceso.
 */
export function viewingLocale(
  cookie: string | null,
  academy: AcademyLocale | null | undefined,
): string | null {
  return cookie ?? (academy ? academyUiLocale(academy) : null);
}

/**
 * Tag que hay que escribir en la cookie para que se pinte el idioma del perfil,
 * o `null` si ya se pinta en él. Se compara con lo que SE PINTA (la cookie o,
 * sin ella, el idioma activo, que es el del aula), no solo con la cookie: sin
 * cookie, un perfil en español en un aula en inglés se quedaba en inglés. La
 * preferencia de cada usuario manda para ese usuario.
 */
export function profileLocaleToApply(
  profileLocale: string,
  cookie: string | null,
  active: string,
): SupportedLocale | null {
  const wanted = toSupportedLocale(profileLocale);
  return wanted !== toSupportedLocale(cookie ?? active) ? wanted : null;
}
