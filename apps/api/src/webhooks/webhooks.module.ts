/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * WebhooksModule — registra service + controller community + bridge al
 * EventBus + (si se carga) el dispatcher EE como provider y controller EE.
 *
 * Imports `*.ee.ts`: este es el patrón aceptado por el ee-fence — un
 * `*.module.ts` puede registrar siblings `.ee.ts` en `controllers` /
 * `providers`. La gating runtime la hacen:
 *   - El community service via `LicenseService.isCapabilityEnabled` (decide
 *     si delega al dispatcher EE).
 *   - El admin controller EE via `@RequiresCapability` (LicenseGuard rechaza
 *     con 402 sin licencia).
 *
 * Por qué registramos el dispatcher EE como provider del token
 * `WEBHOOKS_EE_DISPATCHER_TOKEN`: el community service lo recibe vía
 * `@Optional() @Inject(WEBHOOKS_EE_DISPATCHER_TOKEN)`. Sin licencia válida
 * el dispatcher EE igual está en memoria, pero su `dispatch()` solo se
 * invoca cuando `getCurrentTier() === 'enterprise'`. Esto evita un import
 * estático del CE al EE — el archivo `.ee.ts` solo lo conoce el module.
 *
 * En entornos sin BullMQ (REDIS_URL ausente o NODE_ENV=test), el
 * dispatcher EE no se inicializa (su `onApplicationBootstrap` retorna
 * temprano). El community service detecta `isEnabled() === false` solo
 * indirectamente (al llamar `dispatch()` lanza), así que cae al path naive.
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ModulesModule } from '../modules/modules.module';
import { WebhooksAdminControllerEE } from './webhooks-admin.controller.ee';
import { WebhooksBridge } from './webhooks.bridge';
import { WebhooksController } from './webhooks.controller';
import { WebhooksDispatcherEE } from './webhooks.dispatcher.ee';
import { WebhooksMetricsEE, webhooksMetricsEEProviders } from './webhooks.metrics.ee';
import { WebhooksService } from './webhooks.service';
import { WEBHOOKS_EE_DISPATCHER_TOKEN } from './webhooks.types';

@Module({
  imports: [AuthModule, ModulesModule],
  controllers: [WebhooksController, WebhooksAdminControllerEE],
  providers: [
    ...webhooksMetricsEEProviders,
    WebhooksMetricsEE,
    WebhooksDispatcherEE,
    {
      // El community service inyecta el dispatcher por TOKEN, no por clase.
      // Esto evita un import estático CE → EE (lo prohíbe ee-fence). El
      // import del module al EE está permitido (excepción documentada).
      provide: WEBHOOKS_EE_DISPATCHER_TOKEN,
      useExisting: WebhooksDispatcherEE,
    },
    WebhooksService,
    WebhooksBridge,
  ],
  exports: [WebhooksService],
})
export class WebhooksModule {}
