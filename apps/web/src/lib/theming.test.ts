import { describe, expect, it } from 'vitest';
import { buildThemeStyleBlock, type TenantTheme } from './theming';

function makeTheme(overrides: Partial<TenantTheme> = {}): TenantTheme {
  return {
    tenantId: 'tenant-1',
    logoUrl: null,
    logoUploaded: false,
    faviconUrl: null,
    brandHue: 213,
    brandSaturation: 70,
    displayFontFamily: 'Sora',
    bodyFontFamily: 'Inter',
    customCss: null,
    footerHtml: null,
    signinHeadline: null,
    signinSubheadline: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('buildThemeStyleBlock', () => {
  it('inyecta --brand-h y --brand-s del tenant', () => {
    const css = buildThemeStyleBlock(makeTheme({ brandHue: 24, brandSaturation: 90 }));
    expect(css).toContain('--brand-h: 24;');
    expect(css).toContain('--brand-s: 90%;');
  });

  // alpha.82 — el sidebar consume var(--sidebar-bg) / var(--sidebar-rail-bg)
  it('inyecta las CSS vars del sidebar tintadas al hue/saturation del tenant', () => {
    const css = buildThemeStyleBlock(makeTheme({ brandHue: 24, brandSaturation: 90 }));
    expect(css).toContain('--sidebar-bg: hsl(24, 90%, 12%);');
    expect(css).toContain('--sidebar-rail-bg: hsl(24, 90%, 9%);');
  });

  it('con el hue default (213) las vars del sidebar quedan cercanas al night Didacta', () => {
    const css = buildThemeStyleBlock(makeTheme());
    expect(css).toContain('--sidebar-bg: hsl(213, 70%, 12%);');
    expect(css).toContain('--sidebar-rail-bg: hsl(213, 70%, 9%);');
  });

  it('sobrescribe --font-sans y --font-display con las fuentes del tenant', () => {
    const css = buildThemeStyleBlock(
      makeTheme({ bodyFontFamily: 'Manrope', displayFontFamily: 'Outfit' }),
    );
    expect(css).toContain("--font-sans: 'Manrope', system-ui, sans-serif;");
    expect(css).toContain("--font-display: 'Outfit', system-ui, sans-serif;");
  });

  it('anexa el customCss del tenant cuando está presente', () => {
    const css = buildThemeStyleBlock(makeTheme({ customCss: ':root { --radius-card: 12px; }' }));
    expect(css).toContain('/* custom-css del tenant */');
    expect(css).toContain('--radius-card: 12px;');
  });
});
