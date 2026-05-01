/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * WebhooksController — endpoints CRUD + info del 10º piloto License SDK.
 *
 *   GET    /api/v1/webhooks/info
 *   GET    /api/v1/webhooks/endpoints
 *   POST   /api/v1/webhooks/endpoints
 *   GET    /api/v1/webhooks/endpoints/:id
 *   PUT    /api/v1/webhooks/endpoints/:id
 *   DELETE /api/v1/webhooks/endpoints/:id
 *
 * NO van gateados por @RequiresCapability — son tenant-public en el sentido
 * de que cualquier tenant puede crear endpoints. Lo que cambia con la
 * capability EE es:
 *   - Los límites (1/3 vs 20/ilimitado) — el service los aplica.
 *   - El path de envío (naive vs BullMQ + HMAC + dead-letter) — runtime.
 *
 * Los endpoints administrativos del path EE (dead-letter inspect / retry,
 * métricas) viven en `webhooks-admin.controller.ee.ts` y SÍ van gateados.
 */

import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import {
  WebhookDuplicateUrlError,
  WebhookLimitExceededError,
  WebhooksService,
} from './webhooks.service';
import {
  createEndpointDtoSchema,
  updateEndpointDtoSchema,
  type CreateEndpointDto,
  type UpdateEndpointDto,
} from './webhooks.types';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

function requireTenantAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new ForbiddenException(
      'Solo super_admin y tenant_admin pueden gestionar webhooks salientes.',
    );
  }
  return user;
}

@ApiTags('Webhooks salientes')
@ApiBearerAuth()
@Controller('webhooks')
@UseGuards(JwtAuthGuard)
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get('info')
  @ApiOperation({
    summary:
      'Devuelve el tier activo (community / enterprise), límites efectivos y catálogo de ' +
      'eventos conocidos. NO está gateado: la página de admin lo consume tanto en ' +
      'community (para mostrar upsell) como en EE (para mostrar las cifras reales).',
  })
  @ApiResponse({ status: 200, description: 'Info de webhooks.' })
  info(@CurrentUser() user: SessionClaims | undefined) {
    requireTenantAdmin(user);
    return this.webhooks.getInfo();
  }

  @Get('endpoints')
  @ApiOperation({ summary: 'Lista los endpoints de webhook configurados para el tenant.' })
  @ApiResponse({ status: 200, description: 'Lista de endpoints.' })
  async listEndpoints(@CurrentUser() user: SessionClaims | undefined) {
    const session = requireTenantAdmin(user);
    return this.webhooks.listEndpoints(session.tenantId);
  }

  @Get('endpoints/:id')
  @ApiOperation({ summary: 'Devuelve un endpoint por id.' })
  async getEndpoint(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const session = requireTenantAdmin(user);
    return this.webhooks.getEndpoint(session.tenantId, id);
  }

  @Post('endpoints')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Crea un endpoint de webhook. Devuelve el secret en plano una sola vez — guárdalo.',
  })
  @ApiResponse({ status: 201, description: 'Endpoint creado (secret one-shot incluido).' })
  @ApiResponse({ status: 409, description: 'URL ya registrada para este tenant.' })
  @ApiResponse({ status: 422, description: 'Límite de plan excedido.' })
  async createEndpoint(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createEndpointDtoSchema)) body: CreateEndpointDto,
  ) {
    const session = requireTenantAdmin(user);
    try {
      return await this.webhooks.createEndpoint(session.tenantId, body);
    } catch (err) {
      this.translateDomainError(err);
    }
  }

  @Put('endpoints/:id')
  @ApiOperation({
    summary:
      'Actualiza un endpoint. Si se incluye `secret`, lo rota y devuelve el nuevo en plano ' +
      '(one-shot).',
  })
  async updateEndpoint(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateEndpointDtoSchema)) body: UpdateEndpointDto,
  ) {
    const session = requireTenantAdmin(user);
    try {
      return await this.webhooks.updateEndpoint(session.tenantId, id, body);
    } catch (err) {
      this.translateDomainError(err);
    }
  }

  @Delete('endpoints/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Borra un endpoint. Idempotente.' })
  async deleteEndpoint(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
  ): Promise<void> {
    const session = requireTenantAdmin(user);
    await this.webhooks.deleteEndpoint(session.tenantId, id);
  }

  /**
   * Convierte errores de dominio del service en respuestas HTTP coherentes.
   * Mantiene el controller simple (sin try/catch repetidos).
   */
  private translateDomainError(err: unknown): never {
    if (err instanceof WebhookLimitExceededError) {
      throw new UnprocessableEntityException({
        code: 'webhook_limit_exceeded',
        limit: err.limit,
        message: err.message,
      });
    }
    if (err instanceof WebhookDuplicateUrlError) {
      throw new ConflictException({
        code: 'webhook_url_duplicate',
        message: err.message,
      });
    }
    throw err;
  }
}
