/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  Query,
  type RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { Logger as PinoLogger } from 'nestjs-pino';
import {
  mapWooOrderPayload,
  verifyWooSignature,
  WOO_ORDER_TOPICS,
} from '@didacta/mod-payment-connections';
import { Public } from '../../auth/decorators';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { ModuleRegistryService } from '../module-registry.service';

/**
 * Recibe los pedidos de WooCommerce en cuanto ocurren.
 *
 * Es público porque lo llama la tienda, no un usuario: la autenticación es la
 * firma HMAC del cuerpo. Sin firma válida no se procesa nada — si no,
 * cualquiera podría inventarse un pedido pagado.
 *
 * Fase B: registra la compra y la deja visible en la ficha. **No reparte
 * accesos todavía**; eso es la fase C, pendiente de implementar.
 *
 * El tenant viaja en la query (`?tenant=<slug>`) porque WooCommerce no sabe
 * nada de multi-tenancy y la URL del webhook la fijamos nosotros al crearlo.
 */
@ApiTags('Webhooks · WooCommerce')
@Controller('modules/payment-connections')
export class WooWebhookController {
  constructor(
    private readonly registry: ModuleRegistryService,
    // Tiene que ser la clase concreta: NestJS resuelve la inyección por el
    // token del tipo en runtime, y una interfaz de TypeScript no existe ahí.
    // Declararla como interfaz tumba el arranque de TODA la aplicación.
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {}

  @Post('woo-webhook')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Recibe order.created / order.updated de WooCommerce. Verifica la firma HMAC y refleja el pedido. No reparte accesos.',
  })
  async handle(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Query('tenant') tenantSlug: string | undefined,
    @Headers('x-wc-webhook-signature') signature: string | undefined,
    @Headers('x-wc-webhook-topic') topic: string | undefined,
  ) {
    const rawBuffer = req.rawBody ?? Buffer.alloc(0);
    if (rawBuffer.length === 0) return { ok: true, ping: true };
    const rawBody = rawBuffer.toString('utf8');

    // Ping de verificación: al guardar un webhook, WooCommerce hace un POST de
    // prueba con `{"webhook_id":N}` y **sin cabecera de firma**. No es una
    // entrega, es un «¿estás ahí?».
    //
    // Hay que contestarle 200 o el panel de la tienda enseña un error
    // permanente («La URL de entrega devolvió un código de respuesta: 401»)
    // aunque los pedidos estén entrando perfectamente — que es exactamente lo
    // que pasaba.
    //
    // Aceptarlo sin firma no abre nada: se responde y se corta. No se lee el
    // pedido, no se escribe en la base y no se concede ningún acceso.
    if (!signature && isWooPing(rawBody)) {
      this.logger.log({ tenant: tenantSlug }, 'woo-webhook: ping de verificación');
      return { ok: true, ping: true };
    }

    if (!tenantSlug) {
      throw new BadRequestException({
        message: 'Falta ?tenant= en la URL del webhook.',
        code: 'PAYCONN_WEBHOOK_TENANT_MISSING',
      });
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: { slug: tenantSlug, deletedAt: null },
      select: { id: true },
    });
    if (!tenant)
      throw new BadRequestException({
        message: 'Tenant desconocido.',
        code: 'PAYCONN_WEBHOOK_TENANT_UNKNOWN',
      });

    // RLS F2: con el tenant resuelto por slug, todo lo demás (secreto,
    // ruleset, conexión, espejo del pedido) corre bajo su ALS.
    return runAsTenant(
      tenant.id,
      () => this.handleForTenant(tenant.id, { tenantSlug, signature, topic, rawBuffer, rawBody }),
      { traceLabel: 'woo-webhook' },
    );
  }

  private async handleForTenant(
    tenantId: string,
    args: {
      tenantSlug: string;
      signature: string | undefined;
      topic: string | undefined;
      rawBuffer: Buffer;
      rawBody: string;
    },
  ) {
    const { tenantSlug, signature, topic, rawBuffer, rawBody } = args;
    const pc = this.registry.getPaymentConnectionsService();
    const secret = await pc.getWooWebhookSecret(tenantId);
    if (!secret) {
      // Sin secreto configurado no se puede verificar nada. Rechazar es la
      // única opción segura: aceptar dejaría el endpoint abierto.
      throw new UnauthorizedException({
        message: 'El webhook de WooCommerce no está configurado.',
        code: 'PAYCONN_WOO_WEBHOOK_NOT_CONFIGURED',
      });
    }

    // Se firma sobre el BUFFER, no sobre el string: convertir a texto y volver
    // altera cualquier byte que no sea UTF-8 válido y el HMAC deja de cuadrar.
    if (!verifyWooSignature({ signatureHeader: signature, rawBody: rawBuffer, secret })) {
      // El diagnóstico acompaña al rechazo porque un «firma inválida» a secas
      // no permite distinguir un secreto desincronizado de un cuerpo alterado
      // por el camino, y cada intento a ciegas cuesta un despliegue entero.
      // No se registra ni el secreto ni el cuerpo: solo su huella.
      this.logger.warn(
        {
          tenant: tenantSlug,
          topic,
          bytes: rawBuffer.length,
          recibida: signature?.slice(0, 10) ?? null,
          esperada: expectedSignaturePreview(rawBuffer, secret),
          noAscii: /[^\x20-\x7E]/.test(rawBody),
        },
        'woo-webhook: firma inválida — payload descartado',
      );
      throw new UnauthorizedException({
        message: 'Firma del webhook inválida.',
        code: 'PAYCONN_WEBHOOK_SIGNATURE_INVALID',
      });
    }

    // Solo nos interesan los pedidos. El resto se acepta con 200 para que
    // WooCommerce no marque el webhook como fallido y lo desactive.
    if (topic && !WOO_ORDER_TOPICS.has(topic)) {
      return { ok: true, ignored: topic };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new BadRequestException({
        message: 'El cuerpo del webhook no es JSON válido.',
        code: 'PAYCONN_WEBHOOK_BODY_INVALID',
      });
    }

    const order = mapWooOrderPayload(payload);
    if (!order)
      throw new BadRequestException({
        message: 'El payload no parece un pedido de WooCommerce.',
        code: 'PAYCONN_WEBHOOK_NOT_AN_ORDER',
      });
    if (!order.customerEmail) {
      // Sin email no hay a quién atribuirlo. Se responde 200 para no provocar
      // reintentos infinitos de algo que nunca va a poder procesarse.
      this.logger.warn({ externalId: order.externalId }, 'woo-webhook: pedido sin email');
      return { ok: true, skipped: 'sin-email' };
    }

    const ruleset = await pc.loadEntitlementRuleset(tenantId);
    const connectionId = await pc.findVerifiedWooConnectionId(tenantId);

    const res = await this.registry
      .getOrderMirrorService()
      .mirrorSingleOrder(tenantId, connectionId, order, { ...(ruleset ? { ruleset } : {}) });

    this.logger.log(
      {
        externalId: order.externalId,
        status: order.status,
        kind: res.kind,
        creado: res.creado,
        conCuenta: res.userId !== null,
      },
      'woo-webhook: pedido reflejado',
    );

    return {
      ok: true,
      externalId: order.externalId,
      kind: res.kind,
      created: res.creado,
      matchedUser: res.userId !== null,
    };
  }
}

/**
 * Primeros caracteres del HMAC que ESPERÁBAMOS, para poder comparar de un
 * vistazo con el que llegó sin exponer ni el secreto ni el cuerpo.
 */
function expectedSignaturePreview(body: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64').slice(0, 10);
}

/**
 * ¿Es el ping de verificación de WooCommerce?
 *
 * Se identifica por su forma, no por su tamaño: un objeto plano cuya única
 * información es el id del webhook. Un pedido de verdad trae decenas de campos
 * (`billing`, `line_items`, `total`…), así que no hay forma de confundirlos.
 *
 * Se exige que NO traiga firma en el sitio donde se llama: un payload firmado
 * siempre pasa por la verificación, pase lo que pase aquí.
 */
function isWooPing(rawBody: string): boolean {
  if (rawBody.length > 200) return false;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const claves = Object.keys(parsed as Record<string, unknown>);
    // Vacío (`{}`) o solo el identificador del webhook.
    return claves.length === 0 || (claves.length === 1 && claves[0] === 'webhook_id');
  } catch {
    return false;
  }
}
