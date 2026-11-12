/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Qué ficheros del storage local se pueden servir SIN sesión.
 *
 * `GET /api/v1/storage/file/<key>` es público por necesidad: lo que sirve se
 * carga desde `<img src>`, desde un `<iframe>` de SCORM o desde el enlace de un
 * correo, y ninguno de los tres manda el token de sesión. Pero «público por
 * necesidad» no es «todo lo que haya en el disco»: antes el controlador servía
 * CUALQUIER clave bajo la raíz del storage, y en esa raíz vivía también la
 * clave maestra de cifrado (`.didacta-secret-key`). Bastaba pedirla por URL.
 *
 * Así que se invierte la regla: se sirve SOLO lo que está en esta lista. Todo
 * lo demás responde 404, exista o no.
 *
 *  - `tenants/<tenant>/uploads/…`  imágenes y adjuntos del editor, la
 *    comunidad y los avatares. Van incrustados en lecciones, publicaciones y
 *    correos.
 *  - `tenants/<tenant>/branding/…` logo y favicon del aula (pantalla de
 *    acceso, correos).
 *  - `scorm/<tenant>/<paquete>/…`  los ficheros de un paquete SCORM: el
 *    `<iframe>` carga el HTML de entrada y este pide el resto por ruta
 *    relativa.
 *  - `mod-uploads/<módulo>/<tenant>/<sha256>` lo que suben los módulos (p. ej.
 *    las portadas que importa un migrador), referenciado desde su contenido.
 *
 * Lo que NO está, a propósito, aunque viva en el mismo disco: `certificates/`
 * (PDF con nombre y apellidos; se descargan por su propio endpoint),
 * `evidence/` (evidencias de formación bonificada; ídem), `modules/` (los ZIP
 * firmados del marketplace; ídem) y cualquier fichero de la raíz o con punto
 * delante, que es donde el propio servidor guarda lo suyo.
 */
const PUBLIC_KEY_PATTERNS: readonly RegExp[] = [
  /^tenants\/[^/]+\/uploads\/.+$/,
  /^tenants\/[^/]+\/branding\/.+$/,
  /^scorm\/[^/]+\/[^/]+\/.+$/,
  /^mod-uploads\/[^/]+\/[^/]+\/.+$/,
];

/** Mismo alfabeto que acepta `LocalDiskStorageService` al guardar. */
const KEY_CHARSET = /^[A-Za-z0-9._\-/]+$/;

/**
 * ¿Algún segmento de la ruta es inservible? Vacío (`a//b`, barra al principio o
 * al final) o con punto delante (`.oculto`, `.`, `..`). Lo comparten el
 * controlador público y el adaptador de disco: ningún camino de la aplicación
 * lee ni escribe ficheros ocultos de la raíz del storage.
 */
export function hasForbiddenSegment(key: string): boolean {
  return key.split('/').some((segment) => segment.length === 0 || segment.startsWith('.'));
}

/**
 * ¿Se puede servir esta clave sin sesión? Recibe la clave ya decodificada (lo
 * que entrega el router, no la URL cruda): así `%2e` y compañía se juzgan por
 * lo que son.
 */
export function isPublicStorageKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 512) return false;
  if (!KEY_CHARSET.test(key)) return false;
  if (hasForbiddenSegment(key)) return false;
  return PUBLIC_KEY_PATTERNS.some((pattern) => pattern.test(key));
}
