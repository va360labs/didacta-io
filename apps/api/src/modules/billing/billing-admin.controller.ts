import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
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

const ADMIN_ROLES = ['super_admin', 'tenant_admin'] as const;

/**
 * Dos formas de poner un curso a la venta:
 *   (a) `stripePriceId`: el admin ya creó el Price en el dashboard de Stripe.
 *   (b) `amountCents`:  escribe el importe y Didacta crea Product+Price por él
 *       (mismo comportamiento que los planes de la membresía).
 */
const createProductSchema = z
  .object({
    courseId: z.string().uuid(),
    stripePriceId: z
      .string()
      .regex(/^price_/, 'Debe empezar por price_')
      .optional(),
    amountCents: z.number().int().positive().max(99_999_99).optional(),
    currency: z.string().length(3).toLowerCase().optional(),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .refine((v) => Boolean(v.stripePriceId) !== (v.amountCents !== undefined), {
    message: 'Indica un importe (amountCents) O un stripePriceId, pero no ambos.',
  });

const updateProductSchema = z
  .object({
    active: z.boolean().optional(),
    stripePriceId: z
      .string()
      .regex(/^price_/)
      .optional(),
  })
  .refine((v) => v.active !== undefined || v.stripePriceId !== undefined, {
    message: 'Debes enviar al menos un campo a actualizar (active o stripePriceId).',
  });

type CreateProductDto = z.infer<typeof createProductSchema>;
type UpdateProductDto = z.infer<typeof updateProductSchema>;

function requireAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  const allowed = user.roles.some((r) => (ADMIN_ROLES as readonly string[]).includes(r));
  if (!allowed) {
    throw new ForbiddenException('Esta acción requiere rol tenant_admin o super_admin.');
  }
  return user;
}

@ApiTags('Billing · Admin')
@Controller('modules/billing/products')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class BillingAdminController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Lista productos del tenant (curso ↔ stripePriceId).' })
  async list(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireAdmin(user);
    const products = await this.registry.getBillingService().listProducts(u.tenantId);
    return { products };
  }

  @Post()
  @ApiOperation({ summary: 'Crea producto vinculando un curso a un stripePriceId.' })
  async create(
    @Body(new ZodValidationPipe(createProductSchema)) dto: CreateProductDto,
    @CurrentUser() user: SessionClaims | undefined,
  ) {
    const u = requireAdmin(user);
    // El curso debe existir, ser de este tenant y estar PUBLICADO. Sin esta
    // comprobación se puede poner a la venta un borrador o un UUID mal tecleado:
    // el alumno paga, y la matriculación posterior lo rechaza siempre por no
    // estar publicado. Cobrado y sin acceso. Se valida en LAS DOS vías de alta.
    const course = await this.prisma.modCoursesCourse.findFirst({
      where: { id: dto.courseId, tenantId: u.tenantId, deletedAt: null },
      select: { title: true, status: true },
    });
    if (!course) throw new NotFoundException('El curso no existe en esta organización.');
    if (course.status !== 'PUBLISHED') {
      throw new BadRequestException(
        'Solo se pueden poner a la venta cursos publicados. Publica el curso primero.',
      );
    }
    const product = await this.registry.getBillingService().createProduct({
      tenantId: u.tenantId,
      courseId: dto.courseId,
      stripePriceId: dto.stripePriceId,
      unitAmount: dto.amountCents,
      currency: dto.currency,
      name: dto.name ?? course?.title,
    });
    return { product };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualiza un producto (activar/desactivar o cambiar stripePriceId).' })
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) patch: UpdateProductDto,
    @CurrentUser() user: SessionClaims | undefined,
  ) {
    const u = requireAdmin(user);
    const product = await this.registry.getBillingService().updateProduct({
      tenantId: u.tenantId,
      productId: id,
      patch,
    });
    return { product };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Elimina un producto. No afecta órdenes históricas.' })
  async delete(@Param('id') id: string, @CurrentUser() user: SessionClaims | undefined) {
    const u = requireAdmin(user);
    await this.registry.getBillingService().deleteProduct(u.tenantId, id);
    return { deleted: true };
  }
}
