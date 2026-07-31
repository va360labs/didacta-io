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
 * Auth: TODO añadir guard de super_admin cuando esté disponible globalmente.
 * Por ahora el path admin/* asume protección de capa superior (proxy/Auth).
 */

import { Body, Controller, Delete, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import { optInDtoSchema, type OptInDto } from './dto/opt-in.dto';
import { RegistryService, type RegistryStatus } from './registry.service';

@ApiTags('admin-registry')
@ApiBearerAuth()
@Controller('admin/registry')
export class RegistryController {
  constructor(private readonly registry: RegistryService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Estado del registro opt-in',
    description:
      'Devuelve si esta instalación está registrada en Cloud god, fecha de opt-in, último envío de telemetría y si la conexión está establecida.',
  })
  @ApiResponse({ status: 200, description: 'Estado del registro.' })
  status(): Promise<RegistryStatus> {
    return this.registry.getStatus();
  }

  @Post('opt-in')
  @ApiOperation({
    summary: 'Opt-in: registrar esta instalación con Cloud god',
    description:
      'Activa el envío de telemetría agregada (sin PII) a cambio de comunicación directa con el equipo Didacta. Requiere aceptación explícita de términos.',
  })
  @ApiResponse({ status: 201, description: 'Opt-in confirmado.' })
  optIn(@Body(new ZodValidationPipe(optInDtoSchema)) body: OptInDto): Promise<RegistryStatus> {
    return this.registry.optIn(body);
  }

  @Delete('opt-in')
  @ApiOperation({
    summary: 'Opt-out: borrar registro y telemetría (RGPD)',
    description:
      'Marca el registro como opted-out localmente y solicita borrado remoto a Cloud god. Best-effort en caso de Cloud god inalcanzable.',
  })
  @ApiResponse({ status: 200, description: 'Opt-out aplicado.' })
  optOut(): Promise<RegistryStatus> {
    return this.registry.optOut();
  }
}
