/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
  Controller,
  ForbiddenException,
  HttpCode,
  NotFoundException,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import {
  buildUrlValidationResponse,
  verifyZoomSignature,
  webhookEventSchema,
} from '@didacta/mod-zoom-live';
import type { FastifyRequest } from 'fastify';
import { extractClientContext } from '../../auth/client-context';
import {
  runAsTenant,
  runGlobalWithoutTenant,
  runSanctionedGlobalAccess,
} from '../../tenancy/tenant-context.storage';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { ModuleRegistryService } from '../module-registry.service';
import { PrismaAuditLogService } from '../prisma-audit-log.service';
import { reportForeignTenantWebhook, sameSecret } from '../webhook-foreign-tenant';
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
 * ⚠️ El tenant del dominio —el dueño del secreto que verificó la firma— es
 * PARA EL QUE SE PROCESA el evento. Antes el procesado resolvía el tenant por
 * `zoomMeetingId` y «el tenant por host solo decidía qué secret probar»: como
 * el id de la reunión lo escribe quien firma, el admin de un aula firmaba con
 * SU secreto un aviso con el id de una clase de otra y le cambiaba el estado,
 * le lanzaba la encuesta post-clase o le colgaba como grabación un enlace suyo.
 * Los ids de reunión no son secretos: los ve cualquier alumno del aula.
 *
 * Única excepción: si la reunión es de OTRO tenant que tiene configurado
 * exactamente el MISMO secreto de webhook (la misma app de Zoom repartida entre
 * varias aulas del mismo dueño, con una sola URL de webhook), el evento es
 * legítimo y se procesa para el dueño de la reunión. Un atacante no puede
 * fabricar esa coincidencia sin conocer el secreto de la víctima.
 *
 * Zoom espera 2xx en menos de 3s o reintenta hasta 3 veces. La idempotencia
 * la garantiza `mod_zoom_live_webhook_event.event_id` UNIQUE en DB, con una
 * clave que el módulo deriva del contenido del aviso (`webhookEventKey`): Zoom
 * no manda `event_id` en el cuerpo, así que no se le puede exigir.
 */
@ApiTags('Webhooks · Zoom')
@Controller('webhooks/zoom')
export class ZoomWebhookController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly tenantResolver: TenantResolverService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly logger: PinoLogger,
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

    const secret = await runAsTenant(tenant.id, () => zoomLive.getWebhookSecret(tenant.id));
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
      return buildUrlValidationResponse(plainToken, secret);
    }

    const result = webhookEventSchema.safeParse(parsed);
    if (!result.success) {
      // No es un evento que entendamos: respondemos 200 igual para que Zoom
      // no reintente, pero no aplicamos nada.
      return { result: 'IGNORED', reason: 'unknown_payload_shape' };
    }

    // 1) LOOKUP (sancionado, fuera de cualquier contexto de tenant): de qué
    //    tenant es la reunión que nombra el aviso. Solo lee.
    const ownerTenantId = await runGlobalWithoutTenant(() =>
      zoomLive.resolveWebhookTenantId(result.data),
    );
    // 2) DECISIÓN: el aviso se procesa para el tenant cuyo secreto verificó la
    //    firma. Si la reunión es de otro, solo pasa cuando ese otro tiene el
    //    MISMO secreto (app de Zoom compartida); si no, 403 + rastro, antes de
    //    archivar el aviso siquiera.
    let tenantId = tenant.id;
    if (ownerTenantId && ownerTenantId !== tenant.id) {
      const ownerSecret = await runAsTenant(ownerTenantId, () =>
        zoomLive.getWebhookSecret(ownerTenantId),
      ).catch(() => null);
      if (!ownerSecret || !sameSecret(ownerSecret, secret)) {
        await reportForeignTenantWebhook({
          provider: 'zoom',
          code: 'ZOOM_WEBHOOK_FOREIGN_TENANT',
          verifiedTenantId: tenant.id,
          claimedTenantIds: [ownerTenantId],
          eventId: result.data.event_id ?? String(result.data.event_ts ?? ''),
          eventType: result.data.event,
          extra: { meetingId: String(result.data.payload?.object?.id ?? '').slice(0, 64) },
          audit: (entry) => this.auditLog.record(entry),
          logger: this.logger,
          host: hostStr,
          client: extractClientContext(req),
        });
        throw new ForbiddenException({
          message: 'Este webhook solo acepta avisos del aula a la que pertenece este dominio.',
          code: 'ZOOM_WEBHOOK_FOREIGN_TENANT',
        });
      }
      tenantId = ownerTenantId;
    }
    // 3) PROCESADO: siempre bajo el contexto de ESE tenant (nunca sancionado:
    //    un aviso de una reunión desconocida se archiva en el del dominio) y
    //    diciéndole al módulo cuál es, para que solo mire sus clases.
    const outcome = await runAsTenant(
      tenantId,
      () => zoomLive.handleWebhookEvent(result.data, { rawBody, tenantId }),
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
