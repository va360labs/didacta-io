import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { WpSsoController } from './wp-sso.controller';
import { WpSsoService } from './wp-sso.service';

/**
 * SsoWpModule — SSO desde WordPress (mod.wp-sso). Community, sin gate EE.
 *
 * Reutiliza de AuthModule: PrismaService (global), TokenService y
 * PrismaAuditLogService — mismo patrón que SsoOidcModule/SsoSamlModule.
 *
 * URLs (prefijo global /api/v1):
 *   - GET /api/v1/modules/wp-sso/callback?token=...
 *   - GET /api/v1/modules/wp-sso/status
 */
@Module({
  imports: [AuthModule],
  controllers: [WpSsoController],
  providers: [WpSsoService],
  exports: [WpSsoService],
})
export class SsoWpModule {}
