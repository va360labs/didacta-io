/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import {
  SimpleModeError,
  priceSchema,
  quickStartSchema,
  toggleSchema,
  type QuickStartInput,
} from './simple-mode.model';
import { SimpleModeService } from './simple-mode.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

function requireAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new ForbiddenException({
      message: 'Solo quien administra la academia puede hacer esto.',
      code: 'SIMPLE_MODE_FORBIDDEN',
    });
  }
  return user;
}

/** Errores que el creador puede arreglar él mismo: 409 con un código estable. */
const CONFLICT_CODES = new Set([
  'SIMPLE_MODE_PAYMENTS_NOT_READY',
  'SIMPLE_MODE_NO_LESSONS',
  'SIMPLE_MODE_NO_PRICE',
  'SIMPLE_MODE_NO_OFFER',
]);

async function translate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SimpleModeError) {
      const body = { message: err.message, code: err.code };
      throw CONFLICT_CODES.has(err.code)
        ? new ConflictException(body)
        : new BadRequestException(body);
    }
    throw err;
  }
}

/**
 * Modo sencillo del aula (Didacta Cloud): el camino de 0 a vender del creador.
 * Siempre sobre el tenant del token; no acepta ids de aula.
 */
@ApiTags('Modo sencillo')
@ApiBearerAuth()
@Controller('admin/simple-mode')
@UseGuards(JwtAuthGuard)
export class SimpleModeController {
  constructor(private readonly service: SimpleModeService) {}

  @Get()
  @ApiOperation({ summary: '¿Está el aula en modo sencillo?' })
  async get(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireAdmin(user);
    return { enabled: await this.service.isEnabled(u.tenantId) };
  }

  @Put()
  @ApiOperation({
    summary: 'Enciende o apaga el modo sencillo del aula. Nada se borra: lo avanzado se pliega.',
  })
  async toggle(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(toggleSchema)) body: z.infer<typeof toggleSchema>,
  ) {
    const u = requireAdmin(user);
    return { enabled: await this.service.setEnabled(u.tenantId, body.enabled) };
  }

  @Get('currencies')
  @ApiOperation({ summary: 'Monedas en las que el aula puede poner precio.' })
  async currencies(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireAdmin(user);
    return this.service.currencies(u.tenantId);
  }

  @Post('quick-start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Alta en 3 preguntas: nombre del aula, qué vende (curso o membresía) y precio. Crea el curso o el plan en borrador, los espacios básicos y un post de bienvenida. Idempotente.',
  })
  async quickStart(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(quickStartSchema)) body: QuickStartInput,
  ) {
    const u = requireAdmin(user);
    return translate(() => this.service.quickStart(u.tenantId, { id: u.sub }, body));
  }

  @Get('start-here')
  @ApiOperation({ summary: 'Estado de los 6 pasos de «Empieza aquí» y resumen tras vender.' })
  async startHere(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireAdmin(user);
    return this.service.startHere(u.tenantId);
  }

  @Put('price')
  @ApiOperation({ summary: 'Cambia el precio de la oferta (y el de venta si ya está publicada).' })
  async price(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(priceSchema)) body: z.infer<typeof priceSchema>,
  ) {
    const u = requireAdmin(user);
    return translate(() => this.service.updatePrice(u.tenantId, u.sub, body));
  }

  @Post('academy/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marca «Tu academia» como revisada aunque no cambie logo ni color.' })
  async confirmAcademy(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireAdmin(user);
    await this.service.confirmAcademy(u.tenantId, u.sub);
    return { ok: true };
  }

  @Post('adopt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Aula con cursos, alumnos o ventas que pasa al modo sencillo: se adopta tal cual, sin alta de cero.',
  })
  async adopt(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireAdmin(user);
    return this.service.adoptExisting(u.tenantId, u.sub);
  }

  @Post('publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Publica la oferta y la pone a la venta con el precio guardado. Devuelve la ruta del enlace de venta.',
  })
  async publish(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireAdmin(user);
    return translate(() => this.service.publish(u.tenantId, u.sub));
  }
}
