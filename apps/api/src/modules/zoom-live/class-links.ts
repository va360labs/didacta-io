/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Enlaces públicos de una clase en directo que viajan por email.
 *
 * Todos cuelgan de `WEB_PUBLIC_URL` (el dominio del tenant, no el de la API):
 * Next reescribe `/api/:path*` hacia la API, así que un enlace de calendario
 * servido desde el dominio de siempre funciona igual y no delata una URL
 * interna en la bandeja de entrada.
 *
 * Si `WEB_PUBLIC_URL` no está configurada, devuelven '' — las plantillas
 * envuelven cada enlace en una sección mustache (`{{#classUrl}}…{{/classUrl}}`)
 * y el bloque desaparece del email en vez de mandar una URL rota.
 */

function webBase(): string {
  return (process.env['WEB_PUBLIC_URL'] ?? '').trim().replace(/\/+$/, '');
}

/** Página de la clase — el único sitio donde se ve el `joinUrl` (ADR-017). */
export function classUrl(sessionId: string): string {
  const base = webBase();
  return base ? `${base}/clase/${sessionId}` : '';
}

/** Descarga del `.ics`: Outlook, Apple Calendar y cualquier cliente estándar. */
export function calendarIcsUrl(sessionId: string): string {
  const base = webBase();
  return base ? `${base}/api/v1/modules/zoom-live/sessions/${sessionId}/calendar.ics` : '';
}

/** Redirección al "añadir evento" de Google Calendar. */
export function calendarGoogleUrl(sessionId: string): string {
  const base = webBase();
  return base ? `${base}/api/v1/modules/zoom-live/sessions/${sessionId}/calendar/google` : '';
}

/**
 * Variables de calendario comunes a los emails de la clase (confirmación de
 * inscripción y recordatorio). Un único sitio que cambiar si mañana se añade
 * otro proveedor.
 */
export function calendarVariables(sessionId: string): {
  classUrl: string;
  calendarGoogleUrl: string;
  calendarIcsUrl: string;
} {
  return {
    classUrl: classUrl(sessionId),
    calendarGoogleUrl: calendarGoogleUrl(sessionId),
    calendarIcsUrl: calendarIcsUrl(sessionId),
  };
}
