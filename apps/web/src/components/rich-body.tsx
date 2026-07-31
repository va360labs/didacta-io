'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useMemo } from 'react';

/**
 * Renderiza el cuerpo de un post/comentario de comunidad como texto enriquecido
 * con un subconjunto seguro de Markdown (sin dependencias, mismo criterio que el
 * icon set: bundle controlado y gramática exactamente documentada):
 *
 * Bloques (por línea):
 *  - `# / ## / ###` + espacio → títulos (el espacio es obligatorio: `#hashtag` NO es título).
 *  - `- item` / `* item` → lista con viñetas; `1. item` / `1) item` → lista numerada.
 *  - Línea en blanco → separación de párrafos; salto simple → `<br/>` dentro del párrafo.
 *
 * Inline:
 *  - `**negrita**`, `*cursiva*` (sin espacios pegados a los asteriscos), `` `código` ``.
 *  - Enlaces markdown `[texto](https://…)` y URLs sueltas → `<a>` clicable.
 *  - Menciones `@handle` → resaltadas.
 *
 * Orden inline: código → negrita → cursiva → enlaces → menciones (los enlaces se
 * reconocen DENTRO de la negrita/cursiva; una negrita dentro de la etiqueta de un
 * enlace `[**x**](u)` no está soportada).
 *
 * IMPORTANTE: este componente emite elementos de BLOQUE — el contenedor padre debe
 * ser un `<div>` (no `<p>`) y ya no necesita `whitespace-pre-wrap`. Los enlaces
 * hacen `stopPropagation` para que al pinchar uno dentro de una tarjeta clicable
 * (feed) no se abra el post.
 */

export type RichNode =
  | { type: 'text'; value: string }
  | { type: 'link'; href: string; label: string }
  | { type: 'mention'; handle: string }
  | { type: 'code'; value: string }
  | { type: 'bold'; children: RichNode[] }
  | { type: 'italic'; children: RichNode[] };

export type RichBlock =
  | { type: 'heading'; level: 1 | 2 | 3; children: RichNode[] }
  | { type: 'list'; ordered: boolean; items: RichNode[][] }
  | { type: 'paragraph'; lines: RichNode[][] };

// Enlace markdown `[label](http…)` O URL suelta `http…`.
const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/g;
// Mención: `@handle` precedido por inicio de cadena o un carácter de borde.
const MENTION_RE = /(^|[\s(.,;:!?[\]{}<>])@([A-Za-z0-9._-]+)/g;
// Código inline `…` (sin saltos de línea dentro).
const CODE_RE = /`([^`\n]+)`/g;
// Negrita **…** (non-greedy: cierra en el primer `**`).
const BOLD_RE = /\*\*([^\n]+?)\*\*/g;
// Cursiva *…*: sin espacio pegado al asterisco de apertura ni al de cierre
// (evita falsos positivos como "5 * 3 * 2"). Sin lookbehind (compat Safari).
const ITALIC_RE = /\*(\S(?:[^*\n]*\S)?)\*/g;

// Bloques (evaluados por línea).
const HEADING_RE = /^(#{1,3})\s+(.+)$/;
const BULLET_RE = /^\s{0,3}[-*]\s+(.+)$/;
const ORDERED_RE = /^\s{0,3}\d{1,2}[.)]\s+(.+)$/;

/**
 * Divide `text` con `re`; los matches se mapean con `onMatch` y los huecos de
 * texto entre matches con `onGap`. Base de todo el pipeline inline.
 */
function splitBy(
  text: string,
  re: RegExp,
  onMatch: (m: RegExpExecArray) => RichNode | RichNode[],
  onGap: (gap: string) => RichNode[],
): RichNode[] {
  const out: RichNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(...onGap(text.slice(last, m.index)));
    const node = onMatch(m);
    out.push(...(Array.isArray(node) ? node : [node]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(...onGap(text.slice(last)));
  return out;
}

/** Tokeniza menciones dentro de un fragmento de texto plano (último paso). */
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

/** Enlaces (markdown o URL suelta) y, en los huecos, menciones. */
function tokenizeLinks(text: string): RichNode[] {
  return splitBy(
    text,
    LINK_RE,
    (m) => {
      if (m[2]) return { type: 'link', href: m[2], label: m[1] ?? m[2] };
      // URL suelta — no arrastres la puntuación final dentro del href.
      let url = m[3]!;
      const trail = /[.,;:!?)\]}'"]+$/.exec(url)?.[0] ?? '';
      if (trail) url = url.slice(0, url.length - trail.length);
      const nodes: RichNode[] = [{ type: 'link', href: url, label: url }];
      if (trail) nodes.push({ type: 'text', value: trail });
      return nodes;
    },
    tokenizeMentions,
  );
}

function tokenizeItalic(text: string): RichNode[] {
  return splitBy(
    text,
    ITALIC_RE,
    (m) => ({ type: 'italic', children: tokenizeLinks(m[1]!) }),
    tokenizeLinks,
  );
}

function tokenizeBold(text: string): RichNode[] {
  return splitBy(
    text,
    BOLD_RE,
    (m) => ({ type: 'bold', children: tokenizeItalic(m[1]!) }),
    tokenizeItalic,
  );
}

/**
 * Tokeniza un fragmento inline en nodos ricos. Pura y determinista (testeable).
 * Pipeline: código → negrita → cursiva → enlaces → menciones.
 */
export function tokenizeRichText(body: string): RichNode[] {
  return splitBy(body, CODE_RE, (m) => ({ type: 'code', value: m[1]! }), tokenizeBold);
}

/**
 * Parsea el cuerpo completo en bloques (títulos, listas, párrafos). Los ítems
 * consecutivos del mismo tipo de lista se agrupan en un único `<ul>`/`<ol>`.
 */
export function parseRichBlocks(body: string): RichBlock[] {
  const blocks: RichBlock[] = [];
  let para: RichNode[][] = [];
  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: 'paragraph', lines: para });
      para = [];
    }
  };

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushPara();
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      flushPara();
      blocks.push({
        type: 'heading',
        level: h[1]!.length as 1 | 2 | 3,
        children: tokenizeRichText(h[2]!),
      });
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    const ordered = bullet ? null : ORDERED_RE.exec(line);
    if (bullet || ordered) {
      flushPara();
      const isOrdered = ordered !== null;
      const item = tokenizeRichText((bullet?.[1] ?? ordered?.[1])!);
      const prev = blocks[blocks.length - 1];
      if (prev && prev.type === 'list' && prev.ordered === isOrdered) {
        prev.items.push(item);
      } else {
        blocks.push({ type: 'list', ordered: isOrdered, items: [item] });
      }
      continue;
    }
    para.push(tokenizeRichText(line));
  }
  flushPara();
  return blocks;
}

function InlineNodes({ nodes }: { nodes: RichNode[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case 'link':
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
          case 'mention':
            return (
              <span
                key={i}
                className="rounded px-0.5 font-semibold"
                style={{ background: 'var(--didacta-info-bg)', color: 'var(--didacta-info-fg)' }}
              >
                @{n.handle}
              </span>
            );
          case 'code':
            return (
              <code
                key={i}
                className="rounded border border-border-soft bg-surface-2 px-1 py-0.5 font-mono text-[0.9em]"
              >
                {n.value}
              </code>
            );
          case 'bold':
            return (
              <strong key={i} className="font-semibold">
                <InlineNodes nodes={n.children} />
              </strong>
            );
          case 'italic':
            return (
              <em key={i}>
                <InlineNodes nodes={n.children} />
              </em>
            );
          default:
            return <span key={i}>{n.value}</span>;
        }
      })}
    </>
  );
}

const HEADING_SIZE: Record<1 | 2 | 3, string> = {
  // Relativos al contexto (em) para que escalen igual en el detalle (15px),
  // los comentarios (sm) y la preview del feed (sm).
  1: 'text-[1.2em]',
  2: 'text-[1.12em]',
  3: 'text-[1.05em]',
};

export function RichBody({ body }: { body: string }) {
  const blocks = useMemo(() => parseRichBlocks(body), [body]);
  return (
    <>
      {blocks.map((blk, i) => {
        if (blk.type === 'heading') {
          const Tag = blk.level === 3 ? 'h4' : 'h3';
          return (
            <Tag
              key={i}
              className={`font-display mb-1.5 mt-4 font-semibold text-text first:mt-0 ${HEADING_SIZE[blk.level]}`}
            >
              <InlineNodes nodes={blk.children} />
            </Tag>
          );
        }
        if (blk.type === 'list') {
          const Tag = blk.ordered ? 'ol' : 'ul';
          return (
            <Tag
              key={i}
              className={`my-2 space-y-1 pl-5 first:mt-0 last:mb-0 ${blk.ordered ? 'list-decimal' : 'list-disc'}`}
            >
              {blk.items.map((item, j) => (
                <li key={j}>
                  <InlineNodes nodes={item} />
                </li>
              ))}
            </Tag>
          );
        }
        return (
          <p key={i} className="my-2 first:mt-0 last:mb-0">
            {blk.lines.map((line, j) => (
              <span key={j}>
                {j > 0 ? <br /> : null}
                <InlineNodes nodes={line} />
              </span>
            ))}
          </p>
        );
      })}
    </>
  );
}
