/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Lectura/escritura de la cookie de idioma desde CLIENTE. No es httpOnly a
 * propósito: es una preferencia de presentación, no un secreto, y no hay
 * session server-side en Next que pudiera validarla (el JWT vive en
 * sessionStorage del navegador).
 */

import { LOCALE_COOKIE, type SupportedLocale } from '@/i18n/config';

export function readLocaleCookie(): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export function writeLocaleCookie(tag: SupportedLocale): void {
  document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(tag)}; path=/; max-age=31536000; samesite=lax`;
}
