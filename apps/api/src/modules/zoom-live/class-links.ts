/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Enlaces públicos de una clase en directo que viajan por email.
 *
 * Todos cuelgan de la dirección pública del aula DEL TENANT (su dominio, no el
 * de la API): Next reescribe `/api/:path*` hacia la API, así que un enlace de
 * calendario servido desde el dominio de siempre funciona igual y no delata
 * una URL interna en la bandeja de entrada.
 *
 * La base la resuelve quien llama con
 * `TenantResolverService.resolveTenantWebBaseUrlForBackground` (dominio
 * primario verificado del tenant; `WEB_PUBLIC_URL` solo si no tiene) y la pasa
 * aquí. Es OBLIGATORIA a propósito: estas funciones leían `WEB_PUBLIC_URL` por
 * su cuenta y, en un servidor con varias academias, el recordatorio de clase
 * de cada una enlazaba al dominio general del servidor.
 *
 * Con base `''` (ni dominio de tenant ni `WEB_PUBLIC_URL`) devuelven '' — las
 * plantillas envuelven cada enlace en una sección mustache
 * (`{{#classUrl}}…{{/classUrl}}`) y el bloque desaparece del email en vez de
 * mandar una URL rota.
 */

function clean(webBase: string): string {
  return webBase.trim().replace(/\/+$/, '');
}

/** Página de la clase — el único sitio donde se ve el `joinUrl` (ADR-017). */
export function classUrl(webBase: string, sessionId: string): string {
  const base = clean(webBase);
  return base ? `${base}/live/${sessionId}` : '';
}

/** Descarga del `.ics`: Outlook, Apple Calendar y cualquier cliente estándar. */
export function calendarIcsUrl(webBase: string, sessionId: string): string {
  const base = clean(webBase);
  return base ? `${base}/api/v1/modules/zoom-live/sessions/${sessionId}/calendar.ics` : '';
}

/** Redirección al "añadir evento" de Google Calendar. */
export function calendarGoogleUrl(webBase: string, sessionId: string): string {
  const base = clean(webBase);
  return base ? `${base}/api/v1/modules/zoom-live/sessions/${sessionId}/calendar/google` : '';
}

/**
 * Variables de calendario comunes a los emails de la clase (confirmación de
 * inscripción y recordatorio). Un único sitio que cambiar si mañana se añade
 * otro proveedor.
 */
export function calendarVariables(
  webBase: string,
  sessionId: string,
): {
  classUrl: string;
  calendarGoogleUrl: string;
  calendarIcsUrl: string;
} {
  return {
    classUrl: classUrl(webBase, sessionId),
    calendarGoogleUrl: calendarGoogleUrl(webBase, sessionId),
    calendarIcsUrl: calendarIcsUrl(webBase, sessionId),
  };
}
