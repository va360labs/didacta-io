/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_HASHES,
  LEGACY_QUERY_VALUES,
  LEGACY_ROUTES,
  LEGACY_TAB_VALUES,
  legacyRedirectPath,
  modernTab,
  modernizeUrl,
  queryParam,
} from './legacy-routes';

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

describe('modernTab', () => {
  it.each([
    ['datos', 'details'],
    ['notificaciones', 'notifications'],
    ['suscripcion', 'subscription'],
    ['compras', 'purchases'],
    ['seguridad', 'security'],
    ['actividad', 'activity'],
    ['negocio', 'business'],
    ['registro', 'registration'],
    ['pagos', 'payments'],
    ['claves', 'keys'],
    ['salientes', 'outbound'],
    ['resumen', 'overview'],
    ['formacion', 'training'],
    ['mensajes', 'messages'],
    ['acceso', 'access'],
    ['sanciones', 'sanctions'],
  ])('?tab=%s → %s', (vieja, nueva) => {
    expect(modernTab(vieja)).toBe(nueva);
  });

  it('el valor de ahora se queda como está (también los que nunca fueron español)', () => {
    for (const v of ['security', 'notifications', 'docs', 'zoom', 'saml', 'modules', 'raw']) {
      expect(modernTab(v)).toBe(v);
    }
  });

  it('los valores de antes que declara un módulo, con su mapa', () => {
    const modulo = { 'aula-virtual': 'virtual-classroom' };
    expect(modernTab('aula-virtual', modulo)).toBe('virtual-classroom');
    // Control: sin el mapa del módulo no se traduce (el core no lo conoce).
    expect(modernTab('aula-virtual')).toBe('aula-virtual');
  });

  it('sin valor, null; nada del prototipo cuela como valor de antes', () => {
    expect(modernTab(null)).toBeNull();
    expect(modernTab('  ')).toBeNull();
    expect(modernTab('constructor')).toBe('constructor');
    expect(modernTab('toString', {})).toBe('toString');
  });
});

describe('modernizeUrl', () => {
  it.each([
    // El cambio de contraseña obligatorio y la vuelta del portal de Stripe.
    ['/account', '?tab=seguridad', '', '/account?tab=security'],
    ['/account', '?tab=suscripcion&status=success', '', '/account?tab=subscription&status=success'],
    ['/admin', '?tab=negocio', '', '/admin?tab=business'],
    ['/admin/settings', '?tab=pagos&completo=1', '', '/admin/settings?tab=payments&full=1'],
    ['/u/u-1', '?tab=acceso', '', '/u/u-1?tab=access'],
    // Valores de otras claves, y la clave de antes a la vez.
    ['/calendar', '?vista=eventos', '', '/calendar?view=events'],
    ['/calendar', '?view=eventos', '', '/calendar?view=events'],
    // Anclas.
    ['/admin/payments', '', '#referidos', '/admin/payments#referrals'],
    ['/admin/payments', '?full=1', '#enlace', '/admin/payments?full=1#sale-link'],
    // La query que no es de antes se conserva tal cual, igual que el ancla.
    ['/admin', '?tab=actividad&ref=X', '#top', '/admin?tab=activity&ref=X#top'],
  ])('%s%s%s → %s', (pathname, search, hash, esperado) => {
    expect(modernizeUrl(pathname, search, hash)).toBe(esperado);
  });

  it('la clave nueva gana si vienen las dos: la vieja se quita', () => {
    expect(modernizeUrl('/admin/payments', '?full=0&completo=1', '')).toBe(
      '/admin/payments?full=0',
    );
  });

  it('con el mapa del módulo traduce su pestaña de antes', () => {
    expect(
      modernizeUrl('/admin/settings', '?tab=aula-virtual', '', {
        'aula-virtual': 'virtual-classroom',
      }),
    ).toBe('/admin/settings?tab=virtual-classroom');
  });

  it('una URL ya en inglés no se toca (null): si no, la pantalla entraría en bucle', () => {
    expect(modernizeUrl('/account', '?tab=security', '')).toBeNull();
    expect(modernizeUrl('/admin/payments', '?return=1', '#referrals')).toBeNull();
    expect(modernizeUrl('/calendar', '?view=events', '')).toBeNull();
    expect(modernizeUrl('/community', '', '')).toBeNull();
    // Un slug o una búsqueda en español en la query es contenido: no se traduce.
    expect(modernizeUrl('/courses', '?category=cocina&q=acuarela', '')).toBeNull();
  });
});

describe('tabla de valores de antes', () => {
  it('cada valor nuevo es inglés en kebab-case y ninguno es a la vez uno de antes', () => {
    const viejos = new Set([
      ...Object.keys(LEGACY_TAB_VALUES),
      ...Object.values(LEGACY_QUERY_VALUES).flatMap((m) => Object.keys(m)),
      ...Object.keys(LEGACY_HASHES),
    ]);
    const nuevos = [
      ...Object.values(LEGACY_TAB_VALUES),
      ...Object.values(LEGACY_QUERY_VALUES).flatMap((m) => Object.values(m)),
      ...Object.values(LEGACY_HASHES),
    ];
    for (const n of nuevos) {
      expect(n, n).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(viejos.has(n), `${n} es también un valor de antes`).toBe(false);
    }
  });
});

/** Ficheros de código de la web (sin tests ni catálogos): donde no puede quedar un valor de antes. */
function webSources(): Array<{ file: string; text: string }> {
  const root = path.resolve(__dirname, '..');
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== 'node_modules' && name !== 'i18n') walk(full);
      } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
        // La tabla de lo de antes es justo donde tienen que estar.
        if (full.endsWith(path.join('lib', 'legacy-routes.ts'))) continue;
        out.push({ file: path.relative(root, full), text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(root);
  return out;
}

/** ¿La coincidencia está en un comentario? (citan el valor de antes para explicar la compatibilidad). */
function enComentario(text: string, index: number): boolean {
  const inicio = text.lastIndexOf('\n', index) + 1;
  return /^\s*(\/\/|\*|\/\*)/.test(text.slice(inicio, index));
}

describe('ningún valor de URL de antes en el código de la web', () => {
  const fuentes = webSources();

  it('se leyeron los ficheros (si no, el resto no probaría nada)', () => {
    expect(fuentes.length).toBeGreaterThan(100);
    expect(fuentes.some((f) => f.text.includes('?tab=security'))).toBe(true);
    expect(fuentes.some((f) => f.text.includes('id="referrals"'))).toBe(true);
  });

  it('ningún `?tab=` ni pestaña (`value="…"`) con un valor de antes', () => {
    const viejos = new Set(Object.keys(LEGACY_TAB_VALUES));
    const malos: string[] = [];
    for (const { file, text } of fuentes) {
      for (const m of text.matchAll(/[?&]tab=([a-z][a-z-]*)/g)) {
        if (viejos.has(m[1]!) && !enComentario(text, m.index!)) malos.push(`${file}: ?tab=${m[1]}`);
      }
      for (const m of text.matchAll(/<Tabs(?:Trigger|Content)\s+value="([^"]+)"/g)) {
        if (viejos.has(m[1]!)) malos.push(`${file}: pestaña «${m[1]}»`);
      }
    }
    expect(malos, malos.join('\n')).toEqual([]);
  });

  it('ninguna ancla de antes: ni enlace (`#referidos`) ni destino (`id="referidos"`)', () => {
    const malos: string[] = [];
    for (const { file, text } of fuentes) {
      for (const v of Object.keys(LEGACY_HASHES)) {
        for (const re of [new RegExp(`#${v}["'\`]`, 'g'), new RegExp(`\\bid="${v}"`, 'g')]) {
          for (const m of text.matchAll(re)) {
            if (!enComentario(text, m.index!)) malos.push(`${file}: ${m[0]}`);
          }
        }
      }
    }
    expect(malos, malos.join('\n')).toEqual([]);
  });
});
