/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
  Controller,
  HttpCode,
  NotFoundException,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { verifyZoomSignature, webhookEventSchema } from '@didacta/mod-zoom-live';
import type { FastifyRequest } from 'fastify';
import {
  runAsTenantOrSanctioned,
  runSanctionedGlobalAccess,
} from '../../tenancy/tenant-context.storage';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { ModuleRegistryService } from '../module-registry.service';
import { resolvePublicHost } from '../../common/resolve-public-host';

/**
 * Endpoint público de webhooks de Zoom. NO usa JwtAuthGuard porque Zoom
 * no manda bearer token; la autenticación es por firma HMAC del body con el
 * `webhookSecret` de CADA tenant (`tenant_setting` scope `zoom-live` key
 * `credentials`, junto a sus credenciales S2S — antes vivía en el env global
 * `ZOOM_WEBHOOK_SECRET`, compartido por todos los tenants sin motivo real).
 *
 * Cada tenant configura la URL de su webhook en su propia app de Zoom
 * apuntando a SU dominio verificado (`https://mi-academia.com/api/v1/webhooks/zoom`),
 * igual que ya hace `billing-public.controller.ts` para el checkout anónimo.
 * Eso es lo que nos permite saber, ANTES de leer ningún secret, a qué tenant
 * pertenece la llamada — necesario tanto para el handshake de validación de
 * Zoom (que no lleva ningún id de reunión, no hay otra forma de resolver el
 * tenant ahí) como para elegir qué secret usar al verificar la firma.
 *
 * El procesado real del evento (una vez la firma verificó) sigue resolviendo
 * el tenant por `zoomMeetingId` como antes — es la fuente de verdad de a
 * quién pertenece la reunión; el tenant por host solo decide qué secret
 * probar.
 *
 * Zoom espera 2xx en menos de 3s o reintenta hasta 3 veces. La idempotencia
 * la garantiza `mod_zoom_live_webhook_event.event_id` UNIQUE en DB.
 */
@ApiTags('Webhooks · Zoom')
@Controller('webhooks/zoom')
export class ZoomWebhookController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly tenantResolver: TenantResolverService,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Recibe eventos webhook de Zoom (meeting.started/.ended). Verifica HMAC del body (secret per-tenant) y aplica el cambio de status.',
  })
  async handle(@Req() req: RawBodyRequest<FastifyRequest>) {
    const zoomLive = this.registry.getZoomLiveService();

    const hostStr = resolvePublicHost(req);
    const tenant = await runSanctionedGlobalAccess(() =>
      this.tenantResolver.resolveByHost(hostStr),
    );
    if (!tenant) {
      throw new NotFoundException('No se reconoce el dominio de este webhook.');
    }

    const secret = await runAsTenantOrSanctioned(tenant.id, () =>
      zoomLive.getWebhookSecret(tenant.id),
    );
    if (!secret) {
      // Sin secret configurado para este tenant no hay forma segura de
      // procesar; 401 en vez de aceptar todo (sería un agujero de seguridad
      // si el admin todavía no configuró el webhook secret).
      throw new UnauthorizedException('Webhook de Zoom no configurado para este tenant.');
    }

    const headers = req.headers;
    const signatureHeader = readHeader(headers, 'x-zm-signature');
    const timestampHeader = readHeader(headers, 'x-zm-request-timestamp');
    const rawBody = req.rawBody?.toString('utf8') ?? '';

    if (
      !verifyZoomSignature({
        signatureHeader,
        timestampHeader,
        rawBody,
        secret,
      })
    ) {
      throw new UnauthorizedException('Firma de webhook inválida.');
    }

    let parsed: unknown;
    try {
      parsed = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      throw new BadRequestException('Body no es JSON válido.');
    }

    // URL validation handshake: Zoom envía `event = endpoint.url_validation`
    // con `payload.plainToken` y espera `{ plainToken, encryptedToken }`.
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { event?: string }).event === 'endpoint.url_validation'
    ) {
      const plainToken = (parsed as { payload?: { plainToken?: string } }).payload?.plainToken;
      if (!plainToken) throw new BadRequestException('plainToken requerido para validation.');
      const { createHmac } = await import('node:crypto');
      const encryptedToken = createHmac('sha256', secret).update(plainToken).digest('hex');
      return { plainToken, encryptedToken };
    }

    const result = webhookEventSchema.safeParse(parsed);
    if (!result.success) {
      // No es un evento que entendamos: respondemos 200 igual para que Zoom
      // no reintente, pero no aplicamos nada.
      return { result: 'IGNORED', reason: 'unknown_payload_shape' };
    }

    // RLS F3: lookup sancionado (sesión por zoomMeetingId, cross-tenant) +
    // procesado bajo el contexto del tenant resuelto. Sin sesión local el
    // procesado degrada a sancionado: solo archiva el evento como IGNORED.
    // (Nota: puede diferir del tenant resuelto por host arriba si la key S2S
    // se comparte entre dominios — el dueño real de la reunión manda.)
    const tenantId = await runSanctionedGlobalAccess(() =>
      zoomLive.resolveWebhookTenantId(result.data),
    );
    const outcome = await runAsTenantOrSanctioned(
      tenantId,
      () => zoomLive.handleWebhookEvent(result.data),
      { traceLabel: 'zoom-webhook' },
    );
    return outcome;
  }
}

function readHeader(headers: FastifyRequest['headers'], key: string): string | undefined {
  const v = headers[key];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' ? v : undefined;
}
