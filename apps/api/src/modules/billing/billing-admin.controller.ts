/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Optional,
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
import { PlatformCheckoutGate } from '../payouts/platform-checkout-gate';

const ADMIN_ROLES = ['super_admin', 'tenant_admin'] as const;

/**
 * Dos formas de poner un curso a la venta:
 *   (a) `stripePriceId`: el admin ya creó el Price en el dashboard de Stripe.
 *   (b) `amountCents`:  escribe el importe y Didacta crea Product+Price por él
 *       (mismo comportamiento que los planes de la membresía).
 */
/**
 * Precios fijos extra por mercado (`currency_options`): moneda ISO → importe en
 * su unidad mínima. Opción avanzada: lo normal es no poner ninguno y dejar que
 * Adaptive Pricing enseñe el precio convertido a la moneda del alumno.
 */
const currencyOptionsSchema = z
  .record(
    z
      .string()
      .regex(/^[a-zA-Z]{3}$/)
      .transform((c) => c.toLowerCase()),
    z.number().int().positive().max(99_999_999_99),
  )
  .nullable();

const createProductSchema = z
  .object({
    courseId: z.string().uuid(),
    stripePriceId: z
      .string()
      .regex(/^price_/, 'Debe empezar por price_')
      .optional(),
    amountCents: z.number().int().positive().max(99_999_99).optional(),
    /** Precio anterior (tachado) para la ficha de venta. Opcional. */
    compareAtCents: z.number().int().positive().max(99_999_99).optional(),
    currency: z.string().length(3).toLowerCase().optional(),
    currencyOptions: currencyOptionsSchema.optional(),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .refine((v) => Boolean(v.stripePriceId) !== (v.amountCents !== undefined), {
    message: 'Indica un importe (amountCents) O un stripePriceId, pero no ambos.',
  });

/**
 * Dos formas de cambiar el precio de una opción ya a la venta, igual que al
 * crearla: pegar otro `stripePriceId`, o escribir el importe (`amountCents`,
 * con su moneda y sus precios por mercado), que crea un Price nuevo sobre el
 * MISMO Product de Stripe (los Price no se pueden editar).
 */
const updateProductSchema = z
  .object({
    active: z.boolean().optional(),
    stripePriceId: z
      .string()
      .regex(/^price_/)
      .optional(),
    amountCents: z.number().int().positive().max(99_999_99).optional(),
    currency: z.string().length(3).toLowerCase().optional(),
    currencyOptions: currencyOptionsSchema.optional(),
    compareAtCents: z.number().int().positive().max(99_999_99).nullable().optional(),
  })
  .refine(
    (v) =>
      v.active !== undefined ||
      v.stripePriceId !== undefined ||
      v.amountCents !== undefined ||
      v.currency !== undefined ||
      v.currencyOptions !== undefined ||
      v.compareAtCents !== undefined,
    { message: 'Debes enviar al menos un campo a actualizar.' },
  )
  .refine(
    (v) =>
      !v.stripePriceId ||
      (v.amountCents === undefined && v.currency === undefined && v.currencyOptions === undefined),
    { message: 'Indica un importe (amountCents) O un stripePriceId, pero no ambos.' },
  );

type CreateProductDto = z.infer<typeof createProductSchema>;
type UpdateProductDto = z.infer<typeof updateProductSchema>;

function requireAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  const allowed = user.roles.some((r) => (ADMIN_ROLES as readonly string[]).includes(r));
  if (!allowed) {
    throw new ForbiddenException({
      message: 'Esta acción requiere rol tenant_admin o super_admin.',
      code: 'BILLING_ADMIN_ROLE_REQUIRED',
    });
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
    // Solo con cobros de plataforma encendidos: valida monedas e importes.
    @Optional() private readonly payoutsGate?: PlatformCheckoutGate,
  ) {}

  /**
   * Cobros de plataforma: un `price_…` de la cuenta del creador no existe en la
   * del operador (ni el creador tiene acceso a esta): el precio se escribe como
   * importe, en una moneda de la lista. Con claves propias, todo como siempre.
   */
  private async assertPlatformPrice(
    tenantId: string,
    price: {
      stripePriceId?: string;
      amountCents?: number;
      currency: string;
      currencyOptions?: Record<string, number> | null;
    },
  ): Promise<void> {
    if (!this.payoutsGate) return;
    const policy = await this.payoutsGate.pricePolicy(tenantId);
    if (!policy) return;
    if (price.stripePriceId) {
      throw new BadRequestException({
        message:
          'En esta instalación el precio se escribe como importe: no hace falta crear nada en Stripe.',
        code: 'BILLING_PRICE_ID_NOT_ALLOWED',
      });
    }
    await this.payoutsGate.assertPrice(tenantId, {
      currency: price.currency,
      amounts: price.amountCents === undefined ? [] : [price.amountCents],
      currencyOptions: price.currencyOptions ?? null,
    });
  }

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
    if (!course)
      throw new NotFoundException({
        message: 'El curso no existe en esta organización.',
        code: 'BILLING_ADMIN_COURSE_NOT_FOUND',
      });
    if (course.status !== 'PUBLISHED') {
      throw new BadRequestException({
        message: 'Solo se pueden poner a la venta cursos publicados. Publica el curso primero.',
        code: 'BILLING_COURSE_NOT_PUBLISHED',
      });
    }
    await this.assertPlatformPrice(u.tenantId, {
      stripePriceId: dto.stripePriceId,
      amountCents: dto.amountCents,
      currency: dto.currency ?? 'eur',
      currencyOptions: dto.currencyOptions,
    });
    const product = await this.registry.getBillingService().createProduct({
      tenantId: u.tenantId,
      courseId: dto.courseId,
      stripePriceId: dto.stripePriceId,
      unitAmount: dto.amountCents,
      currency: dto.currency,
      currencyOptions: dto.currencyOptions,
      compareAtAmount: dto.compareAtCents,
      name: dto.name ?? course?.title,
    });
    return { product };
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Actualiza un producto: activar/desactivar, pegar otro stripePriceId, o cambiar el precio ' +
      '(amountCents, currency, currencyOptions, compareAtCents), que crea un Price nuevo sobre el ' +
      'mismo Product de Stripe.',
  })
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) patch: UpdateProductDto,
    @CurrentUser() user: SessionClaims | undefined,
  ) {
    const u = requireAdmin(user);
    const billing = this.registry.getBillingService();
    const priceChange =
      patch.amountCents !== undefined ||
      patch.currency !== undefined ||
      patch.currencyOptions !== undefined ||
      patch.compareAtCents !== undefined;
    if (!priceChange) {
      if (patch.stripePriceId) {
        await this.assertPlatformPrice(u.tenantId, {
          stripePriceId: patch.stripePriceId,
          currency: 'eur',
        });
      }
      const product = await billing.updateProduct({
        tenantId: u.tenantId,
        productId: id,
        patch: { active: patch.active, stripePriceId: patch.stripePriceId },
      });
      return { product };
    }

    const current = (await billing.listProducts(u.tenantId)).find((p) => p.id === id);
    if (!current) {
      throw new NotFoundException({
        message: 'Esa opción de compra no existe en esta organización.',
        code: 'BILLING_PRODUCT_NOT_FOUND',
      });
    }
    const unitAmount = patch.amountCents ?? current.unitAmount;
    const currency = (patch.currency ?? current.currency).toLowerCase();
    await this.assertPlatformPrice(u.tenantId, {
      amountCents: unitAmount,
      currency,
      currencyOptions:
        patch.currencyOptions === undefined
          ? (current.currencyOptions as Record<string, number> | null)
          : patch.currencyOptions,
    });
    const course = await this.prisma.modCoursesCourse.findFirst({
      where: { id: current.courseId, tenantId: u.tenantId, deletedAt: null },
      select: { title: true },
    });
    // Mismo camino que la sincronización de precios: si cambia importe, moneda
    // o precios por mercado, Price nuevo sobre el MISMO Product; si no, nada.
    const { product } = await billing.upsertCoursePrice({
      tenantId: u.tenantId,
      courseId: current.courseId,
      optionName: current.name,
      unitAmount,
      currency,
      currencyOptions: patch.currencyOptions,
      compareAtAmount:
        patch.compareAtCents === undefined ? current.compareAtAmount : patch.compareAtCents,
      name: course?.title,
      externalRef: current.externalRef,
    });
    if (patch.active !== undefined && product.active !== patch.active) {
      return {
        product: await billing.updateProduct({
          tenantId: u.tenantId,
          productId: product.id,
          patch: { active: patch.active },
        }),
      };
    }
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
