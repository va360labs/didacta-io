import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
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
    PrometheusModule.register({
      defaultMetrics: { enabled: true },
      defaultLabels: { app: 'didacta-api' },
    }),
    PrismaModule,
    AuthModule,
    AdminModule,
    TenancyModule,
    ModulesModule,
    HealthModule,
  ],
})
export class AppModule {}
