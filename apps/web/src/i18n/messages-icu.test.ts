/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Guarda de MARCADORES entre catálogos: lo que `messages-parity.test.ts` deja
 * fuera a propósito («compara KEYS, no valores»).
 *
 * Una traducción puede tener todas sus keys y aun así romper la pantalla:
 *  - un argumento renombrado (`{nombre}` → `{nome}`) sale vacío o lanza;
 *  - una rama de plural perdida (`one`) pinta la otra en singular;
 *  - una etiqueta de rich text traducida (`<b>` → `<n>`) hace que next-intl
 *    lance en runtime y la pantalla entera caiga al error boundary.
 *
 * Aquí se compara la ESTRUCTURA ICU de cada valor traducido con la del
 * español (argumentos, tipo, opciones de plural/select y etiquetas). Si no
 * coincide con el español, se acepta que coincida con el inglés: hay frases
 * que el inglés ya resolvió con otra estructura (un plural donde el español no
 * lo necesita) y el portugués puede seguir cualquiera de las dos.
 *
 * El parser es mínimo y propio (no `@formatjs/icu-messageformat-parser`, que
 * la web no declara): solo extrae la firma, no formatea.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MESSAGE_CATALOGS } from './config';

const MESSAGES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'messages');

type Json = { [k: string]: Json | string };

function flat(obj: Json, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') flat(v, key, out);
    else out[key] = v;
  }
  return out;
}

function load(locale: string, ns: string): Record<string, string> {
  return flat(JSON.parse(readFileSync(path.join(MESSAGES_DIR, locale, `${ns}.json`), 'utf8')));
}

const PLURALES = new Set(['plural', 'select', 'selectordinal']);

/**
 * Firma ICU de un mensaje: conjunto de `arg:x`, `plural:x:one,other`, `tag:b`…
 * Lanza si las llaves no cierran (un mensaje así ya rompe next-intl).
 */
export function icuSignature(msg: string): string {
  const out = new Set<string>();
  let i = 0;

  const readUntil = (stops: string): string => {
    let s = '';
    while (i < msg.length && !stops.includes(msg[i]!)) s += msg[i++];
    return s.trim();
  };

  // Texto hasta la `}` que cierra el nivel actual (o el final si depth = 0).
  const parseText = (depth: number): void => {
    while (i < msg.length) {
      const c = msg[i]!;
      if (c === "'" && (msg[i + 1] === '{' || msg[i + 1] === '}')) {
        // Literal entre apóstrofos: `'{'` no es un argumento.
        const end = msg.indexOf("'", i + 1);
        i = end === -1 ? msg.length : end + 1;
      } else if (c === '{') {
        i++;
        parseArgument();
      } else if (c === '}') {
        if (depth === 0) throw new Error(`«}» sin abrir en: ${msg}`);
        return;
      } else if (c === '<' && /[A-Za-z/]/.test(msg[i + 1] ?? '')) {
        const end = msg.indexOf('>', i);
        if (end === -1) throw new Error(`etiqueta sin cerrar en: ${msg}`);
        const name = msg
          .slice(i + 1, end)
          .replace(/^\//, '')
          .trim()
          .split(/\s/)[0];
        out.add(`tag:${name}`);
        i = end + 1;
      } else i++;
    }
    if (depth > 0) throw new Error(`«{» sin cerrar en: ${msg}`);
  };

  const parseArgument = (): void => {
    const name = readUntil(',}');
    if (i >= msg.length) throw new Error(`«{» sin cerrar en: ${msg}`);
    if (msg[i] === '}') {
      out.add(`arg:${name}`);
      i++;
      return;
    }
    i++; // ','
    const type = readUntil(',}');
    if (!PLURALES.has(type)) {
      // number / date / time con estilo opcional: se salta hasta su `}`.
      let depth = 1;
      while (i < msg.length && depth > 0) {
        if (msg[i] === '{') depth++;
        else if (msg[i] === '}') depth--;
        i++;
      }
      out.add(`${type}:${name}`);
      return;
    }
    i++; // ','
    const options: string[] = [];
    for (;;) {
      while (/\s/.test(msg[i] ?? '')) i++;
      if (msg[i] === '}') {
        i++;
        break;
      }
      const selector = readUntil('{}').replace(/^offset:\s*\d+\s*/, '');
      if (msg[i] !== '{') throw new Error(`opción sin cuerpo en: ${msg}`);
      i++;
      options.push(selector);
      parseText(1);
      i++; // '}' de la opción
    }
    out.add(`${type}:${name}:${options.sort().join(',')}`);
  };

  parseText(0);
  return [...out].sort().join(' | ');
}

describe('icuSignature (el detector discrimina)', () => {
  it('ve argumentos, plurales y etiquetas, y no el texto', () => {
    expect(icuSignature('Hola {nombre}, tienes <b>{n}</b>')).toBe(
      icuSignature('Olá {nombre}, você tem <b>{n}</b>'),
    );
    expect(icuSignature('Hola {nombre}')).not.toBe(icuSignature('Olá {nome}'));
    expect(icuSignature('{n, plural, one {# curso} other {# cursos}}')).not.toBe(
      icuSignature('{n, plural, other {# cursos}}'),
    );
    expect(icuSignature('<b>Ojo</b>')).not.toBe(icuSignature('<strong>Olho</strong>'));
    // El texto de las ramas no cuenta, aunque empiece por una palabra.
    expect(icuSignature('{n, plural, one {Miembro} other {Miembros}}')).toBe(
      icuSignature('{n, plural, one {Membro} other {Membros}}'),
    );
    expect(() => icuSignature('Hola {nombre')).toThrow();
  });
});

const TRANSLATED = MESSAGE_CATALOGS.filter((c) => c !== 'es');

describe.each(TRANSLATED)('catálogo %s: mismos marcadores que el español', (locale) => {
  const namespaces = readdirSync(path.join(MESSAGES_DIR, 'es'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));

  it.each(namespaces)('%s', (ns) => {
    const es = load('es', ns);
    const en = load('en', ns);
    const tr = load(locale, ns);
    const malos: string[] = [];
    for (const [key, value] of Object.entries(tr)) {
      let firma: string;
      try {
        firma = icuSignature(value);
      } catch (e) {
        malos.push(`${key}: ${(e as Error).message}`);
        continue;
      }
      const refs = [es[key], en[key]].filter((v): v is string => typeof v === 'string');
      if (refs.length === 0) continue; // huérfanas: las vigila messages-parity.test.ts
      if (!refs.some((r) => icuSignature(r) === firma)) {
        malos.push(`${key}\n    es: ${es[key] ?? '—'}\n    ${locale}: ${value}`);
      }
    }
    expect(malos, malos.join('\n')).toEqual([]);
  });
});
