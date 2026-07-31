/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import semver from 'semver';
import type { DidactaModule } from '@didacta/core-kernel';

export class CircularDependencyError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Dependencia circular detectada: ${cycle.join(' → ')}`);
    this.name = 'CircularDependencyError';
  }
}

export class MissingDependencyError extends Error {
  constructor(
    public readonly moduleName: string,
    public readonly missingDependency: string,
  ) {
    super(`El módulo "${moduleName}" depende de "${missingDependency}", pero no está registrado`);
    this.name = 'MissingDependencyError';
  }
}

export class DependencyVersionMismatchError extends Error {
  constructor(
    public readonly moduleName: string,
    public readonly dependencyName: string,
    public readonly requiredRange: string,
    public readonly actualVersion: string,
  ) {
    super(
      `El módulo "${moduleName}" requiere "${dependencyName}@${requiredRange}", pero la versión instalada es "${actualVersion}"`,
    );
    this.name = 'DependencyVersionMismatchError';
  }
}

/**
 * Ordena una colección de módulos por sus dependencias (topological sort).
 * Valida que todas las dependencias obligatorias estén presentes y sus versiones
 * satisfagan el rango SemVer declarado.
 *
 * Retorna los módulos en un orden seguro para registro/activación: un módulo
 * siempre aparece después de sus dependencias.
 */
export function resolveDependencyOrder(modules: readonly DidactaModule[]): DidactaModule[] {
  const moduleMap = new Map<string, DidactaModule>();
  for (const mod of modules) {
    if (moduleMap.has(mod.manifest.name)) {
      throw new Error(`Módulo duplicado: "${mod.manifest.name}" aparece dos veces`);
    }
    moduleMap.set(mod.manifest.name, mod);
  }

  // Validar dependencias obligatorias y versiones
  for (const mod of modules) {
    for (const dep of mod.manifest.dependencies.modules) {
      const depModule = moduleMap.get(dep.name);
      if (!depModule) {
        throw new MissingDependencyError(mod.manifest.name, dep.name);
      }
      if (!semver.satisfies(depModule.manifest.version, dep.version)) {
        throw new DependencyVersionMismatchError(
          mod.manifest.name,
          dep.name,
          dep.version,
          depModule.manifest.version,
        );
      }
    }
  }

  // Topological sort con DFS + detección de ciclos
  const sorted: DidactaModule[] = [];
  const permanent = new Set<string>();
  const temporary = new Set<string>();
  const pathStack: string[] = [];

  function visit(name: string): void {
    if (permanent.has(name)) return;
    if (temporary.has(name)) {
      const cycleStart = pathStack.indexOf(name);
      const cycle = [...pathStack.slice(cycleStart), name];
      throw new CircularDependencyError(cycle);
    }

    const mod = moduleMap.get(name);
    if (!mod) return;

    temporary.add(name);
    pathStack.push(name);

    for (const dep of mod.manifest.dependencies.modules) {
      visit(dep.name);
    }

    pathStack.pop();
    temporary.delete(name);
    permanent.add(name);
    sorted.push(mod);
  }

  for (const mod of modules) {
    visit(mod.manifest.name);
  }

  return sorted;
}
