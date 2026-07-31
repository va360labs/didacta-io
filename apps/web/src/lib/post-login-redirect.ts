/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Destino pendiente tras el login ("deep link"): cuando un usuario anónimo
 * intenta entrar a una ruta protegida (p. ej. el enlace compartido de un post,
 * `/comunidad/<id>`), guardamos esa ruta ANTES de mandarlo a /signin y la
 * consumimos al completar cualquier flujo de autenticación (password, MFA
 * verify/setup, OIDC o WP-SSO). Los gates del shell (onboarding pendiente,
 * contraseña temporal) re-guardan el destino antes de desviar, así el valor
 * sobrevive hasta el último salto sin gates.
 *
 * Se usa sessionStorage (scoped a la pestaña) y no un query param porque el
 * signin puede rebotar a WordPress (mod.wp-sso) o al IdP OIDC: el roundtrip
 * completo ocurre en la misma pestaña, así que el valor sobrevive, mientras
 * que un `?next=` se perdería en los redirects externos.
 */

const KEY = 'didacta.post_login_redirect';

/**
 * Backslash y ASCII tab/CR/LF: el parser WHATWG los convierte en `/` o los
 * elimina ANTES de parsear, con lo que `/\evil.test` o `/\t/evil.test`
 * terminarían siendo `//evil.test` (cross-origin). Se rechazan en crudo.
 */
const RAW_REJECT = /[\\\t\r\n]/;

/**
 * Solo rutas internas relativas: se resuelven con el parser real de URL contra
 * el origin actual (igual que hace Next al navegar) y se exige mismo origen.
 * Se descartan las pantallas de auth/onboarding para no crear bucles.
 */
export function sanitizeInternalPath(path: string | null | undefined): string | null {
  if (!path || RAW_REJECT.test(path)) return null;
  if (!path.startsWith('/') || path.startsWith('//')) return null;

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://didacta.invalid';
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;

  // Prefijos evaluados sobre el pathname NORMALIZADO (p. ej. `/./signin` ya
  // quedó como `/signin` y no esquiva el filtro anti-bucle).
  const p = url.pathname;
  if (p === '/') return null;
  if (
    p.startsWith('/signin') ||
    p.startsWith('/signup') ||
    p.startsWith('/auth/') ||
    p.startsWith('/mfa/') ||
    p.startsWith('/forgot-password') ||
    p.startsWith('/reset-password') ||
    p.startsWith('/onboarding')
  ) {
    return null;
  }
  return p + url.search;
}

export function rememberIntendedPath(path: string): void {
  const safe = sanitizeInternalPath(path);
  if (!safe) return;
  try {
    sessionStorage.setItem(KEY, safe);
  } catch {
    /* almacenamiento no disponible */
  }
}

/** Devuelve y borra el destino pendiente (o null si no hay/es inválido). */
export function consumeIntendedPath(): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return sanitizeInternalPath(raw);
  } catch {
    return null;
  }
}

/**
 * Borra el destino pendiente sin consumirlo. Se llama en el logout explícito:
 * un valor huérfano no debe redirigir al siguiente usuario que entre en esta
 * pestaña al post que miraba el anterior.
 */
export function clearIntendedPath(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* almacenamiento no disponible */
  }
}
