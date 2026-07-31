/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Logger } from '@nestjs/common';
import type { RlsGap } from './rls-enforcement.extension';

/**
 * Contador de huecos de contexto de tenant detectados por la extensión RLS.
 *
 * Cada firma `Modelo.operación` se loguea UNA vez (warn en modo warn, error en
 * modo on) y se sigue contando: el snapshot es el worklist de la fase 2 —
 * llevarlo a cero es la condición para el flip a `didacta_app`.
 */
export class RlsGapTelemetry {
  private readonly logger = new Logger('RlsEnforcement');
  private readonly counts = new Map<string, number>();

  constructor(private readonly mode: 'warn' | 'on') {}

  record(gap: RlsGap): void {
    const key = `${gap.model}.${gap.operation}`;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    if (n === 1) {
      const msg =
        `Query sin contexto de tenant: ${key} — ` +
        `operación fuera de withTenant/withTenantId/asAdmin (worklist RLS F2).`;
      if (this.mode === 'on') {
        this.logger.error(msg);
      } else {
        this.logger.warn(msg);
      }
    }
  }

  /** Firmas detectadas y cuántas veces se vieron. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}
