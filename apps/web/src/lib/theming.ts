'use client';

/**
 * Cliente del módulo theming. Vive en client-side porque el SSR del root
 * layout no tiene contexto de tenant (la sesión vive en sessionStorage).
 *
 * Estrategia anti-FOUC (Flash Of Unstyled Content):
 *  1. globals.css define defaults Didacta — primer render usa esos.
 *  2. localStorage cachea el último theme conocido del tenant — re-loads
 *     aplican el theme inmediato antes del fetch (cero parpadeo).
 *  3. Tras montar, refresca contra la API y persiste.
 */

import { apiFetch } from './api-client';

const CACHE_KEY = 'didacta.theme.v1';

export interface TenantTheme {
  tenantId: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  brandHue: number;
  brandSaturation: number;
  displayFontFamily: string;
  bodyFontFamily: string;
  customCss: string | null;
  footerHtml: string | null;
  updatedAt: string;
}

export interface UpdateThemeInput {
  logoUrl?: string | null;
  faviconUrl?: string | null;
  brandHue?: number;
  brandSaturation?: number;
  displayFontFamily?: string;
  bodyFontFamily?: string;
  customCss?: string | null;
  footerHtml?: string | null;
}

export const themingApi = {
  async getMine(bearer: string): Promise<TenantTheme> {
    return apiFetch<TenantTheme>('/modules/theming/me', { method: 'GET' }, bearer);
  },
  async update(bearer: string, dto: UpdateThemeInput): Promise<TenantTheme> {
    return apiFetch<TenantTheme>(
      '/modules/theming/me',
      { method: 'PUT', body: JSON.stringify(dto) },
      bearer,
    );
  },
  async reset(bearer: string): Promise<TenantTheme> {
    return apiFetch<TenantTheme>('/modules/theming/me/reset', { method: 'POST' }, bearer);
  },
};

export const themeCache = {
  load(tenantId: string): TenantTheme | null {
    if (typeof window === 'undefined') return null;
    try {
      const raw = localStorage.getItem(`${CACHE_KEY}.${tenantId}`);
      if (!raw) return null;
      return JSON.parse(raw) as TenantTheme;
    } catch {
      return null;
    }
  },
  save(theme: TenantTheme): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(`${CACHE_KEY}.${theme.tenantId}`, JSON.stringify(theme));
    } catch {
      // localStorage lleno o deshabilitado: lo dejamos pasar, el theme se
      // re-fetchea en cada navegación.
    }
  },
  clear(tenantId: string): void {
    if (typeof window === 'undefined') return;
    localStorage.removeItem(`${CACHE_KEY}.${tenantId}`);
  },
};

/**
 * Genera el bloque CSS con los tokens override del tenant. Solo escribe
 * los valores que difieren del default Didacta.
 */
export function buildThemeStyleBlock(theme: TenantTheme): string {
  const lines: string[] = [':root {'];
  lines.push(`  --brand-h: ${theme.brandHue};`);
  lines.push(`  --brand-s: ${theme.brandSaturation}%;`);
  // Las font-family se pueden override con CSS variable. next/font genera
  // --font-inter / --font-sora pero estas son las consumidas por globals.css.
  // Para que un tenant pueda usar Manrope sin re-build, sobrescribimos
  // --font-sans / --font-display directamente.
  if (theme.bodyFontFamily) {
    lines.push(`  --font-sans: '${theme.bodyFontFamily}', system-ui, sans-serif;`);
  }
  if (theme.displayFontFamily) {
    lines.push(`  --font-display: '${theme.displayFontFamily}', system-ui, sans-serif;`);
  }
  lines.push('}');
  if (theme.customCss && theme.customCss.trim().length > 0) {
    lines.push('/* custom-css del tenant */');
    lines.push(theme.customCss);
  }
  return lines.join('\n');
}
