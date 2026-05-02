import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
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
import { ModuleRegistryService } from '../module-registry.service';

const ADMIN_ROLES = ['super_admin', 'tenant_admin'] as const;

const createProductSchema = z.object({
  courseId: z.string().uuid(),
  stripePriceId: z.string().regex(/^price_/, 'Debe empezar por price_'),
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
  constructor(private readonly registry: ModuleRegistryService) {}

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
    const product = await this.registry.getBillingService().createProduct({
      tenantId: u.tenantId,
      courseId: dto.courseId,
      stripePriceId: dto.stripePriceId,
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
