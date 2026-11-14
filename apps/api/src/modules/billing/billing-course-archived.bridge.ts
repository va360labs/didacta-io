/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@didacta/core-kernel';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleContextFactory } from '../module-context.factory';
import { ModuleRegistryService } from '../module-registry.service';

/**
 * Puente entre mod.courses y mod.billing: al ARCHIVAR un curso, caduca en
 * Stripe sus sesiones de pago abiertas y deja sus pedidos pendientes como
 * caducados.
 *
 * Sin esto, una pestaña con la sesión abierta podía pagar hasta 24 h después
 * un curso ya archivado; la matriculación posterior lo rechaza (el curso no
 * está publicado) y el dinero quedaba cobrado sin acceso.
 *
 * Los cambios de precio y la retirada de la opción de compra los caduca el
 * propio `BillingService` (`upsertCoursePrice`, `updateProduct`,
 * `deleteProduct`). Idempotente: una reentrega no encuentra nada abierto.
 */
@Injectable()
export class BillingCourseArchivedBridge implements OnModuleInit {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly factory: ModuleContextFactory,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    this.factory
      .getEventBus()
      .subscribe<{ courseId: string }>('courses.course.archived', async (event) => {
        await this.expire(event);
      });
    this.logger.log({}, 'BillingCourseArchivedBridge: subscribed to courses.course.archived');
  }

  async expire(event: DomainEvent<{ courseId: string }>): Promise<void> {
    const tenantId = event.metadata.tenantId;
    const { courseId } = event.data;
    const result = await this.registry
      .getBillingService()
      .expireOpenCheckouts(tenantId, { courseId });
    const log =
      result.failed > 0 ? this.logger.warn.bind(this.logger) : this.logger.log.bind(this.logger);
    log(
      { tenantId, courseId, ...result },
      result.failed > 0
        ? 'BillingCourseArchivedBridge: curso archivado con sesiones de pago que no se pudieron caducar'
        : 'BillingCourseArchivedBridge: sesiones de pago del curso archivado, caducadas',
    );
  }
}
