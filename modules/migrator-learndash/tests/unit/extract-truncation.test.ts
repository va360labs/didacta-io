/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Regresiones de las tres formas en que la extracción perdía datos en
 * silencio (H13, H14, H15) y del informe que no podía detectarlo (L8).
 *
 * El pipeline vive INLINE en `onJobTick` (4.000 líneas, mocks de http/db/
 * secrets del sandbox), así que aquí se sigue el mismo enfoque que
 * `sample-mode-cursor.test.ts`: helpers exportados donde los hay, y lectura
 * del fuente para fijar las garantías estructurales que no se pueden ejercer
 * sin levantar medio host. Un refactor que borre cualquiera de ellas rompe
 * estos tests antes del release.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseExtractCursor, emptyExtractCursor } from '../../src/index.js';

const REPO_ROOT = resolve(__dirname, '..', '..');
const indexSrc = readFileSync(resolve(REPO_ROOT, 'src', 'index.ts'), 'utf8');

/** Recorta el fuente entre dos anclas para afinar los `toMatch`. */
function bloque(desde: string, hasta: string): string {
  const i = indexSrc.indexOf(desde);
  expect(i).toBeGreaterThan(0);
  const j = indexSrc.indexOf(hasta, i);
  expect(j).toBeGreaterThan(i);
  return indexSrc.slice(i, j);
}

describe('H13 — un corte a mitad de paginación no se confunde con el final', () => {
  const enroll = bloque('let truncado: string | null = null;', 'const entity = EXTRACT_ENTITIES');

  it('un HTTP >= 400 y un JSON roto marcan la extracción como truncada', () => {
    expect(enroll).toMatch(/truncado = `HTTP \$\{r\.status\} en page=\$\{page\}`/);
    expect(enroll).toMatch(/truncado = `respuesta no-JSON en page=\$\{page\}`/);
  });

  it('truncado NO avanza el cursor de curso: reintenta el mismo', () => {
    // El bug era exactamente este: `courseIdx: idx + 1` corría igual tras el
    // break, así que las páginas que faltaban no se traían nunca.
    const reintento = bloque('if (truncado) {', 'ctx.log(');
    expect(reintento).toMatch(/enrollAttempts/);
    expect(reintento).not.toMatch(/courseIdx: idx \+ 1/);
  });

  it('agotados los intentos, la pérdida va a la DLQ en vez de pasar desapercibida', () => {
    expect(enroll).toMatch(/appendDlq\(/);
    expect(enroll).toMatch(/EXTRACT_TRUNCATED/);
  });

  it('el cursor persiste los intentos por curso y sobrevive al parseo', () => {
    const c = parseExtractCursor({
      ...emptyExtractCursor(),
      subphase: 'enroll',
      enrollAttempts: { '24': 2 },
    });
    expect(c.enrollAttempts).toEqual({ '24': 2 });
  });
});

describe('H14 — un 4xx permanente falla el job en vez de reintentar para siempre', () => {
  it('el error de fetch lleva el status HTTP, no solo un mensaje', () => {
    expect(indexSrc).toMatch(/class WpHttpError extends Error/);
    expect(indexSrc).toMatch(/throw new WpHttpError\(resp\.status, url\)/);
  });

  it('401/403/404 están en la lista de permanentes', () => {
    const lista = bloque('const PERMANENT_WP_STATUSES', ';');
    for (const status of ['401', '403', '404']) expect(lista).toContain(status);
  });

  it('un permanente marca el job failed con su motivo apuntado', () => {
    const catchBlock = bloque('const status = e instanceof WpHttpError', '// Upsert items');
    expect(catchBlock).toMatch(/PERMANENT_WP_STATUSES\.has\(status\)/);
    expect(catchBlock).toMatch(/SOURCE_PERMANENT_ERROR/);
    expect(catchBlock).toMatch(/setJobStatus\(db, tenantId, jobId, 'failed'/);
  });

  it('un transitorio reintenta pero con tope, y al agotarlo falla el job', () => {
    const catchBlock = bloque('const status = e instanceof WpHttpError', '// Upsert items');
    expect(catchBlock).toMatch(/PAGE_MAX_ATTEMPTS/);
    expect(catchBlock).toMatch(/SOURCE_UNREACHABLE/);
    // El delay de 30 s sigue existiendo, pero ya no es el único camino.
    expect(catchBlock).toMatch(/delaySec: 30/);
  });

  it('el cursor persiste los intentos por página', () => {
    const c = parseExtractCursor({
      ...emptyExtractCursor(),
      pageAttempts: { 'lessons:3:24': 4 },
    });
    expect(c.pageAttempts).toEqual({ 'lessons:3:24': 4 });
  });
});

describe('H15 — el módulo "General" también se crea cuando lo que cuelga son temas', () => {
  it('la cuenta de huérfanos mira stg_lessons Y stg_topics', () => {
    const q = bloque('let hasOrphans = false;', 'hasOrphans = parseInt');
    expect(q).toContain('mod_migrator_learndash_stg_lessons');
    // Sin esta segunda mitad, un curso 100 % seccionado con temas no creaba
    // "General" y cada upsert de tema acababa en la DLQ.
    expect(q).toContain('mod_migrator_learndash_stg_topics');
  });

  it('el adaptador de temas sigue anclando al curso pelado (por eso hace falta)', () => {
    const adapter = bloque("case 'topics': {", "case 'quizzes': {");
    expect(adapter).toMatch(
      /moduleExternalRef: \{ externalSource: 'learndash', externalId: parentCourseId \}/,
    );
  });
});

describe('L8 — el informe de validación puede detectar registros perdidos', () => {
  it('el source_count real se graba al terminar el extract', () => {
    expect(indexSrc).toMatch(/async function recordSourceCounts\(/);
    expect(indexSrc).toMatch(
      /await recordSourceCounts\(db, tenantId, jobId, newTotals, ctx\.log\)/,
    );
  });

  it('el reconcile NO pisa el source_count grabado por el extract', () => {
    // El upsert del reconcile es el único que termina en `generated_at`.
    const fin = indexSrc.indexOf('generated_at = CURRENT_TIMESTAMP');
    expect(fin).toBeGreaterThan(0);
    const ini = indexSrc.lastIndexOf('ON CONFLICT (tenant_id, job_id, entity_type) DO UPDATE', fin);
    const doUpdate = indexSrc.slice(ini, fin);
    // Si `source_count` entrara en ese DO UPDATE, el reconcile volvería a
    // cablearlo a staged_count y el informe podría darse la razón a sí mismo.
    expect(doUpdate).not.toContain('source_count');
    expect(doUpdate).toContain('staged_count = EXCLUDED.staged_count');
  });
});
