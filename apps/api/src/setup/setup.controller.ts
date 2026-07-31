/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { extractClientContext } from '../auth/client-context';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import { setupInitSchema, type SetupInitDto } from './dto';
import { SetupService } from './setup.service';

@ApiTags('Setup')
@Controller('setup')
export class SetupController {
  constructor(private readonly service: SetupService) {}

  @Get('status')
  @ApiOperation({
    summary:
      'Indica si la instancia ya tiene al menos un tenant configurado. El frontend lo consulta antes de pintar /signin para decidir si redirigir a /setup.',
  })
  async status() {
    return this.service.getStatus();
  }

  @Get('available-modules')
  @ApiOperation({
    summary:
      'Listado de módulos del registry para el wizard de setup. Cada item indica si es core (no desactivable) y si está marcado como default. Endpoint público — solo útil ANTES de inicializar la plataforma.',
  })
  async availableModules() {
    return { modules: await this.service.listAvailableModules() };
  }

  @Post('init')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Bootstrap de primer arranque: crea tenant + dominio + usuario super_admin con password inline. Devuelve tokens firmados (auto-login). 409 si ya hay tenants.',
  })
  async init(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(setupInitSchema)) dto: SetupInitDto,
  ) {
    const host = req.headers.host ?? req.headers['x-forwarded-host'];
    const hostStr = Array.isArray(host) ? (host[0] ?? null) : (host ?? null);
    // Quitamos el puerto: el TenantDomain.hostname no incluye `:port`. El
    // request a `localhost:4000` debe persistir como `localhost`.
    const hostNoPort = hostStr ? (hostStr.split(':')[0] ?? null) : null;
    return this.service.init(dto, hostNoPort, extractClientContext(req));
  }
}
