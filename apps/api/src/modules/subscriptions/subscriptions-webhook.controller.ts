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
import type Stripe from 'stripe';
import type { FastifyRequest } from 'fastify';
import { extractClientContext } from '../../auth/client-context';
import { resolveWebBaseUrl } from '../../common/resolve-web-base-url';
import { ModuleRegistryService } from '../module-registry.service';
import { MembershipProvisioningService } from './membership-provisioning.service';

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
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly provisioning: MembershipProvisioningService,
  ) {}

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

    // Fulfillment de MEMBRESÍA: el checkout completado materializa al
    // comprador (find-or-create user + bienvenida con enlace mágico) y crea la
    // suscripción local. Idempotente por stripeSubscriptionId — un retry de
    // Stripe no duplica user ni sub. Va DESPUÉS de handleWebhookEvent (que
    // persiste el evento para auditoría) y es independiente de su dedupe.
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const ctx = extractClientContext(req);
      const webBaseUrl = resolveWebBaseUrl(req);
      await this.registry
        .getMembershipService()
        .fulfillMembershipCheckout(session, ({ tenantId, email, name }) =>
          this.provisioning.provision({ tenantId, email, name, webBaseUrl, ctx }),
        );
    }

    return { received: true, type: event.type, id: event.id };
  }
}

function readHeader(headers: FastifyRequest['headers'], key: string): string | undefined {
  const v = headers[key];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' ? v : undefined;
}
