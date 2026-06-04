import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readSampleConfig,
  parseExtractCursor,
  emptyExtractCursor,
  type ExtractCursor,
} from '../../src/index.js';

/// Tests del sample mode (v1.0.32+).
///
/// El sample mode vive INLINE en `src/index.ts` dentro de `onJobTick`
/// (case 'extracting'). Esos handlers no son fácilmente testables como
/// unit (requieren mocks de http/db/secrets del sandbox del host), así que
/// los tests aquí cubren dos capas:
///
///   1. Los HELPERS exportados (`readSampleConfig`, `parseExtractCursor`):
///      garantizan que el shape del cursor y la lectura defensiva de
///      `options.sample` funcionan como espera el case 'extracting'.
///
///   2. Tests de REGRESIÓN estructural sobre `src/index.ts`: verifican
///      por lectura del archivo que el bloque `subphase === 'sample-pick'`
///      sigue cableado dentro de `case 'extracting':` y antes del bloque
///      'fixup'. Si alguien refactoriza onJobTick y borra el bloque por
///      accidente (regresión exacta del bug que ya pasó en 1.0.30/1.0.31
///      donde el sample mode vivía en un archivo aislado), estos tests
///      fallan en CI antes del release.

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('sample mode — helpers del cursor', () => {
  describe('readSampleConfig', () => {
    it('devuelve null si options es null/undefined/string/non-object', () => {
      expect(readSampleConfig(null)).toBeNull();
      expect(readSampleConfig(undefined)).toBeNull();
      expect(readSampleConfig('not-an-object')).toBeNull();
      expect(readSampleConfig(42)).toBeNull();
    });

    it('devuelve null si options.sample no está set', () => {
      expect(readSampleConfig({})).toBeNull();
      expect(readSampleConfig({ retentionDays: 30 })).toBeNull();
    });

    it('devuelve null si options.sample no es objeto', () => {
      expect(readSampleConfig({ sample: null })).toBeNull();
      expect(readSampleConfig({ sample: 'yes' })).toBeNull();
      expect(readSampleConfig({ sample: true })).toBeNull();
    });

    it('lee courses y usersPerCourse cuando son números válidos', () => {
      expect(readSampleConfig({ sample: { courses: 1, usersPerCourse: 5 } })).toEqual({
        courses: 1,
        usersPerCourse: 5,
      });
      expect(readSampleConfig({ sample: { courses: 3, usersPerCourse: 10 } })).toEqual({
        courses: 3,
        usersPerCourse: 10,
      });
    });

    it('aplica defaults sensatos si faltan campos individuales', () => {
      expect(readSampleConfig({ sample: {} })).toEqual({ courses: 1, usersPerCourse: 5 });
      expect(readSampleConfig({ sample: { courses: 2 } })).toEqual({
        courses: 2,
        usersPerCourse: 5,
      });
      expect(readSampleConfig({ sample: { usersPerCourse: 20 } })).toEqual({
        courses: 1,
        usersPerCourse: 20,
      });
    });

    it('aplica caps a valores fuera de rango (no rejecta, satura)', () => {
      // courses cap = 5
      expect(readSampleConfig({ sample: { courses: 999 } })).toEqual({
        courses: 5,
        usersPerCourse: 5,
      });
      // usersPerCourse cap = 50
      expect(readSampleConfig({ sample: { usersPerCourse: 1_000_000 } })).toEqual({
        courses: 1,
        usersPerCourse: 50,
      });
      // Mínimos
      expect(readSampleConfig({ sample: { courses: 0, usersPerCourse: -5 } })).toEqual({
        courses: 1,
        usersPerCourse: 1,
      });
    });

    it('redondea hacia abajo valores decimales (defensa contra payloads raros)', () => {
      expect(readSampleConfig({ sample: { courses: 1.9, usersPerCourse: 5.7 } })).toEqual({
        courses: 1,
        usersPerCourse: 5,
      });
    });
  });

  describe('parseExtractCursor', () => {
    it('devuelve cursor vacío en paginate si progress es null/undefined/no-extract', () => {
      const fresh = emptyExtractCursor();
      expect(parseExtractCursor(null)).toEqual(fresh);
      expect(parseExtractCursor(undefined)).toEqual(fresh);
      expect(parseExtractCursor({ phase: 'transform' })).toEqual(fresh);
    });

    it('preserva subphase fixup', () => {
      const input: ExtractCursor = {
        phase: 'extract',
        subphase: 'fixup',
        current: 'lessons',
        page: 3,
        completed: ['users', 'courses'],
        totalsPerEntity: { users: 50, courses: 1 },
        courseIdx: 0,
        fixupTotalCourses: 1,
      };
      const out = parseExtractCursor(input);
      expect(out.subphase).toBe('fixup');
      expect(out.fixupTotalCourses).toBe(1);
    });

    it('preserva subphase sample-pick (regresión del bug que dio origen al sample mode)', () => {
      const input: ExtractCursor = {
        phase: 'extract',
        subphase: 'sample-pick',
        current: 'users',
        page: 1,
        completed: [],
        totalsPerEntity: {},
        courseIdx: 0,
      };
      const out = parseExtractCursor(input);
      expect(out.subphase).toBe('sample-pick');
    });

    it('normaliza subphase desconocida a paginate', () => {
      const input = {
        phase: 'extract',
        subphase: 'unknown-future-phase' as any,
        current: 'users',
        page: 1,
        completed: [],
        totalsPerEntity: {},
      };
      const out = parseExtractCursor(input);
      expect(out.subphase).toBe('paginate');
    });

    it('preserva sampleCourseId entre ticks (audit trail del curso elegido)', () => {
      const input: ExtractCursor = {
        phase: 'extract',
        subphase: 'paginate',
        current: 'lessons',
        page: 1,
        completed: ['users', 'courses', 'groups'],
        totalsPerEntity: { users: 5, courses: 1, groups: 0 },
        courseIdx: 0,
        sampleCourseId: '12345',
      };
      const out = parseExtractCursor(input);
      expect(out.sampleCourseId).toBe('12345');
    });
  });
});

describe('sample mode — regresión estructural en src/index.ts', () => {
  /// Lee el SOURCE de src/index.ts (no el bundle compilado) y verifica
  /// que el bloque sample-pick está cableado dentro de case 'extracting'.
  /// Esto protege contra el bug que provocó MIGRATOR-001: tener código de
  /// sample mode "en otro archivo" sin que el runtime lo invoque. Si
  /// alguien borra accidentalmente el handler de sample-pick mientras
  /// refactoriza onJobTick, este test falla.
  const indexSrc = readFileSync(resolve(REPO_ROOT, 'src', 'index.ts'), 'utf8');

  it('contiene el handler subphase === sample-pick', () => {
    expect(indexSrc).toMatch(/cursor\.subphase\s*===\s*['"]sample-pick['"]/);
  });

  it('el handler sample-pick llama upsertStgCourse y upsertStgUser (inyecta a stg)', () => {
    const samplePickStart = indexSrc.indexOf("cursor.subphase === 'sample-pick'");
    expect(samplePickStart).toBeGreaterThan(0);
    // Limitamos la búsqueda al siguiente bloque grande para no matchear
    // calls de fases no relacionadas más abajo.
    const samplePickBlock = indexSrc.slice(samplePickStart, samplePickStart + 8000);
    expect(samplePickBlock).toContain('upsertStgCourse(');
    expect(samplePickBlock).toContain('upsertStgUser(');
  });

  it('el sample-pick avanza a subphase paginate desde lessons con users/courses/groups completed', () => {
    const samplePickStart = indexSrc.indexOf("cursor.subphase === 'sample-pick'");
    const samplePickBlock = indexSrc.slice(samplePickStart, samplePickStart + 8000);
    expect(samplePickBlock).toMatch(/subphase:\s*['"]paginate['"]/);
    expect(samplePickBlock).toMatch(/current:\s*['"]lessons['"]/);
    expect(samplePickBlock).toMatch(
      /completed:\s*\[\s*['"]users['"]\s*,\s*['"]courses['"]\s*,\s*['"]groups['"]\s*\]/,
    );
  });

  it('el sample-pick aparece ANTES del handler de fixup en el switch case extracting', () => {
    const samplePickIdx = indexSrc.indexOf("cursor.subphase === 'sample-pick'");
    const fixupIdx = indexSrc.indexOf("cursor.subphase === 'fixup'");
    expect(samplePickIdx).toBeGreaterThan(0);
    expect(fixupIdx).toBeGreaterThan(0);
    expect(samplePickIdx).toBeLessThan(fixupIdx);
  });

  it('el case extracting fuerza subphase sample-pick si options.sample existe y cursor está fresh', () => {
    // Esta línea (o equivalente) es la que activa el sample mode al primer
    // tick. Sin ella, un job con options.sample arrancaría paginate normal
    // y traería los miles de users del origen — exactamente el bug que
    // 1.0.30/1.0.31 tuvo y este fix corrige.
    // Multilínea: las dos variables se declaran en líneas separadas.
    expect(indexSrc).toMatch(/sampleCfg[\s\S]{0,500}isFreshExtract/);
    expect(indexSrc).toMatch(/cursor\s*=\s*\{\s*\.\.\.cursor,\s*subphase:\s*['"]sample-pick['"]/);
  });
});
