/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Helper de bootstrap para tests de integración (MIG-034).
 *
 * Crea una NestFastifyApplication con sólo los módulos necesarios para
 * ejercitar `LicenseGuard` end-to-end con DB Postgres real:
 *
 *   - LicenseModule.forRoot({ key, allowDevBypass })  → guard + servicio
 *   - PrismaModule                                    → conecta al Postgres
 *   - BrandingModule                                  → expone /branding y
 *                                                       /branding/white-label/*
 *
 * Por qué no AppModule completo:
 *   AppModule arrastra Auth, Admin, Tenancy, AI, etc. — cada uno con sus
 *   dependencias (BullMQ, Redis pub/sub, smtp, S3, secrets enc-key, etc.).
 *   Para validar el contrato del LicenseGuard nos basta con un controller
 *   gateado real (`WhiteLabelController`) y la conexión real a Postgres.
 *   Esto mantiene el test rápido y deterministico sin sacrificar la señal
 *   "el guard funciona dentro de un Nest real con DI completo".
 */

import { Module, type ModuleMetadata } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { LoggerModule } from 'nestjs-pino';
import { LicenseExceptionFilter, LicenseModule } from '@didacta/license-sdk';
import { PrismaModule } from '../../../src/prisma/prisma.module';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { BrandingModule } from '../../../src/branding/branding.module';

export interface TestAppOptions {
  /** JWT firmado a inyectar como licencia. `null` → estado community. */
  licenseKey: string | null;
  /** Activa dev bypass. Solo efectivo si NODE_ENV !== 'production'. */
  allowDevBypass?: boolean;
  /**
   * Módulos extra a montar junto al stack base (LicenseModule + PrismaModule).
   *
   * Si se proveen, REEMPLAZAN a `BrandingModule` (default histórico).
   * Cada módulo extra carga sus propios providers — el caller es responsable
   * de incluir todas las deps transitivas (e.g. AuthModule) cuando un controller
   * use `JwtAuthGuard` o servicios del kernel.
   *
   * Use-case típico: tests de integración por capability EE que sólo montan
   * el sub-grafo necesario, sin inflar la app con AppModule completo (BullMQ,
   * smtp, S3, etc.).
   */
  extraModules?: ModuleMetadata['imports'];
}

@Module({})
class IntegrationRootModule {}

export interface TestApp {
  app: NestFastifyApplication;
  prisma: PrismaService;
  close: () => Promise<void>;
}

/**
 * Construye y arranca la app de tests con la licencia inyectada.
 * Cada llamada genera una instancia limpia: el LicenseService es nuevo,
 * el bootstrap se ejecuta y la conexión Prisma se abre.
 */
export async function createTestApp(opts: TestAppOptions): Promise<TestApp> {
  // Construimos el módulo dinámicamente para poder pasar la licencia distinta
  // en cada test. forRoot recibe `key` directo (no env) — más explícito y
  // libre de race conditions con process.env entre tests paralelos.
  // Si el caller no provee `extraModules`, mantenemos el default histórico
  // (BrandingModule) para no romper `license-guard.integration.test.ts`.
  const featureImports =
    opts.extraModules && opts.extraModules.length > 0 ? opts.extraModules : [BrandingModule];
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      // LoggerModule (nestjs-pino) es global y lo necesitan algunos services
      // del AuthModule (PasswordResetService, etc.). Lo configuramos en modo
      // silencioso para no inundar el output del test runner.
      LoggerModule.forRoot({
        pinoHttp: {
          level: 'silent',
          autoLogging: false,
        },
      }),
      LicenseModule.forRoot({
        key: opts.licenseKey,
        allowDevBypass: opts.allowDevBypass ?? false,
      }),
      PrismaModule,
      ...featureImports,
    ],
  }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ logger: false }),
    { logger: false },
  );

  // Replica el setup de main.ts relevante para los endpoints gateados:
  // - prefijo global /api/v1 (todos los endpoints de branding viven ahí)
  // - LicenseExceptionFilter global (mapea CapabilityRequiredError → 402)
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new LicenseExceptionFilter());

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const prisma = app.get(PrismaService);

  return {
    app,
    prisma,
    close: async () => {
      await app.close();
    },
  };
}
