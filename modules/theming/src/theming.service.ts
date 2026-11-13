/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import {
  ALLOWED_BODY_FONTS,
  ALLOWED_COVER_MIME_TYPES,
  ALLOWED_DISPLAY_FONTS,
  ALLOWED_FAVICON_MIME_TYPES,
  ALLOWED_LOGO_MIME_TYPES,
  DEFAULT_LOGO_DISPLAY_MODE,
  DEFAULT_THEME,
  LOGO_DISPLAY_MODES,
  MAX_ABOUT_CHARS,
  MAX_COVER_BYTES,
  MAX_CUSTOM_CSS_BYTES,
  MAX_FAVICON_BYTES,
  MAX_FOOTER_HTML_BYTES,
  MAX_LOGO_BYTES,
  MAX_SIGNIN_HEADLINE_CHARS,
  MAX_SIGNIN_SUBHEADLINE_CHARS,
  type LogoDisplayMode,
  type ThemeSnapshot,
  type UpdateThemeDto,
} from './dto.js';
import {
  AboutTooLongError,
  CoverNotFoundError,
  CoverTooLargeError,
  CustomCssTooLargeError,
  CustomCssUnsafeError,
  EmptyCoverError,
  EmptyFaviconError,
  EmptyLogoError,
  FaviconNotFoundError,
  FaviconTooLargeError,
  FooterHtmlTooLargeError,
  InvalidHueError,
  InvalidSaturationError,
  InvalidSocialLinkError,
  LogoNotFoundError,
  LogoTooLargeError,
  SigninCopyTooLongError,
  TooManySocialLinksError,
  UnsupportedCoverTypeError,
  UnsupportedFaviconTypeError,
  UnsupportedFontError,
  UnsupportedLogoTypeError,
} from './errors.js';
import {
  MAX_SOCIAL_LINKS,
  SOCIAL_LINK_KINDS,
  parseSocialLinks,
  socialLinkProblem,
  type SocialLinkKind,
} from './social-links.js';

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
        ...(dto.logoDisplayMode !== undefined ? { logoDisplayMode: dto.logoDisplayMode } : {}),
        ...(dto.faviconUrl !== undefined ? { faviconUrl: dto.faviconUrl } : {}),
        ...(dto.brandHue !== undefined ? { brandHue: dto.brandHue } : {}),
        ...(dto.brandSaturation !== undefined ? { brandSaturation: dto.brandSaturation } : {}),
        ...(dto.displayFontFamily !== undefined
          ? { displayFontFamily: dto.displayFontFamily }
          : {}),
        ...(dto.bodyFontFamily !== undefined ? { bodyFontFamily: dto.bodyFontFamily } : {}),
        ...(dto.customCss !== undefined ? { customCss: dto.customCss } : {}),
        ...(dto.footerHtml !== undefined ? { footerHtml: dto.footerHtml } : {}),
        // Copy del panel de marca de /signin: cadena vacía = "sin copy propio"
        // (vuelve al genérico Didacta), igual que hacemos con logoUrl.
        ...(dto.signinHeadline !== undefined ? { signinHeadline: dto.signinHeadline || null } : {}),
        ...(dto.signinSubheadline !== undefined
          ? { signinSubheadline: dto.signinSubheadline || null }
          : {}),
        // Descripción de la academia: vacía = sin descripción propia (la
        // tarjeta de la comunidad vuelve al titular de acceso).
        ...(dto.about !== undefined ? { about: dto.about?.trim() || null } : {}),
        // Enlaces: la lista entera sustituye a la anterior ([] = ninguno).
        // Objetos literales (no la interfaz) para el tipo Json de Prisma.
        ...(dto.socialLinks !== undefined
          ? { socialLinks: dto.socialLinks.map((l) => ({ kind: l.kind, url: l.url.trim() })) }
          : {}),
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
    if (current.faviconUploaded) {
      await this.deleteFaviconBlob(tenantId).catch(() => {
        // Best-effort: si el blob ya no existe en storage, seguimos.
      });
    }
    if (current.coverUploaded) {
      await this.deleteCoverBlob(tenantId).catch(() => {
        // Best-effort, igual que el favicon.
      });
    }
    const updated = await this.prisma.modThemingTenantTheme.update({
      where: { tenantId },
      data: {
        logoUrl: null,
        logoStorageKey: null,
        logoMimeType: null,
        logoDisplayMode: DEFAULT_LOGO_DISPLAY_MODE,
        faviconUrl: null,
        faviconStorageKey: null,
        faviconMimeType: null,
        brandHue: DEFAULT_THEME.brandHue,
        brandSaturation: DEFAULT_THEME.brandSaturation,
        displayFontFamily: DEFAULT_THEME.displayFontFamily,
        bodyFontFamily: DEFAULT_THEME.bodyFontFamily,
        customCss: null,
        footerHtml: null,
        signinHeadline: null,
        signinSubheadline: null,
        about: null,
        socialLinks: [],
        coverUrl: null,
        coverStorageKey: null,
        coverMimeType: null,
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

  /**
   * Sube un favicon al storage y lo asocia al theme. Espejo de `uploadLogo`
   * con dos diferencias deliberadas: 128 px de ancho máximo (es un icono de
   * pestaña, no una cabecera; los navegadores lo reescalan sin pena) y 1 MB
   * de límite. Igual que el logo, sale en PNG (los SVG se guardan intactos).
   */
  async uploadFavicon(
    tenantId: string,
    input: { data: string; filename: string; contentType: string },
  ): Promise<ThemeSnapshot> {
    if (!ALLOWED_FAVICON_MIME_TYPES.includes(input.contentType as never)) {
      throw new UnsupportedFaviconTypeError(input.contentType, ALLOWED_FAVICON_MIME_TYPES);
    }

    const buffer = Buffer.from(input.data, 'base64');
    if (buffer.length === 0) {
      throw new EmptyFaviconError();
    }
    if (buffer.length > MAX_FAVICON_BYTES) {
      throw new FaviconTooLargeError(MAX_FAVICON_BYTES);
    }

    const current = await this.getOrCreate(tenantId);
    if (current.faviconUploaded) {
      await this.deleteFaviconBlob(tenantId).catch(() => {
        // Best-effort: si el blob anterior ya no existe en storage, seguimos.
      });
    }

    const requestedKey = `tenants/${tenantId}/branding/favicon`;
    const stored = await this.ctx.storage.uploadImage(requestedKey, buffer, input.contentType, {
      maxWidth: 128,
      format: 'png',
    });

    // Cache-buster basado en timestamp para que el browser refresque al cambiar.
    const publicUrl = `/api/v1/modules/theming/tenants/${tenantId}/favicon?v=${Date.now()}`;

    const updated = await this.prisma.modThemingTenantTheme.update({
      where: { tenantId },
      data: {
        faviconUrl: publicUrl,
        // Key y MIME REALES que devolvió el core (ver nota en uploadLogo).
        faviconStorageKey: stored.key,
        faviconMimeType: stored.contentType,
      },
    });

    await this.ctx.eventBus.publish({
      name: 'theming.favicon.uploaded',
      version: 1,
      data: { tenantId, contentType: input.contentType, size: buffer.length },
      metadata: {
        tenantId,
        timestamp: new Date().toISOString(),
        traceId: `${tenantId}:favicon:${Date.now()}`,
        idempotencyKey: `theming.favicon.uploaded:${tenantId}:${Date.now()}`,
      },
    });
    this.ctx.logger.info('mod.theming: favicon uploaded', {
      tenantId,
      size: stored.size,
      originalSize: buffer.length,
      contentType: stored.contentType,
      optimized: stored.optimized,
    });

    return this.toSnapshot(updated);
  }

  /**
   * Devuelve el blob del favicon para el endpoint público. Lanza
   * `FaviconNotFoundError` si no hay favicon subido (un `faviconUrl` externo
   * no pasa por aquí).
   */
  async getFaviconBlob(tenantId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const theme = await this.prisma.modThemingTenantTheme.findUnique({
      where: { tenantId },
    });
    if (!theme || !theme.faviconStorageKey || !theme.faviconMimeType) {
      throw new FaviconNotFoundError();
    }
    const buffer = await this.ctx.storage.download(theme.faviconStorageKey);
    return { buffer, mimeType: theme.faviconMimeType };
  }

  /**
   * Borra el favicon subido (blob + columnas). Un `faviconUrl` externo también
   * se limpia, igual que hace `removeLogo` con el logo.
   */
  async removeFavicon(tenantId: string): Promise<ThemeSnapshot> {
    const current = await this.getOrCreate(tenantId);
    if (current.faviconUploaded) {
      await this.deleteFaviconBlob(tenantId).catch(() => {
        // Best-effort.
      });
    }
    const updated = await this.prisma.modThemingTenantTheme.update({
      where: { tenantId },
      data: {
        faviconUrl: null,
        faviconStorageKey: null,
        faviconMimeType: null,
      },
    });
    this.ctx.logger.info('mod.theming: favicon removed', { tenantId });
    return this.toSnapshot(updated);
  }

  private async deleteFaviconBlob(tenantId: string): Promise<void> {
    const theme = await this.prisma.modThemingTenantTheme.findUnique({
      where: { tenantId },
    });
    if (theme?.faviconStorageKey) {
      await this.ctx.storage.delete(theme.faviconStorageKey);
    }
  }

  /**
   * Sube la portada de la academia (la imagen de cabecera de su tarjeta en la
   * comunidad, como la de un grupo de Skool). Espejo de `uploadLogo` con dos
   * diferencias: 10 MB de límite (es una foto, como la portada de un curso) y
   * salida WebP de 1600 px de ancho, que es lo que hace el core con cualquier
   * imagen grande (no viaja en correos, así que WebP es seguro aquí).
   */
  async uploadCover(
    tenantId: string,
    input: { data: string; filename: string; contentType: string },
  ): Promise<ThemeSnapshot> {
    if (!ALLOWED_COVER_MIME_TYPES.includes(input.contentType as never)) {
      throw new UnsupportedCoverTypeError(input.contentType, ALLOWED_COVER_MIME_TYPES);
    }

    const buffer = Buffer.from(input.data, 'base64');
    if (buffer.length === 0) {
      throw new EmptyCoverError();
    }
    if (buffer.length > MAX_COVER_BYTES) {
      throw new CoverTooLargeError(MAX_COVER_BYTES);
    }

    const current = await this.getOrCreate(tenantId);
    if (current.coverUploaded) {
      await this.deleteCoverBlob(tenantId).catch(() => {
        // Best-effort: si el blob anterior ya no existe en storage, seguimos.
      });
    }

    const requestedKey = `tenants/${tenantId}/branding/cover`;
    const stored = await this.ctx.storage.uploadImage(requestedKey, buffer, input.contentType, {
      maxWidth: 1600,
    });

    // Cache-buster basado en timestamp para que el browser refresque al cambiar.
    const publicUrl = `/api/v1/modules/theming/tenants/${tenantId}/cover?v=${Date.now()}`;

    const updated = await this.prisma.modThemingTenantTheme.update({
      where: { tenantId },
      data: {
        coverUrl: publicUrl,
        // Key y MIME REALES que devolvió el core (ver nota en uploadLogo).
        coverStorageKey: stored.key,
        coverMimeType: stored.contentType,
      },
    });
    this.ctx.logger.info('mod.theming: cover uploaded', {
      tenantId,
      size: stored.size,
      originalSize: buffer.length,
      contentType: stored.contentType,
      optimized: stored.optimized,
    });

    return this.toSnapshot(updated);
  }

  /**
   * Blob de la portada para el endpoint público. `CoverNotFoundError` si no
   * hay portada subida.
   */
  async getCoverBlob(tenantId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const theme = await this.prisma.modThemingTenantTheme.findUnique({
      where: { tenantId },
    });
    if (!theme || !theme.coverStorageKey || !theme.coverMimeType) {
      throw new CoverNotFoundError();
    }
    const buffer = await this.ctx.storage.download(theme.coverStorageKey);
    return { buffer, mimeType: theme.coverMimeType };
  }

  /** Quita la portada (blob + columnas): la tarjeta vuelve a la banda de color. */
  async removeCover(tenantId: string): Promise<ThemeSnapshot> {
    const current = await this.getOrCreate(tenantId);
    if (current.coverUploaded) {
      await this.deleteCoverBlob(tenantId).catch(() => {
        // Best-effort.
      });
    }
    const updated = await this.prisma.modThemingTenantTheme.update({
      where: { tenantId },
      data: {
        coverUrl: null,
        coverStorageKey: null,
        coverMimeType: null,
      },
    });
    this.ctx.logger.info('mod.theming: cover removed', { tenantId });
    return this.toSnapshot(updated);
  }

  private async deleteCoverBlob(tenantId: string): Promise<void> {
    const theme = await this.prisma.modThemingTenantTheme.findUnique({
      where: { tenantId },
    });
    if (theme?.coverStorageKey) {
      await this.ctx.storage.delete(theme.coverStorageKey);
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
    // Copy del panel de acceso: el límite es de CARACTERES (no bytes) porque
    // coincide con el VarChar de la columna — pasarse aquí reventaría en Prisma
    // con un error opaco en vez de uno explicable al admin.
    if (
      dto.signinHeadline !== undefined &&
      dto.signinHeadline !== null &&
      dto.signinHeadline.length > MAX_SIGNIN_HEADLINE_CHARS
    ) {
      throw new SigninCopyTooLongError('signinHeadline', MAX_SIGNIN_HEADLINE_CHARS);
    }
    if (
      dto.signinSubheadline !== undefined &&
      dto.signinSubheadline !== null &&
      dto.signinSubheadline.length > MAX_SIGNIN_SUBHEADLINE_CHARS
    ) {
      throw new SigninCopyTooLongError('signinSubheadline', MAX_SIGNIN_SUBHEADLINE_CHARS);
    }
    // Defensa en profundidad: el DTO ya lo valida, pero el service se puede
    // llamar sin pasar por el pipe (setup, scripts, otros módulos del core).
    if (
      dto.about !== undefined &&
      dto.about !== null &&
      dto.about.trim().length > MAX_ABOUT_CHARS
    ) {
      throw new AboutTooLongError(MAX_ABOUT_CHARS);
    }
    if (dto.socialLinks !== undefined) {
      if (dto.socialLinks.length > MAX_SOCIAL_LINKS) {
        throw new TooManySocialLinksError(MAX_SOCIAL_LINKS);
      }
      for (const link of dto.socialLinks) {
        const known = (SOCIAL_LINK_KINDS as readonly string[]).includes(link.kind);
        if (!known || socialLinkProblem(link.kind as SocialLinkKind, link.url) !== null) {
          throw new InvalidSocialLinkError(link.url);
        }
      }
    }
  }

  private toSnapshot(row: {
    tenantId: string;
    logoUrl: string | null;
    logoStorageKey: string | null;
    logoDisplayMode: string;
    faviconUrl: string | null;
    faviconStorageKey: string | null;
    brandHue: number;
    brandSaturation: number;
    displayFontFamily: string;
    bodyFontFamily: string;
    customCss: string | null;
    footerHtml: string | null;
    signinHeadline: string | null;
    signinSubheadline: string | null;
    // Opcionales en el tipo: filas de antes de la migración (o dobles de test)
    // no los traen, y el snapshot cae a «sin descripción, enlaces ni portada».
    about?: string | null;
    socialLinks?: unknown;
    coverUrl?: string | null;
    coverStorageKey?: string | null;
    updatedAt: Date;
  }): ThemeSnapshot {
    return {
      tenantId: row.tenantId,
      logoUrl: row.logoUrl,
      logoUploaded: row.logoStorageKey !== null,
      // La columna es texto libre en la base: un valor que no esté en la
      // whitelist (edición a mano, versión vieja) cae al default en vez de
      // propagar un modo que el front no sabe pintar.
      logoDisplayMode: LOGO_DISPLAY_MODES.includes(row.logoDisplayMode as LogoDisplayMode)
        ? (row.logoDisplayMode as LogoDisplayMode)
        : DEFAULT_LOGO_DISPLAY_MODE,
      faviconUrl: row.faviconUrl,
      faviconUploaded: row.faviconStorageKey !== null,
      brandHue: row.brandHue,
      brandSaturation: row.brandSaturation,
      displayFontFamily: row.displayFontFamily,
      bodyFontFamily: row.bodyFontFamily,
      customCss: row.customCss,
      footerHtml: row.footerHtml,
      signinHeadline: row.signinHeadline,
      signinSubheadline: row.signinSubheadline,
      about: row.about?.trim() || null,
      // La columna es JSON libre: solo pasan los enlaces que el DTO aceptaría.
      socialLinks: parseSocialLinks(row.socialLinks),
      coverUrl: row.coverUrl ?? null,
      coverUploaded: (row.coverStorageKey ?? null) !== null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
