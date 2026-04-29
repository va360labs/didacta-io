import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { LicenseModule } from '@didacta/license-sdk';
import { AdminModule } from './admin/admin.module';
import { AiModule } from './ai/ai.module';
import { AuthModule } from './auth/auth.module';
import { BrandingModule } from './branding/branding.module';
import { HealthModule } from './health/health.module';
import { ApiLicenseModule } from './license/license.module';
import { MetricsAuthController } from './modules/metrics-auth.controller';
import { ModulesModule } from './modules/modules.module';
import { PrismaModule } from './prisma/prisma.module';
import { TenancyModule } from './tenancy/tenancy.module';

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
    BrandingModule,
    AuthModule,
    AdminModule,
    TenancyModule,
    AiModule,
    ModulesModule,
    HealthModule,
  ],
})
export class AppModule {}
