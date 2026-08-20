/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Module, RequestMethod } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { LicenseModule } from '@didacta/license-sdk';
import { AdminModule } from './admin/admin.module';
import { ModerationModule } from './moderation/moderation.module';
import { AiModule } from './ai/ai.module';
import { AuthModule } from './auth/auth.module';
import { BrandingModule } from './branding/branding.module';
import { HealthModule } from './health/health.module';
import { InscribeModule } from './enrollment/inscribe.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { ApiLicenseModule } from './license/license.module';
import { LicenseAdminModule } from './license/license-admin.module';
import { MarketplaceModule } from './marketplace/marketplace.module';
import { AuditExportModule } from './modules/audit-export/audit-export.module';
import { InstanceSettingsModule } from './modules/instance-settings.module';
import { MemberRegistrationModule } from './modules/member-registration/member-registration.module';
import { MetricsAuthController } from './modules/metrics-auth.controller';
import { ModulesModule } from './modules/modules.module';
import { PrismaInstanceConfigService } from './modules/prisma-instance-config.service';
import { PrismaModule } from './prisma/prisma.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { RegistryModule } from './registry/registry.module';
import { ScimModule } from './scim/scim.module';
import { PublicModule } from './public/public.module';
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
      // El default de nestjs-pino es `path: '*'` (sintaxis legacy); con
      // path-to-regexp v8 (Nest 11) el wildcard va nombrado.
      forRoutes: [{ path: '{*path}', method: RequestMethod.ALL }],
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
    // License SDK: cargamos la licencia al boot. Precedencia env > BD
    // (work/migracion-env-a-panel.md §1): si DIDACTA_LICENSE_KEY está seteada
    // se usa esa; si no, `keyProvider` cae a `instance_setting` (lo que
    // guarda /admin/licencia). Exponemos LicenseService como provider global
    // para el gateado de capabilities Enterprise con @RequiresCapability.
    LicenseModule.forRootAsync({
      imports: [InstanceSettingsModule],
      inject: [PrismaInstanceConfigService],
      useFactory: (instanceSettings: PrismaInstanceConfigService) => ({
        keyEnv: 'DIDACTA_LICENSE_KEY',
        allowDevBypass: process.env['DIDACTA_DEV_BYPASS'] === 'true',
        keyProvider: () => instanceSettings.get<string>('license', 'key').then((v) => v ?? null),
      }),
    }),
    ApiLicenseModule,
    // `/admin/licencia`: gestionar la key desde el panel con recarga en
    // caliente (sin esto, guardar no surtía efecto hasta reiniciar).
    LicenseAdminModule,
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
    PublicModule,
    // Endpoints transversales (proxy a Docker Hub para "versión nueva", etc.).
    SystemModule,
    AdminModule,
    // Moderación de personas: sanciones que dejan leer pero no aportar.
    // Registra RestrictionInterceptor como APP_INTERCEPTOR global, así que
    // cubre también las rutas que no pasan por JwtAuthGuard (community-api).
    ModerationModule,
    TenancyModule,
    AiModule,
    ModulesModule,
    // Inscripción externa por API (`POST /api/v1/inscribe`). Va después de
    // ModulesModule porque reusa ModuleRegistryService (mod.learning) y de
    // AuthModule (JwtOrApiKeyGuard + creación de usuario + SMTP).
    InscribeModule,
    // Lectura para integradores externos (`GET /api/v1/integrations/…`): la
    // otra mitad de InscribeModule. Permite que un sitio de fuera pinte la
    // ficha de un curso con datos de Didacta y sepa si quien la mira ya es
    // alumno. Mismas dependencias que InscribeModule, por lo mismo.
    IntegrationsModule,
    // Inscripción de miembros (verificadores componibles + validación manual).
    // Host de mod.member-registration (la lógica portable vive en
    // modules/member-registration/); reusa AuthModule (PasswordService, SMTP,
    // audit, JwtAuthGuard) y ModulesModule (registry, access-groups, outbox).
    MemberRegistrationModule,
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
