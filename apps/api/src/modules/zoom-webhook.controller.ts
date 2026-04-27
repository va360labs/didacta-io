import {
  BadRequestException,
  Controller,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { verifyZoomSignature, webhookEventSchema } from '@didacta/mod-zoom-live';
import type { FastifyRequest } from 'fastify';
import { ModuleRegistryService } from './module-registry.service';

/**
 * Endpoint público de webhooks de Zoom. NO usa JwtAuthGuard porque Zoom
 * no manda bearer token; la autenticación es por firma HMAC del body
 * con un secret compartido (`ZOOM_WEBHOOK_SECRET` en env).
 *
 * Zoom espera 2xx en menos de 3s o reintenta hasta 3 veces. La idempotencia
 * la garantiza `mod_zoom_webhook_event.event_id` UNIQUE en DB.
 *
 * `validation` event (Zoom envía esto cuando configurás el endpoint en su
 * panel) responde con `{ plainToken, encryptedToken }` para handshake.
 */
@ApiTags('Webhooks · Zoom')
@Controller('webhooks/zoom')
export class ZoomWebhookController {
  constructor(private readonly registry: ModuleRegistryService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Recibe eventos webhook de Zoom (meeting.started/.ended). Verifica HMAC del body y aplica el cambio de status.',
  })
  async handle(@Req() req: RawBodyRequest<FastifyRequest>) {
    const secret = process.env['ZOOM_WEBHOOK_SECRET'];
    if (!secret) {
      // Sin secret no hay forma segura de procesar; respondemos 401 en vez
      // de aceptar todo (sería un agujero de seguridad si el deploy lo
      // olvida). Los tests usan un secret de fixtures.
      throw new UnauthorizedException('ZOOM_WEBHOOK_SECRET no configurado.');
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

    const outcome = await this.registry.getZoomLiveService().handleWebhookEvent(result.data);
    return outcome;
  }
}

function readHeader(headers: FastifyRequest['headers'], key: string): string | undefined {
  const v = headers[key];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' ? v : undefined;
}
