/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { ModuleRegistryService } from '../module-registry.service';
import { verifyUnsubscribeToken } from './broadcast-unsubscribe';

/**
 * Endpoints PÚBLICOS de comunidad (sin JwtAuthGuard). Hoy solo la baja de avisos
 * masivos, que se abre desde el enlace de un email — el destinatario no tiene por
 * qué estar logueado. La autorización va en el TOKEN firmado del enlace.
 */
@ApiTags('Modules · Community (public)')
@Controller('modules/community')
export class CommunityPublicController {
  constructor(private readonly registry: ModuleRegistryService) {}

  @Get('unsubscribe')
  @ApiOperation({ summary: 'Baja de avisos masivos vía token firmado (enlace del email).' })
  async unsubscribe(@Query('token') token: string | undefined, @Res() reply: FastifyReply) {
    const parsed = token ? verifyUnsubscribeToken(token) : null;
    if (!parsed) {
      reply
        .status(400)
        .header('content-type', 'text/html; charset=utf-8')
        .send(page('Enlace no válido', 'El enlace de baja no es válido.'));
      return;
    }
    try {
      await this.registry
        .getCommunityService()
        .setBroadcastOptOut(parsed.tenantId, parsed.userId, true);
    } catch {
      reply
        .status(500)
        .header('content-type', 'text/html; charset=utf-8')
        .send(page('Error', 'No pudimos procesar tu baja. Inténtalo más tarde.'));
      return;
    }
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .send(
        page(
          'Te has dado de baja',
          'Ya no recibirás más avisos masivos de la comunidad. Puedes reactivarlos desde tus preferencias en la app.',
        ),
      );
  }
}

function page(title: string, message: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (
    `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>` +
    `<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;margin:0;padding:40px 16px;color:#0d1b2a">` +
    `<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:32px;text-align:center">` +
    `<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>` +
    `<p style="color:#475569;line-height:1.6;margin:0">${esc(message)}</p></div></body></html>`
  );
}
