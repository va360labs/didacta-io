/*
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * La versión del núcleo, en UN solo sitio.
 *
 * Antes vivía en dos, y no coincidían: el arranque validaba
 * `coreVersionRequired` contra un `const CORE_VERSION = '0.0.1'` escrito a
 * mano en `module-registry.service.ts` (la llamada «versión de contrato»),
 * mientras el instalador del marketplace lo validaba contra
 * `DIDACTA_CORE_VERSION`, que el compose cablea al tag de la imagen. Con el
 * comparador arreglado, un módulo que declara `^0.0.1` satisfacía una y no la
 * otra: hasta entonces el desacuerdo estaba tapado porque el comparador era
 * permisivo. Decisión: manda la versión REAL del producto, resuelta en
 * caliente, y la usan todos.
 */

/**
 * Se memoiza SOLO la búsqueda del `package.json`, que toca disco. La variable
 * de entorno se relee en cada llamada a propósito: que la versión se inyecte
 * en runtime y no en build time es una propiedad deliberada (permite
 * sobreescribirla en un test sin recompilar), y memoizar el resultado final la
 * rompía — lo cazó `admin-system.controller.test.ts`, que la cambia en caliente
 * y esperaba verla reflejada.
 *
 * `null` = todavía no se ha buscado; `undefined` = se buscó y no está.
 */
let rootVersionCache: string | undefined | null = null;

/**
 * Busca el `package.json` de la raíz del monorepo subiendo desde este fichero.
 * Se identifica por el nombre (`didacta`), no por la posición: así sigue
 * valiendo desde `src/` en desarrollo y desde `dist/` dentro de la imagen.
 */
function readRootPackageVersion(): string | undefined {
  if (rootVersionCache !== null) return rootVersionCache;
  rootVersionCache = buscarVersionEnLaRaiz();
  return rootVersionCache;
}

function buscarVersionEnLaRaiz(): string | undefined {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === 'didacta' && pkg.version) return pkg.version;
      } catch {
        // package.json ilegible: seguimos subiendo, no es fatal.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Versión que corre AHORA, tal cual, con su prerelease si lo tiene
 * (`7.8.9-solo-para-este-test`). Es la que se REPORTA: health, panel de administración y
 * telemetría. `DIDACTA_CORE_VERSION` la inyecta la imagen desde su propio tag;
 * fuera del contenedor cae al `package.json` de la raíz.
 *
 * `npm_package_version` NO se consulta: en el contenedor la app no arranca por
 * `npm run`, así que esa variable no existe y devolvía siempre '0.0.0'.
 */
export function resolveCoreVersion(): string {
  return process.env['DIDACTA_CORE_VERSION'] ?? readRootPackageVersion() ?? '0.0.0';
}

/**
 * La misma versión, sin el prerelease (`7.8.9-solo-para-este-test` → `7.8.9`).
 * Es la que se
 * COMPARA contra el `coreVersionRequired` de los módulos.
 *
 * Hace falta porque semver ordena todo prerelease POR DEBAJO de su versión
 * final: `7.8.9-beta.1 < 7.8.9`, así que un módulo que declara `^7.8.9` no lo
 * satisfaría y ningún módulo cargaría durante toda la fase beta. Medido, no
 * supuesto. Recortar el prerelease es lo que ya se pretendía con la «versión
 * de contrato» congelada en 0.0.1; la diferencia es que ahora se DERIVA de la
 * versión real en vez de escribirse a mano, que es justo lo que las dejó
 * discrepando.
 *
 * No abre la mano hacia arriba: con `^0.1.0`, un core `0.2.0-alpha.1` da base
 * `0.2.0` y queda fuera igual.
 */
export function resolveCoreContractVersion(): string {
  const full = resolveCoreVersion();
  const base = /^(\d+\.\d+\.\d+)/.exec(full);
  return base ? base[1]! : full;
}

/** Solo para tests: olvida el `package.json` ya localizado. */
export function resetCoreVersionCache(): void {
  rootVersionCache = null;
}
