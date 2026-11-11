/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Controller, Get, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrometheusController } from '@willsoto/nestjs-prometheus';
import type { FastifyRequest } from 'fastify';

/**
 * Controller custom de `/metrics` con auth por bearer token.
 *
 * - Si `METRICS_TOKEN` está set en env: requiere `Authorization: Bearer <token>`.
 *   Diseñado para deploys donde la API queda expuesta a Internet (sin reverse
 *   proxy interno restringiendo `/metrics`). El default metrics de prom-client
 *   incluye memoria/GC/event loop, info útil para un atacante.
 * - Si `METRICS_TOKEN` NO está set:
 *   - en producción (`NODE_ENV=production`, que es lo que fija la imagen
 *     Docker) responde 401. Antes quedaba público: memoria, GC, event loop y
 *     los contadores de outbox, digest y jobs de módulos para cualquiera que
 *     alcanzase la API. Que un proxy lo tape no se puede comprobar desde aquí,
 *     así que el valor por defecto tiene que ser el cerrado;
 *   - fuera de producción sigue siendo público (desarrollo y tests locales).
 *
 * No hay variable para volver a abrirlo sin token a propósito: quien scrapea
 * desde una red interna define `METRICS_TOKEN` y se lo pasa a Prometheus
 * (`authorization.credentials`), que es una línea en cada lado.
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
      'Métricas Prometheus en formato OpenMetrics. Requiere Bearer METRICS_TOKEN si está configurado, y siempre en producción.',
  })
  override async index(
    @Res({ passthrough: false }) response: unknown,
    @Req() request?: FastifyRequest,
  ): Promise<string> {
    const expected = process.env['METRICS_TOKEN'];
    if (!expected && process.env['NODE_ENV'] === 'production') {
      // El mensaje dice qué hacer: quien se lo encuentra tras actualizar es un
      // operador mirando por qué su scraper ha dejado de recibir datos.
      throw new UnauthorizedException(
        'En producción /metrics exige METRICS_TOKEN: defínelo en el entorno de la API y envíalo como Bearer.',
      );
    }
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { timingSafeEqual } = require('node:crypto') as typeof import('node:crypto');
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}
