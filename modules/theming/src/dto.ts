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

/**
 * URLs de branding aceptan:
 *  - `https://...` (URL externa pegada por el admin).
 *  - `/api/v1/...` (endpoint público del backend que sirve el logo subido).
 *
 * Vetamos `http://` (mixed content), `javascript:`, `data:` y demás esquemas
 * raros. Es el equivalente a `httpsUrl` previo + permitir relative paths del
 * propio backend para servir logos del storage.
 */
const safeImageUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (u) => u.startsWith('https://') || u.startsWith('/api/v1/'),
    'La URL debe ser https:// o un endpoint relativo /api/v1/...',
  );

export const updateThemeSchema = z
  .object({
    logoUrl: safeImageUrl.nullable().optional(),
    faviconUrl: safeImageUrl.nullable().optional(),
    brandHue: z.number().int().min(0).max(360).optional(),
    brandSaturation: z.number().int().min(0).max(100).optional(),
    displayFontFamily: z.enum(ALLOWED_DISPLAY_FONTS).optional(),
    bodyFontFamily: z.enum(ALLOWED_BODY_FONTS).optional(),
    customCss: z.string().max(MAX_CUSTOM_CSS_BYTES).nullable().optional(),
    footerHtml: z.string().max(MAX_FOOTER_HTML_BYTES).nullable().optional(),
  })
  .strict();

/**
 * Tipos MIME aceptados para el logo. PNG y JPG son universales; SVG se acepta
 * porque escala y no pixela, y WebP por compatibilidad moderna.
 */
export const ALLOWED_LOGO_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'image/webp',
] as const;

/** 2 MB máximo. Un logo serio rara vez pasa de 200 KB. */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export const uploadLogoSchema = z.object({
  /** Contenido del archivo en base64 (sin el prefijo data:). */
  data: z.string().min(1),
  /** Nombre original del archivo, solo para auditoría / extensión. */
  filename: z.string().min(1).max(256),
  contentType: z.enum(ALLOWED_LOGO_MIME_TYPES),
});

export type UploadLogoDto = z.infer<typeof uploadLogoSchema>;

export type UpdateThemeDto = z.infer<typeof updateThemeSchema>;

export type DisplayFont = (typeof ALLOWED_DISPLAY_FONTS)[number];
export type BodyFont = (typeof ALLOWED_BODY_FONTS)[number];

/**
 * Snapshot inmutable del theme para SSR — lo que el web consume.
 */
export interface ThemeSnapshot {
  tenantId: string;
  logoUrl: string | null;
  /** True si el logo actual fue subido por el uploader del panel. */
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

export const DEFAULT_THEME = Object.freeze({
  brandHue: 213,
  brandSaturation: 70,
  displayFontFamily: 'Sora' as DisplayFont,
  bodyFontFamily: 'Inter' as BodyFont,
});
