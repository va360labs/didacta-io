import { describe, expect, it } from 'vitest';
import { moduleManifestSchema } from '../../src/marketplace/module-manifest.schema';
import { DIDACTA_PERMISSIONS } from '../../src/marketplace/sandboxed-didacta.types';

/// Tests del bloque `didacta` añadido al manifest en alpha.52 (Sprint 2 / DD-001).
///
/// El bloque declara qué métodos del core puede invocar el módulo a través
/// de `ctx.didacta.*`. Si el bloque está ausente, el dispatcher inyecta
/// `BlockedDidactaApi` que rechaza todo con `DIDACTA_PERMISSION_DENIED` —
/// los tests del cliente viven en `sandboxed-didacta.types.test.ts`.
///
/// Reglas importantes verificadas aquí:
///  - El bloque entero es opcional (módulos que no tocan el core funcionan).
///  - `externalSource` es obligatorio si el bloque está, y respeta el regex.
///  - `permissions` es lista cerrada — cualquier valor fuera de
///    `DIDACTA_PERMISSIONS` rechaza el manifest.

const baseManifest = {
  name: 'mod.example',
  version: '1.0.0',
  displayName: 'Example',
  coreVersionRequired: '^0.0.0',
  tablePrefix: 'mod_example_',
  apiNamespace: '/modules/example',
  vendor: 'didacta' as const,
};

describe('moduleManifestSchema — bloque didacta (alpha.52)', () => {
  it('manifest sin bloque didacta es válido (módulos puramente locales)', () => {
    const result = moduleManifestSchema.safeParse(baseManifest);
    expect(result.success).toBe(true);
  });

  it('didacta válido con un solo permiso es aceptado', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      didacta: {
        externalSource: 'learndash',
        permissions: ['courses.upsertByExternalRef'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('didacta con todos los permisos del catálogo es aceptado (uso típico de un migrator)', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      didacta: {
        externalSource: 'learndash',
        permissions: [...DIDACTA_PERMISSIONS],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rechaza didacta con permissions vacío (debe declarar al menos uno)', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      didacta: {
        externalSource: 'learndash',
        permissions: [],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rechaza un permiso fuera del catálogo cerrado', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      didacta: {
        externalSource: 'learndash',
        permissions: ['courses.dropTable'],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rechaza externalSource con caracteres prohibidos (espacios, mayúsculas)', () => {
    const wrongChars = moduleManifestSchema.safeParse({
      ...baseManifest,
      didacta: {
        externalSource: 'Learn Dash',
        permissions: ['courses.upsertByExternalRef'],
      },
    });
    expect(wrongChars.success).toBe(false);

    const upperCase = moduleManifestSchema.safeParse({
      ...baseManifest,
      didacta: {
        externalSource: 'LEARNDASH',
        permissions: ['courses.upsertByExternalRef'],
      },
    });
    expect(upperCase.success).toBe(false);
  });

  it('acepta externalSource con guión y guión bajo', () => {
    const dash = moduleManifestSchema.safeParse({
      ...baseManifest,
      didacta: {
        externalSource: 'learn-dash',
        permissions: ['courses.upsertByExternalRef'],
      },
    });
    expect(dash.success).toBe(true);

    const underscore = moduleManifestSchema.safeParse({
      ...baseManifest,
      didacta: {
        externalSource: 'learn_dash',
        permissions: ['courses.upsertByExternalRef'],
      },
    });
    expect(underscore.success).toBe(true);
  });

  it('rechaza externalSource vacío', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      didacta: {
        externalSource: '',
        permissions: ['courses.upsertByExternalRef'],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rechaza externalSource > 40 chars', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      didacta: {
        externalSource: 'a'.repeat(41),
        permissions: ['courses.upsertByExternalRef'],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rechaza didacta sin externalSource (campo obligatorio)', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      didacta: {
        permissions: ['courses.upsertByExternalRef'],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rechaza didacta sin permissions (campo obligatorio)', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      didacta: {
        externalSource: 'learndash',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rechaza didacta con campos extra (strict)', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      didacta: {
        externalSource: 'learndash',
        permissions: ['courses.upsertByExternalRef'],
        extra: 'field',
      },
    });
    expect(result.success).toBe(false);
  });
});
