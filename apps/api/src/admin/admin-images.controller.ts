/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { AdminImagesService, type ImageRef } from './admin-images.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

const imageRefSchema = z.object({
  source: z.enum(['avatar', 'curso', 'coleccion', 'logo', 'post']),
  ownerId: z.string().min(1).max(200),
  label: z.string().max(300).default(''),
  url: z.string().min(1).max(2000),
});

/** Tope por lote: cada imagen se descarga y recomprime, así que no es gratis. */
const optimizeSchema = z.object({
  refs: z.array(imageRefSchema).min(1).max(50),
});

type OptimizeDto = z.infer<typeof optimizeSchema>;

/**
 * Reoptimización de las imágenes YA subidas del tenant (/admin/imagenes).
 *
 * Lo que entra nuevo ya nace optimizado en la capa de storage; esto es para el
 * histórico. Reservado a administradores: repunta filas de varios módulos.
 */
@ApiTags('Admin · Imágenes')
@ApiBearerAuth()
@Controller('admin/images')
@UseGuards(JwtAuthGuard)
export class AdminImagesController {
  constructor(private readonly service: AdminImagesService) {}

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new ForbiddenException('Esta acción requiere rol de administrador.');
    }
    return user;
  }

  @Get('inventory')
  @ApiOperation({
    summary:
      'Inventario de imágenes del tenant con su peso actual y el que tendrían optimizadas. No escribe nada.',
  })
  @ApiResponse({ status: 200 })
  async inventory(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    return this.service.inventory(u.tenantId);
  }

  @Post('optimize')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Reoptimiza las imágenes indicadas (máx 50 por lote) y repunta la fila dueña a la URL nueva.',
  })
  @ApiResponse({ status: 200 })
  async optimize(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(optimizeSchema)) dto: OptimizeDto,
  ) {
    const u = this.requireAdmin(user);
    return { results: await this.service.optimize(u.tenantId, dto.refs as ImageRef[]) };
  }
}
