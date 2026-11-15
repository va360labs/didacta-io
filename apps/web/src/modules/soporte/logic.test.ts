/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import enSoporte from '@/i18n/messages/en/modSoporte.json';
import esSoporte from '@/i18n/messages/es/modSoporte.json';
import ptSoporte from '@/i18n/messages/pt/modSoporte.json';
import enErrors from '@/i18n/messages/en/errorsApiModulesB.json';
import esErrors from '@/i18n/messages/es/errorsApiModulesB.json';
import ptErrors from '@/i18n/messages/pt/errorsApiModulesB.json';
import { mergeExtensionSidebarItems } from '@/lib/sidebar-extensions-merge';
import { buildAdminGroups, buildGroups } from '@/lib/sidebar-nav';
import { buildSimpleMore, buildSimpleTabs } from '@/lib/simple-nav';
import { soporteExtension } from './index';
import {
  CAPTURA_MAX_BYTES,
  ESTADOS,
  TEXTO_MAX,
  TEXTO_MIN,
  TIPOS,
  construirContexto,
  construirPayload,
  estadoBadge,
  filtrosAQuery,
  puedeVerBandeja,
  ticketPedido,
  urlEnlazable,
  validarCaptura,
  validarTexto,
} from './logic';

describe('tipos de ticket', () => {
  it('tres tipos; la sugerencia, la primera (la ventana es también el buzón)', () => {
    expect(TIPOS).toEqual(['MEJORA', 'FALLO', 'PROBLEMA']);
  });

  it('cada tipo tiene etiqueta, ayuda, pregunta y pista en los tres idiomas', () => {
    for (const cat of [esSoporte, enSoporte, ptSoporte]) {
      for (const tipo of TIPOS) {
        const t = cat.tipos[tipo];
        for (const campo of ['label', 'ayuda', 'pregunta', 'pista'] as const) {
          expect(t[campo].length, `${tipo}.${campo}`).toBeGreaterThan(0);
        }
      }
    }
    expect(esSoporte.tipos.MEJORA.label).toBe('Tengo una sugerencia');
    expect(enSoporte.tipos.FALLO.label).toBe('Something is not working');
    expect(ptSoporte.tipos.PROBLEMA.label).toBe('Estou com um problema');
  });

  it('quien administra escribe a Didacta: sus tipos, su ventana y su «enviado», en los tres idiomas', () => {
    for (const cat of [esSoporte, enSoporte, ptSoporte]) {
      for (const tipo of TIPOS) {
        const t = cat.tiposPlataforma[tipo];
        for (const campo of ['label', 'ayuda', 'pregunta', 'pista'] as const) {
          expect(t[campo].length, `${tipo}.${campo}`).toBeGreaterThan(0);
        }
      }
      // La ventana dice a quién escribe y que la respuesta llega por correo.
      expect(cat.dialogo.tituloPlataforma).toMatch(/Didacta/);
      expect(cat.dialogo.enviadoCorreoPlataforma).toContain('{email}');
      expect(cat.mios.enviadoADidacta).toMatch(/Didacta/);
    }
    expect(esSoporte.dialogo.tituloPlataforma).toBe('Escribe al equipo de Didacta');
    expect(enSoporte.dialogo.tituloPlataforma).toBe('Write to the Didacta team');
    expect(ptSoporte.dialogo.tituloPlataforma).toBe('Escreva para a equipe da Didacta');
    expect(enSoporte.mios.enviadoADidacta).toBe('Sent to Didacta');
    expect(ptSoporte.mios.enviadoADidacta).toBe('Enviado à Didacta');
    // El miembro sigue escribiendo a su aula, no a Didacta.
    expect(esSoporte.dialogo.descripcion).not.toMatch(/Didacta/);
    expect(enSoporte.dialogo.descripcion).not.toMatch(/Didacta/);
  });

  it('en portugués el aula es «escola», nunca «academia»', () => {
    const texto = JSON.stringify(ptSoporte);
    expect(texto).toMatch(/escola/);
    expect(texto).not.toMatch(/academia/i);
  });
});

describe('estados', () => {
  it('cuatro estados con su etiqueta en cada idioma', () => {
    expect(ESTADOS.map((e) => esSoporte.estados[e])).toEqual([
      'Nuevo',
      'En curso',
      'Resuelto',
      'Descartado',
    ]);
    expect(ESTADOS.map((e) => enSoporte.estados[e])).toEqual([
      'New',
      'In progress',
      'Resolved',
      'Dismissed',
    ]);
    expect(ESTADOS.map((e) => ptSoporte.estados[e])).toEqual([
      'Novo',
      'Em andamento',
      'Resolvido',
      'Descartado',
    ]);
  });

  it('cada estado tiene su color de badge', () => {
    expect(estadoBadge('NUEVO')).toBe('info');
    expect(estadoBadge('EN_CURSO')).toBe('warning');
    expect(estadoBadge('RESUELTO')).toBe('success');
    expect(estadoBadge('DESCARTADO')).toBe('muted');
  });
});

describe('validarTexto (devuelve la clave, no el texto)', () => {
  it(`exige entre ${TEXTO_MIN} y ${TEXTO_MAX} caracteres (sin contar espacios de los bordes)`, () => {
    expect(validarTexto('')).toBe('vacio');
    expect(validarTexto('   abc   ')).toBe('corto');
    expect(validarTexto('abcde')).toBeNull();
    expect(validarTexto('x'.repeat(TEXTO_MAX))).toBeNull();
    expect(validarTexto('x'.repeat(TEXTO_MAX + 1))).toBe('largo');
  });

  it('todas las claves que puede devolver existen en los tres idiomas', () => {
    for (const cat of [esSoporte, enSoporte, ptSoporte]) {
      for (const k of ['vacio', 'corto', 'largo', 'capturaTipo', 'capturaPesada'] as const) {
        expect(cat.validacion[k].length).toBeGreaterThan(0);
      }
      expect(cat.validacion.corto).toContain('{min}');
      expect(cat.validacion.largo).toContain('{max}');
    }
  });
});

describe('validarCaptura', () => {
  it('admite PNG, JPEG y WebP de hasta 5 MB', () => {
    expect(validarCaptura({ type: 'image/png', size: 10 })).toBeNull();
    expect(validarCaptura({ type: 'image/jpeg', size: CAPTURA_MAX_BYTES })).toBeNull();
    expect(validarCaptura({ type: 'image/webp', size: 1 })).toBeNull();
  });

  it('rechaza otros formatos (también SVG, que puede llevar código)', () => {
    expect(validarCaptura({ type: 'image/gif', size: 10 })).toBe('capturaTipo');
    expect(validarCaptura({ type: 'image/svg+xml', size: 10 })).toBe('capturaTipo');
    expect(validarCaptura({ type: 'application/pdf', size: 10 })).toBe('capturaTipo');
  });

  it('rechaza más de 5 MB', () => {
    expect(validarCaptura({ type: 'image/png', size: CAPTURA_MAX_BYTES + 1 })).toBe(
      'capturaPesada',
    );
  });
});

describe('errores de la API', () => {
  it('todo code SOPORTE_* tiene frase en los tres idiomas', () => {
    const codes = Object.keys(esErrors).filter((k) => k.startsWith('SOPORTE_'));
    expect(codes).toHaveLength(14);
    for (const cat of [enErrors, ptErrors] as Array<Record<string, string>>) {
      for (const c of codes) expect(cat[c], c).toBeTruthy();
    }
    expect((enErrors as Record<string, string>)['SOPORTE_LIMITE_DIARIO']).toMatch(/24 hours/);
  });
});

describe('construirContexto', () => {
  it('recoge la página, el navegador, el tamaño de la ventana y la hora', () => {
    expect(
      construirContexto({
        href: 'https://aula.example/courses/1',
        userAgent: 'Mozilla/5.0 Test',
        innerWidth: 1280,
        innerHeight: 720,
        now: new Date('2026-11-12T10:00:00.000Z'),
      }),
    ).toEqual({
      url: 'https://aula.example/courses/1',
      userAgent: 'Mozilla/5.0 Test',
      viewport: '1280x720',
      at: '2026-11-12T10:00:00.000Z',
    });
  });

  it('guarda la página sin parámetros ni ancla: pueden llevar claves de un solo uso', () => {
    const c = construirContexto({
      href: 'https://aula.example/reset-password?token=secreto&x=1#paso',
      userAgent: 'UA',
      innerWidth: 1,
      innerHeight: 1,
      now: new Date('2026-11-12T10:00:00.000Z'),
    });
    expect(c.url).toBe('https://aula.example/reset-password');
  });

  it('si la dirección no se entiende, la manda sin lo que va tras «?» o «#»', () => {
    const c = construirContexto({
      href: 'no-es-una-url?token=secreto',
      userAgent: 'UA',
      innerWidth: 1,
      innerHeight: 1,
      now: new Date('2026-11-12T10:00:00.000Z'),
    });
    expect(c.url).toBe('no-es-una-url');
  });
});

describe('construirPayload', () => {
  const contexto = { url: 'u', userAgent: 'ua', viewport: '1x1', at: 'a' };

  it('recorta el texto y manda tipo y contexto; sin captura no hay campo captura', () => {
    const p = construirPayload({ tipo: 'MEJORA', texto: '  Una idea  ', contexto });
    expect(p).toEqual({ tipo: 'MEJORA', texto: 'Una idea', contexto });
    expect('captura' in p).toBe(false);
  });

  it('con captura la manda en base64 con su nombre y tipo', () => {
    const p = construirPayload({
      tipo: 'FALLO',
      texto: 'No carga el vídeo',
      contexto,
      captura: { data: 'AAAA', filename: 'pantalla.png', contentType: 'image/png' },
    });
    expect(p.captura).toEqual({ data: 'AAAA', filename: 'pantalla.png', contentType: 'image/png' });
  });
});

describe('filtrosAQuery', () => {
  it('solo pone los filtros elegidos', () => {
    expect(filtrosAQuery({})).toBe('');
    expect(filtrosAQuery({ estado: 'NUEVO' })).toBe('?estado=NUEVO');
    expect(filtrosAQuery({ estado: 'RESUELTO', tipo: 'FALLO' })).toBe(
      '?estado=RESUELTO&tipo=FALLO',
    );
  });
});

describe('urlEnlazable', () => {
  it('solo enlaza http(s); el resto (lo escribe el navegador del miembro) va como texto', () => {
    expect(urlEnlazable('https://aula.example/courses')).toBe('https://aula.example/courses');
    expect(urlEnlazable('http://localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(urlEnlazable('javascript:alert(1)')).toBeNull();
    expect(urlEnlazable('no es una url')).toBeNull();
    expect(urlEnlazable(null)).toBeNull();
  });
});

describe('ticketPedido', () => {
  it('lee ?ticket=<id> y descarta vacíos', () => {
    expect(ticketPedido('abc')).toBe('abc');
    expect(ticketPedido('  ')).toBeNull();
    expect(ticketPedido(null)).toBeNull();
  });
});

describe('acceso a la bandeja del equipo', () => {
  it('solo super_admin y tenant_admin', () => {
    expect(puedeVerBandeja(['super_admin'])).toBe(true);
    expect(puedeVerBandeja(['tenant_admin'])).toBe(true);
    expect(puedeVerBandeja(['formador'])).toBe(false);
    expect(puedeVerBandeja(['moderador'])).toBe(false);
    expect(puedeVerBandeja(['alumno'])).toBe(false);
  });

  const enAdmin = (rol: string) =>
    mergeExtensionSidebarItems(
      buildAdminGroups({ isSuperAdmin: rol === 'super_admin' }),
      [soporteExtension],
      new Set([rol]),
    );

  it('la entrada del menú de administración la ven tenant_admin y super_admin; formador y moderador no', () => {
    const ve = (rol: string) =>
      enAdmin(rol)
        .flatMap((g) => g.items)
        .some((i) => i.href === '/admin/support');
    expect(ve('tenant_admin')).toBe(true);
    expect(ve('super_admin')).toBe(true);
    expect(ve('formador')).toBe(false);
    expect(ve('moderador')).toBe(false);
  });

  it('va en «Comunicación» y depende de mod.soporte (el merge le pone requiresModule)', () => {
    const grupo = enAdmin('tenant_admin').find((g) =>
      g.items.some((i) => i.href === '/admin/support'),
    );
    expect(grupo?.label).toBe('Comunicación');
    expect(grupo?.items.find((i) => i.href === '/admin/support')?.requiresModule).toBe(
      'mod.soporte',
    );
  });

  it('modo sencillo: la bandeja sale UNA vez en «Más» para quien administra, nunca para un alumno', () => {
    const roles = new Set(['tenant_admin']);
    const full = mergeExtensionSidebarItems(
      [
        ...buildGroups({
          isAdminOrFormador: true,
          isAdmin: true,
          isSuperAdmin: false,
          espacios: { label: 'Foros', icon: 'hash', items: [] },
        }),
        ...buildAdminGroups({ isSuperAdmin: false }),
      ],
      [soporteExtension],
      roles,
    );
    const tabs = buildSimpleTabs({ isAdmin: true, activeModules: null, hasSold: false });
    const more = buildSimpleMore(full, tabs);
    const veces = more.flatMap((g) => g.items).filter((i) => i.href === '/admin/support');
    expect(veces).toHaveLength(1);

    const alumno = mergeExtensionSidebarItems(
      buildGroups({
        isAdminOrFormador: false,
        isAdmin: false,
        isSuperAdmin: false,
        espacios: { label: 'Foros', icon: 'hash', items: [] },
      }),
      [soporteExtension],
      new Set(['alumno']),
    );
    const masAlumno = buildSimpleMore(
      alumno,
      buildSimpleTabs({ isAdmin: false, activeModules: null, hasSold: false }),
    );
    expect(masAlumno.flatMap((g) => g.items).some((i) => i.href === '/admin/support')).toBe(false);
  });
});
