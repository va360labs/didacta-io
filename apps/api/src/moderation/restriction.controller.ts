/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractClientContext } from '../auth/client-context';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import { DossierService } from './dossier.service';
import { ALL_SCOPES } from './restriction-scopes';
import { RestrictionService } from './restriction.service';

const createSchema = z.object({
  scopes: z.array(z.string()).min(1),
  reason: z.string().trim().min(1).max(500),
  /** ISO 8601. Ausente o null = permanente. */
  expiresAt: z.string().datetime().nullish(),
});
type CreateDto = z.infer<typeof createSchema>;

const liftSchema = z.object({
  liftReason: z.string().trim().max(500).nullish(),
});
type LiftDto = z.infer<typeof liftSchema>;

/** Tope del lote: el feed pinta 20-50 autores, no miles. */
const MAX_BATCH = 200;

const activeQuerySchema = z.object({
  userIds: z
    .string()
    .trim()
    .min(1)
    .max(MAX_BATCH * 40),
});
type ActiveQueryDto = z.infer<typeof activeQuerySchema>;

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

function requireAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new ForbiddenException('Esta acción requiere rol de administrador.');
  }
  return user;
}

@ApiTags('Admin · Moderación')
@ApiBearerAuth()
@Controller('admin/users/:userId/restrictions')
@UseGuards(JwtAuthGuard)
export class RestrictionController {
  constructor(private readonly service: RestrictionService) {}

  @Get()
  @ApiOperation({
    summary:
      'Histórico de sanciones del usuario (activas, caducadas y levantadas), más reciente primero.',
  })
  async list(@CurrentUser() user: SessionClaims | undefined, @Param('userId') userId: string) {
    const u = requireAdmin(user);
    return this.service.list(u.tenantId, userId);
  }

  @Post()
  @ApiOperation({
    summary:
      'Sancionar al usuario en una o varias áreas. Sigue pudiendo entrar y leer; no puede aportar contenido.',
  })
  async create(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(createSchema)) dto: CreateDto,
  ) {
    const u = requireAdmin(user);
    return this.service.create(
      u.tenantId,
      u.sub,
      userId,
      { scopes: dto.scopes, reason: dto.reason, expiresAt: dto.expiresAt ?? null },
      extractClientContext(req),
    );
  }

  @Post(':restrictionId/lift')
  @ApiOperation({ summary: 'Levantar una sanción. No borra la fila: la sella con liftedAt.' })
  async lift(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('restrictionId') restrictionId: string,
    @Body(new ZodValidationPipe(liftSchema)) dto: LiftDto,
  ) {
    const u = requireAdmin(user);
    return this.service.lift(
      u.tenantId,
      u.sub,
      restrictionId,
      dto.liftReason ?? null,
      extractClientContext(req),
    );
  }
}

/** Expediente completo del usuario. Solo admin, y cada consulta queda auditada. */
@ApiTags('Admin · Moderación')
@ApiBearerAuth()
@Controller('admin/users/:userId/dossier')
@UseGuards(JwtAuthGuard)
export class DossierController {
  constructor(private readonly service: DossierService) {}

  @Get()
  @ApiOperation({
    summary:
      'Expediente del usuario: identidad, compras, suscripción, formación, actividad, mensajes, gamificación, acceso y sanciones.',
  })
  async get(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('userId') userId: string,
  ) {
    const u = requireAdmin(user);
    return this.service.get(u.tenantId, u.sub, userId, extractClientContext(req));
  }
}

/** Catálogo de áreas y consulta por lotes para el escudo del feed. */
@ApiTags('Admin · Moderación')
@ApiBearerAuth()
@Controller('admin/restrictions')
@UseGuards(JwtAuthGuard)
export class RestrictionScopesController {
  constructor(private readonly service: RestrictionService) {}

  @Get('scopes')
  @ApiOperation({ summary: 'Áreas sancionables disponibles.' })
  scopes(@CurrentUser() user: SessionClaims | undefined) {
    requireAdmin(user);
    return { scopes: ALL_SCOPES };
  }

  @Get('active')
  @ApiOperation({
    summary:
      'Sanciones vigentes de varios usuarios (?userIds=a,b,c). Permite pintar el escudo del feed sin una petición por autor.',
  })
  active(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(activeQuerySchema)) query: ActiveQueryDto,
  ) {
    const u = requireAdmin(user);
    const ids = query.userIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_BATCH);
    return this.service.activeForMany(u.tenantId, ids);
  }
}
