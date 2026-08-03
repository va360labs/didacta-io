/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Endpoints admin para gestionar el opt-in del registro de instalación.
 *
 * - POST   /admin/registry/opt-in     → activar registro
 * - GET    /admin/registry/status     → consultar estado
 * - DELETE /admin/registry/opt-in     → opt-out (RGPD)
 *
 * Auth: JwtAuthGuard + super_admin. El opt-in/opt-out del registro es una
 * decisión de INSTANCIA (no de tenant): solo el operador de la instalación
 * puede activarlo, consultarlo o revocarlo.
 */

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import { optInDtoSchema, type OptInDto } from './dto/opt-in.dto';
import { RegistryService, type RegistryStatus } from './registry.service';

function requireSuperAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.includes('super_admin')) {
    throw new ForbiddenException('El registro de la instalación requiere rol super_admin.');
  }
  return user;
}

@ApiTags('admin-registry')
@ApiBearerAuth()
@Controller('admin/registry')
@UseGuards(JwtAuthGuard)
export class RegistryController {
  constructor(private readonly registry: RegistryService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Estado del registro opt-in',
    description:
      'Devuelve si esta instalación está registrada en Cloud god, fecha de opt-in, último envío de telemetría y si la conexión está establecida.',
  })
  @ApiResponse({ status: 200, description: 'Estado del registro.' })
  status(@CurrentUser() user: SessionClaims | undefined): Promise<RegistryStatus> {
    requireSuperAdmin(user);
    return this.registry.getStatus();
  }

  @Post('opt-in')
  @ApiOperation({
    summary: 'Opt-in: registrar esta instalación con Cloud god',
    description:
      'Activa el envío de telemetría agregada (sin PII) a cambio de comunicación directa con el equipo Didacta. Requiere aceptación explícita de términos.',
  })
  @ApiResponse({ status: 201, description: 'Opt-in confirmado.' })
  optIn(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(optInDtoSchema)) body: OptInDto,
  ): Promise<RegistryStatus> {
    requireSuperAdmin(user);
    return this.registry.optIn(body);
  }

  @Delete('opt-in')
  @ApiOperation({
    summary: 'Opt-out: borrar registro y telemetría (RGPD)',
    description:
      'Marca el registro como opted-out localmente y solicita borrado remoto a Cloud god. Best-effort en caso de Cloud god inalcanzable.',
  })
  @ApiResponse({ status: 200, description: 'Opt-out aplicado.' })
  optOut(@CurrentUser() user: SessionClaims | undefined): Promise<RegistryStatus> {
    requireSuperAdmin(user);
    return this.registry.optOut();
  }
}
