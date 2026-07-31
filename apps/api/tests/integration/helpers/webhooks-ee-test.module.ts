/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Módulo de test que registra los controllers/providers EE de webhooks.
 *
 * Vive en un fichero `*.module.ts` a propósito: es la excepción aceptada del
 * ee-fence — un módulo NestJS puede importar siblings `.ee` estáticamente
 * SOLO para registrarlos, porque a runtime los gatea @RequiresCapability
 * (402 sin licencia válida). El test que lo consume no importa nada `.ee`.
 */

import { Module, type Type } from '@nestjs/common';
import { WebhooksController } from '../../../src/webhooks/webhooks.controller';
import { WebhooksService } from '../../../src/webhooks/webhooks.service';
import { WebhooksAdminControllerEE } from '../../../src/webhooks/webhooks-admin.controller.ee';
import { WebhooksDispatcherEE } from '../../../src/webhooks/webhooks.dispatcher.ee';
import {
  WebhooksMetricsEE,
  webhooksMetricsEEProviders,
} from '../../../src/webhooks/webhooks.metrics.ee';
import { WEBHOOKS_EE_DISPATCHER_TOKEN } from '../../../src/webhooks/webhooks.types';

/**
 * Construye el módulo de webhooks del test con el core de auth que le pase el
 * spec (cada integration test monta su propio auth core mínimo).
 */
export function buildIntegrationWebhooksModule(authCoreModule: Type<unknown>): Type<unknown> {
  @Module({
    imports: [authCoreModule],
    controllers: [WebhooksController, WebhooksAdminControllerEE],
    providers: [
      ...webhooksMetricsEEProviders,
      WebhooksMetricsEE,
      WebhooksDispatcherEE,
      {
        provide: WEBHOOKS_EE_DISPATCHER_TOKEN,
        useExisting: WebhooksDispatcherEE,
      },
      WebhooksService,
    ],
  })
  class IntegrationWebhooksModule {}
  return IntegrationWebhooksModule;
}
