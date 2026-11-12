/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Quién firma un correo de un aula y adónde van las respuestas.
 *
 * Con el SMTP compartido de la plataforma, la DIRECCIÓN es siempre la de la
 * plataforma (es la que tiene SPF/DKIM), pero el alumno tiene que ver el
 * NOMBRE de la academia y, si contesta, escribirle al creador:
 *
 *   From: "Academia Ñandú" <hola@didacta.io>
 *   Reply-To: contacto@academia-nandu.com
 *
 * El nombre lo escribe el creador, así que es entrada no fiable que acaba en
 * una cabecera: todo pasa por `sanitizeSenderName` y `sanitizeReplyTo`.
 */
export interface SmtpSenderIdentity {
  /**
   * Nombre que manda sobre el que pase el emisor. Solo existe cuando el aula
   * usa su SMTP PROPIO y escribió un «nombre del remitente»: ahí se respeta lo
   * que configuró.
   */
  fixedName?: string;
  /** Nombre si el emisor no pasa ninguno: el de la plataforma (`SMTP_FROM`). */
  fallbackName?: string;
  /** Adónde van las respuestas. Ya saneado. */
  replyTo?: string;
}

/** Ajuste del aula: `tenant_setting` scope `notifications`, key `sender`. */
export const SENDER_SETTING_MODULE = 'notifications';
export const SENDER_SETTING_KEY = 'sender';

export interface TenantSenderSetting {
  /** «Correo para respuestas». null = no configurado. */
  replyToEmail: string | null;
}

/**
 * Longitud máxima del nombre visible. Los clientes cortan hacia los 40-60
 * caracteres; 64 deja sitio a cualquier nombre real y nada a un párrafo.
 */
export const SENDER_NAME_MAX = 64;

/**
 * Caracteres que convierten un nombre en algo con forma de dirección
 * («soporte@banco.com <x@y>») o rompen el entrecomillado: `<` `>` `@` `"` `\`
 * y sus parecidos de ancho completo/pequeños, que un cliente de correo pinta
 * igual que los ASCII.
 */
const ADDRESS_LIKE = /[<>@"\\\uFF1C\uFF1E\uFF20\uFE6B\uFE64\uFE65\u2039\u203A\u00AB\u00BB]/g;

/**
 * Controles (CR, LF, TAB, NUL, C1…), separadores de línea/párrafo Unicode y
 * caracteres de formato (marcas bidi que invierten el texto, espacios de ancho
 * cero). Cualquiera de ellos en una cabecera es inyección o suplantación.
 */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Deja un nombre de academia apto para el `From`. Devuelve null si no queda
 * nada utilizable (y entonces el emisor cae al siguiente nombre de la cadena).
 * La codificación RFC 2047 de acentos y «ñ» la hace nodemailer al serializar
 * `{ name, address }`; aquí solo se decide QUÉ texto llega.
 */
export function sanitizeSenderName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .normalize('NFC')
    .replace(CONTROL_OR_FORMAT, ' ')
    .replace(ADDRESS_LIKE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  const chars = Array.from(cleaned);
  const cut =
    chars.length > SENDER_NAME_MAX ? chars.slice(0, SENDER_NAME_MAX).join('').trim() : cleaned;
  return cut || null;
}

/**
 * Una sola dirección, sin nada que pueda partir la cabecera en dos (coma,
 * punto y coma, espacios, controles) ni nombre visible. Devuelve null si no
 * lo es: un Reply-To dudoso se omite, nunca se «arregla».
 */
export function sanitizeReplyTo(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 254) return null;
  if (/[\s,;<>"\\()[\]:]/.test(value) || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return null;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? value : null;
}

/** El nombre de «Nombre <email>» de `SMTP_FROM`, o null si solo hay dirección. */
export function displayNameFromAddress(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
  return m && m[1] ? sanitizeSenderName(m[1]) : null;
}

/**
 * Nombre que acaba en el `From`, por orden: el fijado por el SMTP propio del
 * aula → el que pasa el emisor (el nombre de la academia) → el de la
 * plataforma. null = la dirección sola.
 */
export function resolveSenderName(
  identity: SmtpSenderIdentity | undefined,
  callerName: string | undefined,
): string | null {
  return (
    sanitizeSenderName(identity?.fixedName) ??
    sanitizeSenderName(callerName) ??
    sanitizeSenderName(identity?.fallbackName)
  );
}
