import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import {
  ALLOWED_BODY_FONTS,
  ALLOWED_DISPLAY_FONTS,
  ALLOWED_LOGO_MIME_TYPES,
  DEFAULT_THEME,
  MAX_CUSTOM_CSS_BYTES,
  MAX_FOOTER_HTML_BYTES,
  MAX_LOGO_BYTES,
  type ThemeSnapshot,
  type UpdateThemeDto,
} from './dto.js';
import {
  CustomCssTooLargeError,
  CustomCssUnsafeError,
  EmptyLogoError,
  FooterHtmlTooLargeError,
  InvalidHueError,
  InvalidSaturationError,
  LogoNotFoundError,
  LogoTooLargeError,
  UnsupportedFontError,
  UnsupportedLogoTypeError,
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
   * los campos para que el tenant use los valores base. También borra el
   * logo del storage si fue subido por el uploader.
   */
  async reset(tenantId: string): Promise<ThemeSnapshot> {
    const current = await this.getOrCreate(tenantId);
    if (current.logoUploaded) {
      await this.deleteLogoBlob(tenantId);
    }
    const updated = await this.prisma.modThemingTenantTheme.update({
      where: { tenantId },
      data: {
        logoUrl: null,
        logoStorageKey: null,
        logoMimeType: null,
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

  /**
   * Sube un logo al storage y lo asocia al theme del tenant. Si ya había uno
   * subido previamente, lo borra primero del storage para no acumular blobs
   * huérfanos.
   *
   * Garantías:
   * - El blob entra en `tenants/{tenantId}/branding/logo` (key estable). Como
   *   el endpoint público sirve por tenantId y añade `?v=updatedAt`, el cache
   *   se invalida solo al subir uno nuevo.
   * - Tipos MIME validados contra whitelist (`ALLOWED_LOGO_MIME_TYPES`).
   * - Tamaño validado (`MAX_LOGO_BYTES`).
   * - `logoUrl` se setea a un endpoint relativo del backend para que el front
   *   pueda renderizarlo sin presigning recurrente.
   */
  async uploadLogo(
    tenantId: string,
    input: { data: string; filename: string; contentType: string },
  ): Promise<ThemeSnapshot> {
    if (!ALLOWED_LOGO_MIME_TYPES.includes(input.contentType as never)) {
      throw new UnsupportedLogoTypeError(input.contentType, ALLOWED_LOGO_MIME_TYPES);
    }

    const buffer = Buffer.from(input.data, 'base64');
    // Un base64 inválido decodifica a un buffer vacío (o casi): rechazamos
    // explícitamente para no persistir un blob corrupto y devolver un error
    // claro al admin en vez de un 200 con un logo roto.
    if (buffer.length === 0) {
      throw new EmptyLogoError();
    }
    if (buffer.length > MAX_LOGO_BYTES) {
      throw new LogoTooLargeError(MAX_LOGO_BYTES);
    }

    const current = await this.getOrCreate(tenantId);
    if (current.logoUploaded) {
      await this.deleteLogoBlob(tenantId).catch(() => {
        // Best-effort: si el blob anterior ya no existe en storage, seguimos.
      });
    }

    // `uploadImage` (no `upload`) para que el logo se recomprima como el resto
    // de imágenes de la plataforma, pero con dos ajustes propios: 512 px de
    // ancho (un logo de cabecera se ve pequeño) y salida PNG.
    //
    // `format: 'png'` NO es un capricho: este mismo blob es el que va en la
    // cabecera de TODOS los emails del tenant, y WebP no es seguro en clientes
    // de correo. Al pasar el logo a WebP (2026-07-29) los emails empezaron a
    // enseñar un rectángulo negro con las letras recortadas: el cliente
    // decodifica el WebP e ignora su canal alfa, así que el fondo transparente
    // se pinta con el RGB que hay debajo. PNG lo pinta cualquier cliente, con
    // transparencia y sin halos alrededor del texto. Un SVG no es optimizable y
    // el core lo guarda intacto, que es justo lo que queremos con un vector.
    const requestedKey = `tenants/${tenantId}/branding/logo`;
    const stored = await this.ctx.storage.uploadImage(requestedKey, buffer, input.contentType, {
      maxWidth: 512,
      format: 'png',
    });

    // Cache-buster basado en timestamp para que el browser refresque al cambiar.
    const publicUrl = `/api/v1/modules/theming/tenants/${tenantId}/logo?v=${Date.now()}`;

    const updated = await this.prisma.modThemingTenantTheme.update({
      where: { tenantId },
      data: {
        logoUrl: publicUrl,
        // La key y el MIME son los REALES que devolvió el core: al recomprimir a
        // WebP cambia la extensión, y el endpoint público sirve por esta key con
        // este content-type. Persistir lo pedido serviría el blob equivocado.
        logoStorageKey: stored.key,
        logoMimeType: stored.contentType,
      },
    });

    await this.ctx.eventBus.publish({
      name: 'theming.logo.uploaded',
      version: 1,
      data: { tenantId, contentType: input.contentType, size: buffer.length },
      metadata: {
        tenantId,
        timestamp: new Date().toISOString(),
        traceId: `${tenantId}:logo:${Date.now()}`,
        idempotencyKey: `theming.logo.uploaded:${tenantId}:${Date.now()}`,
      },
    });
    this.ctx.logger.info('mod.theming: logo uploaded', {
      tenantId,
      size: stored.size,
      originalSize: buffer.length,
      contentType: stored.contentType,
      optimized: stored.optimized,
    });

    return this.toSnapshot(updated);
  }

  /**
   * Devuelve el blob del logo del tenant para servir desde el endpoint
   * público. Lanza `LogoNotFoundError` si no hay logo subido (puede haber
   * `logoUrl` apuntando a una URL externa, en cuyo caso este método no aplica).
   */
  async getLogoBlob(tenantId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const theme = await this.prisma.modThemingTenantTheme.findUnique({
      where: { tenantId },
    });
    if (!theme || !theme.logoStorageKey || !theme.logoMimeType) {
      throw new LogoNotFoundError();
    }
    const buffer = await this.ctx.storage.download(theme.logoStorageKey);
    return { buffer, mimeType: theme.logoMimeType };
  }

  /**
   * Borra el logo subido (blob + columnas). Si el theme tenía un `logoUrl`
   * externo, también se limpia para que la UI vuelva a mostrar el wordmark.
   */
  async removeLogo(tenantId: string): Promise<ThemeSnapshot> {
    const current = await this.getOrCreate(tenantId);
    if (current.logoUploaded) {
      await this.deleteLogoBlob(tenantId).catch(() => {
        // Best-effort.
      });
    }
    const updated = await this.prisma.modThemingTenantTheme.update({
      where: { tenantId },
      data: {
        logoUrl: null,
        logoStorageKey: null,
        logoMimeType: null,
      },
    });
    this.ctx.logger.info('mod.theming: logo removed', { tenantId });
    return this.toSnapshot(updated);
  }

  private async deleteLogoBlob(tenantId: string): Promise<void> {
    const theme = await this.prisma.modThemingTenantTheme.findUnique({
      where: { tenantId },
    });
    if (theme?.logoStorageKey) {
      await this.ctx.storage.delete(theme.logoStorageKey);
    }
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
    logoStorageKey: string | null;
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
      logoUploaded: row.logoStorageKey !== null,
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
