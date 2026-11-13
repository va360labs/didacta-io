/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
  Controller,
  HttpCode,
  NotFoundException,
  Optional,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import {
  SubscriptionsStripeSdkAdapter,
  WebhookSignatureInvalidError,
} from '@didacta/mod-subscriptions';
import type { FastifyRequest } from 'fastify';
import { extractClientContext } from '../../auth/client-context';
import { runAsTenant, runSanctionedGlobalAccess } from '../../tenancy/tenant-context.storage';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { BillingProvisioningService } from '../billing/billing-provisioning.service';
import { ModuleRegistryService } from '../module-registry.service';
import { PlatformObjectGuard } from '../payouts/platform-object-guard';
import { PrismaAuditLogService } from '../prisma-audit-log.service';
import { collectStripeEventClaims, dispatchStripeEventToAll } from '../stripe-event-dispatch';
import { PurchaseConsentService } from '../purchase-consent/purchase-consent.service';
import { resolveStripeEventTenant } from '../stripe-webhook-tenant';
import { TenantStripeResolverService } from '../tenant-stripe-resolver.service';
import { MembershipProvisioningService } from './membership-provisioning.service';
import { resolvePublicHost } from '../../common/resolve-public-host';

/**
 * Endpoint público de webhooks de Stripe específico de mod.subscriptions.
 * Misma defensa HMAC que mod.billing webhook (tenant por Host → credenciales
 * de ESE tenant, Administración → Pagos, con fallback a las envs de
 * instancia) pero con su propio `subscriptionsWebhookSecret` (puede ser
 * distinto al de billing — Stripe permite múltiples endpoints firmados con
 * distintos secrets).
 *
 * Idempotencia: PK natural `stripe_event_id` en `mod_subscriptions_webhook_event`.
 *
 * ⚠️ El tenant del dominio —el dueño del secreto que verificó la firma— es PARA
 * EL QUE SE PROCESA el evento, en los tres consumidores (suscripciones,
 * membresía y el fan-out a billing). Lo que el evento diga de sí mismo
 * (`metadata.tenantId`, ids de suscripción o de factura) lo escribe quien firma
 * y no decide nada: si nombra a otra aula se rechaza con 403 sin tocar nada.
 * Ver `stripe-webhook-tenant.ts`.
 */
@ApiTags('Webhooks · Subscriptions')
@Controller('modules/subscriptions')
export class SubscriptionsWebhookController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly provisioning: MembershipProvisioningService,
    private readonly billingProvisioning: BillingProvisioningService,
    private readonly logger: PinoLogger,
    private readonly tenantResolver: TenantResolverService,
    private readonly stripeResolver: TenantStripeResolverService,
    private readonly auditLog: PrismaAuditLogService,
    /**
     * Solo existe con el modo plataforma encendido (lo provee `PayoutsModule`,
     * global en ese modo). Sin él, este endpoint es el de siempre.
     */
    @Optional() private readonly platformObjects?: PlatformObjectGuard,
    /**
     * Confirmación por correo de la compra con la casilla aceptada (renuncia al
     * desistimiento). Opcional solo para los tests que montan el controlador
     * a mano; en la aplicación siempre está (módulo global).
     */
    @Optional() private readonly consents?: PurchaseConsentService,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Recibe eventos webhook de Stripe (customer.subscription.*, invoice.*). Verifica firma HMAC, persiste con idempotencia y procesa.',
  })
  async handle(@Req() req: RawBodyRequest<FastifyRequest>) {
    const subs = this.registry.getSubscriptionsService();

    const hostStr = resolvePublicHost(req);
    const tenant = await runSanctionedGlobalAccess(() =>
      this.tenantResolver.resolveByHost(hostStr),
    );
    if (!tenant) {
      throw new NotFoundException({
        message: 'No se reconoce el dominio de este webhook.',
        code: 'SUBS_WEBHOOK_UNKNOWN_DOMAIN',
      });
    }

    const resolved = await runAsTenant(tenant.id, () => this.stripeResolver.resolve(tenant.id));
    if (!resolved) {
      throw new UnauthorizedException({
        message: 'Stripe no está configurado para este tenant.',
        code: 'SUBS_STRIPE_NOT_CONFIGURED',
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const StripeCtor = require('stripe').default ?? require('stripe');
    const stripe = new SubscriptionsStripeSdkAdapter(
      resolved.credentials.secretKey,
      resolved.credentials.subscriptionsWebhookSecret || resolved.credentials.webhookSecret,
      StripeCtor,
    );

    const signature = readHeader(req.headers, 'stripe-signature');
    if (!signature)
      throw new UnauthorizedException({
        message: 'stripe-signature ausente.',
        code: 'SUBS_WEBHOOK_SIGNATURE_MISSING',
      });
    const rawBody = req.rawBody?.toString('utf8') ?? '';
    if (!rawBody)
      throw new BadRequestException({
        message: 'Body raw vacío — Stripe siempre envía payload.',
        code: 'SUBS_WEBHOOK_EMPTY_BODY',
      });

    let event;
    try {
      event = stripe.constructWebhookEvent(rawBody, signature);
    } catch (err) {
      if (err instanceof WebhookSignatureInvalidError) throw err;
      // Ídem `BILLING_WEBHOOK_SIGNATURE_REJECTED`: el diagnóstico del SDK de
      // Stripe viaja aparte del `message`.
      const detail = (err as Error).message;
      throw new UnauthorizedException({
        message: `Firma del webhook inválida: ${detail}`,
        code: 'SUBS_WEBHOOK_SIGNATURE_REJECTED',
        detail,
      });
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = { raw: rawBody };
    }

    const ctx = extractClientContext(req);
    const consumers = {
      subscriptions: subs,
      membership: this.registry.getMembershipService(),
      billing: this.registry.getBillingService(),
    };

    // 1) LOOKUP (sancionado, fuera de cualquier contexto de tenant): a qué
    //    tenants nombra o toca el evento, sumando los TRES consumidores que lo
    //    van a procesar aquí abajo. Solo lee.
    const claims = await collectStripeEventClaims(event, consumers);
    const platformObjects = this.platformObjects;
    // 2) DECISIÓN: el evento se procesa para el tenant cuyo secreto verificó la
    //    firma. Si nombra a otro, 403 + rastro, y aquí se acaba — antes de
    //    archivar el evento siquiera.
    const tenantId = await resolveStripeEventTenant({
      endpoint: 'subscriptions',
      errorCode: 'SUBS_WEBHOOK_FOREIGN_TENANT',
      verifiedTenantId: tenant.id,
      verified: resolved,
      claims,
      event,
      resolveCredentials: (id) => this.stripeResolver.resolve(id),
      audit: (entry) => this.auditLog.record(entry),
      logger: this.logger,
      host: hostStr,
      client: ctx,
      namesPlatformObject: platformObjects
        ? () => platformObjects.namesPlatformObject(event)
        : undefined,
      platformObjectErrorCode: 'SUBS_WEBHOOK_PLATFORM_OBJECT',
    });

    // 3) PROCESADO: siempre bajo el contexto de ESE tenant (nunca sancionado:
    //    un evento sin dueño reconocible se archiva en el del dominio) y
    //    diciéndole a cada módulo cuál es, para que compruebe cada fila.
    //    Suscripciones, membresía y, best-effort, billing — ver
    //    `stripe-event-dispatch.ts`.
    // El Host de este request es el de la API (Stripe), no el del frontend
    // del tenant — con el tenant ya resuelto arriba, preferimos su dominio
    // primario.
    const webBaseUrl = await this.tenantResolver.resolveTenantWebBaseUrl(tenantId, req);
    await dispatchStripeEventToAll({
      event,
      parsedBody,
      tenantId,
      webBaseUrl,
      ctx,
      consumers,
      provisionMember: (args) => this.provisioning.provision(args),
      provisionBuyer: (args) => this.billingProvisioning.provision(args),
      logger: this.logger,
    });
    // Pago confirmado: correo con el texto que aceptó el comprador. Nunca lanza.
    await this.consents?.confirmCheckout(tenantId, event);

    return { received: true, type: event.type, id: event.id };
  }
}

function readHeader(headers: FastifyRequest['headers'], key: string): string | undefined {
  const v = headers[key];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' ? v : undefined;
}
