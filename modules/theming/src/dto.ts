/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { z } from 'zod';
import {
  MAX_SOCIAL_LINKS,
  MAX_SOCIAL_LINK_URL_CHARS,
  SOCIAL_LINK_KINDS,
  socialLinkProblem,
  type SocialLink,
} from './social-links.js';

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
 * Copy del panel de marca de las pantallas de acceso (/signin y hermanas).
 * Son textos PLANOS (se pintan como texto, nunca como HTML), así que el límite
 * es de legibilidad, no de seguridad: un titular que no entre en dos líneas
 * rompe el layout.
 */
export const MAX_SIGNIN_HEADLINE_CHARS = 160;
export const MAX_SIGNIN_SUBHEADLINE_CHARS = 240;

/**
 * Descripción de la academia en su comunidad (tarjeta de /community). Texto
 * PLANO; el límite es el de una presentación que se lee de un vistazo y
 * coincide con el VarChar de la columna.
 */
export const MAX_ABOUT_CHARS = 280;

/**
 * Cómo se presenta la marca del tenant allí donde aparece (sidebar, panel de
 * acceso, asistente de bienvenida…).
 *
 *  - `logo_only`: el logo sustituye al nombre, a su ancho natural. Es lo que
 *    quiere un logo horizontal que ya lleva el wordmark dentro — pintarle el
 *    nombre al lado lo duplica, y encajarlo en un cuadrado lo hace ilegible.
 *  - `logo_and_name`: logo compacto + nombre en texto. Es lo que quiere un
 *    isotipo cuadrado.
 *
 * El default es `logo_only` porque es el comportamiento que ya tenían el
 * sidebar y /signin con los logos existentes: el campo añade la elección, no
 * cambia lo desplegado.
 */
export const LOGO_DISPLAY_MODES = ['logo_only', 'logo_and_name'] as const;
export type LogoDisplayMode = (typeof LOGO_DISPLAY_MODES)[number];
export const DEFAULT_LOGO_DISPLAY_MODE: LogoDisplayMode = 'logo_only';

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

/**
 * Un enlace social: su red y una URL `https://` de esa red (ver
 * `social-links.ts`). El mensaje del refine es la razón estable del rechazo.
 */
export const socialLinkSchema = z
  .object({
    kind: z.enum(SOCIAL_LINK_KINDS),
    url: z.string().trim().min(1).max(MAX_SOCIAL_LINK_URL_CHARS),
  })
  .strict()
  .superRefine((link, ctx) => {
    const problem = socialLinkProblem(link.kind, link.url);
    if (problem) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: problem });
    }
  });

export const updateThemeSchema = z
  .object({
    logoUrl: safeImageUrl.nullable().optional(),
    logoDisplayMode: z.enum(LOGO_DISPLAY_MODES).optional(),
    faviconUrl: safeImageUrl.nullable().optional(),
    brandHue: z.number().int().min(0).max(360).optional(),
    brandSaturation: z.number().int().min(0).max(100).optional(),
    displayFontFamily: z.enum(ALLOWED_DISPLAY_FONTS).optional(),
    bodyFontFamily: z.enum(ALLOWED_BODY_FONTS).optional(),
    customCss: z.string().max(MAX_CUSTOM_CSS_BYTES).nullable().optional(),
    footerHtml: z.string().max(MAX_FOOTER_HTML_BYTES).nullable().optional(),
    signinHeadline: z.string().trim().max(MAX_SIGNIN_HEADLINE_CHARS).nullable().optional(),
    signinSubheadline: z.string().trim().max(MAX_SIGNIN_SUBHEADLINE_CHARS).nullable().optional(),
    about: z.string().trim().max(MAX_ABOUT_CHARS).nullable().optional(),
    socialLinks: z.array(socialLinkSchema).max(MAX_SOCIAL_LINKS).optional(),
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

/**
 * Favicon: mismos tipos que el logo. Sin ICO a propósito — el optimizador de
 * imágenes del core (sharp) no lo lee, y un PNG/SVG funciona como favicon en
 * cualquier navegador de este siglo.
 */
export const ALLOWED_FAVICON_MIME_TYPES = ALLOWED_LOGO_MIME_TYPES;

/** 1 MB máximo. Un favicon real rara vez pasa de 50 KB. */
export const MAX_FAVICON_BYTES = 1 * 1024 * 1024;

export const uploadFaviconSchema = z.object({
  /** Contenido del archivo en base64 (sin el prefijo data:). */
  data: z.string().min(1),
  /** Nombre original del archivo, solo para auditoría / extensión. */
  filename: z.string().min(1).max(256),
  contentType: z.enum(ALLOWED_FAVICON_MIME_TYPES),
});

export type UploadFaviconDto = z.infer<typeof uploadFaviconSchema>;

/**
 * Portada de la academia: los mismos tipos que el logo y el tope de la portada
 * de un curso (10 MB, el del upload genérico). Se recomprime a WebP de 1600 px
 * como el resto de imágenes grandes; un SVG se guarda intacto.
 */
export const ALLOWED_COVER_MIME_TYPES = ALLOWED_LOGO_MIME_TYPES;

/** 10 MB, como la portada de un curso. En base64 cabe en el bodyLimit (16 MB). */
export const MAX_COVER_BYTES = 10 * 1024 * 1024;

export const uploadCoverSchema = z.object({
  /** Contenido del archivo en base64 (sin el prefijo data:). */
  data: z.string().min(1),
  /** Nombre original del archivo, solo para auditoría / extensión. */
  filename: z.string().min(1).max(256),
  contentType: z.enum(ALLOWED_COVER_MIME_TYPES),
});

export type UploadCoverDto = z.infer<typeof uploadCoverSchema>;

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
  /** Cómo se presenta la marca: solo el logo, o logo compacto + nombre. */
  logoDisplayMode: LogoDisplayMode;
  faviconUrl: string | null;
  /** True si el favicon actual fue subido por el uploader del panel. */
  faviconUploaded: boolean;
  brandHue: number;
  brandSaturation: number;
  displayFontFamily: string;
  bodyFontFamily: string;
  customCss: string | null;
  footerHtml: string | null;
  /** Titular del panel de marca de /signin. null = copy genérico Didacta. */
  signinHeadline: string | null;
  /** Línea de apoyo del panel de marca de /signin. null = copy genérico. */
  signinSubheadline: string | null;
  /** Descripción de la academia en su comunidad. null = cae al titular de acceso. */
  about: string | null;
  /** Enlaces sociales (solo los válidos, en orden, máximo 5). */
  socialLinks: SocialLink[];
  /** Portada propia de la academia. null = banda de color. */
  coverUrl: string | null;
  /** True si la portada actual se subió al storage del tenant. */
  coverUploaded: boolean;
  updatedAt: string;
}

export const DEFAULT_THEME = Object.freeze({
  brandHue: 213,
  brandSaturation: 70,
  displayFontFamily: 'Sora' as DisplayFont,
  bodyFontFamily: 'Inter' as BodyFont,
});
