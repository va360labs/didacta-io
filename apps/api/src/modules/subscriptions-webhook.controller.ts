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
import { WebhookSignatureInvalidError } from '@didacta/mod-subscriptions';
import type { FastifyRequest } from 'fastify';
import { ModuleRegistryService } from './module-registry.service';

/**
 * Endpoint público de webhooks de Stripe específico de mod.subscriptions.
 * Misma defensa HMAC que mod.billing webhook pero con su propio
 * STRIPE_WEBHOOK_SECRET (puede ser distinto al de billing — Stripe permite
 * múltiples endpoints firmados con distintos secrets).
 *
 * Idempotencia: PK natural `stripe_event_id` en `mod_subscriptions_webhook_event`.
 */
@ApiTags('Webhooks · Subscriptions')
@Controller('modules/subscriptions')
export class SubscriptionsWebhookController {
  constructor(private readonly registry: ModuleRegistryService) {}

  @Post('webhook')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Recibe eventos webhook de Stripe (customer.subscription.*, invoice.*). Verifica firma HMAC, persiste con idempotencia y procesa.',
  })
  async handle(@Req() req: RawBodyRequest<FastifyRequest>) {
    const subs = this.registry.getSubscriptionsService();
    const stripe = this.registry.getSubscriptionsStripeAdapter();

    const signature = readHeader(req.headers, 'stripe-signature');
    if (!signature) throw new UnauthorizedException('stripe-signature ausente.');
    const rawBody = req.rawBody?.toString('utf8') ?? '';
    if (!rawBody) throw new BadRequestException('Body raw vacío — Stripe siempre envía payload.');

    let event;
    try {
      event = stripe.constructWebhookEvent(rawBody, signature);
    } catch (err) {
      if (err instanceof WebhookSignatureInvalidError) throw err;
      throw new UnauthorizedException(`Firma del webhook inválida: ${(err as Error).message}`);
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = { raw: rawBody };
    }

    await subs.handleWebhookEvent(event, parsedBody);
    return { received: true, type: event.type, id: event.id };
  }
}

function readHeader(headers: FastifyRequest['headers'], key: string): string | undefined {
  const v = headers[key];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' ? v : undefined;
}
