import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { SessionClaims } from '../../auth/token.service';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { PrismaService } from '../../prisma/prisma.service';
import { ModuleRegistryService } from '../module-registry.service';
import { SubscriptionsGraceExpirationWorker } from './subscriptions-grace-expiration.worker';

/**
 * Endpoints alumno de mod.subscriptions:
 *   POST /modules/subscriptions/checkout/:courseId  → start checkout (mode=subscription)
 *   GET  /modules/subscriptions/me                  → lista propias
 *   GET  /modules/subscriptions/me/:id/invoices     → historial de facturas
 *   POST /modules/subscriptions/me/:id/cancel       → cancelar
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
  })
  .strict();

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
    @Body(new ZodValidationPipe(startCheckoutSchema)) body: { stripePriceId: string },
  ) {
    if (!user) throw new UnauthorizedException();
    const account = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { email: true },
    });
    return this.registry.getSubscriptionsService().startSubscription({
      tenantId: user.tenantId,
      userId: user.sub,
      userEmail: account?.email ?? '',
      courseId,
      stripePriceId: body.stripePriceId,
    });
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
    // nombre real del plan para que /cuenta muestre "VA360.pro Anual" y no un
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
    return {
      subscriptions: subs.map((s) => ({
        ...s,
        planName: s.planId ? (planName.get(s.planId) ?? null) : null,
        courseTitle: s.courseId ? (courseTitle.get(s.courseId) ?? null) : null,
      })),
    };
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
    if (!id || id.length < 5) throw new BadRequestException('id inválido');
    // Re-leemos la sub para verificar ownership antes de listar invoices.
    const subs = await this.registry.getSubscriptionsService().listMine(user.tenantId, user.sub);
    const owned = subs.find((s) => s.id === id);
    if (!owned) throw new UnauthorizedException('Esa suscripción no es tuya o no existe.');
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
      throw new UnauthorizedException(
        'Solo super_admin puede disparar grace-expiration manualmente.',
      );
    }
    await this.graceExpiration.triggerNow();
    return { enqueued: true };
  }
}
