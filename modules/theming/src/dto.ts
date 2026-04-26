import { z } from 'zod';

/**
 * Whitelist de familias tipográficas soportadas.
 * Limitada a fuentes Google Fonts cargables en latin subset y compatibles
 * con el design system Didacta. Ampliable solo via PR + ADR.
 */
export const ALLOWED_DISPLAY_FONTS = [
  'Sora',
  'Inter',
  'Manrope',
  'Space Grotesk',
  'DM Sans',
  'Plus Jakarta Sans',
  'Outfit',
  'Lexend',
] as const;

export const ALLOWED_BODY_FONTS = [
  'Inter',
  'Manrope',
  'DM Sans',
  'IBM Plex Sans',
  'Source Sans 3',
  'Plus Jakarta Sans',
  'Outfit',
  'Nunito Sans',
] as const;

/**
 * Tamaños máximos para campos potencialmente abusables.
 * 16 KB de CSS es muy generoso para overrides; el patrón esperado son
 * 5-30 reglas. 4 KB de footer HTML es suficiente para texto + 5-6 links.
 */
export const MAX_CUSTOM_CSS_BYTES = 16 * 1024;
export const MAX_FOOTER_HTML_BYTES = 4 * 1024;

const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), {
    message: 'La URL debe usar https',
  });

export const updateThemeSchema = z
  .object({
    logoUrl: httpsUrl.nullable().optional(),
    faviconUrl: httpsUrl.nullable().optional(),
    brandHue: z.number().int().min(0).max(360).optional(),
    brandSaturation: z.number().int().min(0).max(100).optional(),
    displayFontFamily: z.enum(ALLOWED_DISPLAY_FONTS).optional(),
    bodyFontFamily: z.enum(ALLOWED_BODY_FONTS).optional(),
    customCss: z.string().max(MAX_CUSTOM_CSS_BYTES).nullable().optional(),
    footerHtml: z.string().max(MAX_FOOTER_HTML_BYTES).nullable().optional(),
  })
  .strict();

export type UpdateThemeDto = z.infer<typeof updateThemeSchema>;

export type DisplayFont = (typeof ALLOWED_DISPLAY_FONTS)[number];
export type BodyFont = (typeof ALLOWED_BODY_FONTS)[number];

/**
 * Snapshot inmutable del theme para SSR — lo que el web consume.
 */
export interface ThemeSnapshot {
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

export const DEFAULT_THEME = Object.freeze({
  brandHue: 213,
  brandSaturation: 70,
  displayFontFamily: 'Sora' as DisplayFont,
  bodyFontFamily: 'Inter' as BodyFont,
});
