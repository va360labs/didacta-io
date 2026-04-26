import { Module } from '@nestjs/common';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaTenantConfigService } from '../modules/prisma-tenant-config.service';
import { SecretCipherService } from '../modules/secret-cipher.service';
import { SmtpAdapterService } from '../modules/smtp-adapter.service';
import { ApiKeyController } from './api-key.controller';
import { JwtOrApiKeyGuard } from './api-key.guard';
import { ApiKeyService } from './api-key.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { PasswordResetService } from './password-reset.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/**
 * Factory para SecretCipherService — replica la lógica de
 * `module-context.factory.ts` para que el AuthModule no dependa de
 * ModulesModule (evita ciclo) pero use la misma key del .env.
 */
function loadCipherKey(): string {
  const key = process.env.TENANT_SETTINGS_ENC_KEY;
  if (!key || key.trim().length === 0) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'TENANT_SETTINGS_ENC_KEY es obligatoria en producción. Generala con: openssl rand -hex 32',
      );
    }
    return '0'.repeat(64);
  }
  return key;
}

@Module({
  controllers: [AuthController, MfaController, ApiKeyController],
  providers: [
    AuthService,
    PasswordResetService,
    PasswordService,
    TokenService,
    MfaService,
    ApiKeyService,
    JwtAuthGuard,
    JwtOrApiKeyGuard,
    PrismaAuditLogService,
    PrismaTenantConfigService,
    SmtpAdapterService,
    {
      provide: SecretCipherService,
      useFactory: () => new SecretCipherService(loadCipherKey()),
    },
  ],
  exports: [
    AuthService,
    PasswordResetService,
    TokenService,
    PasswordService,
    MfaService,
    ApiKeyService,
    JwtAuthGuard,
    JwtOrApiKeyGuard,
    PrismaAuditLogService,
  ],
})
export class AuthModule {}
