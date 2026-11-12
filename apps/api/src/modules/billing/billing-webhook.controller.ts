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
import { StripeSdkAdapter, WebhookSignatureInvalidError } from '@didacta/mod-billing';
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
import { resolveStripeEventTenant } from '../stripe-webhook-tenant';
import { TenantStripeResolverService } from '../tenant-stripe-resolver.service';
import { BillingProvisioningService } from './billing-provisioning.service';
import { resolvePublicHost } from '../../common/resolve-public-host';

/**
 * Endpoint público de webhooks de Stripe. NO usa JwtAuthGuard porque Stripe
 * no envía bearer; la autenticación es por firma HMAC del raw body con el
 * secret de webhook — propio del tenant (Administración → Pagos) o el
 * fallback de instancia. La idempotencia la garantiza la PK natural
 * `stripe_event_id` en `mod_billing_webhook_event`.
 *
 * Cada tenant apunta su endpoint de Stripe a SU dominio verificado
 * (`https://mi-academia.com/api/v1/modules/billing/webhook`), igual que
 * `zoom-webhook.controller.ts`: el Host del request nos dice a qué tenant
 * pertenece la llamada ANTES de leer ningún secret, que es lo que hace falta
 * para saber qué secret probar al verificar la firma.
 *
 * ⚠️ Ese mismo tenant —el dueño del secreto que verificó la firma— es PARA EL
 * QUE SE PROCESA el evento. Lo que el evento diga de sí mismo (`metadata`,
 * ids de órdenes) lo escribe quien firma y no decide nada: si nombra a otra
 * aula se rechaza con 403 sin tocar nada. Ver `stripe-webhook-tenant.ts`.
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
    private readonly stripeResolver: TenantStripeResolverService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly logger: PinoLogger,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Recibe eventos webhook de Stripe (checkout.session.completed/expired, charge.refunded). Verifica firma HMAC, persiste con idempotencia y procesa.',
  })
  async handle(@Req() req: RawBodyRequest<FastifyRequest>) {
    const billing = this.registry.getBillingService();

    const hostStr = resolvePublicHost(req);
    const tenant = await runSanctionedGlobalAccess(() =>
      this.tenantResolver.resolveByHost(hostStr),
    );
    if (!tenant) {
      throw new NotFoundException({
        message: 'No se reconoce el dominio de este webhook.',
        code: 'BILLING_WEBHOOK_UNKNOWN_DOMAIN',
      });
    }

    const resolved = await runAsTenant(tenant.id, () => this.stripeResolver.resolve(tenant.id));
    if (!resolved) {
      throw new UnauthorizedException({
        message: 'Stripe no está configurado para este tenant.',
        code: 'BILLING_STRIPE_NOT_CONFIGURED',
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const StripeCtor = require('stripe').default ?? require('stripe');
    const stripe = new StripeSdkAdapter(
      resolved.credentials.secretKey,
      resolved.credentials.webhookSecret,
      StripeCtor,
    );

    const signature = readHeader(req.headers, 'stripe-signature');
    if (!signature)
      throw new UnauthorizedException({
        message: 'stripe-signature ausente.',
        code: 'BILLING_WEBHOOK_SIGNATURE_MISSING',
      });
    const rawBody = req.rawBody?.toString('utf8') ?? '';
    if (!rawBody)
      throw new BadRequestException({
        message: 'Body raw vacío — Stripe siempre envía payload.',
        code: 'BILLING_WEBHOOK_EMPTY_BODY',
      });

    let event;
    try {
      event = stripe.constructWebhookEvent(rawBody, signature);
    } catch (err) {
      // El filter mapea WebhookSignatureInvalidError → 401. Pero el
      // controlador puede recibir otros errores de Stripe (parser SDK).
      if (err instanceof WebhookSignatureInvalidError) throw err;
      // El motivo lo redacta el SDK de Stripe (timestamp fuera de tolerancia,
      // secreto que no corresponde…). Va aparte del `message` para que quien
      // depure el endpoint desde una UI en inglés lo siga viendo entero.
      const detail = (err as Error).message;
      throw new UnauthorizedException({
        message: `Firma del webhook inválida: ${detail}`,
        code: 'BILLING_WEBHOOK_SIGNATURE_REJECTED',
        detail,
      });
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
    // 1) LOOKUP (sancionado, fuera de cualquier contexto de tenant): a qué
    //    tenants nombra o toca el evento. Solo lee.
    const claims = await runGlobalWithoutTenant(() => billing.resolveWebhookTenantClaims(event));
    // 2) DECISIÓN: el evento se procesa para el tenant cuyo secreto verificó la
    //    firma. Si nombra a otro, 403 + rastro, y aquí se acaba — antes de
    //    archivar el evento siquiera.
    const tenantId = await resolveStripeEventTenant({
      endpoint: 'billing',
      errorCode: 'BILLING_WEBHOOK_FOREIGN_TENANT',
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
    // El Host de este request es el de la API (Stripe), no el del frontend
    // del tenant — con el tenant ya resuelto, preferimos su dominio primario.
    const webBaseUrl = await this.tenantResolver.resolveTenantWebBaseUrl(tenantId, req);
    // 3) PROCESADO: siempre bajo el contexto de ESE tenant (nunca sancionado:
    //    un evento sin dueño reconocible se archiva en el del dominio) y
    //    diciéndole al módulo cuál es, para que compruebe cada fila que toque.
    await runAsTenant(
      tenantId,
      () =>
        billing.handleWebhookEvent(event, parsedBody, {
          tenantId,
          provisionUser: ({ email, name, locale }) =>
            this.provisioning.provision({
              // El tenant verificado, no el que devuelva el módulo.
              tenantId,
              email,
              name,
              // Idioma con el que compró, capturado al iniciar el checkout y
              // transportado en la metadata de la session. El service lo valida
              // y solo lo escribe si CREA la fila.
              locale,
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
