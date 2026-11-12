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
import { Logger as PinoLogger } from 'nestjs-pino';
import { WebhookTenantMismatchError as BillingWebhookTenantMismatchError } from '@didacta/mod-billing';
import {
  SubscriptionsStripeSdkAdapter,
  WebhookSignatureInvalidError,
} from '@didacta/mod-subscriptions';
import type Stripe from 'stripe';
import type { FastifyRequest } from 'fastify';
import { extractClientContext } from '../../auth/client-context';
import type { ClientContext } from '../../auth/client-context';
import {
  runAsTenant,
  runGlobalWithoutTenant,
  runSanctionedGlobalAccess,
} from '../../tenancy/tenant-context.storage';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { BillingProvisioningService } from '../billing/billing-provisioning.service';
import { ModuleRegistryService } from '../module-registry.service';
import { PrismaAuditLogService } from '../prisma-audit-log.service';
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
    const membership = this.registry.getMembershipService();
    const billing = this.registry.getBillingService();

    // 1) LOOKUP (sancionado, fuera de cualquier contexto de tenant): a qué
    //    tenants nombra o toca el evento, sumando los TRES consumidores que lo
    //    van a procesar aquí abajo. Solo lee.
    const claims = await runGlobalWithoutTenant(async () => [
      ...(await subs.resolveWebhookTenantClaims(event)),
      ...(await membership.resolveWebhookTenantClaims(event)),
      ...(await billing.resolveWebhookTenantClaims(event)),
    ]);
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
    });

    // 3) PROCESADO: siempre bajo el contexto de ESE tenant (nunca sancionado:
    //    un evento sin dueño reconocible se archiva en el del dominio) y
    //    diciéndole a cada módulo cuál es, para que compruebe cada fila.
    await runAsTenant(tenantId, () => subs.handleWebhookEvent(event, parsedBody, { tenantId }), {
      traceLabel: 'subscriptions-webhook',
    });

    // Fulfillment de MEMBRESÍA: el checkout completado materializa al
    // comprador (find-or-create user + bienvenida con enlace mágico) y crea la
    // suscripción local. Idempotente por stripeSubscriptionId — un retry de
    // Stripe no duplica user ni sub. Va DESPUÉS de handleWebhookEvent (que
    // persiste el evento para auditoría) y es independiente de su dedupe.
    // El Host de este request es el de la API (Stripe), no el del frontend
    // del tenant — con el tenant ya resuelto arriba, preferimos su dominio
    // primario.
    const webBaseUrl = await this.tenantResolver.resolveTenantWebBaseUrl(tenantId, req);
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      // La membresía se crea en el tenant VERIFICADO. Antes salía de
      // `session.metadata.tenantId`, que escribe quien firma el evento: era el
      // agujero por el que un aula se regalaba membresías en otra.
      const fulfilled = await runAsTenant(
        tenantId,
        () =>
          membership.fulfillMembershipCheckout(
            session,
            ({ email, name, locale }) =>
              this.provisioning.provision({
                // El tenant verificado, no el que devuelva el módulo.
                tenantId,
                email,
                name,
                // Idioma con el que compró, capturado al iniciar el checkout
                // y transportado en la metadata de la session. El service lo
                // valida y solo lo escribe si CREA la fila.
                locale,
                webBaseUrl,
                ctx,
              }),
            { tenantId },
          ),
        { traceLabel: 'membership-fulfillment' },
      );

      // Pagó teniendo ya una membresía viva. La venta anónima no permite
      // evitarlo antes —el correo lo escribe en la pantalla de Stripe—, así que
      // lo único que se puede hacer es que no pase inadvertido: son dos cobros
      // recurrentes por el mismo acceso, y nadie se queja de lo que no ve.
      // No se resuelve solo a propósito: reembolsar la nueva, cancelar la vieja
      // o dejar las dos es una decisión de negocio, no del webhook.
      if (fulfilled?.duplicateOf) {
        this.logger.warn(
          {
            tenantId,
            userId: fulfilled.userId,
            nueva: fulfilled.subscriptionId,
            existente: fulfilled.duplicateOf,
            stripeSession: session.id,
          },
          'MEMBRESÍA DUPLICADA: este usuario ya tenía una membresía viva y acaba de contratar otra. Hay que decidir cuál se queda.',
        );
      }
    }

    // FAN-OUT a mod.billing (compra de curso suelto). Una sola cuenta de Stripe
    // alimenta los dos módulos, así que un ÚNICO endpoint de webhook puede
    // servir a ambos: el evento ya viene verificado con el mismo secreto de
    // firma, y cada módulo procesa solo lo suyo (la membresía descarta las
    // sesiones sin `membership:'1'`; billing, las que no llevan `courseId`).
    // Best-effort: un fallo de billing NO puede tumbar el fulfillment de la
    // membresía ya hecho arriba, ni provocar que Stripe reintente el evento
    // durante días. Queda registrado en `mod_billing_webhook_event`.
    await this.dispatchToBilling(event, parsedBody, webBaseUrl, ctx, tenantId);

    return { received: true, type: event.type, id: event.id };
  }

  private async dispatchToBilling(
    event: Stripe.Event,
    parsedBody: unknown,
    webBaseUrl: string,
    ctx: ClientContext,
    /** Tenant VERIFICADO (el mismo para los tres consumidores del evento). */
    tenantId: string,
  ): Promise<void> {
    const billing = this.registry.getBillingService();
    try {
      // Mismo provisioner que el endpoint propio de billing: una compra
      // ANÓNIMA de curso puede entrar por este webhook compartido. Y mismo
      // tenant: el verificado, ya decidido arriba con los claims de billing
      // incluidos — aquí no se vuelve a preguntar al evento de quién es.
      await runAsTenant(
        tenantId,
        () =>
          billing.handleWebhookEvent(event, parsedBody, {
            tenantId,
            provisionUser: ({ email, name, locale }) =>
              this.billingProvisioning.provision({
                tenantId,
                email,
                name,
                locale,
                webBaseUrl,
                ctx,
              }),
          }),
        { traceLabel: 'billing-webhook' },
      );
    } catch (err) {
      // Un evento que toca filas de otra aula NUNCA se traga, sea del tipo que
      // sea: es la segunda cerradura del módulo saltando.
      if (err instanceof BillingWebhookTenantMismatchError) throw err;
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
