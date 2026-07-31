/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Detección de la clase en directo referenciada por un post de comunidad.
///
/// Un post puede anunciar una clase de dos formas:
///
///  1. **Marcador explícito** `<!--didacta-clase:<uuid>-->` al final del body.
///     Lo escribe el puente del host que anuncia las clases recién creadas
///     (`ZoomLiveCommunityBridge` en la API). Mismo patrón que el marcador de
///     adjuntos de `modules/community/attachments.ts`: metadato invisible
///     pegado al body, que el render separa del texto.
///  2. **Enlace pegado a mano** a `/clase/<uuid>` (absoluto o relativo) dentro
///     del texto. Así un miembro que comparte el enlace de una clase obtiene
///     la misma tarjeta rica sin saber nada del marcador.
///
/// Esta es la ÚNICA fuente de verdad del formato: cualquier render del body
/// debe pasar por `parseClaseEmbed`.

const CLASE_MARKER = '<!--didacta-clase:';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const MARKER_RE = new RegExp(`<!--didacta-clase:(${UUID})-->`);
/** `https://host/clase/<uuid>` o `/clase/<uuid>`, con o sin barra final. */
const CLASE_URL_RE = new RegExp(`(?:https?://[^\\s/]+)?/clase/(${UUID})/?`, 'g');

export interface ParsedClaseEmbed {
  /** Texto visible del post, sin marcador y sin la URL ya representada. */
  cleanBody: string;
  /** Sesión de mod.zoom-live a la que apunta el post, o null. */
  sessionId: string | null;
}

/** Contraparte de `parseClaseEmbed` para quien componga el body en el cliente. */
export function buildClaseAnnouncementBody(text: string, sessionId: string): string {
  return `${text.trim()}\n\n${CLASE_MARKER}${sessionId}-->`;
}

export function parseClaseEmbed(body: string): ParsedClaseEmbed {
  const marker = MARKER_RE.exec(body);
  if (marker) {
    return {
      cleanBody: body.replace(MARKER_RE, '').trimEnd(),
      sessionId: marker[1]!.toLowerCase(),
    };
  }

  // Sin marcador: el primer enlace a una clase manda. Se quita del texto
  // porque la tarjeta ya lo representa (igual que cualquier "unfurl"), pero
  // solo el que se convierte en tarjeta — los demás siguen siendo enlaces.
  CLASE_URL_RE.lastIndex = 0;
  const link = CLASE_URL_RE.exec(body);
  if (!link) return { cleanBody: body, sessionId: null };

  const withoutLink = body.slice(0, link.index) + body.slice(link.index + link[0].length);
  return {
    // Al quitar la URL puede quedar espacio doble o una línea vacía colgando.
    cleanBody: withoutLink
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    sessionId: link[1]!.toLowerCase(),
  };
}
