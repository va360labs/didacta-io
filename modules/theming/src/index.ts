/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export { ThemingService } from './theming.service.js';
export {
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
  socialLinkSchema,
  updateThemeSchema,
  uploadCoverSchema,
  uploadFaviconSchema,
  uploadLogoSchema,
  type BodyFont,
  type DisplayFont,
  type LogoDisplayMode,
  type ThemeSnapshot,
  type UpdateThemeDto,
  type UploadCoverDto,
  type UploadFaviconDto,
  type UploadLogoDto,
} from './dto.js';
export {
  MAX_SOCIAL_LINKS,
  MAX_SOCIAL_LINK_URL_CHARS,
  SOCIAL_LINK_HOSTS,
  SOCIAL_LINK_KINDS,
  parseSocialLinks,
  socialLinkProblem,
  type SocialLink,
  type SocialLinkKind,
} from './social-links.js';
export {
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
  InvalidUrlError,
  LogoNotFoundError,
  LogoTooLargeError,
  SigninCopyTooLongError,
  ThemingError,
  TooManySocialLinksError,
  UnsupportedCoverTypeError,
  UnsupportedFaviconTypeError,
  UnsupportedFontError,
  UnsupportedLogoTypeError,
} from './errors.js';

export const themingModule: DidactaModule = {
  manifest,
  async onRegister(ctx: ModuleContext) {
    ctx.logger.info('mod.theming: onRegister', { name: manifest.name });
  },
  async onEnable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.theming: onEnable', { tenantId });
  },
  async onDisable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.theming: onDisable', { tenantId });
  },
  async onUninstall(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.theming: onUninstall', { tenantId });
  },
};
