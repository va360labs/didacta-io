import { afterEach, describe, expect, it } from 'vitest';
import semver from 'semver';
import {
  resetCoreVersionCache,
  resolveCoreContractVersion,
  resolveCoreVersion,
} from '../src/core-version';
import { isCoreVersionCompatible } from '../src/marketplace/module-package.service';

const ENV = 'DIDACTA_CORE_VERSION';

/**
 * Versiones DELIBERADAMENTE imposibles. Al cortar release, `release-bump.sh`
 * reescribe la versión vieja en todo el repo y falla si queda alguna: un
 * número que parezca real se fosilizaría aquí y saldría en esa lista como si
 * fuera un sitio que hay que subir. Ya pasó dos veces.
 */
const VERSION_DE_PRUEBA = '7.8.9-solo-para-este-test';
const BASE_DE_PRUEBA = '7.8.9';

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
    conVersion(VERSION_DE_PRUEBA, () => {
      expect(resolveCoreVersion()).toBe(VERSION_DE_PRUEBA);
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
    conVersion(VERSION_DE_PRUEBA, () => {
      expect(resolveCoreVersion()).toBe(VERSION_DE_PRUEBA);
      expect(resolveCoreContractVersion()).toBe(BASE_DE_PRUEBA);
    });
  });

  it('un módulo first-party pasa LAS DOS validaciones con la misma versión', () => {
    // La regresión concreta: `^0.1.0` contra un core en beta pasaba por el
    // comparador del instalador y fallaba por el semver del arranque, porque
    // cada uno miraba una versión distinta.
    conVersion(VERSION_DE_PRUEBA, () => {
      const contrato = resolveCoreContractVersion();
      expect(isCoreVersionCompatible(`^${BASE_DE_PRUEBA}`, contrato)).toBe(true);
      expect(semver.satisfies(contrato, `^${BASE_DE_PRUEBA}`)).toBe(true);
    });
  });

  it('sin recortar el prerelease, el arranque rechazaría al módulo', () => {
    // Deja constancia de por qué existe `resolveCoreContractVersion`: es la
    // comprobación que cae en rojo si alguien decide usar la versión a pelo.
    expect(semver.satisfies(VERSION_DE_PRUEBA, `^${BASE_DE_PRUEBA}`)).toBe(false);
  });

  it('recortar el prerelease no abre la mano hacia arriba', () => {
    // Un core más nuevo sigue dejando fuera al módulo: recortar el prerelease
    // sólo iguala `X.Y.Z-pre` con `X.Y.Z`, no ensancha el rango.
    conVersion('8.0.0-alpha.1', () => {
      const contrato = resolveCoreContractVersion();
      expect(contrato).toBe('8.0.0');
      expect(isCoreVersionCompatible(`^${BASE_DE_PRUEBA}`, contrato)).toBe(false);
      expect(semver.satisfies(contrato, `^${BASE_DE_PRUEBA}`)).toBe(false);
    });
  });
});
