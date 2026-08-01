/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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
import { Logger as PinoLogger } from 'nestjs-pino';
import { WebhookSignatureInvalidError } from '@didacta/mod-subscriptions';
import type Stripe from 'stripe';
import type { FastifyRequest } from 'fastify';
import { extractClientContext } from '../../auth/client-context';
import type { ClientContext } from '../../auth/client-context';
import { resolveWebBaseUrl } from '../../common/resolve-web-base-url';
import { BillingProvisioningService } from '../billing/billing-provisioning.service';
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
    private readonly billingProvisioning: BillingProvisioningService,
    private readonly logger: PinoLogger,
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
    const ctx = extractClientContext(req);
    const webBaseUrl = resolveWebBaseUrl(req);
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      await this.registry
        .getMembershipService()
        .fulfillMembershipCheckout(session, ({ tenantId, email, name }) =>
          this.provisioning.provision({ tenantId, email, name, webBaseUrl, ctx }),
        );
    }

    // FAN-OUT a mod.billing (compra de curso suelto). Una sola cuenta de Stripe
    // alimenta los dos módulos, así que un ÚNICO endpoint de webhook puede
    // servir a ambos: el evento ya viene verificado con el mismo secreto de
    // firma, y cada módulo procesa solo lo suyo (la membresía descarta las
    // sesiones sin `membership:'1'`; billing, las que no llevan `courseId`).
    // Best-effort: un fallo de billing NO puede tumbar el fulfillment de la
    // membresía ya hecho arriba, ni provocar que Stripe reintente el evento
    // durante días. Queda registrado en `mod_billing_webhook_event`.
    await this.dispatchToBilling(event, parsedBody, webBaseUrl, ctx);

    return { received: true, type: event.type, id: event.id };
  }

  private async dispatchToBilling(
    event: Stripe.Event,
    parsedBody: unknown,
    webBaseUrl: string,
    ctx: ClientContext,
  ): Promise<void> {
    let billing: ReturnType<ModuleRegistryService['getBillingService']>;
    try {
      billing = this.registry.getBillingService();
    } catch {
      return; // mod.billing sin configurar en esta instancia: nada que hacer.
    }
    try {
      // Mismo provisioner que el endpoint propio de billing: una compra
      // ANÓNIMA de curso puede entrar por este webhook compartido.
      await billing.handleWebhookEvent(event, parsedBody, {
        provisionUser: ({ tenantId, email, name }) =>
          this.billingProvisioning.provision({ tenantId, email, name, webBaseUrl, ctx }),
      });
    } catch (err) {
      // Si el evento ERA de una compra de curso, propagamos: Stripe verá un
      // 5xx y reintentará, que es la única red de seguridad que evita cobrar
      // sin dar acceso. Es seguro reintentar todo el handler porque el trabajo
      // de la membresía ya hecho arriba es idempotente (dedupe por evento y
      // por stripeSubscriptionId).
      // Si el evento NO era nuestro, lo tragamos: un fallo procesando algo
      // ajeno no puede hacer que Stripe reintente en bucle un evento de
      // membresía que sí se completó.
      if (isCoursePurchaseEvent(event)) {
        this.logger.error(
          { err, eventId: event.id, type: event.type },
          'stripe webhook: fallo procesando una COMPRA DE CURSO — devolvemos 5xx para que Stripe reintente',
        );
        throw err;
      }
      this.logger.warn(
        { err, eventId: event.id, type: event.type },
        'stripe webhook: mod.billing no pudo procesar un evento ajeno (no bloqueante)',
      );
    }
  }
}

/**
 * ¿Este evento pertenece a una compra de curso de mod.billing? Se reconoce por
 * la marca que escribe su checkout (`orderId` + `productId` en la metadata).
 * Misma comprobación positiva que hace el propio servicio de billing.
 */
function isCoursePurchaseEvent(event: Stripe.Event): boolean {
  const obj = event.data?.object as { metadata?: Record<string, string> } | undefined;
  const meta = obj?.metadata ?? {};
  return Boolean(meta['orderId'] && meta['productId']);
}

function readHeader(headers: FastifyRequest['headers'], key: string): string | undefined {
  const v = headers[key];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' ? v : undefined;
}
