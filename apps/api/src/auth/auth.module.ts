import { Module } from '@nestjs/common';
import { LicenseService } from '@didacta/license-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaTenantConfigService } from '../modules/prisma-tenant-config.service';
import { SecretCipherService } from '../modules/secret-cipher.service';
import { SmtpAdapterService } from '../modules/smtp-adapter.service';
import { TenantSmtpResolverService } from '../modules/tenant-smtp-resolver.service';
import { ApiKeyController } from './api-key.controller';
import { MeController } from './me.controller';
import { JwtOrApiKeyGuard } from './api-key.guard';
import { ApiKeyService } from './api-key.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { MfaController } from './mfa.controller';
import { MfaPolicyController } from './mfa-policy/mfa-policy.controller';
import { MfaPolicyService } from './mfa-policy/mfa-policy.service';
import { MfaService } from './mfa.service';
import { PublicProfileController } from './public-profile.controller';
import { PasswordResetService } from './password-reset.service';
import { PasswordService } from './password.service';
import { SigninContextService } from './signin-context.service';
import { TokenService } from './token.service';
import { loadCipherKey, describeCipherKeySource } from './cipher-key';

/**
 * Factory para SecretCipherService — replica la lógica de
 * `module-context.factory.ts` para que el AuthModule no dependa de
 * ModulesModule (evita ciclo) pero use la misma key resuelta por
 * `loadCipherKey()` (env → file persistente → fallback efímero).
 */
function loadCipherKeyForAuth(): string {
  const resolved = loadCipherKey();
  // Solo mostramos el WARN al boot UNA vez — desde aquí, porque AuthModule
  // se construye antes que ModuleContextFactory (que comparte la key).
  if (resolved.source !== 'env') {
    // eslint-disable-next-line no-console
    console.warn(describeCipherKeySource(resolved));
  }
  return resolved.key;
}

@Module({
  controllers: [
    AuthController,
    MfaController,
    MfaPolicyController,
    ApiKeyController,
    MeController,
    PublicProfileController,
  ],
  providers: [
    AuthService,
    PasswordResetService,
    PasswordService,
    SigninContextService,
    TokenService,
    MfaService,
    ApiKeyService,
    JwtAuthGuard,
    JwtOrApiKeyGuard,
    PrismaAuditLogService,
    SmtpAdapterService,
    {
      provide: SecretCipherService,
      useFactory: () => new SecretCipherService(loadCipherKeyForAuth()),
    },
    // PrismaTenantConfigService recibe AuditLogService (interface del kernel)
    // como tercer arg. NestJS DI no puede resolver una interface, así que
    // construimos manualmente con useFactory para inyectar la impl concreta.
    {
      provide: PrismaTenantConfigService,
      inject: [PrismaService, SecretCipherService, PrismaAuditLogService],
      useFactory: (
        prisma: PrismaService,
        cipher: SecretCipherService,
        auditLog: PrismaAuditLogService,
      ) => new PrismaTenantConfigService(prisma, cipher, auditLog),
    },
    // TenantSmtpResolverService — centraliza la cascada tenant→global→none
    // para todos los call sites de envío de mail (password reset, hub,
    // smoke test admin). Inyectamos manual porque depende de la interface
    // del kernel (TenantConfigService) y NestJS no resuelve interfaces.
    {
      provide: TenantSmtpResolverService,
      inject: [PrismaTenantConfigService, SmtpAdapterService],
      useFactory: (config: PrismaTenantConfigService, smtp: SmtpAdapterService) =>
        new TenantSmtpResolverService(config, smtp),
    },
    // MfaPolicyService — orquesta CRUD de la política tenant-wide y la
    // evaluación del enforcement en el flujo de login. Inyectamos manual
    // para mantener la fuente de verdad de PrismaTenantConfigService dentro
    // del propio AuthModule (ver factory anterior).
    {
      provide: MfaPolicyService,
      inject: [PrismaTenantConfigService, LicenseService],
      useFactory: (tenantConfig: PrismaTenantConfigService, license: LicenseService) =>
        new MfaPolicyService(tenantConfig, license),
    },
  ],
  exports: [
    AuthService,
    PasswordResetService,
    TokenService,
    PasswordService,
    MfaService,
    MfaPolicyService,
    ApiKeyService,
    JwtAuthGuard,
    JwtOrApiKeyGuard,
    PrismaAuditLogService,
    // Exportado para que el AdminModule pueda inyectar el config service
    // en CustomDomainsService (cuarto piloto License SDK) sin reproveerlo.
    // La instancia queda compartida con AuthModule (donde la usa MfaPolicyService).
    PrismaTenantConfigService,
    // Exportado para que AdminModule (AdminSmtpController) y cualquier
    // otro caller que mande mail use el mismo resolver.
    SmtpAdapterService,
    TenantSmtpResolverService,
  ],
})
export class AuthModule {}
