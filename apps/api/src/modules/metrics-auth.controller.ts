/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Controller, Get, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrometheusController } from '@willsoto/nestjs-prometheus';
import type { FastifyRequest } from 'fastify';

/**
 * Controller custom de `/metrics` con auth opcional por bearer token.
 *
 * - Si `METRICS_TOKEN` está set en env: requiere `Authorization: Bearer <token>`.
 *   Diseñado para deploys donde la API queda expuesta a Internet (sin reverse
 *   proxy interno restringiendo `/metrics`). El default metrics de prom-client
 *   incluye memoria/GC/event loop, info útil para un atacante.
 * - Si `METRICS_TOKEN` NO está set: comportamiento público anterior. Backward
 *   compatible con Easypanel + reverse proxy interno (escenario habitual).
 *
 * El check se hace timing-safe (longitud + comparación caracter a caracter
 * via `crypto.timingSafeEqual`) para evitar timing attacks. La comparación
 * solo se ejecuta si ambos buffers tienen la misma longitud.
 */
@ApiTags('Health · Metrics')
@Controller('metrics')
export class MetricsAuthController extends PrometheusController {
  @Get()
  @ApiOperation({
    summary:
      'Métricas Prometheus en formato OpenMetrics. Si METRICS_TOKEN está configurado, requiere Bearer token.',
  })
  override async index(
    @Res({ passthrough: false }) response: unknown,
    @Req() request?: FastifyRequest,
  ): Promise<string> {
    const expected = process.env['METRICS_TOKEN'];
    if (expected && expected.length > 0) {
      const header = request?.headers['authorization'];
      const provided =
        typeof header === 'string' && header.startsWith('Bearer ')
          ? header.slice('Bearer '.length).trim()
          : null;
      if (!provided || !timingSafeStringEqual(provided, expected)) {
        throw new UnauthorizedException('Token de /metrics requerido o inválido.');
      }
    }
    return super.index(response);
  }
}

function timingSafeStringEqual(a: string, b: string): boolean {
  // Para evitar comparaciones tempranas filtradas por length, hacemos la
  // operación en buffers del mismo tamaño y luego comparamos el length.
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  // Imports tardíos para no añadir runtime cost si no se usa.
  const { timingSafeEqual } = require('node:crypto') as typeof import('node:crypto');
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}
