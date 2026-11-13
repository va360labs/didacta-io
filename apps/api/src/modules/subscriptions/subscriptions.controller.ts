/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Optional,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { SessionClaims } from '../../auth/token.service';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { ModuleRegistryService } from '../module-registry.service';
import { PlatformCheckoutGate } from '../payouts/platform-checkout-gate';
import { PurchaseConsentService } from '../purchase-consent/purchase-consent.service';
import {
  withdrawalWaiverSchema,
  type WithdrawalWaiverDto,
} from '../purchase-consent/withdrawal-waiver';
import { SubscriptionsGraceExpirationWorker } from './subscriptions-grace-expiration.worker';

/**
 * Endpoints alumno de mod.subscriptions:
 *   POST /modules/subscriptions/checkout/:courseId  → start checkout (mode=subscription)
 *   GET  /modules/subscriptions/me                  → lista propias
 *   GET  /modules/subscriptions/me/:id/invoices     → historial de facturas
 *   POST /modules/subscriptions/me/:id/cancel       → cancelar
 *   POST /modules/subscriptions/me/portal           → portal de cliente de Stripe
 *
 * El admin endpoint de gestión de productos lo dejamos para una iteración
 * posterior — en MVP el admin configura el priceId desde mod.billing-admin
 * (un courseId puede tener un price one-shot o uno recurring; los módulos
 * separan responsabilidades).
 */

const startCheckoutSchema = z
  .object({
    stripePriceId: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^price_[A-Za-z0-9]+$/, 'stripePriceId debe ser un Stripe Price ID válido'),
    /** Renuncia al desistimiento (obligatoria: 422 si falta). */
    withdrawalWaiver: withdrawalWaiverSchema.optional(),
  })
  .strict();

const portalSchema = z
  .object({
    subscriptionId: z.string().uuid().optional(),
  })
  .strict()
  .optional();

const cancelSchema = z
  .object({
    immediate: z.boolean().optional(),
  })
  .strict();

@ApiTags('Subscriptions · Alumno')
@Controller('modules/subscriptions')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SubscriptionsController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly prisma: PrismaService,
    private readonly graceExpiration: SubscriptionsGraceExpirationWorker,
    private readonly tenantResolver: TenantResolverService,
    /** Renuncia al desistimiento: prueba antes de pagar y confirmación después. */
    private readonly consents: PurchaseConsentService,
    /**
     * Solo con el modo plataforma encendido (E5): dice qué clientes de Stripe
     * son de la cuenta del operador, cuyo portal lleva el nombre del creador.
     */
    @Optional() private readonly payoutsGate?: PlatformCheckoutGate,
  ) {}

  @Post('checkout/:courseId')
  @ApiOperation({
    summary:
      'Inicia checkout Stripe en mode=subscription para una suscripción recurrente al curso. ' +
      'Devuelve URL hosted a la que redirigir el navegador.',
  })
  async startCheckout(
    @Param('courseId') courseId: string,
    @CurrentUser() user: SessionClaims | undefined,
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(startCheckoutSchema))
    body: { stripePriceId: string; withdrawalWaiver?: WithdrawalWaiverDto },
  ) {
    if (!user) throw new UnauthorizedException();
    const account = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { email: true },
    });
    const course = await this.prisma.modCoursesCourse.findFirst({
      where: { id: courseId, tenantId: user.tenantId, deletedAt: null },
      select: { title: true },
    });
    // La casilla de la renuncia al desistimiento (422 sin ella, 409 si el
    // texto cambió), guardada antes de crear la sesión de pago.
    const consentId = await this.consents.accept({
      req,
      tenantId: user.tenantId,
      purchaseKind: 'course_subscription',
      itemRef: courseId,
      itemName: course?.title ?? null,
      userId: user.sub,
      buyerEmail: account?.email ?? null,
      waiver: body.withdrawalWaiver,
    });
    const result = await this.registry.getSubscriptionsService().startSubscription({
      tenantId: user.tenantId,
      userId: user.sub,
      userEmail: account?.email ?? '',
      courseId,
      stripePriceId: body.stripePriceId,
    });
    if (result.sessionId) {
      await this.consents.attachSession(user.tenantId, consentId, { sessionId: result.sessionId });
    }
    return result;
  }

  @Get('me')
  @ApiOperation({ summary: 'Lista las suscripciones del alumno autenticado.' })
  async listMine(@CurrentUser() user: SessionClaims | undefined): Promise<object> {
    if (!user) throw new UnauthorizedException();
    // Tolerante: si mod.subscriptions no está inicializado en este despliegue
    // (usa pagos externos vía mod.payment-connections), el alumno simplemente no
    // tiene suscripciones a cursos → [] en vez de 500.
    const svc = this.registry.getSubscriptionsServiceOrNull();
    if (!svc) return { subscriptions: [] };
    const subs = await svc.listMine(user.tenantId, user.sub);

    // Las filas de MEMBRESÍA (courseId null + planId) se enriquecen con el
    // nombre real del plan para que /account muestre "Membresía Anual" y no un
    // UUID. Las de curso se enriquecen con el título del curso.
    const planIds = [...new Set(subs.map((s) => s.planId).filter((x): x is string => !!x))];
    const courseIds = [...new Set(subs.map((s) => s.courseId).filter((x): x is string => !!x))];
    const [plans, courses] = await Promise.all([
      planIds.length
        ? this.prisma.modSubscriptionsPlan.findMany({
            where: { tenantId: user.tenantId, id: { in: planIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      courseIds.length
        ? this.prisma.modCoursesCourse.findMany({
            where: { tenantId: user.tenantId, id: { in: courseIds } },
            select: { id: true, title: true },
          })
        : Promise.resolve([]),
    ]);
    const planName = new Map(plans.map((p) => [p.id, p.name]));
    const courseTitle = new Map(courses.map((c) => [c.id, c.title]));
    // Portal de cliente: solo se ofrece donde sabemos que está configurado —
    // los clientes cobrados por la plataforma, cuyo portal crea Didacta con el
    // nombre del creador—. Con claves propias depende de que el aula lo haya
    // configurado en su Stripe: ahí la pestaña sigue como siempre.
    const platformCustomers = this.payoutsGate
      ? await this.payoutsGate.platformObjects(subs.map((s) => s.stripeCustomerId))
      : new Set<string>();
    return {
      subscriptions: subs.map((s) => ({
        ...s,
        planName: s.planId ? (planName.get(s.planId) ?? null) : null,
        courseTitle: s.courseId ? (courseTitle.get(s.courseId) ?? null) : null,
        billingPortal: platformCustomers.has(s.stripeCustomerId),
      })),
    };
  }

  @Post('me/portal')
  @ApiOperation({
    summary:
      'Abre el portal de cliente de Stripe del alumno (cambiar la tarjeta, ver sus facturas, ' +
      'darse de baja). Sin subscriptionId, el de su membresía viva más reciente. Devuelve la URL.',
  })
  async portal(
    @CurrentUser() user: SessionClaims | undefined,
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(portalSchema)) body: { subscriptionId?: string } | undefined,
  ): Promise<{ url: string; subscriptionId: string }> {
    if (!user) throw new UnauthorizedException();
    // Solo existe con cobros de plataforma, que crean el portal con el nombre
    // del creador. En Community (claves propias) el portal depende de que el
    // aula lo haya configurado en su Stripe y la interfaz no lo ofrece: la
    // ruta responde como si no existiera, igual que antes de los cobros de
    // plataforma.
    if (!this.payoutsGate) {
      throw new NotFoundException({ message: 'Not Found', code: 'SUBS_PORTAL_UNAVAILABLE' });
    }
    const base = await this.tenantResolver.resolveTenantWebBaseUrl(user.tenantId, req);
    return this.registry
      .getSubscriptionsService()
      .createBillingPortalSession(user.tenantId, user.sub, {
        subscriptionId: body?.subscriptionId,
        returnUrl: `${base}/account?tab=subscription`,
      });
  }

  @Post('me/membership/pay-now')
  @ApiOperation({
    summary:
      'Termina el periodo de prueba de la membresía AHORA: Stripe cobra el primer periodo ' +
      'inmediatamente y, si el cargo entra, la sub pasa a ACTIVE y se desbloquea todo el contenido.',
  })
  async membershipPayNow(@CurrentUser() user: SessionClaims | undefined): Promise<object> {
    if (!user) throw new UnauthorizedException();
    const updated = await this.registry.getMembershipService().payNow(user.tenantId, user.sub);
    return { subscription: updated };
  }

  @Get('me/:id/invoices')
  @ApiOperation({
    summary: 'Lista facturas de una suscripción propia (Stripe hosted URL incluida).',
  })
  async invoices(
    @Param('id') id: string,
    @CurrentUser() user: SessionClaims | undefined,
  ): Promise<object> {
    if (!user) throw new UnauthorizedException();
    if (!id || id.length < 5)
      throw new BadRequestException({ message: 'id inválido', code: 'SUBS_ID_INVALID' });
    // Re-leemos la sub para verificar ownership antes de listar invoices.
    const subs = await this.registry.getSubscriptionsService().listMine(user.tenantId, user.sub);
    const owned = subs.find((s) => s.id === id);
    // 404 (no 401): hay sesión válida; la sub no existe o es de otro usuario,
    // y no confirmamos cuál de las dos para no permitir enumerar ids ajenos.
    if (!owned)
      throw new NotFoundException({
        message: 'Esa suscripción no es tuya o no existe.',
        code: 'SUBS_NOT_OWNED',
      });
    const invoices = await this.registry
      .getSubscriptionsService()
      .listInvoicesForSubscription(user.tenantId, id);
    return { invoices };
  }

  @Post('me/:id/cancel')
  @ApiOperation({
    summary:
      'Cancela una suscripción propia. Por defecto al final del periodo (sigue con acceso ' +
      'hasta currentPeriodEnd). Si immediate=true cancela ya y desenrolla.',
  })
  async cancel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(cancelSchema)) body: { immediate?: boolean },
    @CurrentUser() user: SessionClaims | undefined,
  ): Promise<object> {
    if (!user) throw new UnauthorizedException();
    const updated = await this.registry
      .getSubscriptionsService()
      .cancelSubscription(user.tenantId, user.sub, id, {
        immediate: body.immediate ?? false,
        actorIsAdmin: false,
      });
    return { subscription: updated };
  }

  @Post('admin/grace-expiration/run-now')
  @HttpCode(202)
  @ApiOperation({
    summary:
      'Encola un job manual de expireGracePeriods (PAST_DUE → UNPAID). Solo super_admin (test/QA).',
  })
  async runGraceExpirationNow(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.includes('super_admin')) {
      throw new ForbiddenException({
        message: 'Solo super_admin puede disparar grace-expiration manualmente.',
        code: 'SUBS_SUPER_ADMIN_REQUIRED',
      });
    }
    await this.graceExpiration.triggerNow();
    return { enqueued: true };
  }
}
