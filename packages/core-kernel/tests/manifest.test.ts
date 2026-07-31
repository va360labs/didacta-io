import { describe, expect, it } from 'vitest';
import {
  ModuleManifestValidationError,
  parseModuleManifest,
  type ModuleManifest,
} from '../src/index.js';

const validManifest: ModuleManifest = {
  name: 'mod.courses',
  displayName: 'Gestión de cursos',
  description: 'Cursos, módulos y lecciones',
  version: '1.0.0',
  coreVersionRequired: '^1.0.0',
  dependencies: { modules: [], optionalModules: [] },
  tablePrefix: 'mod_courses_',
  permissions: ['courses.manage'],
  roles: [],
  eventsEmitted: ['courses.course.created'],
  eventsConsumed: [],
  hooksExposed: [],
  hooksConsumed: [],
  defaultConfig: {},
  uiExtensions: [],
  pages: [],
  apiNamespace: '/modules/courses',
};

describe('parseModuleManifest', () => {
  it('acepta un manifest válido', () => {
    const parsed = parseModuleManifest(validManifest);
    expect(parsed.name).toBe('mod.courses');
    expect(parsed.tablePrefix).toBe('mod_courses_');
  });

  it('acepta "core" como nombre especial', () => {
    const parsed = parseModuleManifest({
      ...validManifest,
      name: 'core',
      tablePrefix: 'mod_core_',
    });
    expect(parsed.name).toBe('core');
  });

  it('aplica defaults cuando faltan arrays opcionales', () => {
    const minimal = {
      name: 'mod.minimal',
      displayName: 'Minimal',
      description: 'Minimal module',
      version: '1.0.0',
      coreVersionRequired: '^1.0.0',
      tablePrefix: 'mod_minimal_',
      apiNamespace: '/modules/minimal',
    };
    const parsed = parseModuleManifest(minimal);
    expect(parsed.permissions).toEqual([]);
    expect(parsed.eventsEmitted).toEqual([]);
    expect(parsed.dependencies.modules).toEqual([]);
  });

  it('rechaza nombres que no siguen el patrón mod.<nombre> o core', () => {
    expect(() => parseModuleManifest({ ...validManifest, name: 'courses' })).toThrow(
      ModuleManifestValidationError,
    );
  });

  it('rechaza tablePrefix que no respeta el patrón mod_<nombre>_', () => {
    expect(() => parseModuleManifest({ ...validManifest, tablePrefix: 'courses_' })).toThrow(
      ModuleManifestValidationError,
    );
  });

  it('rechaza versión sin formato SemVer', () => {
    expect(() => parseModuleManifest({ ...validManifest, version: '1.0' })).toThrow(
      ModuleManifestValidationError,
    );
  });

  it('rechaza coreVersionRequired sin formato de rango SemVer', () => {
    expect(() => parseModuleManifest({ ...validManifest, coreVersionRequired: 'latest' })).toThrow(
      ModuleManifestValidationError,
    );
  });

  it('rechaza apiNamespace sin slash inicial', () => {
    expect(() =>
      parseModuleManifest({ ...validManifest, apiNamespace: 'modules/courses' }),
    ).toThrow(ModuleManifestValidationError);
  });

  it('rechaza pages con path sin slash inicial', () => {
    expect(() =>
      parseModuleManifest({
        ...validManifest,
        pages: [{ path: 'admin/courses', component: './Dashboard.tsx' }],
      }),
    ).toThrow(ModuleManifestValidationError);
  });

  it('el error incluye el nombre del módulo cuando está disponible', () => {
    try {
      parseModuleManifest({ ...validManifest, tablePrefix: 'invalid' });
      expect.fail('debería haber lanzado');
    } catch (error) {
      expect(error).toBeInstanceOf(ModuleManifestValidationError);
      expect((error as Error).message).toContain('mod.courses');
    }
  });

  it('acepta dependencias opcionales declaradas', () => {
    const parsed = parseModuleManifest({
      ...validManifest,
      dependencies: {
        modules: [{ name: 'mod.learning', version: '^1.0.0' }],
        optionalModules: [{ name: 'mod.zoom-live', version: '^1.0.0' }],
      },
    });
    expect(parsed.dependencies.modules).toHaveLength(1);
    expect(parsed.dependencies.optionalModules).toHaveLength(1);
  });
});
