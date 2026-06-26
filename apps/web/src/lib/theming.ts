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
  /** True si el logo se subió al storage del tenant (vs URL externa). */
  logoUploaded: boolean;
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
    return apiFetch<TenantTheme>('/api/v1/modules/theming/me', { method: 'GET' }, bearer);
  },
  async update(bearer: string, dto: UpdateThemeInput): Promise<TenantTheme> {
    return apiFetch<TenantTheme>(
      '/api/v1/modules/theming/me',
      { method: 'PUT', body: JSON.stringify(dto) },
      bearer,
    );
  },
  async reset(bearer: string): Promise<TenantTheme> {
    return apiFetch<TenantTheme>('/api/v1/modules/theming/me/reset', { method: 'POST' }, bearer);
  },
  async uploadLogo(
    bearer: string,
    input: { data: string; filename: string; contentType: string },
  ): Promise<TenantTheme> {
    return apiFetch<TenantTheme>(
      '/api/v1/modules/theming/me/logo',
      { method: 'POST', body: JSON.stringify(input) },
      bearer,
    );
  },
  async removeLogo(bearer: string): Promise<TenantTheme> {
    return apiFetch<TenantTheme>('/api/v1/modules/theming/me/logo', { method: 'DELETE' }, bearer);
  },
};

/**
 * Evento global que propaga un theme nuevo al TenantThemeProvider (root layout)
 * para que reaplique el branding EN VIVO, sin esperar a un reload duro. Sin
 * esto, cambiar el color en /admin/branding solo actualizaba la preview local
 * y el cache, pero el `<style>` global del provider seguía con el theme viejo
 * hasta recargar (el provider solo hace fetch en su mount).
 */
export const THEME_UPDATED_EVENT = 'didacta:theme-updated';

/**
 * Evento que pide al TenantThemeProvider RE-FETCHEAR el theme del tenant. Se
 * dispara justo después de iniciar sesión: el provider vive en el root layout y
 * NO se re-monta en navegaciones SPA, así que su fetch de mount (hecho en
 * /signin, sin token) no vuelve a correr tras el login → el logo del tenant no
 * aparecía hasta un reload duro. Con este evento se recoge el branding al vuelo.
 */
export const SESSION_THEME_REFRESH_EVENT = 'didacta:session-theme-refresh';

/** Pide al provider re-fetchear el theme (úsalo justo después de loguear). */
export function requestThemeRefresh(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SESSION_THEME_REFRESH_EVENT));
}

/**
 * Persiste el theme en cache y notifica al TenantThemeProvider para que
 * reaplique el branding de inmediato. Úsalo tras guardar / resetear / cambiar
 * el logo en la pantalla de branding.
 */
export function publishThemeUpdate(theme: TenantTheme): void {
  if (typeof window === 'undefined') return;
  themeCache.save(theme);
  window.dispatchEvent(new CustomEvent<TenantTheme>(THEME_UPDATED_EVENT, { detail: theme }));
}

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
  // Sidebar (rail + panel): el azul noche Didacta por default (#0D1B2A /
  // #0a1421) pero tintado al hue del tenant para que el branding alcance a
  // la navegación. Luminancias muy bajas (12% / 9%) mantienen el contraste
  // del texto blanco con cualquier hue. Si el tenant deja el hue default
  // (213) el resultado es prácticamente idéntico al night Didacta original.
  lines.push(`  --sidebar-bg: hsl(${theme.brandHue}, ${theme.brandSaturation}%, 12%);`);
  lines.push(`  --sidebar-rail-bg: hsl(${theme.brandHue}, ${theme.brandSaturation}%, 9%);`);
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
