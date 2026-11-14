/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Valentín (14-nov-2026): «si el creador no pone un logo, pon las iniciales,
 * no el logo de Didacta. Didacta solo en el pie». Este guardián lee TODO el
 * código del web y falla si el logo de Didacta vuelve a pintarse como marca
 * por defecto de un aula (cabecera, barra lateral, asistente…): sus ficheros
 * de `public/brand/` o el cuadrado azul de Didacta que lo envolvía.
 *
 * Si un día hace falta el logo de Didacta en una pantalla que NO es del aula,
 * se añade aquí con el porqué.
 */

const WEB_SRC = path.resolve(__dirname, '..');

const DIDACTA_MARK = /\/brand\/(?:anagrama|logo|logo-blanco)\.png|bg-\[#1e5aa8\]/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

export function didactaMarkLines(source: string): string[] {
  return source
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => DIDACTA_MARK.test(line))
    .map(({ line, n }) => `${n}: ${line.trim()}`);
}

describe('la marca por defecto del aula no es la de Didacta', () => {
  it('ningún fichero del web pinta el logo de Didacta', () => {
    const hits = sourceFiles(WEB_SRC).flatMap((file) =>
      didactaMarkLines(readFileSync(file, 'utf8')).map(
        (l) => `${path.relative(WEB_SRC, file)}:${l}`,
      ),
    );
    expect(hits).toEqual([]);
  });

  it('el guardián discrimina: caza el anagrama, el logo y el cuadrado azul', () => {
    expect(didactaMarkLines('<Image src="/brand/anagrama.png" alt="" />')).toHaveLength(1);
    expect(didactaMarkLines("src: '/brand/logo-blanco.png'")).toHaveLength(1);
    expect(didactaMarkLines('className="grid h-9 w-9 bg-[#1E5AA8]"')).toHaveLength(1);
    expect(didactaMarkLines('<AcademyMark name={name} size={36} />')).toEqual([]);
  });
});
