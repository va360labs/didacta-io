import { describe, expect, it } from 'vitest';
import {
  resolveDependencyOrder,
  CircularDependencyError,
  MissingDependencyError,
  DependencyVersionMismatchError,
} from '../src/dependency-resolver.js';
import { buildModule } from './helpers.js';

describe('resolveDependencyOrder', () => {
  it('ordena topológicamente: dependencias antes que dependientes', () => {
    const courses = buildModule({ name: 'mod.courses' });
    const learning = buildModule({
      name: 'mod.learning',
      dependencies: {
        modules: [{ name: 'mod.courses', version: '^1.0.0' }],
        optionalModules: [],
      },
    });
    const certificates = buildModule({
      name: 'mod.certificates',
      dependencies: {
        modules: [{ name: 'mod.learning', version: '^1.0.0' }],
        optionalModules: [],
      },
    });

    const ordered = resolveDependencyOrder([certificates, learning, courses]);
    expect(ordered.map((m) => m.manifest.name)).toEqual([
      'mod.courses',
      'mod.learning',
      'mod.certificates',
    ]);
  });

  it('preserva orden de módulos sin dependencias', () => {
    const a = buildModule({ name: 'mod.a' });
    const b = buildModule({ name: 'mod.b' });
    const ordered = resolveDependencyOrder([a, b]);
    expect(ordered).toHaveLength(2);
    expect(ordered.map((m) => m.manifest.name).sort()).toEqual(['mod.a', 'mod.b']);
  });

  it('lanza MissingDependencyError si falta una dependencia', () => {
    const dependent = buildModule({
      name: 'mod.dependent',
      dependencies: {
        modules: [{ name: 'mod.missing', version: '^1.0.0' }],
        optionalModules: [],
      },
    });
    expect(() => resolveDependencyOrder([dependent])).toThrow(MissingDependencyError);
  });

  it('lanza DependencyVersionMismatchError si la versión no satisface el rango', () => {
    const courses = buildModule({ name: 'mod.courses', version: '2.0.0' });
    const learning = buildModule({
      name: 'mod.learning',
      dependencies: {
        modules: [{ name: 'mod.courses', version: '^1.0.0' }],
        optionalModules: [],
      },
    });
    expect(() => resolveDependencyOrder([courses, learning])).toThrow(
      DependencyVersionMismatchError,
    );
  });

  it('detecta ciclos simples (A → B → A)', () => {
    const a = buildModule({
      name: 'mod.a',
      dependencies: { modules: [{ name: 'mod.b', version: '^1.0.0' }], optionalModules: [] },
    });
    const b = buildModule({
      name: 'mod.b',
      dependencies: { modules: [{ name: 'mod.a', version: '^1.0.0' }], optionalModules: [] },
    });
    expect(() => resolveDependencyOrder([a, b])).toThrow(CircularDependencyError);
  });

  it('detecta ciclos indirectos (A → B → C → A)', () => {
    const a = buildModule({
      name: 'mod.a',
      dependencies: { modules: [{ name: 'mod.b', version: '^1.0.0' }], optionalModules: [] },
    });
    const b = buildModule({
      name: 'mod.b',
      dependencies: { modules: [{ name: 'mod.c', version: '^1.0.0' }], optionalModules: [] },
    });
    const c = buildModule({
      name: 'mod.c',
      dependencies: { modules: [{ name: 'mod.a', version: '^1.0.0' }], optionalModules: [] },
    });
    expect(() => resolveDependencyOrder([a, b, c])).toThrow(CircularDependencyError);
  });

  it('rechaza módulos duplicados con mismo nombre', () => {
    const a1 = buildModule({ name: 'mod.a', version: '1.0.0' });
    const a2 = buildModule({ name: 'mod.a', version: '2.0.0' });
    expect(() => resolveDependencyOrder([a1, a2])).toThrow(/duplicado/);
  });

  it('ignora dependencias opcionales ausentes', () => {
    const mod = buildModule({
      name: 'mod.with-optional',
      dependencies: {
        modules: [],
        optionalModules: [{ name: 'mod.missing', version: '^1.0.0' }],
      },
    });
    const ordered = resolveDependencyOrder([mod]);
    expect(ordered).toHaveLength(1);
  });
});
