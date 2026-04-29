/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Integración Nest del LicenseService como módulo dinámico.
 *
 * Uso desde apps/api:
 *
 *   @Module({
 *     imports: [
 *       LicenseModule.forRoot({
 *         keyEnv: 'DIDACTA_LICENSE_KEY',
 *         allowDevBypass: process.env.DIDACTA_DEV_BYPASS === 'true',
 *       }),
 *     ],
 *   })
 *   export class AppModule {}
 *
 * El servicio carga la licencia al primer `OnApplicationBootstrap`. El estado
 * queda disponible para guards, services y endpoints públicos.
 */

import {
  Catch,
  type ArgumentsHost,
  type DynamicModule,
  type ExceptionFilter,
  type FactoryProvider,
  type OnApplicationBootstrap,
  Global,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Module,
} from '@nestjs/common';
import { LicenseService } from './runtime.js';
import { CapabilityRequiredError, LicenseSignatureError } from './types.js';
import { LicenseGuard } from './guards.js';

export const LICENSE_OPTIONS_TOKEN = 'DIDACTA_LICENSE_OPTIONS';

export interface LicenseModuleOptions {
  /** Variable de entorno donde leer el JWT. Default 'DIDACTA_LICENSE_KEY'. */
  keyEnv?: string;
  /** Pasa la key directamente (en vez de leerla de env). */
  key?: string | null;
  /** Activa el bypass de desarrollo. Solo efecto si NODE_ENV !== 'production'. */
  allowDevBypass?: boolean;
}

@Injectable()
class LicenseBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger('LicenseService');

  constructor(
    @Inject(LICENSE_OPTIONS_TOKEN)
    private readonly options: LicenseModuleOptions,
    private readonly license: LicenseService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const env = this.options.keyEnv ?? 'DIDACTA_LICENSE_KEY';
    const key = this.options.key ?? process.env[env] ?? null;

    const state = await this.license.load({
      key,
      allowDevBypass: this.options.allowDevBypass ?? false,
    });

    const subj = state.subject;
    if (state.status === 'community') {
      this.logger.log('License: community (no key set). Enterprise capabilities disabled.');
    } else if (state.status === 'dev') {
      this.logger.warn('License: DEV BYPASS active. ALL Enterprise capabilities enabled. NEVER use in production.');
    } else if (state.status === 'invalid') {
      this.logger.error(`License: INVALID. ${state.warnings.join(' | ')}`);
    } else {
      this.logger.log(
        `License: ${state.status} for "${subj?.organizationName ?? subj?.organizationId ?? 'unknown'}" ` +
          `(plan=${subj?.plan}, expires=${subj?.expiresAt?.toISOString()}, capabilities=${subj?.capabilities.length ?? 0}).`,
      );
    }

    for (const w of state.warnings) {
      this.logger.warn(`License warning: ${w}`);
    }
  }
}

@Catch(CapabilityRequiredError, LicenseSignatureError)
export class LicenseExceptionFilter implements ExceptionFilter {
  catch(exception: CapabilityRequiredError | LicenseSignatureError, host: ArgumentsHost) {
    const httpHost = host.switchToHttp();
    const response = httpHost.getResponse();
    const request = httpHost.getRequest();

    const isCapabilityError = exception instanceof CapabilityRequiredError;
    const status = isCapabilityError ? HttpStatus.PAYMENT_REQUIRED : HttpStatus.UNAUTHORIZED;
    const body = {
      statusCode: status,
      error: exception.name,
      code: exception.code,
      message: exception.message,
      ...(isCapabilityError ? { capability: exception.capability } : {}),
      path: request?.url ?? null,
      timestamp: new Date().toISOString(),
    };

    // Soporta tanto Express como Fastify (la app usa Fastify, pero por
    // robustez detectamos ambas APIs).
    if (typeof response.status === 'function' && typeof response.json === 'function') {
      // Express
      response.status(status).json(body);
      return;
    }
    if (typeof response.code === 'function' && typeof response.send === 'function') {
      // Fastify
      response.code(status).send(body);
      return;
    }
    // Fallback: write & end
    response.statusCode = status;
    response.end(JSON.stringify(body));
  }
}

@Global()
@Module({})
export class LicenseModule {
  static forRoot(options: LicenseModuleOptions = {}): DynamicModule {
    const optionsProvider: FactoryProvider = {
      provide: LICENSE_OPTIONS_TOKEN,
      useFactory: () => options,
    };

    return {
      module: LicenseModule,
      providers: [
        optionsProvider,
        LicenseService,
        LicenseGuard,
        LicenseBootstrap,
      ],
      exports: [LicenseService, LicenseGuard],
    };
  }
}
