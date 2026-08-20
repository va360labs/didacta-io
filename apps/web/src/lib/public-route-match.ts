/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Emparejado de rutas públicas aportadas por módulos.
///
/// Pequeño a propósito: los patrones admitidos son tres (estático, parámetro
/// y catch-all) y nada más. Un enrutador general aquí sería la puerta a que
/// cada módulo invente su propia gramática, y quien acaba pagando eso es el
/// que depura por qué una URL cae en el módulo equivocado.
///
/// La regla que gobierna todo: **el orden de declaración no decide nada**.
/// Gana siempre el patrón más específico. Si dos módulos declaran el mismo
/// patrón, eso no se resuelve por precedencia — se considera un error y se
/// detecta al construir (`assertNoPublicRouteCollisions`).

export interface RouteMatch {
  params: Record<string, string>;
}

/** Normaliza una ruta: empieza por `/`, sin barra final (salvo la raíz). */
export function normalizePathname(pathname: string): string {
  const withLeading = pathname.startsWith('/') ? pathname : `/${pathname}`;
  if (withLeading === '/') return '/';
  return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading;
}

function segments(pathname: string): string[] {
  const normalized = normalizePathname(pathname);
  return normalized === '/' ? [] : normalized.slice(1).split('/');
}

/**
 * Empareja un patrón con una ruta. Devuelve los parámetros capturados, o
 * `null` si no casa.
 */
export function matchPublicRoute(pattern: string, pathname: string): RouteMatch | null {
  const patternSegments = segments(pattern);
  const pathSegments = segments(pathname);
  const params: Record<string, string> = {};

  for (let i = 0; i < patternSegments.length; i += 1) {
    const patternSegment = patternSegments[i] as string;

    // Catch-all: `:nombre*` se queda con todo lo que reste, barras incluidas.
    if (patternSegment.startsWith(':') && patternSegment.endsWith('*')) {
      const name = patternSegment.slice(1, -1);
      const rest = pathSegments.slice(i);
      // Un catch-all también casa con cero segmentos: `/:ruta*` cubre `/`.
      params[name] = rest.join('/');
      return { params };
    }

    const pathSegment = pathSegments[i];
    if (pathSegment === undefined) return null;

    if (patternSegment.startsWith(':')) {
      // Un parámetro no puede quedar vacío: `/blog/:slug` no casa con `/blog/`.
      if (pathSegment.length === 0) return null;
      params[patternSegment.slice(1)] = decodeURIComponent(pathSegment);
      continue;
    }

    if (patternSegment !== pathSegment) return null;
  }

  // Sin catch-all, la ruta no puede tener segmentos de más.
  return pathSegments.length === patternSegments.length ? { params } : null;
}

/**
 * Especificidad de un patrón. Mayor gana.
 *
 * Se ordena por: (1) no ser catch-all, (2) número de segmentos, (3) cuántos
 * de esos segmentos son estáticos. Así `/blog/nuevo` gana a `/blog/:slug`, y
 * `/blog/:slug` gana a `/:ruta*`, sin que importe en qué orden se declararon
 * ni qué módulo los trajo.
 */
export function routeSpecificity(pattern: string): number {
  const patternSegments = segments(pattern);
  const isCatchAll = patternSegments.some((s) => s.startsWith(':') && s.endsWith('*'));
  const staticCount = patternSegments.filter((s) => !s.startsWith(':')).length;
  return (isCatchAll ? 0 : 1_000_000) + patternSegments.length * 1_000 + staticCount;
}

/**
 * Elige la ruta que atiende `pathname` entre las candidatas, por
 * especificidad. Devuelve `null` si ninguna casa.
 */
export function selectPublicRoute<T extends { pattern: string }>(
  routes: readonly T[],
  pathname: string,
): { route: T; params: Record<string, string> } | null {
  const ordered = [...routes].sort(
    (a, b) => routeSpecificity(b.pattern) - routeSpecificity(a.pattern),
  );

  for (const route of ordered) {
    const matched = matchPublicRoute(route.pattern, pathname);
    if (matched) return { route, params: matched.params };
  }
  return null;
}

/**
 * Clave de comparación de un patrón, ignorando cómo se llamen los parámetros:
 * `/blog/:slug` y `/blog/:id` son la MISMA ruta y no pueden coexistir.
 */
export function publicRouteKey(pattern: string): string {
  return (
    '/' +
    segments(pattern)
      .map((s) => {
        if (s.startsWith(':') && s.endsWith('*')) return '*';
        if (s.startsWith(':')) return ':';
        return s;
      })
      .join('/')
  );
}

export interface PublicRouteOwner {
  moduleName: string;
  pattern: string;
}

/**
 * Falla si dos módulos reclaman la misma ruta.
 *
 * Se llama al construir el catálogo (import estático), así que una colisión
 * rompe la compilación en vez de resolverse en silencio por el orden de los
 * imports — que es justo el tipo de dependencia invisible que luego nadie
 * encuentra. Un módulo puede declarar el mismo patrón dos veces por error, y
 * eso también se caza.
 */
export function assertNoPublicRouteCollisions(owners: readonly PublicRouteOwner[]): void {
  const byKey = new Map<string, PublicRouteOwner[]>();

  for (const owner of owners) {
    const key = publicRouteKey(owner.pattern);
    byKey.set(key, [...(byKey.get(key) ?? []), owner]);
  }

  const collisions = [...byKey.entries()].filter(([, list]) => list.length > 1);
  if (collisions.length === 0) return;

  const detail = collisions
    .map(([key, list]) => {
      const claimants = list.map((o) => `${o.moduleName} (${o.pattern})`).join(', ');
      return `  ${key} ← ${claimants}`;
    })
    .join('\n');

  throw new Error(
    `Dos módulos reclaman la misma ruta pública. Esto no se resuelve por orden de ` +
      `declaración: hay que decidir de quién es la ruta.\n${detail}`,
  );
}
