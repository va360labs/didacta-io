/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Optional,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { SessionClaims } from '../../auth/token.service';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { ModuleRegistryService } from '../module-registry.service';
import { PurchaseConsentService } from '../purchase-consent/purchase-consent.service';
import {
  withdrawalWaiverSchema,
  type WithdrawalWaiverDto,
} from '../purchase-consent/withdrawal-waiver';
import {
  PAYOUTS_NOT_READY_OFFER_REASON,
  PlatformCheckoutGate,
} from '../payouts/platform-checkout-gate';

/**
 * Endpoint de checkout para el ALUMNO (rol student/alumno o cualquier user
 * autenticado del tenant). Genera la Checkout Session de Stripe y devuelve
 * la URL hosted; el frontend redirige el browser. La autorización fina (¿el
 * curso es público / requiere licencia / etc.) la valida BillingService al
 * resolver el producto.
 */
/** Cuerpo opcional del checkout: qué formato del curso quiere comprar. */
// Falso positivo: el esquema se usa dentro de un decorador (@Body), que el
// análisis de flujo de la regla no cuenta como «sentencia posterior».
// eslint-disable-next-line no-useless-assignment
const checkoutBodySchema = z
  .object({
    optionId: z.string().uuid().optional(),
    /** Renuncia al desistimiento (obligatoria: 422 si falta). */
    withdrawalWaiver: withdrawalWaiverSchema.optional(),
    /**
     * Código del enlace de referido (`?ref=` de la página de venta). OPCIONAL y
     * opaco para la venta: viaja en la metadata de Stripe y lo interpreta
     * mod.referrals al completarse el pago. Mismo formato que en la membresía.
     */
    referralCode: z
      .string()
      .trim()
      .regex(/^[a-z0-9]{3,32}$/i)
      .optional(),
  })
  .strict()
  .optional()
  .transform((v) => v ?? {});

@ApiTags('Billing · Alumno')
@Controller('modules/billing')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class BillingController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly prisma: PrismaService,
    private readonly tenantResolver: TenantResolverService,
    /** Renuncia al desistimiento: prueba antes de pagar y confirmación después. */
    private readonly consents: PurchaseConsentService,
    /**
     * Solo con el modo plataforma encendido: si el aula cobra por la plataforma
     * y su cuenta aún no puede vender, el curso no está a la venta.
     */
    @Optional() private readonly payoutsGate?: PlatformCheckoutGate,
  ) {}

  @Get('offer/:courseId')
  @ApiOperation({
    summary:
      'Oferta del curso para el alumno: si está a la venta, precio, precio anterior y % de descuento. ' +
      'Devuelve forSale=false (200) cuando el curso no se vende, para que la ficha oculte la compra.',
  })
  async getOffer(
    @Param('courseId') courseId: string,
    @CurrentUser() user: SessionClaims | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    // Si mod.billing no está configurado, la ficha debe seguir renderizando:
    // simplemente no se ofrece la compra.
    // El aula cobra por la plataforma y su cuenta aún no puede vender.
    if (await this.payoutsGate?.saleBlockedReason(user.tenantId)) {
      return { forSale: false, options: [], reason: PAYOUTS_NOT_READY_OFFER_REASON };
    }
    try {
      return await this.registry.getBillingService().getCourseOffer(user.tenantId, courseId);
    } catch {
      return {
        forSale: false,
        unitAmount: null,
        compareAtAmount: null,
        currency: null,
        discountPercent: null,
      };
    }
  }

  @Post('checkout/:courseId')
  @ApiOperation({
    summary:
      'Inicia checkout Stripe para el curso indicado. Devuelve URL hosted a la que redirigir.',
  })
  async startCheckout(
    @Param('courseId') courseId: string,
    @CurrentUser() user: SessionClaims | undefined,
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(checkoutBodySchema))
    body: { optionId?: string; withdrawalWaiver?: WithdrawalWaiverDto; referralCode?: string },
  ) {
    if (!user) throw new UnauthorizedException();

    // Guardas ANTES de mandar a nadie a pagar. Sin esto se puede cobrar por un
    // curso despublicado (que la matriculación posterior rechazaría siempre) o
    // cobrar dos veces al mismo alumno desde dos pestañas.
    const course = await this.prisma.modCoursesCourse.findFirst({
      where: { id: courseId, tenantId: user.tenantId, deletedAt: null },
      select: { status: true, title: true },
    });
    if (!course)
      throw new NotFoundException({
        message: 'Curso no encontrado.',
        code: 'BILLING_COURSE_NOT_FOUND',
      });
    if (course.status !== 'PUBLISHED') {
      throw new ConflictException({
        message: 'Este curso no está disponible para la compra.',
        code: 'BILLING_COURSE_NOT_PURCHASABLE',
      });
    }
    const yaTieneAcceso = await this.prisma.modLearningEnrollment.findFirst({
      where: {
        tenantId: user.tenantId,
        userId: user.sub,
        courseId,
        status: { in: ['ACTIVE', 'COMPLETED'] },
      },
      select: { id: true },
    });
    if (yaTieneAcceso) {
      throw new ConflictException({
        message: 'Ya tienes acceso a este curso.',
        code: 'BILLING_ALREADY_ENROLLED',
      });
    }

    // SessionClaims no incluye email; lo resolvemos vía lookup. Pre-rellena
    // customer_email en Stripe para que el alumno no lo introduzca de nuevo.
    // Si la cuenta no tiene email registrado (caso anómalo), dejamos que
    // Stripe lo pida en su hosted checkout: pasamos undefined.
    const account = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { email: true },
    });
    // URLs de retorno resueltas con el Host REAL de la petición (mismo patrón
    // que el checkout de la membresía). Antes las construía el registry al
    // arrancar, a partir de AUTH_URL — que en producción no está definida, así
    // que el comprador acababa en `localhost:3000/cursos/<uuid>?paid=1`.
    // La página de éxito espera `session_id` para confirmar el pago.
    const webBaseUrl = (
      await this.tenantResolver.resolveTenantWebBaseUrl(user.tenantId, req)
    ).replace(/\/$/, '');
    // Modo plataforma: 409 PAYOUTS_NOT_READY si la cuenta no puede vender
    // (antes de crear la orden), y precios del curso en la cuenta del operador.
    const billing = this.registry.getBillingService();
    await this.payoutsGate?.prepareCheckout(user.tenantId, courseId, billing);
    // La casilla de la renuncia al desistimiento (422 sin ella, 409 si el
    // texto cambió): la prueba se guarda ANTES de crear la orden.
    const consentId = await this.consents.accept({
      req,
      tenantId: user.tenantId,
      purchaseKind: 'course',
      itemRef: courseId,
      itemName: course.title,
      userId: user.sub,
      buyerEmail: account?.email ?? null,
      waiver: body?.withdrawalWaiver,
    });
    const result = await billing.startCheckout({
      tenantId: user.tenantId,
      userId: user.sub,
      userEmail: account?.email ?? '',
      courseId,
      optionId: body?.optionId,
      ...(body?.referralCode ? { referralCode: body.referralCode.toLowerCase() } : {}),
      successUrl: `${webBaseUrl}/cursos/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${webBaseUrl}/cursos/checkout/cancel`,
    });
    await this.consents.attachSession(user.tenantId, consentId, {
      sessionId: result.sessionId,
      orderId: result.orderId,
    });
    return result;
  }
}
