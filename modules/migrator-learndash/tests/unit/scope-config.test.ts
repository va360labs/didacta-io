import { describe, expect, it } from 'vitest';
import { readScopeConfig } from '../../src/index.js';

/// Tests del selector de scope de migración (v1.1.0+ — "elegir qué migrar").
///
/// readScopeConfig traduce las options del job a un ScopeConfig con dos sets:
///   - load:    entidades que se CARGAN al core (intención del operador)
///   - extract: entidades que se EXTRAEN a staging (load ∪ dependencias)
/// El gating del ETL (extract/load/reconcile) filtra las listas reales contra
/// estos sets. Default 'all' para no regresionar jobs legacy.

const has = (s: Set<string>, ...names: string[]) => names.every((n) => s.has(n));

describe('readScopeConfig', () => {
  describe('default / compat legacy', () => {
    it('sin options → modo all (todo)', () => {
      const c = readScopeConfig(undefined);
      expect(c.mode).toBe('all');
      expect(c.onlyEnrolledUsers).toBe(false);
      expect(has(c.load, 'users', 'courses', 'lessons', 'topics', 'quizzes', 'groups')).toBe(true);
    });

    it('options sin mode ni scope (job legacy pre-1.1.0) → all', () => {
      const c = readScopeConfig({ retentionDays: 30, passwordStrategy: 'activation_reset' });
      expect(c.mode).toBe('all');
    });

    it('options no-objeto (defensa) → all', () => {
      expect(readScopeConfig('garbage').mode).toBe('all');
      expect(readScopeConfig(42).mode).toBe('all');
      expect(readScopeConfig(null).mode).toBe('all');
    });
  });

  describe('mode explícito', () => {
    it("mode 'courses' → solo contenido, sin usuarios ni grupos", () => {
      const c = readScopeConfig({ mode: 'courses' });
      expect(c.mode).toBe('courses');
      expect(has(c.load, 'courses', 'lessons', 'topics', 'quizzes')).toBe(true);
      expect(c.load.has('users')).toBe(false);
      expect(c.load.has('groups')).toBe(false);
      expect(c.load.has('enrollments')).toBe(false);
      // extract == load en este modo
      expect(c.extract.has('users')).toBe(false);
      expect(c.extract.has('courses')).toBe(true);
      expect(c.onlyEnrolledUsers).toBe(false);
    });

    it("mode 'enrolled-students' → carga users+enrollments, extrae también courses (para IDs)", () => {
      const c = readScopeConfig({ mode: 'enrolled-students' });
      expect(c.mode).toBe('enrolled-students');
      expect(has(c.load, 'users', 'enrollments')).toBe(true);
      expect(c.load.has('courses')).toBe(false); // se extrae pero NO se carga
      expect(has(c.extract, 'courses', 'users', 'enrollments')).toBe(true);
      expect(c.onlyEnrolledUsers).toBe(true);
    });

    it("mode 'all' → todas las entidades + enrollments", () => {
      const c = readScopeConfig({ mode: 'all' });
      expect(c.mode).toBe('all');
      expect(
        has(c.load, 'users', 'courses', 'lessons', 'topics', 'quizzes', 'groups', 'enrollments'),
      ).toBe(true);
      expect(c.onlyEnrolledUsers).toBe(false);
    });

    it('mode inválido → cae a default all', () => {
      expect(readScopeConfig({ mode: 'nonsense' }).mode).toBe('all');
    });
  });

  describe('derivación desde scope booleano (wizard que solo manda scope)', () => {
    it('scope con courses+users true → all', () => {
      const c = readScopeConfig({ scope: { courses: true, users: true } });
      expect(c.mode).toBe('all');
    });

    it('scope con courses false y users true → enrolled-students', () => {
      const c = readScopeConfig({ scope: { courses: false, users: true } });
      expect(c.mode).toBe('enrolled-students');
      expect(c.onlyEnrolledUsers).toBe(true);
    });

    it('scope con courses true y users false → courses', () => {
      const c = readScopeConfig({ scope: { courses: true, users: false, enrollments: false } });
      expect(c.mode).toBe('courses');
    });

    it('mode explícito gana sobre scope booleano', () => {
      const c = readScopeConfig({ mode: 'courses', scope: { courses: true, users: true } });
      expect(c.mode).toBe('courses');
    });
  });
});
