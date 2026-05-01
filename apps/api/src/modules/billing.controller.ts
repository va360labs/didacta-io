import { Controller, Param, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { PrismaService } from '../prisma/prisma.service';
import { ModuleRegistryService } from './module-registry.service';

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
  ) {
    if (!user) throw new UnauthorizedException();
    // SessionClaims no incluye email; lo resolvemos vía lookup. Pre-rellena
    // customer_email en Stripe para que el alumno no lo introduzca de nuevo.
    // Si la cuenta no tiene email registrado (caso anómalo), dejamos que
    // Stripe lo pida en su hosted checkout: pasamos undefined.
    const account = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { email: true },
    });
    const result = await this.registry.getBillingService().startCheckout({
      tenantId: user.tenantId,
      userId: user.sub,
      userEmail: account?.email ?? '',
      courseId,
    });
    return result;
  }
}
