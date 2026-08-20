import { afterEach, describe, expect, it } from 'vitest';
import semver from 'semver';
import {
  resetCoreVersionCache,
  resolveCoreContractVersion,
  resolveCoreVersion,
} from '../src/core-version';
import { isCoreVersionCompatible } from '../src/marketplace/module-package.service';

const ENV = 'DIDACTA_CORE_VERSION';

function conVersion<T>(valor: string | undefined, fn: () => T): T {
  const previo = process.env[ENV];
  if (valor === undefined) delete process.env[ENV];
  else process.env[ENV] = valor;
  resetCoreVersionCache();
  try {
    return fn();
  } finally {
    if (previo === undefined) delete process.env[ENV];
    else process.env[ENV] = previo;
    resetCoreVersionCache();
  }
}

afterEach(() => resetCoreVersionCache());

describe('core-version — una sola versión para todo', () => {
  it('manda DIDACTA_CORE_VERSION, que la imagen cablea a su propio tag', () => {
    conVersion('0.1.0-beta.6', () => {
      expect(resolveCoreVersion()).toBe('0.1.0-beta.6');
    });
  });

  it('sin la variable, cae al package.json de la raíz y NO a un 0.0.0 inventado', () => {
    conVersion(undefined, () => {
      // El fallback viejo era el literal '0.0.0', que rechazaba todos los
      // módulos fuera del contenedor: en desarrollo no cargaba ninguno.
      expect(resolveCoreVersion()).not.toBe('0.0.0');
      expect(semver.valid(resolveCoreVersion())).not.toBeNull();
    });
  });

  it('la versión de contrato recorta el prerelease', () => {
    conVersion('0.1.0-beta.6', () => {
      expect(resolveCoreVersion()).toBe('0.1.0-beta.6');
      expect(resolveCoreContractVersion()).toBe('0.1.0');
    });
  });

  it('un módulo first-party pasa LAS DOS validaciones con la misma versión', () => {
    // La regresión concreta: `^0.1.0` contra un core en beta pasaba por el
    // comparador del instalador y fallaba por el semver del arranque, porque
    // cada uno miraba una versión distinta.
    conVersion('0.1.0-beta.6', () => {
      const contrato = resolveCoreContractVersion();
      expect(isCoreVersionCompatible('^0.1.0', contrato)).toBe(true);
      expect(semver.satisfies(contrato, '^0.1.0')).toBe(true);
    });
  });

  it('sin recortar el prerelease, el arranque rechazaría al módulo', () => {
    // Deja constancia de por qué existe `resolveCoreContractVersion`: es la
    // comprobación que cae en rojo si alguien decide usar la versión a pelo.
    expect(semver.satisfies('0.1.0-beta.6', '^0.1.0')).toBe(false);
  });

  it('recortar el prerelease no abre la mano hacia arriba', () => {
    // Un core 0.2.0-alpha.1 es MÁS nuevo, y un módulo de la 0.1.x sigue fuera:
    // en 0.x el minor hace de major.
    conVersion('0.2.0-alpha.1', () => {
      const contrato = resolveCoreContractVersion();
      expect(contrato).toBe('0.2.0');
      expect(isCoreVersionCompatible('^0.1.0', contrato)).toBe(false);
      expect(semver.satisfies(contrato, '^0.1.0')).toBe(false);
    });
  });
});
