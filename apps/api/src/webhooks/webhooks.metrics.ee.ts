/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Enterprise
 *
 * This file is part of Didacta Enterprise Edition and is licensed under the
 * Didacta Enterprise License (LICENSE_EE). It cannot be used in production
 * without a valid Didacta Enterprise license key. See LICENSE_EE for details.
 *
 * Métricas Prometheus del path EE de webhooks salientes.
 *
 *   - `webhooks_outbound_total{result, tenant_id}` (counter)
 *   - `webhooks_outbound_duration_seconds` (histogram)
 *   - `webhooks_outbound_attempts` (histogram)
 *   - `webhooks_outbound_dead_letter_total{tenant_id}` (counter)
 *   - `webhooks_outbound_queue_depth` (gauge)
 *
 * Las métricas con label `tenant_id` se reportan SIN el id real (lo
 * truncamos a las primeras 8 chars del UUID). Esto evita explosión de
 * cardinalidad en Prometheus mientras mantiene utilidad para alertas
 * "tenant X tiene tasa de fallo > 50%".
 */

import { Injectable } from '@nestjs/common';
import {
  InjectMetric,
  makeCounterProvider,
  makeGaugeProvider,
  makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';
import { Counter, Gauge, Histogram } from 'prom-client';

@Injectable()
export class WebhooksMetricsEE {
  constructor(
    @InjectMetric('webhooks_outbound_total')
    private readonly totalCounter: Counter<'result' | 'tenant_id'>,
    @InjectMetric('webhooks_outbound_duration_seconds')
    private readonly duration: Histogram<string>,
    @InjectMetric('webhooks_outbound_attempts')
    private readonly attempts: Histogram<string>,
    @InjectMetric('webhooks_outbound_dead_letter_total')
    private readonly deadLetterCounter: Counter<'tenant_id'>,
    @InjectMetric('webhooks_outbound_queue_depth')
    private readonly queueDepth: Gauge<string>,
  ) {}

  recordDelivery(result: 'success' | 'failure', tenantId: string): void {
    this.totalCounter.inc({ result, tenant_id: this.shortTenantId(tenantId) });
  }

  recordDuration(seconds: number): void {
    this.duration.observe(seconds);
  }

  recordAttempts(count: number): void {
    this.attempts.observe(count);
  }

  recordDeadLetter(tenantId: string): void {
    this.deadLetterCounter.inc({ tenant_id: this.shortTenantId(tenantId) });
  }

  setQueueDepth(value: number): void {
    this.queueDepth.set(value);
  }

  private shortTenantId(tenantId: string): string {
    return tenantId.slice(0, 8);
  }
}

export const webhooksMetricsEEProviders = [
  makeCounterProvider({
    name: 'webhooks_outbound_total',
    help: 'Total de entregas de webhook outbound por resultado y tenant (truncado).',
    labelNames: ['result', 'tenant_id'],
  }),
  makeHistogramProvider({
    name: 'webhooks_outbound_duration_seconds',
    help: 'Duración (s) de cada entrega de webhook outbound (path EE).',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  }),
  makeHistogramProvider({
    name: 'webhooks_outbound_attempts',
    help: 'Número de intentos por entrega (1 = primer intento OK; 5 = max BullMQ retries).',
    buckets: [1, 2, 3, 4, 5],
  }),
  makeCounterProvider({
    name: 'webhooks_outbound_dead_letter_total',
    help: 'Total de entregas que terminaron en dead-letter tras agotar reintentos.',
    labelNames: ['tenant_id'],
  }),
  makeGaugeProvider({
    name: 'webhooks_outbound_queue_depth',
    help: 'Profundidad actual de la cola BullMQ didacta.webhooks.outbound.',
  }),
];
