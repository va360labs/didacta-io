/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import {
  InjectMetric,
  makeCounterProvider,
  makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';
import { Counter, Histogram } from 'prom-client';

/**
 * Métricas Prometheus del worker de mod-jobs (Sprint 3 / JR-002).
 *
 *  - `didacta_mod_jobs_ticks_total{module, status}` (counter): cada
 *    tick procesado por el worker, etiquetado por módulo y resultado:
 *      - `continue`     → el handler retornó { status: 'continue' }
 *      - `completed`    → el handler retornó { status: 'completed' }
 *      - `failed`       → el handler retornó { status: 'failed' }
 *      - `timeout`      → el handler superó los 5 min y se re-encoló
 *      - `error`        → el handler lanzó excepción
 *      - `unregistered` → el job llegó al worker pero no hay handler
 *                         (módulo desinstalado mientras estaba encolado)
 *
 *  - `didacta_mod_jobs_tick_duration_seconds{module}` (histogram):
 *    duración de cada tick (incluye timeouts y errores). Útil para
 *    detectar handlers lentos antes de que rocen el cap de 5 min.
 */
@Injectable()
export class ModJobsMetrics {
  constructor(
    @InjectMetric('didacta_mod_jobs_ticks_total')
    private readonly ticksCounter: Counter<'module' | 'status'>,
    @InjectMetric('didacta_mod_jobs_tick_duration_seconds')
    private readonly tickDuration: Histogram<'module'>,
  ) {}

  recordTick(
    moduleName: string,
    status: 'continue' | 'completed' | 'failed' | 'timeout' | 'error' | 'unregistered',
  ): void {
    this.ticksCounter.inc({ module: moduleName, status });
  }

  recordTickDuration(moduleName: string, seconds: number): void {
    this.tickDuration.observe({ module: moduleName }, seconds);
  }
}

export const modJobsMetricsProviders = [
  makeCounterProvider({
    name: 'didacta_mod_jobs_ticks_total',
    help: 'Total de ticks de onJobTick procesados por el worker, etiquetados por módulo y resultado.',
    labelNames: ['module', 'status'],
  }),
  makeHistogramProvider({
    name: 'didacta_mod_jobs_tick_duration_seconds',
    help: 'Duración (s) de cada tick de onJobTick. Incluye timeouts y errores.',
    labelNames: ['module'],
    // Buckets pensados para jobs largos: hasta 5 min (cap del worker).
    // Los buckets bajos (50ms-1s) sirven para detectar handlers triviales
    // que siempre devuelven `continue` sin trabajo real (anti-pattern).
    buckets: [0.05, 0.5, 1, 5, 10, 30, 60, 120, 300],
  }),
];
