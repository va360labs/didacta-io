/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Trozos de un mensaje: texto tal cual y enlaces http(s) para pintarlos
 * clicables. Solo http y https: un `javascript:` escrito en un mensaje se
 * queda en texto. La puntuación que cierra una frase («…/cata-de-cafe.») no
 * entra en el enlace.
 */
export type MessagePart = { type: 'text'; value: string } | { type: 'link'; href: string };

const URL_RE = /https?:\/\/[^\s<>"]+/g;
const TRAILING = /[.,;:!?)\]»”'’]+$/;

export function splitLinks(body: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let last = 0;
  for (const m of body.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const href = m[0].replace(TRAILING, '');
    if (!href) continue;
    if (start > last) parts.push({ type: 'text', value: body.slice(last, start) });
    parts.push({ type: 'link', href });
    last = start + href.length;
  }
  if (last < body.length) parts.push({ type: 'text', value: body.slice(last) });
  return parts.length > 0 ? parts : [{ type: 'text', value: body }];
}
