import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { LicenseModule } from '@didacta/license-sdk';
import { AdminModule } from './admin/admin.module';
import { AiModule } from './ai/ai.module';
import { AuthModule } from './auth/auth.module';
import { BrandingModule } from './branding/branding.module';
import { HealthModule } from './health/health.module';
import { InscribeModule } from './enrollment/inscribe.module';
import { InscripcionModule } from './inscripcion/inscripcion.module';
import { ApiLicenseModule } from './license/license.module';
import { MarketplaceModule } from './marketplace/marketplace.module';
import { AuditExportModule } from './modules/audit-export/audit-export.module';
import { MetricsAuthController } from './modules/metrics-auth.controller';
import { ModulesModule } from './modules/modules.module';
import { PrismaModule } from './prisma/prisma.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { RegistryModule } from './registry/registry.module';
import { ScimModule } from './scim/scim.module';
import { SetupModule } from './setup/setup.module';
import { SystemModule } from './system/system.module';
import { SsoOidcModule } from './sso/oidc/oidc.module';
import { SsoSamlModule } from './sso/saml/saml.module';
import { SsoWpModule } from './sso/wp/wp-sso.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env['NODE_ENV'] === 'production' ? 'info' : 'debug',
        transport:
          process.env['NODE_ENV'] === 'production'
            ? undefined
            : {
                target: 'pino-pretty',
                options: {
                  singleLine: true,
                  colorize: true,
                  translateTime: 'SYS:HH:MM:ss.l',
                  ignore: 'pid,hostname',
                },
              },
        redact: ['req.headers.authorization', 'req.headers.cookie'],
        customProps: () => ({
          service: 'api',
        }),
      },
    }),
    // Expone /metrics con default metrics + las custom registradas en
    // los módulos. El path se excluye del prefijo global en main.ts.
    // Usamos `MetricsAuthController` para opcionalmente exigir Bearer token
    // si `METRICS_TOKEN` está set en env (deploys expuestos a Internet).
    PrometheusModule.register({
      defaultMetrics: { enabled: true },
      defaultLabels: { app: 'didacta-api' },
      controller: MetricsAuthController,
    }),
    PrismaModule,
    // License SDK: cargamos la licencia al boot desde DIDACTA_LICENSE_KEY
    // y exponemos LicenseService como provider global. Permite gateado de
    // capabilities Enterprise transversales del core con @RequiresCapability.
    LicenseModule.forRoot({
      keyEnv: 'DIDACTA_LICENSE_KEY',
      allowDevBypass: process.env['DIDACTA_DEV_BYPASS'] === 'true',
    }),
    ApiLicenseModule,
    // Sexto piloto License SDK — gate feat:api.rate_limit.elevated end-to-end.
    // Registra RateLimitInterceptor como APP_INTERCEPTOR global, así que
    // todas las rutas (con las exenciones definidas en el interceptor)
    // pasan por el limiter sin tocar controllers.
    RateLimitModule,
    BrandingModule,
    RegistryModule,
    AuthModule,
    // Bootstrap del primer arranque. Endpoints públicos /setup/status + /setup/init.
    // Va después de AuthModule porque reusa PasswordService + TokenService.
    SetupModule,
    // Endpoints transversales (proxy a Docker Hub para "versión nueva", etc.).
    SystemModule,
    AdminModule,
    TenancyModule,
    AiModule,
    ModulesModule,
    // Inscripción externa por API (`POST /api/v1/inscribe`). Va después de
    // ModulesModule porque reusa ModuleRegistryService (mod.learning) y de
    // AuthModule (JwtOrApiKeyGuard + creación de usuario + SMTP).
    InscribeModule,
    // Inscripción de miembros (gate Telegram + OTP por email + validación
    // manual). Infra CORE del host; reusa AuthModule (PasswordService, SMTP,
    // audit, JwtAuthGuard) y ModulesModule (ModuleRegistryService).
    InscripcionModule,
    // Quinto piloto License SDK — gate feat:reports.advanced_signed end-to-end.
    // Vivimos en módulo separado para acoplar `adm-zip` solo donde se usa.
    AuditExportModule,
    // Séptimo piloto License SDK — gate feat:scim end-to-end (endpoints
    // /scim/v2/...). El prefijo global /api/v1 NO aplica a estos paths
    // (excluidos en main.ts) porque los IdPs esperan exactamente /scim/v2.
    ScimModule,
    // 8º piloto License SDK — gate feat:sso.oidc end-to-end. Endpoints públicos
    // bajo /api/v1/auth/oidc/* y admin bajo /api/v1/admin/sso/oidc/* (este
    // último vive en AdminModule). El secret del IdP se cifra at-rest.
    SsoOidcModule,
    // 9º piloto License SDK — gate feat:sso.saml end-to-end. Endpoints públicos
    // bajo /api/v1/auth/saml/* (incluye ACS POST x-www-form-urlencoded — el
    // parser está registrado en main.ts) y admin bajo /api/v1/admin/sso/saml/*
    // (en AdminModule). El cert IdP es público; no se cifra.
    SsoSamlModule,
    // SSO desde WordPress (mod.wp-sso) — Community, sin gate EE. Token HMAC
    // corto firmado por WP → sesión Didacta. Callback en /api/v1/modules/wp-sso/*.
    SsoWpModule,
    // 10º piloto License SDK — gate feat:api.webhooks.high_throughput.
    // CRUD endpoints CE + envío naive síncrono. Path EE (BullMQ + HMAC +
    // dead-letter) gateado por capability en runtime.
    WebhooksModule,
    // Marketplace de módulos — fundaciones (PR A de ADR-009). Solo expone
    // ModuleSignatureService + ModulePackageService para que los tests y
    // futuros endpoints (PR B) los consuman. Sin endpoints todavía: el
    // upload del *.zip llega en PRs siguientes.
    MarketplaceModule,
    HealthModule,
  ],
})
export class AppModule {}
