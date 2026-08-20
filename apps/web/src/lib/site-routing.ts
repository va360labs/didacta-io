/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Prefijo interno bajo el que se monta el sitio público.
///
/// Next no sabe enrutar por dominio, así que el reparto lo hace el middleware
/// reescribiendo a este prefijo. Es un detalle de implementación, NO una URL:
/// el visitante nunca lo ve, y una petición que lo pida directamente se corta
/// en el middleware.
///
/// Tampoco puede empezar por `_`: en el App Router una carpeta con guion bajo
/// es una carpeta privada y no genera ruta, que es justo lo contrario de lo
/// que hace falta aquí.
export const SITE_PATH_PREFIX = '/sitio';

/// Convierte la ruta interna reescrita de vuelta en la que pidió el visitante.
/// `/sitio/blog/x` → `/blog/x`, y `/sitio` → `/`.
export function publicPathnameFromSegments(segments: readonly string[] | undefined): string {
  if (!segments || segments.length === 0) return '/';
  return `/${segments.join('/')}`;
}
