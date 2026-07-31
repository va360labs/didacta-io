/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * MfaPolicyController — endpoints admin de la política MFA tenant-wide.
 *
 *   GET /api/v1/admin/mfa-policy
 *     Lectura disponible siempre (super_admin / tenant_admin) — el frontend
 *     necesita saber el estado para pintar el toggle (incluso si no hay
 *     licencia EE, porque debe mostrarlo gateado con upsell).
 *
 *   PUT /api/v1/admin/mfa-policy
 *     Mutación gateada por @RequiresCapability(MFA_ENFORCEMENT). Sin licencia
 *     EE devuelve 402 Payment Required vía LicenseExceptionFilter.
 *
 * Patrón gemelo de `white-label.controller.ee.ts` (gate completo) y
 * `audit.controller.ts` (gate selectivo) — el de aquí mezcla ambos: GET libre,
 * PUT gateado. La marcación EE va en cada handler (no a nivel de clase) porque
 * solo la mutación cambia comportamiento contractual.
 *
 * IMPORTANTE: el controller queda fuera de `MfaExempt`, así que un admin sin
 * mfaVerified=true no podrá acceder (ya está cubierto por el JwtAuthGuard
 * global). Esto evita que un super_admin sin MFA verificada cambie la
 * política y se auto-bloquee de la cuenta.
 */

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { LICENSE_CAPABILITIES, RequiresCapability } from '@didacta/license-sdk';
import { CurrentUser } from '../decorators';
import { JwtAuthGuard } from '../jwt-auth.guard';
import type { SessionClaims } from '../token.service';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { extractClientContext } from '../client-context';
import { PrismaAuditLogService } from '../../modules/prisma-audit-log.service';
import { updateMfaPolicyDtoSchema, type UpdateMfaPolicyDto } from './mfa-policy.dto';
import { MfaPolicyService } from './mfa-policy.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

function requireTenantAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new ForbiddenException(
      'Solo super_admin y tenant_admin pueden gestionar la política MFA.',
    );
  }
  return user;
}

@ApiTags('Auth · MFA Policy')
@ApiBearerAuth()
@Controller('admin/mfa-policy')
@UseGuards(JwtAuthGuard)
export class MfaPolicyController {
  constructor(
    private readonly policyService: MfaPolicyService,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Devuelve la política MFA tenant-wide (requiredForAll, gracePeriodDays) + flag derivado ' +
      '`enforcementActive` (capability EE activa AND requiredForAll=true).',
  })
  @ApiResponse({ status: 200, description: 'Política actual.' })
  @ApiResponse({ status: 403, description: 'Solo super_admin / tenant_admin.' })
  async get(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireTenantAdmin(user);
    return this.policyService.getPolicy(u.tenantId);
  }

  @Put()
  @RequiresCapability(LICENSE_CAPABILITIES.MFA_ENFORCEMENT)
  @ApiOperation({
    summary:
      'Actualiza la política MFA tenant-wide. Requiere capability ' +
      '`feat:mfa.enforcement`. Sin licencia EE → 402 Payment Required. ' +
      'Cada cambio queda registrado en el audit log.',
  })
  @ApiResponse({ status: 200, description: 'Política actualizada.' })
  @ApiResponse({ status: 402, description: 'Capability `feat:mfa.enforcement` no licenciada.' })
  @ApiResponse({ status: 403, description: 'Solo super_admin / tenant_admin.' })
  async update(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(updateMfaPolicyDtoSchema)) dto: UpdateMfaPolicyDto,
  ) {
    const u = requireTenantAdmin(user);
    const previous = await this.policyService.getPolicy(u.tenantId);
    const next = await this.policyService.updatePolicy(u.tenantId, dto, { userId: u.sub });

    const ctx = extractClientContext(req);
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'auth.mfa_policy.updated',
      resourceType: 'tenant',
      resourceId: u.tenantId,
      metadata: {
        previous: {
          requiredForAll: previous.policy.requiredForAll,
          gracePeriodDays: previous.policy.gracePeriodDays,
        },
        next: {
          requiredForAll: next.requiredForAll,
          gracePeriodDays: next.gracePeriodDays,
        },
      },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return {
      policy: next,
      enforcementActive: previous.licensed && next.requiredForAll,
      capability: LICENSE_CAPABILITIES.MFA_ENFORCEMENT,
      licensed: previous.licensed,
    };
  }
}
