/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Marca por defecto del aula en los CORREOS (Valentín, 14-nov-2026): sin logo,
 * las iniciales del aula sobre su color, nunca el logo de Didacta; y al pie
 * «Powered by Didacta — Crea tu academia gratis», enlazado al alta de
 * didacta.io en el idioma del correo con la campaña del aula.
 *
 * La tabla de iniciales es la MISMA que `apps/web/src/lib/academy-mark.test.ts`:
 * la cabecera del aula y la del correo tienen que decir lo mismo.
 */

import { describe, expect, it } from 'vitest';
import {
  academyInitials,
  academyMarkColors,
  contrastRatio,
  MARK_DARK_TEXT,
  MIN_MARK_CONTRAST,
  poweredByHref,
  poweredByText,
} from '../src/common/academy-mark';
import {
  renderBrandedEmail,
  resolveEmailBranding,
  type BrandingPrisma,
  type EmailBranding,
} from '../src/common/branded-email';

const CASOS_INICIALES: Array<[string | null | undefined, string]> = [
  ['Potenzia', 'P'],
  ['Academia de Yoga', 'AY'],
  ['  Ana   Pérez  ', 'AP'],
  ['ágora escuela', 'ÁE'],
  ['Ágora', 'Á'],
  ['E\u0301cole Lumière', 'ÉL'],
  ['x\u0303avier Ruiz', 'X\u0303R'],
  ['Ñandú Formación', 'ÑF'],
  ['🚀 Cohete Academy', 'CA'],
  ['Cohete 🚀', 'C'],
  ['¡Hola Mundo!', 'HM'],
  ['Yoga-Pilates', 'YP'],
  ['Arte & Diseño', 'AD'],
  ['360 Academy', '3A'],
  ['VA360', 'V'],
  ['东京 学院', '东学'],
  ['Академия Света', 'АС'],
  ['🚀🔥', ''],
  ['   ', ''],
  ['', ''],
  [null, ''],
  [undefined, ''],
];

describe('academyInitials (correos)', () => {
  it.each(CASOS_INICIALES)('%j → %j', (name, expected) => {
    expect(academyInitials(name)).toBe(expected);
  });
});

describe('academyMarkColors (correos)', () => {
  it('contraste AA para cualquier color de marca', () => {
    const peores: string[] = [];
    for (let h = 0; h <= 360; h += 3) {
      for (let s = 0; s <= 100; s += 5) {
        const c = academyMarkColors(h, s);
        if (contrastRatio(c.background, c.foreground) < MIN_MARK_CONTRAST) peores.push(`${h}/${s}`);
      }
    }
    expect(peores).toEqual([]);
  });

  it('el amarillo lleva letras oscuras; el azul por defecto, blancas', () => {
    expect(academyMarkColors(55, 90).foreground).toBe(MARK_DARK_TEXT);
    expect(academyMarkColors(213, 70).foreground).toBe('#FFFFFF');
  });
});

describe('pie «Powered by Didacta» de los correos', () => {
  it('texto y enlace en el idioma del correo, con la campaña del aula', () => {
    expect(poweredByText('es')).toBe('Powered by Didacta — Crea tu academia gratis');
    expect(poweredByText('en')).toBe('Powered by Didacta — Create your own academy free');
    expect(poweredByText('pt')).toBe('Powered by Didacta — Crie sua escola grátis');
    expect(poweredByHref('es', 'cafe')).toBe(
      'https://didacta.io/es/start?utm_source=aula&utm_medium=powered_by&utm_campaign=cafe',
    );
    expect(poweredByHref('en', 'cafe')).toContain('https://didacta.io/en/start?');
    expect(poweredByHref('pt', 'cafe')).toContain('https://didacta.io/pt-br/start?');
    expect(poweredByHref('es', null)).not.toContain('utm_campaign');
  });
});

/** Prisma mínimo de un aula: nombre, slug y su tema (o ninguno). */
function prismaDe(
  tenant: { name: string; slug: string } | null,
  theme: { logoUrl: string | null; brandHue: number; brandSaturation: number } | null,
): BrandingPrisma {
  return {
    tenant: { findUnique: async () => tenant },
    modThemingTenantTheme: { findUnique: async () => theme },
  };
}

const CONTENT = { title: 'Hola', bodyHtml: '<p>x</p>', bodyText: 'x' } as const;

describe('correo de un aula SIN logo', () => {
  it('cabecera: sus iniciales sobre su color y su nombre; nada de Didacta arriba', async () => {
    const branding = await resolveEmailBranding(
      prismaDe(
        { name: 'Café Primeiro Gole', slug: 'cafe' },
        { logoUrl: null, brandHue: 20, brandSaturation: 80 },
      ),
      't1',
      'https://cafe.didacta.io',
    );
    expect(branding.academy).toEqual({
      slug: 'cafe',
      mark: { initials: 'CG', ...academyMarkColors(20, 80) },
    });
    const { html, text } = renderBrandedEmail(branding, { lang: 'es', ...CONTENT });
    const header = html.slice(0, html.indexOf('Hola'));
    expect(header).toContain('>CG</td>');
    expect(header).toContain(`background:${academyMarkColors(20, 80).background}`);
    expect(header).toContain('Café Primeiro Gole');
    expect(header).not.toMatch(/didacta/i);
    // Pie: la línea, enlazada al alta con la campaña del aula.
    expect(html).toContain(
      '<a href="https://didacta.io/es/start?utm_source=aula&amp;utm_medium=powered_by&amp;utm_campaign=cafe"',
    );
    expect(html).toContain('Powered by Didacta — Crea tu academia gratis</a>');
    expect(text).toContain(
      'Powered by Didacta — Crea tu academia gratis: https://didacta.io/es/start?utm_source=aula&utm_medium=powered_by&utm_campaign=cafe',
    );
  });

  it('en inglés y portugués, el pie en su idioma y a su didacta.io', async () => {
    const branding = await resolveEmailBranding(
      prismaDe({ name: 'Escola Sol', slug: 'sol' }, null),
      't1',
      'https://sol.didacta.io',
    );
    const en = renderBrandedEmail(branding, { lang: 'en', ...CONTENT });
    expect(en.html).toContain('https://didacta.io/en/start?');
    expect(en.html).toContain('Powered by Didacta — Create your own academy free</a>');
    const pt = renderBrandedEmail(branding, { lang: 'pt', ...CONTENT });
    expect(pt.html).toContain('https://didacta.io/pt-br/start?');
    expect(pt.html).toContain('Powered by Didacta — Crie sua escola grátis</a>');
    // Sin tema: el color por defecto del aula, con sus iniciales igualmente.
    expect(branding.academy?.mark?.initials).toBe('ES');
  });
});

describe('correo de un aula CON logo', () => {
  it('su logo, sin monograma; el pie igual', async () => {
    const branding = await resolveEmailBranding(
      prismaDe(
        { name: 'Café Primeiro Gole', slug: 'cafe' },
        { logoUrl: 'https://cdn.example/logo.png', brandHue: 20, brandSaturation: 80 },
      ),
      't1',
      'https://cafe.didacta.io',
    );
    expect(branding.academy?.mark).toBeNull();
    const { html } = renderBrandedEmail(branding, { lang: 'es', ...CONTENT });
    expect(html).toContain('<img src="https://cdn.example/logo.png"');
    expect(html).not.toContain('>CG</td>');
    expect(html).toContain('utm_campaign=cafe');
  });
});

describe('aviso de la PLATAFORMA (sin aula)', () => {
  it('control: sin `academy`, ni monograma ni «crea tu academia»', () => {
    const operador: EmailBranding = {
      tenantName: 'Didacta Cloud',
      logoUrl: null,
      brandColor: '#1E5AA8',
    };
    const { html, text } = renderBrandedEmail(operador, { lang: 'es', ...CONTENT });
    expect(html).not.toContain('</td>\n          <td style="padding-left:12px');
    expect(html).not.toContain('didacta.io/es/start');
    // El pie de la maqueta de correos: el texto solo, sin enlace al alta.
    expect(html).toMatch(/<p style="margin:0;[^"]*">Powered by Didacta<\/p>/);
    expect(html).not.toContain('Crea tu academia');
    expect(text.trim().endsWith('Powered by Didacta')).toBe(true);
  });

  it('si el aula no se puede leer, el correo sale como antes (sin romper el envío)', async () => {
    const roto: BrandingPrisma = {
      tenant: {
        findUnique: async () => {
          throw new Error('db caída');
        },
      },
      modThemingTenantTheme: { findUnique: async () => null },
    };
    const branding = await resolveEmailBranding(roto, 't1', 'https://x');
    expect(branding.academy).toBeUndefined();
    expect(renderBrandedEmail(branding, { lang: 'es', ...CONTENT }).html).toContain(
      'Powered by Didacta',
    );
  });
});
