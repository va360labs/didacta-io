/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import { makeCounterProvider, makeHistogramProvider } from '@willsoto/nestjs-prometheus';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter, Histogram } from 'prom-client';

/**
 * Métricas Prometheus del digest worker.
 *
 * - `community_digest_emails_total{result}`: contador de envíos por
 *   resultado (`sent` | `skipped` | `failed`).
 * - `community_digest_run_duration_seconds`: histograma de la duración
 *   de cada ejecución completa del job (segundos).
 * - `community_digest_users_processed_total`: contador de usuarios
 *   procesados (cualquier resultado, para sanity de la cadencia).
 *
 * Los providers se exponen como factories vía `MetricsProviders` para
 * registrarlos en el módulo.
 */
@Injectable()
export class CommunityDigestMetrics {
  constructor(
    @InjectMetric('community_digest_emails_total')
    private readonly emailsCounter: Counter<'result'>,
    @InjectMetric('community_digest_run_duration_seconds')
    private readonly durationHistogram: Histogram<string>,
    @InjectMetric('community_digest_users_processed_total')
    private readonly usersCounter: Counter<string>,
  ) {}

  recordSent(): void {
    this.emailsCounter.inc({ result: 'sent' });
  }

  recordSkipped(): void {
    this.emailsCounter.inc({ result: 'skipped' });
  }

  recordFailed(): void {
    this.emailsCounter.inc({ result: 'failed' });
  }

  recordUserProcessed(): void {
    this.usersCounter.inc();
  }

  /**
   * Devuelve un timer; al llamarlo guarda la duración. Patrón estándar
   * de prom-client.
   */
  startRunTimer(): () => number {
    return this.durationHistogram.startTimer();
  }
}

export const communityDigestMetricsProviders = [
  makeCounterProvider({
    name: 'community_digest_emails_total',
    help: 'Total de emails de digest semanal por resultado.',
    labelNames: ['result'],
  }),
  makeHistogramProvider({
    name: 'community_digest_run_duration_seconds',
    help: 'Duración (s) de cada ejecución del job de digest.',
    buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  }),
  makeCounterProvider({
    name: 'community_digest_users_processed_total',
    help: 'Usuarios procesados por el job (cualquier resultado).',
  }),
];
