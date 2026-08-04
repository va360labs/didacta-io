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
import { WebhookSignatureInvalidError } from '@didacta/mod-billing';
import type { FastifyRequest } from 'fastify';
import { extractClientContext } from '../../auth/client-context';
import {
  runAsTenantOrSanctioned,
  runSanctionedGlobalAccess,
} from '../../tenancy/tenant-context.storage';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { ModuleRegistryService } from '../module-registry.service';
import { BillingProvisioningService } from './billing-provisioning.service';

/**
 * Endpoint público de webhooks de Stripe. NO usa JwtAuthGuard porque Stripe
 * no envía bearer; la autenticación es por firma HMAC del raw body con el
 * secret `STRIPE_WEBHOOK_SECRET`. La idempotencia la garantiza la PK natural
 * `stripe_event_id` en `mod_billing_webhook_event`.
 *
 * Stripe espera 2xx en menos de 30s o reintenta hasta 3 días. El handler
 * persiste el evento ANTES de procesar, así que un timeout intermedio no
 * causa duplicación: la siguiente entrega encuentra el row y skip silencioso.
 */
@ApiTags('Webhooks · Billing')
@Controller('modules/billing')
export class BillingWebhookController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly provisioning: BillingProvisioningService,
    private readonly tenantResolver: TenantResolverService,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Recibe eventos webhook de Stripe (checkout.session.completed/expired, charge.refunded). Verifica firma HMAC, persiste con idempotencia y procesa.',
  })
  async handle(@Req() req: RawBodyRequest<FastifyRequest>) {
    const billing = this.registry.getBillingService();
    const stripe = this.registry.getStripeAdapter();

    const signature = readHeader(req.headers, 'stripe-signature');
    if (!signature) throw new UnauthorizedException('stripe-signature ausente.');
    const rawBody = req.rawBody?.toString('utf8') ?? '';
    if (!rawBody) throw new BadRequestException('Body raw vacío — Stripe siempre envía payload.');

    let event;
    try {
      event = stripe.constructWebhookEvent(rawBody, signature);
    } catch (err) {
      // El filter mapea WebhookSignatureInvalidError → 401. Pero el
      // controlador puede recibir otros errores de Stripe (parser SDK).
      if (err instanceof WebhookSignatureInvalidError) throw err;
      throw new UnauthorizedException(`Firma del webhook inválida: ${(err as Error).message}`);
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = { raw: rawBody };
    }

    // Provisioner del checkout PÚBLICO: si la order completada no tiene dueño
    // (comprador anónimo), el fulfillment materializa la cuenta con el email
    // confirmado en Stripe y envía la bienvenida con el enlace de contraseña.
    const ctx = extractClientContext(req);
    // RLS F3: lookup sancionado (metadata / order por id global) + procesado
    // bajo el contexto del tenant resuelto. Sin tenant (evento ajeno) el
    // procesado degrada a sancionado: solo archiva para auditoría.
    const tenantId = await runSanctionedGlobalAccess(() => billing.resolveWebhookTenantId(event));
    // El Host de este request es el de la API (Stripe), no el del frontend
    // del tenant — con el tenant ya resuelto, preferimos su dominio primario.
    const webBaseUrl = await this.tenantResolver.resolveTenantWebBaseUrl(tenantId, req);
    await runAsTenantOrSanctioned(
      tenantId,
      () =>
        billing.handleWebhookEvent(event, parsedBody, {
          provisionUser: ({ tenantId: provisionTenantId, email, name }) =>
            this.provisioning.provision({
              tenantId: provisionTenantId,
              email,
              name,
              webBaseUrl,
              ctx,
            }),
        }),
      { traceLabel: 'billing-webhook' },
    );
    return { received: true, type: event.type, id: event.id };
  }
}

function readHeader(headers: FastifyRequest['headers'], key: string): string | undefined {
  const v = headers[key];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' ? v : undefined;
}
