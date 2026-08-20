/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTHENTICATED_MODULE_SURFACES, MODULE_SURFACES, isModuleSurface } from '../src/surfaces';

describe('MODULE_SURFACES', () => {
  it('incluye la superficie pública', () => {
    expect(MODULE_SURFACES).toContain('publico');
  });

  it('no tiene duplicados', () => {
    expect(new Set(MODULE_SURFACES).size).toBe(MODULE_SURFACES.length);
  });

  it('`publico` es la única que no exige sesión', () => {
    expect(AUTHENTICATED_MODULE_SURFACES).not.toContain('publico');
    expect(AUTHENTICATED_MODULE_SURFACES).toHaveLength(MODULE_SURFACES.length - 1);
  });
});

describe('isModuleSurface', () => {
  it('acepta cada superficie del contrato', () => {
    for (const surface of MODULE_SURFACES) {
      expect(isModuleSurface(surface)).toBe(true);
    }
  });

  it('rechaza `student`, que nunca ha existido pese a estar declarada en un manifiesto', () => {
    expect(isModuleSurface('student')).toBe(false);
  });

  it('rechaza valores que no son cadenas', () => {
    for (const value of [null, undefined, 42, {}, ['admin']]) {
      expect(isModuleSurface(value)).toBe(false);
    }
  });
});

/// Este bloque es el que habría cazado el fallo: recorre los manifiestos REALES
/// del repo en vez de fiarse de que alguien los valide en otro sitio. Los
/// `module.json` internos no pasan por el esquema Zod del marketplace, así que
/// sin esto no los mira nadie.
describe('los manifiestos del repo declaran superficies del contrato', () => {
  const modulesDir = resolve(__dirname, '../../../modules');

  const manifests = existsSync(modulesDir)
    ? readdirSync(modulesDir)
        .filter((name) => existsSync(join(modulesDir, name, 'module.json')))
        .map((name) => ({
          name,
          manifest: JSON.parse(readFileSync(join(modulesDir, name, 'module.json'), 'utf8')) as {
            surfaces?: unknown;
          },
        }))
    : [];

  it('encuentra los manifiestos (si esto falla, el resto del bloque no prueba nada)', () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  it.each(manifests.map((m) => [m.name, m.manifest] as const))('%s', (_name, manifest) => {
    const { surfaces } = manifest;
    if (surfaces === undefined || surfaces === null) return;

    // Dos grafías vivas: array de nombres (20 módulos) y objeto con la
    // configuración por superficie (el esquema del marketplace).
    const declared = Array.isArray(surfaces)
      ? surfaces
      : Object.keys(surfaces as Record<string, unknown>);

    for (const surface of declared) {
      expect(isModuleSurface(surface), `superficie desconocida: ${JSON.stringify(surface)}`).toBe(
        true,
      );
    }
  });
});
