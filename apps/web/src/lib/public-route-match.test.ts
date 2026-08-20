/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import {
  assertNoPublicRouteCollisions,
  matchPublicRoute,
  normalizePathname,
  publicRouteKey,
  routeSpecificity,
  selectPublicRoute,
} from './public-route-match';

describe('normalizePathname', () => {
  it('deja la raíz como está', () => {
    expect(normalizePathname('/')).toBe('/');
  });

  it('quita la barra final', () => {
    expect(normalizePathname('/blog/')).toBe('/blog');
  });

  it('añade la barra inicial si falta', () => {
    expect(normalizePathname('blog')).toBe('/blog');
  });
});

describe('matchPublicRoute', () => {
  it('casa una ruta estática', () => {
    expect(matchPublicRoute('/precios', '/precios')).toEqual({ params: {} });
    expect(matchPublicRoute('/precios', '/otro')).toBeNull();
  });

  it('casa la raíz', () => {
    expect(matchPublicRoute('/', '/')).toEqual({ params: {} });
    expect(matchPublicRoute('/', '/blog')).toBeNull();
  });

  it('captura un parámetro', () => {
    expect(matchPublicRoute('/blog/:slug', '/blog/como-crear-un-agente')).toEqual({
      params: { slug: 'como-crear-un-agente' },
    });
  });

  it('un parámetro no casa con un segmento vacío', () => {
    expect(matchPublicRoute('/blog/:slug', '/blog/')).toBeNull();
  });

  it('no casa si sobran segmentos', () => {
    expect(matchPublicRoute('/blog/:slug', '/blog/a/b')).toBeNull();
  });

  it('no casa si faltan segmentos', () => {
    expect(matchPublicRoute('/blog/:slug', '/blog')).toBeNull();
  });

  it('decodifica el parámetro', () => {
    expect(matchPublicRoute('/blog/:slug', '/blog/qu%C3%A9-es')).toEqual({
      params: { slug: 'qué-es' },
    });
  });

  it('el catch-all se queda con el resto, barras incluidas', () => {
    expect(matchPublicRoute('/:ruta*', '/guias/avanzado/uno')).toEqual({
      params: { ruta: 'guias/avanzado/uno' },
    });
  });

  it('el catch-all también cubre la raíz, con el resto vacío', () => {
    expect(matchPublicRoute('/:ruta*', '/')).toEqual({ params: { ruta: '' } });
  });
});

describe('routeSpecificity', () => {
  it('lo estático gana al parámetro, y el parámetro al catch-all', () => {
    expect(routeSpecificity('/blog/nuevo')).toBeGreaterThan(routeSpecificity('/blog/:slug'));
    expect(routeSpecificity('/blog/:slug')).toBeGreaterThan(routeSpecificity('/:ruta*'));
  });
});

describe('selectPublicRoute', () => {
  // El blog de VA360 cuelga de la raíz, así que convive un catch-all con
  // rutas concretas. Que gane la correcta no puede depender del orden.
  const rutas = [
    { pattern: '/:ruta*', id: 'articulo' },
    { pattern: '/', id: 'portada' },
    { pattern: '/blog', id: 'listado' },
    { pattern: '/blog/:slug', id: 'entrada' },
  ];

  it('la raíz va a la portada, no al catch-all', () => {
    expect(selectPublicRoute(rutas, '/')?.route.id).toBe('portada');
  });

  it('una ruta estática gana al catch-all', () => {
    expect(selectPublicRoute(rutas, '/blog')?.route.id).toBe('listado');
  });

  it('el parámetro gana al catch-all cuando el prefijo casa', () => {
    const hit = selectPublicRoute(rutas, '/blog/hola');
    expect(hit?.route.id).toBe('entrada');
    expect(hit?.params).toEqual({ slug: 'hola' });
  });

  it('lo que no casa con nada concreto cae en el catch-all', () => {
    const hit = selectPublicRoute(rutas, '/como-crear-un-agente');
    expect(hit?.route.id).toBe('articulo');
    expect(hit?.params).toEqual({ ruta: 'como-crear-un-agente' });
  });

  it('el orden de declaración NO cambia el resultado', () => {
    const alReves = [...rutas].reverse();
    for (const path of ['/', '/blog', '/blog/hola', '/lo-que-sea']) {
      expect(selectPublicRoute(alReves, path)?.route.id).toBe(
        selectPublicRoute(rutas, path)?.route.id,
      );
    }
  });

  it('devuelve null si no hay ninguna candidata', () => {
    expect(selectPublicRoute([{ pattern: '/precios' }], '/otra')).toBeNull();
  });
});

describe('publicRouteKey', () => {
  it('ignora cómo se llame el parámetro', () => {
    expect(publicRouteKey('/blog/:slug')).toBe(publicRouteKey('/blog/:id'));
  });

  it('distingue estático de parámetro', () => {
    expect(publicRouteKey('/blog/nuevo')).not.toBe(publicRouteKey('/blog/:slug'));
  });
});

describe('assertNoPublicRouteCollisions', () => {
  it('pasa cuando cada ruta tiene un solo dueño', () => {
    expect(() =>
      assertNoPublicRouteCollisions([
        { moduleName: 'mod.site', pattern: '/' },
        { moduleName: 'mod.site', pattern: '/blog/:slug' },
        { moduleName: 'mod.store', pattern: '/packs/:slug' },
      ]),
    ).not.toThrow();
  });

  it('falla si dos módulos reclaman la misma ruta, aunque el parámetro se llame distinto', () => {
    expect(() =>
      assertNoPublicRouteCollisions([
        { moduleName: 'mod.site', pattern: '/blog/:slug' },
        { moduleName: 'mod.store', pattern: '/blog/:id' },
      ]),
    ).toThrow(/misma ruta pública/);
  });

  it('el error nombra a los dos módulos, para que se sepa a quién preguntar', () => {
    let message = '';
    try {
      assertNoPublicRouteCollisions([
        { moduleName: 'mod.site', pattern: '/' },
        { moduleName: 'mod.store', pattern: '/' },
      ]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('mod.site');
    expect(message).toContain('mod.store');
  });

  it('caza también que un mismo módulo declare la ruta dos veces', () => {
    expect(() =>
      assertNoPublicRouteCollisions([
        { moduleName: 'mod.site', pattern: '/precios' },
        { moduleName: 'mod.site', pattern: '/precios' },
      ]),
    ).toThrow(/misma ruta pública/);
  });
});
