/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Enterprise
 *
 * This file is part of Didacta Enterprise Edition and is licensed under the
 * Didacta Enterprise License (LICENSE_EE). It cannot be used in production
 * without a valid Didacta Enterprise license key. See LICENSE_EE for details.
 *
 * Endpoints administrativos del path EE:
 *
 *   GET    /api/v1/admin/webhooks/dead-letter
 *   POST   /api/v1/admin/webhooks/dead-letter/:id/retry
 *   DELETE /api/v1/admin/webhooks/dead-letter/:id
 *
 * Todos van gateados con @RequiresCapability(API_WEBHOOKS_HIGH_THROUGHPUT).
 * Sin licencia EE, el LicenseGuard responde 402 vía LicenseExceptionFilter
 * (registrado globalmente en main.ts).
 */

import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { LICENSE_CAPABILITIES, RequiresCapability } from '@didacta/license-sdk';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksDispatcherEE } from './webhooks.dispatcher.ee';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

function requireTenantAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new ForbiddenException({
      message: 'Solo super_admin y tenant_admin pueden gestionar la dead-letter de webhooks.',
      code: 'WEBHOOKS_DEAD_LETTER_ADMIN_REQUIRED',
    });
  }
  return user;
}

@ApiTags('Admin · Webhooks (Enterprise)')
@ApiBearerAuth()
@Controller('admin/webhooks')
@UseGuards(JwtAuthGuard)
export class WebhooksAdminControllerEE {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: WebhooksDispatcherEE,
  ) {}

  @Get('dead-letter')
  @RequiresCapability(LICENSE_CAPABILITIES.API_WEBHOOKS_HIGH_THROUGHPUT)
  @ApiOperation({
    summary:
      'Lista los eventos en dead-letter (entregas que agotaron todos los reintentos). ' +
      'Capability: `feat:api.webhooks.high_throughput`.',
  })
  @ApiResponse({ status: 200, description: 'Lista paginada de dead-letters.' })
  @ApiResponse({ status: 402, description: 'Capability no licenciada.' })
  async listDeadLetter(
    @CurrentUser() user: SessionClaims | undefined,
    @Query('limit') limit?: string,
  ): Promise<object> {
    const session = requireTenantAdmin(user);
    const take = Math.min(Math.max(Number.parseInt(limit ?? '50', 10) || 50, 1), 200);
    const items = await this.prisma.webhookDeadLetter.findMany({
      where: { tenantId: session.tenantId },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return {
      items: items.map((it) => ({
        id: it.id,
        endpointId: it.endpointId,
        eventType: it.eventType,
        payload: it.payload,
        lastError: it.lastError,
        attempts: it.attempts,
        createdAt: it.createdAt.toISOString(),
      })),
      count: items.length,
    };
  }

  @Post('dead-letter/:id/retry')
  @HttpCode(202)
  @RequiresCapability(LICENSE_CAPABILITIES.API_WEBHOOKS_HIGH_THROUGHPUT)
  @ApiOperation({
    summary:
      'Re-encola la entrega de un evento dead-letter en BullMQ. La row se borra solo si ' +
      'el re-encolado tuvo éxito.',
  })
  @ApiResponse({ status: 202, description: 'Re-encolado.' })
  @ApiResponse({ status: 404, description: 'Dead-letter no encontrado.' })
  async retryDeadLetter(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const session = requireTenantAdmin(user);
    const row = await this.prisma.webhookDeadLetter.findFirst({
      where: { id, tenantId: session.tenantId },
    });
    if (!row) {
      throw new ForbiddenException({
        message: 'Dead-letter no encontrado o ajeno al tenant.',
        code: 'WEBHOOKS_DEAD_LETTER_NOT_FOUND',
      });
    }

    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id: row.endpointId, tenantId: session.tenantId },
    });
    if (!endpoint) {
      throw new ForbiddenException({
        message: 'El endpoint asociado fue borrado — no hay forma de reintentar.',
        code: 'WEBHOOKS_DEAD_LETTER_ENDPOINT_DELETED',
      });
    }

    await this.dispatcher.dispatch({
      tenantId: session.tenantId,
      endpointId: endpoint.id,
      url: endpoint.url,
      secret: endpoint.secret,
      eventType: row.eventType,
      payload: row.payload,
    });

    // Borramos la row para evitar reintentos duplicados desde la UI.
    await this.prisma.webhookDeadLetter.delete({ where: { id: row.id } });

    return {
      status: 'queued',
      endpointId: endpoint.id,
      eventType: row.eventType,
    };
  }

  @Delete('dead-letter/:id')
  @HttpCode(204)
  @RequiresCapability(LICENSE_CAPABILITIES.API_WEBHOOKS_HIGH_THROUGHPUT)
  @ApiOperation({ summary: 'Descarta una entrada del dead-letter sin reintentar.' })
  async dismissDeadLetter(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
  ): Promise<void> {
    const session = requireTenantAdmin(user);
    await this.prisma.webhookDeadLetter.deleteMany({
      where: { id, tenantId: session.tenantId },
    });
  }
}
