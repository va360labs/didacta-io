import { describe, expect, it } from 'vitest';
import { labelOr, markupOr, type MarkupTranslatorLike, type TranslatorLike } from './labels';

function makeT(catalog: Record<string, string>): TranslatorLike {
  const t = ((key: string) => catalog[key] ?? key) as TranslatorLike;
  t.has = (key: string) => key in catalog;
  return t;
}

describe('labelOr', () => {
  it('traduce cuando la key existe', () => {
    expect(labelOr(makeT({ 'estado.ACTIVE': 'Activo' }), 'estado.ACTIVE', 'ACTIVE')).toBe('Activo');
  });

  // CAMINO DEGRADADO: valor abierto que la API inventa (estado nuevo, enum de
  // un módulo de terceros). Nunca puede acabar pintando la key.
  it('degrada al valor crudo, nunca a la key', () => {
    const out = labelOr(makeT({}), 'estado.PENDING_REVIEW', 'PENDING_REVIEW');
    expect(out).toBe('PENDING_REVIEW');
    expect(out).not.toContain('estado.');
  });
});

describe('markupOr', () => {
  const TAGS = { p: (c: string) => `<p>${c}</p>` };

  it('devuelve el markup formateado cuando el mensaje es correcto', () => {
    const t: MarkupTranslatorLike = { markup: () => '<p>Hola</p>' };
    expect(markupOr(t, 'branding.footerPlaceholder', TAGS, 'FALLBACK')).toBe('<p>Hola</p>');
  });

  // CAMINO DEGRADADO 1: `use-intl` no lanza — devuelve `getMessageFallback`,
  // que sin override es la RUTA DE LA KEY. Eso NO se puede pintar.
  it('degrada cuando use-intl devuelve la ruta de la key', () => {
    const t: MarkupTranslatorLike = { markup: (key: string) => key };
    expect(markupOr(t, 'branding.footerPlaceholder', TAGS, 'FALLBACK')).toBe('FALLBACK');
  });

  // CAMINO DEGRADADO 2: cualquier excepción real.
  it('degrada cuando el formateo lanza', () => {
    const t: MarkupTranslatorLike = {
      markup: () => {
        throw new Error('markup roto');
      },
    };
    expect(markupOr(t, 'branding.footerPlaceholder', TAGS, 'FALLBACK')).toBe('FALLBACK');
  });
});
