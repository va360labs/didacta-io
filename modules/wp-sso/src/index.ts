import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

/**
 * Contrato `DidactaModule` para mod.wp-sso. El trabajo real (callback +
 * emisión de sesión) lo hace el host (apps/api/src/sso/wp) porque necesita
 * TokenService/Prisma/Redis. Este objeto sólo cumple el lifecycle del registry.
 */
export const wpSsoModule: DidactaModule = {
  manifest,

  async onRegister(ctx: ModuleContext) {
    ctx.logger.info('wp-sso: onRegister', { name: manifest.name });
  },

  async onEnable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('wp-sso: onEnable', { tenantId });
  },

  async onDisable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('wp-sso: onDisable', { tenantId });
  },

  async onUninstall(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('wp-sso: onUninstall', { tenantId });
  },
};

export { manifest };
export {
  verifyWpSsoToken,
  WP_SSO_DEFAULT_AUDIENCE,
  WP_SSO_DEFAULT_MAX_TTL_SECONDS,
} from './token.js';
export type { WpSsoClaims, VerifyWpSsoOptions } from './token.js';
export { WpSsoTokenError } from './errors.js';
export type { WpSsoErrorCode } from './errors.js';
