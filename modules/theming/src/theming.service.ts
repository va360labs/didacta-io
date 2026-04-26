import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import {
  ALLOWED_BODY_FONTS,
  ALLOWED_DISPLAY_FONTS,
  DEFAULT_THEME,
  MAX_CUSTOM_CSS_BYTES,
  MAX_FOOTER_HTML_BYTES,
  type ThemeSnapshot,
  type UpdateThemeDto,
} from './dto.js';
import {
  CustomCssTooLargeError,
  CustomCssUnsafeError,
  FooterHtmlTooLargeError,
  InvalidHueError,
  InvalidSaturationError,
  UnsupportedFontError,
} from './errors.js';

/**
 * Patrones que NUNCA deben aparecer en custom CSS (defensa en profundidad,
 * el navegador igual filtra muchos pero no perjudica).
 */
const FORBIDDEN_CSS_PATTERNS = [
  /@import\s/i, // No permitir import de hojas externas.
  /url\s*\(\s*['"]?\s*javascript:/i, // No JS dentro de url().
  /expression\s*\(/i, // IE legacy expression().
  /<\/style>/i, // No cerrar el tag style desde el contenido.
  /<script/i,
];

export class ThemingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
  ) {}

  /**
   * Devuelve el theme del tenant. Si no existe, crea uno con defaults Didacta.
   * Esta operación es idempotente y safe para llamarse en SSR.
   */
  async getOrCreate(tenantId: string): Promise<ThemeSnapshot> {
    const existing = await this.prisma.modThemingTenantTheme.findUnique({
      where: { tenantId },
    });

    if (existing) return this.toSnapshot(existing);

    const created = await this.prisma.modThemingTenantTheme.create({
      data: {
        tenantId,
        brandHue: DEFAULT_THEME.brandHue,
        brandSaturation: DEFAULT_THEME.brandSaturation,
        displayFontFamily: DEFAULT_THEME.displayFontFamily,
        bodyFontFamily: DEFAULT_THEME.bodyFontFamily,
      },
    });
    this.ctx.logger.info('mod.theming: theme created with defaults', { tenantId });
    return this.toSnapshot(created);
  }

  /**
   * Actualiza parcialmente el theme. Sólo cambia los campos provistos.
   * Lanza error específico para cada validación.
   */
  async update(tenantId: string, dto: UpdateThemeDto): Promise<ThemeSnapshot> {
    this.validate(dto);

    // Asegurar que existe (crea si falta).
    await this.getOrCreate(tenantId);

    const updated = await this.prisma.modThemingTenantTheme.update({
      where: { tenantId },
      data: {
        ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
        ...(dto.faviconUrl !== undefined ? { faviconUrl: dto.faviconUrl } : {}),
        ...(dto.brandHue !== undefined ? { brandHue: dto.brandHue } : {}),
        ...(dto.brandSaturation !== undefined ? { brandSaturation: dto.brandSaturation } : {}),
        ...(dto.displayFontFamily !== undefined
          ? { displayFontFamily: dto.displayFontFamily }
          : {}),
        ...(dto.bodyFontFamily !== undefined ? { bodyFontFamily: dto.bodyFontFamily } : {}),
        ...(dto.customCss !== undefined ? { customCss: dto.customCss } : {}),
        ...(dto.footerHtml !== undefined ? { footerHtml: dto.footerHtml } : {}),
      },
    });
    this.ctx.logger.info('mod.theming: theme updated', { tenantId, fields: Object.keys(dto) });
    return this.toSnapshot(updated);
  }

  /**
   * Restaura el theme a los defaults Didacta. No borra el registro — limpia
   * los campos para que el tenant use los valores base.
   */
  async reset(tenantId: string): Promise<ThemeSnapshot> {
    await this.getOrCreate(tenantId);
    const updated = await this.prisma.modThemingTenantTheme.update({
      where: { tenantId },
      data: {
        logoUrl: null,
        faviconUrl: null,
        brandHue: DEFAULT_THEME.brandHue,
        brandSaturation: DEFAULT_THEME.brandSaturation,
        displayFontFamily: DEFAULT_THEME.displayFontFamily,
        bodyFontFamily: DEFAULT_THEME.bodyFontFamily,
        customCss: null,
        footerHtml: null,
      },
    });
    this.ctx.logger.info('mod.theming: theme reset to defaults', { tenantId });
    return this.toSnapshot(updated);
  }

  // -------------------- helpers privados --------------------

  private validate(dto: UpdateThemeDto): void {
    if (dto.brandHue !== undefined && (dto.brandHue < 0 || dto.brandHue > 360)) {
      throw new InvalidHueError();
    }
    if (
      dto.brandSaturation !== undefined &&
      (dto.brandSaturation < 0 || dto.brandSaturation > 100)
    ) {
      throw new InvalidSaturationError();
    }
    if (
      dto.displayFontFamily !== undefined &&
      !ALLOWED_DISPLAY_FONTS.includes(dto.displayFontFamily)
    ) {
      throw new UnsupportedFontError(dto.displayFontFamily, ALLOWED_DISPLAY_FONTS);
    }
    if (dto.bodyFontFamily !== undefined && !ALLOWED_BODY_FONTS.includes(dto.bodyFontFamily)) {
      throw new UnsupportedFontError(dto.bodyFontFamily, ALLOWED_BODY_FONTS);
    }
    if (dto.customCss !== undefined && dto.customCss !== null) {
      const bytes = Buffer.byteLength(dto.customCss, 'utf8');
      if (bytes > MAX_CUSTOM_CSS_BYTES) throw new CustomCssTooLargeError(MAX_CUSTOM_CSS_BYTES);
      for (const pattern of FORBIDDEN_CSS_PATTERNS) {
        if (pattern.test(dto.customCss)) {
          throw new CustomCssUnsafeError(`patrón prohibido: ${pattern.source}`);
        }
      }
    }
    if (dto.footerHtml !== undefined && dto.footerHtml !== null) {
      const bytes = Buffer.byteLength(dto.footerHtml, 'utf8');
      if (bytes > MAX_FOOTER_HTML_BYTES) throw new FooterHtmlTooLargeError(MAX_FOOTER_HTML_BYTES);
    }
  }

  private toSnapshot(row: {
    tenantId: string;
    logoUrl: string | null;
    faviconUrl: string | null;
    brandHue: number;
    brandSaturation: number;
    displayFontFamily: string;
    bodyFontFamily: string;
    customCss: string | null;
    footerHtml: string | null;
    updatedAt: Date;
  }): ThemeSnapshot {
    return {
      tenantId: row.tenantId,
      logoUrl: row.logoUrl,
      faviconUrl: row.faviconUrl,
      brandHue: row.brandHue,
      brandSaturation: row.brandSaturation,
      displayFontFamily: row.displayFontFamily,
      bodyFontFamily: row.bodyFontFamily,
      customCss: row.customCss,
      footerHtml: row.footerHtml,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
