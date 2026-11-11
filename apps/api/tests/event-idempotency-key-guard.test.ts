/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guarda: ninguna clave de idempotencia lleva el payload dentro.
 *
 * `outbox_event.idempotency_key` vive bajo un índice único de Postgres cuya
 * fila no pasa de 2.704 bytes. Quince servicios de ocho módulos componían la
 * clave como `${name}:${JSON.stringify(data)}:${Date.now()}`: la clave crecía
 * con el payload y, pasado el límite, publicar el evento reventaba después de
 * haber hecho ya la acción (cancelar una clase con ~70 inscritos la dejaba
 * cancelada y a nadie avisado).
 *
 * El patrón se había copiado de módulo en módulo, así que volverá a copiarse.
 * Este test lee el código y falla si reaparece: la clave se compone con
 * `eventIdempotencyKey()` de `@didacta/core-kernel`, o con identificadores
 * cortos escritos a mano.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const ROOTS = ['modules', 'apps/api/src', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', '.next', 'tests', 'coverage']);

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Una asignación de `idempotencyKey` que serializa algo dentro de la clave. */
const PAYLOAD_EN_LA_CLAVE = /idempotencyKey\s*[:=][^\n]*JSON\.stringify\s*\(/;

describe('claves de idempotencia de eventos', () => {
  const files = ROOTS.flatMap((r) => tsFiles(join(REPO_ROOT, r)));

  it('el barrido encuentra código que mirar', () => {
    // Si las rutas cambian y no se lee nada, la guarda pasaría en verde sin
    // estar mirando: que al menos se entere.
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith(join('zoom-live', 'src', 'zoom-live.service.ts')))).toBe(
      true,
    );
  });

  it('ninguna lleva el payload serializado dentro', () => {
    const culpables: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (PAYLOAD_EN_LA_CLAVE.test(line)) {
          culpables.push(`${relative(REPO_ROOT, file).replace(/\\/g, '/')}:${i + 1}`);
        }
      });
    }
    expect(
      culpables,
      'Clave de idempotencia con el payload dentro. Usa eventIdempotencyKey(name, data) ' +
        'de @didacta/core-kernel: resume el payload en vez de transportarlo.',
    ).toEqual([]);
  });

  it('CONTROL: el patrón que se busca es el que había', () => {
    const antes = 'idempotencyKey: `${name}:${JSON.stringify(data)}:${Date.now()}`,';
    const ahora = 'idempotencyKey: eventIdempotencyKey(name, data),';
    const aMano = 'idempotencyKey: `${name}:${orderId}`,';

    expect(PAYLOAD_EN_LA_CLAVE.test(antes)).toBe(true);
    expect(PAYLOAD_EN_LA_CLAVE.test(ahora)).toBe(false);
    expect(PAYLOAD_EN_LA_CLAVE.test(aMano)).toBe(false);
  });

  it('los módulos que publican eventos usan el helper compartido', () => {
    const conHelper = files.filter((f) =>
      /idempotencyKey:\s*eventIdempotencyKey\(/.test(readFileSync(f, 'utf8')),
    );
    // Los 15 sitios que tenían el patrón antiguo.
    expect(conHelper.length).toBeGreaterThanOrEqual(15);
  });
});
