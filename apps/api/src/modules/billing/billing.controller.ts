import {
  ConflictException,
  Controller,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { resolveWebBaseUrl } from '../../common/resolve-web-base-url';
import type { SessionClaims } from '../../auth/token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ModuleRegistryService } from '../module-registry.service';

/**
 * Endpoint de checkout para el ALUMNO (rol student/alumno o cualquier user
 * autenticado del tenant). Genera la Checkout Session de Stripe y devuelve
 * la URL hosted; el frontend redirige el browser. La autorización fina (¿el
 * curso es público / requiere licencia / etc.) la valida BillingService al
 * resolver el producto.
 */
@ApiTags('Billing · Alumno')
@Controller('modules/billing')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class BillingController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('checkout/:courseId')
  @ApiOperation({
    summary:
      'Inicia checkout Stripe para el curso indicado. Devuelve URL hosted a la que redirigir.',
  })
  async startCheckout(
    @Param('courseId') courseId: string,
    @CurrentUser() user: SessionClaims | undefined,
    @Req() req: FastifyRequest,
  ) {
    if (!user) throw new UnauthorizedException();

    // Guardas ANTES de mandar a nadie a pagar. Sin esto se puede cobrar por un
    // curso despublicado (que la matriculación posterior rechazaría siempre) o
    // cobrar dos veces al mismo alumno desde dos pestañas.
    const course = await this.prisma.modCoursesCourse.findFirst({
      where: { id: courseId, tenantId: user.tenantId, deletedAt: null },
      select: { status: true },
    });
    if (!course) throw new NotFoundException('Curso no encontrado.');
    if (course.status !== 'PUBLISHED') {
      throw new ConflictException('Este curso no está disponible para la compra.');
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
      throw new ConflictException('Ya tienes acceso a este curso.');
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
    const webBaseUrl = resolveWebBaseUrl(req).replace(/\/$/, '');
    const result = await this.registry.getBillingService().startCheckout({
      tenantId: user.tenantId,
      userId: user.sub,
      userEmail: account?.email ?? '',
      courseId,
      successUrl: `${webBaseUrl}/cursos/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${webBaseUrl}/cursos/checkout/cancel`,
    });
    return result;
  }
}
