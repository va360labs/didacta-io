/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Superficies donde un módulo puede exponer UI.
///
/// Vive aquí, y no en el backend, por la misma razón que el resto de este
/// paquete: antes la lista existía SOLO dentro del esquema Zod del
/// marketplace, así que los `module.json` de los módulos internos —que no
/// pasan por ese esquema— podían declarar cualquier cosa sin que nadie se
/// enterara. Y lo hicieron: `modules/theming/module.json` declaraba la
/// superficie `student`, que no ha existido nunca.
///
/// Ahora la lista es única y la importan los tres sitios que deciden si un
/// manifiesto es válido: el esquema del marketplace, `module-doctor` y
/// cualquier packager de terceros.
export const MODULE_SURFACES = [
  /// Backoffice del tenant.
  'admin',
  /// Vista del instructor.
  'formador',
  /// Vista del alumno.
  'alumno',
  /// Informes y lectura.
  'auditor',
  /// Gestión B2B de empresa.
  'empresa_manager',
  /// Sitio público: SIN sesión, renderizado en servidor e indexable, servido
  /// bajo un dominio del tenant marcado como sitio. Es la única superficie que
  /// un visitante anónimo puede ver, así que nada de lo que se renderice ahí
  /// puede depender de un usuario autenticado.
  'publico',
] as const;

export type ModuleSurface = (typeof MODULE_SURFACES)[number];

/// Superficies que exigen sesión. `publico` es, por definición, la excepción.
export const AUTHENTICATED_MODULE_SURFACES: readonly ModuleSurface[] = MODULE_SURFACES.filter(
  (s): s is ModuleSurface => s !== 'publico',
);

export function isModuleSurface(value: unknown): value is ModuleSurface {
  return typeof value === 'string' && (MODULE_SURFACES as readonly string[]).includes(value);
}
