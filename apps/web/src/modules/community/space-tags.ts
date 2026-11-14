/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Rótulo de un tag de publicación.
 *
 * El primer tag de cada publicación es el SLUG del espacio donde se publicó
 * (`general`, `preguntas`, `anuncios`…). El slug es un identificador estable
 * —la API y el agente publican en `general` por defecto— y no se traduce; lo
 * que se lee es el TÍTULO del espacio, que se siembra en el idioma del aula
 * («Questions», «Perguntas e dúvidas»). El modo completo pintaba el slug tal
 * cual y un aula inglesa veía «preguntas». Un tag que no es de ningún espacio
 * se queda como está: lo escribió una persona.
 */
export function spaceTagLabel(
  spaces: ReadonlyArray<{ slug: string; title: string }>,
  tag: string,
): string {
  return spaces.find((s) => s.slug === tag)?.title ?? tag;
}
