import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
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

/** Catálogo de áreas para que el diálogo del escudo no las duplique en el front. */
@ApiTags('Admin · Moderación')
@ApiBearerAuth()
@Controller('admin/restriction-scopes')
@UseGuards(JwtAuthGuard)
export class RestrictionScopesController {
  @Get()
  @ApiOperation({ summary: 'Áreas sancionables disponibles.' })
  list(@CurrentUser() user: SessionClaims | undefined) {
    requireAdmin(user);
    return { scopes: ALL_SCOPES };
  }
}
