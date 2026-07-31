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
import { ModuleRegistryService } from '../module-registry.service';

/**
 * Recibe los pedidos de WooCommerce en cuanto ocurren.
 *
 * Es público porque lo llama la tienda, no un usuario: la autenticación es la
 * firma HMAC del cuerpo. Sin firma válida no se procesa nada — si no,
 * cualquiera podría inventarse un pedido pagado.
 *
 * Fase B: registra la compra y la deja visible en la ficha. **No reparte
 * accesos todavía**; eso es la fase C y va después de que Valen revise.
 *
 * El tenant viaja en la query (`?tenant=<slug>`) porque WooCommerce no sabe
 * nada de multi-tenancy y la URL del webhook la fijamos nosotros al crearlo.
 */
@ApiTags('Webhooks · WooCommerce')
@Controller('modules/payment-connections')
export class WooWebhookController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly prisma: PrismaLike,
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
    // WooCommerce manda un ping sin cuerpo al crear el webhook para comprobar
    // que la URL responde. Hay que contestar 200 o se queda deshabilitado.
    const rawBody = req.rawBody?.toString('utf8') ?? '';
    if (!rawBody) return { ok: true, ping: true };

    if (!tenantSlug) {
      throw new BadRequestException('Falta ?tenant= en la URL del webhook.');
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: { slug: tenantSlug, deletedAt: null },
      select: { id: true },
    });
    if (!tenant) throw new BadRequestException('Tenant desconocido.');

    const pc = this.registry.getPaymentConnectionsService();
    const secret = await pc.getWooWebhookSecret(tenant.id);
    if (!secret) {
      // Sin secreto configurado no se puede verificar nada. Rechazar es la
      // única opción segura: aceptar dejaría el endpoint abierto.
      throw new UnauthorizedException('El webhook de WooCommerce no está configurado.');
    }

    if (!verifyWooSignature({ signatureHeader: signature, rawBody, secret })) {
      this.logger.warn(
        { tenant: tenantSlug, topic },
        'woo-webhook: firma inválida — payload descartado',
      );
      throw new UnauthorizedException('Firma del webhook inválida.');
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
      throw new BadRequestException('El cuerpo del webhook no es JSON válido.');
    }

    const order = mapWooOrderPayload(payload);
    if (!order) throw new BadRequestException('El payload no parece un pedido de WooCommerce.');
    if (!order.customerEmail) {
      // Sin email no hay a quién atribuirlo. Se responde 200 para no provocar
      // reintentos infinitos de algo que nunca va a poder procesarse.
      this.logger.warn({ externalId: order.externalId }, 'woo-webhook: pedido sin email');
      return { ok: true, skipped: 'sin-email' };
    }

    const ruleset = await pc.loadEntitlementRuleset(tenant.id);
    const connectionId = await pc.findVerifiedWooConnectionId(tenant.id);

    const res = await this.registry
      .getOrderMirrorService()
      .mirrorSingleOrder(tenant.id, connectionId, order, { ...(ruleset ? { ruleset } : {}) });

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

/** Lo mínimo que este controller necesita de Prisma: resolver el tenant. */
interface PrismaLike {
  tenant: {
    findFirst(args: {
      where: { slug: string; deletedAt: null };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}
