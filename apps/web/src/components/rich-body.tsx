'use client';

import { useMemo } from 'react';

/**
 * Renderiza el cuerpo de un post/comentario de comunidad como texto enriquecido:
 *  - URLs sueltas (`https://…`) → enlaces clicables (autolink).
 *  - Enlaces markdown `[texto](https://…)` (lo que inserta el botón de enlace del
 *    compositor) → `<a>` con el texto como etiqueta.
 *  - Menciones `@handle` → resaltadas.
 *
 * Los saltos de línea se preservan con `whitespace-pre-wrap` en el contenedor padre
 * (este componente solo emite nodos inline). Los enlaces hacen `stopPropagation` para
 * que al pinchar uno dentro de una tarjeta clicable (feed) no se abra el post.
 */

export type RichNode =
  | { type: 'text'; value: string }
  | { type: 'link'; href: string; label: string }
  | { type: 'mention'; handle: string };

// Enlace markdown `[label](http…)` O URL suelta `http…`.
const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/g;
// Mención: `@handle` precedido por inicio de cadena o un carácter de borde.
const MENTION_RE = /(^|[\s(.,;:!?[\]{}<>])@([A-Za-z0-9._-]+)/g;

/** Tokeniza menciones dentro de un fragmento de texto (sin enlaces). */
function tokenizeMentions(text: string): RichNode[] {
  const out: RichNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const handle = m[2];
    if (!handle) continue;
    const at = text.indexOf(`@${handle}`, m.index);
    if (at === -1) continue;
    if (at > last) out.push({ type: 'text', value: text.slice(last, at) });
    out.push({ type: 'mention', handle });
    last = at + handle.length + 1;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

/**
 * Tokeniza el cuerpo en nodos {text|link|mention}. Pura y determinista (testeable).
 * Primero separa enlaces (markdown o URL suelta); el resto se pasa por el tokenizador
 * de menciones.
 */
export function tokenizeRichText(body: string): RichNode[] {
  const out: RichNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(body)) !== null) {
    if (m.index > last) out.push(...tokenizeMentions(body.slice(last, m.index)));
    if (m[2]) {
      // Enlace markdown [label](href).
      out.push({ type: 'link', href: m[2], label: m[1] ?? m[2] });
    } else if (m[3]) {
      // URL suelta — no arrastres la puntuación final dentro del href.
      let url = m[3];
      const trail = /[.,;:!?)\]}'"]+$/.exec(url)?.[0] ?? '';
      if (trail) url = url.slice(0, url.length - trail.length);
      out.push({ type: 'link', href: url, label: url });
      if (trail) out.push({ type: 'text', value: trail });
    }
    last = LINK_RE.lastIndex;
  }
  if (last < body.length) out.push(...tokenizeMentions(body.slice(last)));
  return out;
}

export function RichBody({ body }: { body: string }) {
  const nodes = useMemo(() => tokenizeRichText(body), [body]);
  return (
    <>
      {nodes.map((n, i) => {
        if (n.type === 'link') {
          return (
            <a
              key={i}
              href={n.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="break-words text-brand-700 underline underline-offset-2 hover:text-brand-800"
            >
              {n.label}
            </a>
          );
        }
        if (n.type === 'mention') {
          return (
            <span
              key={i}
              className="rounded px-0.5 font-semibold"
              style={{ background: 'var(--didacta-info-bg)', color: 'var(--didacta-info-fg)' }}
            >
              @{n.handle}
            </span>
          );
        }
        return <span key={i}>{n.value}</span>;
      })}
    </>
  );
}
