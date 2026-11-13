/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_ROUTES, legacyRedirectPath, queryParam } from './legacy-routes';

describe('legacyRedirectPath', () => {
  it.each([
    ['/catalogo', '/catalog'],
    ['/catalogo/acuarela-desde-cero', '/catalog/acuarela-desde-cero'],
    ['/catalogo/checkout/success', '/catalog/checkout/success'],
    ['/unete', '/join'],
    ['/condiciones-referidos', '/referral-terms'],
    ['/verificar/0b6c', '/verify/0b6c'],
    ['/clase/abc', '/live/abc'],
    ['/comunidad', '/community'],
    ['/comunidad/menciones', '/community/mentions'],
    ['/comunidad/p-1', '/community/p-1'],
    ['/espacios/general', '/spaces/general'],
    ['/cuenta', '/account'],
    ['/cuenta/suscripciones', '/account/subscriptions'],
    ['/cursos/mi-curso', '/courses/mi-curso'],
    ['/empieza', '/start'],
    ['/bienvenida', '/welcome'],
    ['/inicio/mi-panel', '/home/dashboard'],
    ['/formador', '/studio'],
    ['/formador/cursos', '/studio/courses'],
    ['/formador/cursos/nuevo', '/studio/courses/new'],
    ['/formador/cursos/c-1', '/studio/courses/c-1'],
    ['/formador/cursos/c-1/alumnos', '/studio/courses/c-1/students'],
    ['/formador/cursos/c-1/alumnos/e-2', '/studio/courses/c-1/students/e-2'],
    ['/formador/aula-virtual', '/studio/live'],
    ['/formador/rutas/nueva', '/studio/paths/new'],
    ['/formador/correcciones/x', '/studio/grading/x'],
    ['/soporte/acceso', '/support/access'],
    ['/inscripcion-miembros/decision', '/member-registration/decision'],
    ['/admin/cobros', '/admin/payments'],
    ['/admin/configuracion', '/admin/settings'],
    ['/admin/usuarios/invitar', '/admin/users/invite'],
    ['/admin/usuarios/u-1', '/admin/users/u-1'],
    ['/admin/comunidad/tags', '/admin/community/tags'],
    ['/admin/fundae/empresas/e-1', '/admin/fundae/companies/e-1'],
    ['/admin/integraciones/migrator-learndash', '/admin/integrations/migrator-learndash'],
  ])('%s → %s', (vieja, nueva) => {
    expect(legacyRedirectPath(vieja)).toBe(nueva);
  });

  it.each([
    '/',
    '/catalog/acuarela',
    '/community',
    '/signin',
    '/u/1',
    '/admin',
    '/admin/branding',
    '/leaderboard',
    // Un slug que empieza como una ruta vieja no es esa ruta.
    '/clases',
    '/cursos-extra',
    // Los segmentos dinámicos no se traducen aunque sean palabras españolas.
    '/courses/cursos',
    // El prefijo interno del sitio nunca fue público.
    '/sitio',
    '/site/x',
  ])('%s → sin redirección', (ruta) => {
    expect(legacyRedirectPath(ruta)).toBeNull();
  });

  it('el slug de un curso que se llama como una ruta vieja se conserva', () => {
    expect(legacyRedirectPath('/catalogo/comunidad')).toBe('/catalog/comunidad');
    expect(legacyRedirectPath('/cursos/nuevo')).toBe('/courses/nuevo');
  });
});

describe('queryParam: el nombre en inglés y, si no viene, el de antes', () => {
  const q = (s: string) => new URLSearchParams(s);
  it.each([
    ['add', 'add=1', '1'],
    ['add', 'anadir=1', '1'],
    ['full', 'completo=1', '1'],
    ['return', 'vuelta=1', '1'],
    ['refresh', 'renovar=1', '1'],
    ['group', 'grupo=g-1', 'g-1'],
    ['view', 'vista=eventos', 'eventos'],
    ['view', 'view=events', 'events'],
  ] as const)('%s con ?%s → %s', (key, query, valor) => {
    expect(queryParam(q(query), key)).toBe(valor);
  });

  it('gana el nombre nuevo si vienen los dos', () => {
    expect(queryParam(q('full=0&completo=1'), 'full')).toBe('0');
  });

  it('sin el parámetro, o sin params, null', () => {
    expect(queryParam(q('tab=x'), 'full')).toBeNull();
    expect(queryParam(null, 'full')).toBeNull();
  });
});

/** Rutas de las páginas reales del App Router (sin los grupos `(xxx)`). */
function appRoutes(): string[] {
  const root = path.resolve(__dirname, '..', 'app');
  const out: string[] = [];
  const walk = (dir: string, segs: string[]) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full, /^\(.*\)$/.test(name) ? segs : [...segs, name]);
      } else if (name === 'page.tsx') {
        out.push(`/${segs.join('/')}`);
      }
    }
  };
  walk(root, []);
  return out;
}

describe('tabla de rutas viejas', () => {
  const rutas = appRoutes();

  it('cada destino es una página que existe (o el prefijo de una)', () => {
    for (const [, nueva] of LEGACY_ROUTES) {
      expect(
        rutas.some((r) => r === nueva || r.startsWith(`${nueva}/`)),
        `${nueva} no es ninguna página`,
      ).toBe(true);
    }
  });

  it('ninguna ruta vieja sigue existiendo como página (si no, nunca se serviría)', () => {
    for (const [vieja] of LEGACY_ROUTES) {
      expect(rutas.includes(vieja), `${vieja} sigue siendo una página`).toBe(false);
    }
  });

  it('ninguna página del aula lleva un segmento fijo de las rutas viejas', () => {
    const viejos = new Set(LEGACY_ROUTES.flatMap(([v]) => v.split('/').filter(Boolean)));
    // Están en rutas viejas pero no son español: se quedan.
    for (const ok of ['admin', 'fundae', 'tenants']) viejos.delete(ok);
    viejos.add('sitio');
    viejos.add('alumnos');
    for (const ruta of rutas) {
      const fijos = ruta.split('/').filter((s) => s && !s.startsWith('['));
      for (const s of fijos) expect(viejos.has(s), `${ruta} lleva «${s}»`).toBe(false);
    }
  });
});
