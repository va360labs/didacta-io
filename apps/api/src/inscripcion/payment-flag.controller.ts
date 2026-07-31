/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  Delete,
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
import { extractClientContext } from '../auth/client-context';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import {
  paymentFlagImportSchema,
  paymentFlagUpsertSchema,
  type PaymentFlagImportDto,
  type PaymentFlagUpsertDto,
} from './inscripcion.dto';
import { MemberPaymentFlagService } from './member-payment-flag.service';

// ============================================================================
// Controller ADMIN de la gestión de impagos (tabla member_payment_flag). El
// flag de impago alimenta la validación manual del flujo de inscripción. Solo
// roles admin del tenant pueden operar. El tenant sale del JWT (no del Host).
// ============================================================================

/** Roles autorizados a gestionar impagos. Clon de AdminUsersController. */
const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

function requireAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new ForbiddenException('Esta acción requiere rol de administrador.');
  }
  return user;
}

@ApiTags('Admin · Impagos de inscripción')
@ApiBearerAuth()
@Controller('inscripcion/payment-flags')
@UseGuards(JwtAuthGuard)
export class PaymentFlagController {
  constructor(private readonly service: MemberPaymentFlagService) {}

  @Get()
  @ApiOperation({
    summary:
      'Lista los flags de impago del tenant. Filtros opcionales: ?delinquentOnly=true y ?q=<texto>.',
  })
  async list(
    @CurrentUser() user: SessionClaims | undefined,
    @Query('delinquentOnly') delinquentOnly?: string,
    @Query('q') q?: string,
  ) {
    const u = requireAdmin(user);
    return this.service.list(u.tenantId, {
      delinquentOnly: delinquentOnly === 'true',
      q,
    });
  }

  @Post()
  @ApiOperation({
    summary: 'Crea o actualiza el flag de impago de un telegramId (idempotente por telegramId).',
  })
  async upsert(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(paymentFlagUpsertSchema)) dto: PaymentFlagUpsertDto,
  ) {
    const u = requireAdmin(user);
    return this.service.upsert(u.tenantId, dto, u.sub, extractClientContext(req));
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Elimina un flag de impago por id (acotado al tenant).' })
  async remove(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = requireAdmin(user);
    await this.service.remove(u.tenantId, id, u.sub);
    return { ok: true };
  }

  @Post('import')
  @ApiOperation({ summary: 'Importa flags de impago en bloque (carga CSV) de forma atómica.' })
  async import(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(paymentFlagImportSchema)) dto: PaymentFlagImportDto,
  ) {
    const u = requireAdmin(user);
    return this.service.importCsv(u.tenantId, dto.rows, u.sub, extractClientContext(req));
  }
}
