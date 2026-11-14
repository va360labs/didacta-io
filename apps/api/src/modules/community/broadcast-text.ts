/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { AcademyLocale } from '../../common/academy-defaults';

/**
 * Cabecera del aviso que llega a TODOS los miembros cuando un admin publica
 * con «avisar a todos» (correo + campana). Es un único texto por difusión, así
 * que va en el idioma del aula. Antes se componía en español fijo: un aula
 * inglesa recibía «Ana ha publicado en la comunidad:» en cada aviso.
 */
const COPY: Readonly<Record<AcademyLocale, { posted: (who: string) => string; someone: string }>> =
  {
    es: { posted: (who) => `${who} ha publicado en la comunidad:`, someone: 'Un administrador' },
    en: { posted: (who) => `${who} posted in the community:`, someone: 'An administrator' },
    pt: { posted: (who) => `${who} publicou na comunidade:`, someone: 'Um administrador' },
  };

/** Cuerpo del aviso de difusión: «<autor> ha publicado en la comunidad:» + extracto. */
export function broadcastBodyText(
  locale: AcademyLocale,
  authorName: string | null,
  excerpt: string,
): string {
  const copy = COPY[locale] ?? COPY.es;
  return `${copy.posted(authorName?.trim() || copy.someone)}\n\n${excerpt}`;
}
