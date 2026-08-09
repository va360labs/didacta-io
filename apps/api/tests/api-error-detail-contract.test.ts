/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Contrato `detail` entre el backend y el catálogo del front.
 *
 * El bug que cierra: un `message` español con el dato incrustado
 * (`SMTP falló: ${err}`) se traducía en el front por `code` y el inglés perdía
 * el dato. El arreglo es mandar ese dato como campo `detail` APARTE y que cada
 * idioma escriba su frase interpolando `{detail}`.
 *
 * Ese arreglo tiene DOS mitades que viven en repos distintos del monorepo, y si
 * una se hace sin la otra el síntoma es silencioso:
 *
 *   · catálogo con `{detail}` pero throw sin `detail` → el front detecta el
 *     hueco y degrada al `message` crudo: el inglés vuelve a ver español.
 *   · throw con `detail` pero catálogo sin `{detail}` → el dato se sigue
 *     perdiendo, exactamente el bug original.
 *
 * Este test cierra la primera mitad desde el lado del backend, SIN duplicar
 * ninguna lista: lee los catálogos ES del disco (son datos, no código),
 * deduce qué codes prometen `{detail}` y exige que todos los productores que
 * los usen rellenen el campo. La segunda mitad la cubre
 * `apps/web/src/lib/i18n/api-error.test.ts`.
 *
 * ── Los DOS shapes de productor ───────────────────────────────────────────────
 *
 * Un code de error nace en uno de dos sitios, con sintaxis distinta:
 *
 *   · `apps/api/src/**` — literal de objeto: `throw new BadRequestException({
 *     message: '…', code: 'X', detail })`.
 *   · `modules/<mod>/src/errors.ts` — clase de dominio:
 *     `super('…', 'X', { detail })` (o `super('X', '…', { detail })`, que el
 *     orden de argumentos varía por módulo).
 *
 * La versión anterior de este test SOLO veía el primero, y por eso ~98 codes de
 * `modules/**` llevaban invisibles desde el principio: no es que fallaran, es
 * que nadie los miraba. Ahora se barren los dos.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const API_SRC = path.join(TESTS_DIR, '..', 'src');
const ES_MESSAGES = path.join(TESTS_DIR, '..', '..', 'web', 'src', 'i18n', 'messages', 'es');
const MODULES = path.join(TESTS_DIR, '..', '..', '..', 'modules');

/** Codes cuyo copy español promete un `{detail}` que el backend debe mandar. */
function codesThatPromiseDetail(): Set<string> {
  const out = new Set<string>();
  for (const file of readdirSync(ES_MESSAGES)) {
    if (!file.startsWith('errorsApi') || !file.endsWith('.json')) continue;
    const json = JSON.parse(readFileSync(path.join(ES_MESSAGES, file), 'utf8')) as Record<
      string,
      string
    >;
    for (const [code, text] of Object.entries(json)) {
      if (typeof text === 'string' && text.includes('{detail}')) out.add(code);
    }
  }
  return out;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Ficheros de clases de error de los 24 módulos (`modules/<mod>/**\/errors.ts`). */
function moduleErrorFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) moduleErrorFiles(full, out);
    else if (entry === 'errors.ts') out.push(full);
  }
  return out;
}

/**
 * Bloques `super(...)` de un fichero de errores de módulo, con la línea en la
 * que empiezan. Igual que `literalAround`: no es un parser, y no lo necesita —
 * son llamadas de 1-6 líneas que terminan en `);`.
 */
function superCalls(source: string): Array<{ line: number; body: string }> {
  const out: Array<{ line: number; body: string }> = [];
  const re = /super\(([\s\S]*?)\n?\s*\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push({ line: source.slice(0, m.index).split('\n').length, body: m[1]! });
  }
  return out;
}

/**
 * Bloque del literal que contiene un `code:` dado. Empieza en el `throw` más
 * cercano hacia arriba (o 12 líneas, lo que llegue antes) y termina en el
 * primer cierre `});` hacia abajo. No es un parser: no lo necesita, porque los
 * throws de la API son literales de objeto de 3-6 líneas y el test falla en
 * cuanto uno deje de serlo.
 */
function literalAround(lines: string[], index: number): string {
  let start = index;
  for (let i = index; i >= Math.max(0, index - 12); i--) {
    if (/throw new \w+\(\{/.test(lines[i]!)) {
      start = i;
      break;
    }
    start = i;
  }
  let end = index;
  for (let i = index; i < Math.min(lines.length, index + 12); i++) {
    end = i;
    if (/^\s*\}\);?\s*$/.test(lines[i]!)) break;
  }
  return lines.slice(start, end + 1).join('\n');
}

const PROMISED = codesThatPromiseDetail();
const FILES = sourceFiles(API_SRC);
const MODULE_ERROR_FILES = moduleErrorFiles(MODULES);

describe('contrato `detail` · backend ↔ catálogo', () => {
  it('el barrido encuentra catálogos y fuentes (no valida sobre el vacío)', () => {
    // Si alguien mueve una carpeta, sin esto el resto pasaría en verde sobre
    // dos listas vacías.
    expect(PROMISED.size).toBeGreaterThan(20);
    expect(FILES.length).toBeGreaterThan(200);
    // Y lo mismo para el shape de `modules/**`, que es justo el que se escapó
    // de los dos barridos anteriores.
    expect(MODULE_ERROR_FILES.length).toBeGreaterThan(15);
  });

  it('todo throw de un code con {detail} rellena el campo', () => {
    const sinDetalle: string[] = [];
    for (const file of FILES) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const match = /code:\s*'([A-Z0-9_]+)'/.exec(lines[i]!);
        if (!match || !PROMISED.has(match[1]!)) continue;
        if (!/\bdetail\b/.test(literalAround(lines, i))) {
          sinDetalle.push(
            `${path.relative(API_SRC, file).replace(/\\/g, '/')}:${i + 1} ${match[1]}`,
          );
        }
      }
    }
    expect(
      sinDetalle,
      'throws que prometen {detail} en el catálogo pero no lo mandan.\n' +
        'El front degrada al `message` crudo (español) y el inglés vuelve a\n' +
        'perder el dato:\n  ' +
        sinDetalle.join('\n  '),
    ).toEqual([]);
  });

  it('toda clase de error de modules/** con un code {detail} rellena el campo', () => {
    // El mismo contrato para el OTRO shape. Aquí el `detail` se pasa como
    // opciones (`super(msg, CODE, { detail })`) precisamente para que sea
    // visible en el call-site y para que este barrido no dependa de contar
    // argumentos posicionales.
    const sinDetalle: string[] = [];
    for (const file of MODULE_ERROR_FILES) {
      const source = readFileSync(file, 'utf8');
      for (const { line, body } of superCalls(source)) {
        const code = /'([A-Z][A-Z0-9_]*)'/.exec(body)?.[1];
        if (!code || !PROMISED.has(code)) continue;
        if (!/\bdetail\b/.test(body)) {
          sinDetalle.push(`${path.relative(MODULES, file).replace(/\\/g, '/')}:${line} ${code}`);
        }
      }
    }
    expect(
      sinDetalle,
      'clases de error que prometen {detail} en el catálogo pero no lo mandan.\n' +
        'El front degrada al `message` crudo (español) y el inglés vuelve a\n' +
        'perder el dato:\n  ' +
        sinDetalle.join('\n  '),
    ).toEqual([]);
  });

  it('ningún code con {detail} se quedó sin productor', () => {
    // Al revés: una key de catálogo con `{detail}` cuyo backend ya no existe es
    // una promesa muerta. El corpus son LOS DOS shapes: `apps/api/src` y las
    // clases de error de `modules/<mod>`.
    const todoElCodigo = [...FILES, ...MODULE_ERROR_FILES]
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const huerfanos = [...PROMISED].filter((c) => !todoElCodigo.includes(`'${c}'`)).sort();
    expect(
      huerfanos,
      `codes con {detail} en el catálogo que ningún productor del backend genera:\n  ${huerfanos.join('\n  ')}`,
    ).toEqual([]);
  });
});
