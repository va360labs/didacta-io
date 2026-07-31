/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * CustomDomainsController — endpoints admin de dominios personalizados.
 *
 *   GET    /api/v1/admin/custom-domains
 *   POST   /api/v1/admin/custom-domains
 *   POST   /api/v1/admin/custom-domains/:id/verify
 *   PATCH  /api/v1/admin/custom-domains/:id
 *   DELETE /api/v1/admin/custom-domains/:id
 *
 * TODOS los endpoints van gateados por @RequiresCapability(CUSTOM_DOMAINS) —
 * esto difiere de `mfa-policy` (que tiene GET libre + PUT gateado) porque
 * aquí sin licencia EE el frontend no necesita siquiera el GET; muestra
 * directo el upsell card. Sin licencia → 402 Payment Required vía
 * LicenseExceptionFilter (registrado globalmente en `main.ts`).
 *
 * Cada acción persistente registra un entry en el audit log con prefijo
 * `tenancy.custom_domain.<verb>` para que el panel /admin/auditoria pueda
 * filtrar por tipo de evento.
 */

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { LICENSE_CAPABILITIES, RequiresCapability } from '@didacta/license-sdk';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { SessionClaims } from '../../auth/token.service';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { extractClientContext } from '../../auth/client-context';
import { PrismaAuditLogService } from '../../modules/prisma-audit-log.service';
import {
  addCustomDomainDtoSchema,
  setCustomDomainStatusDtoSchema,
  verifyCustomDomainDtoSchema,
  type AddCustomDomainDto,
  type SetCustomDomainStatusDto,
  type VerifyCustomDomainDto,
} from './custom-domains.dto';
import { CustomDomainsService } from './custom-domains.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

function requireTenantAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new ForbiddenException(
      'Solo super_admin y tenant_admin pueden gestionar dominios personalizados.',
    );
  }
  return user;
}

@ApiTags('Tenancy · Custom Domains')
@ApiBearerAuth()
@Controller('admin/custom-domains')
@UseGuards(JwtAuthGuard)
export class CustomDomainsController {
  constructor(
    private readonly domains: CustomDomainsService,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  @Get()
  @RequiresCapability(LICENSE_CAPABILITIES.CUSTOM_DOMAINS)
  @ApiOperation({
    summary:
      'Lista los dominios personalizados del tenant. Requiere capability ' +
      '`feat:custom_domains`. Sin licencia EE → 402.',
  })
  @ApiResponse({ status: 200, description: 'Lista de dominios.' })
  @ApiResponse({ status: 402, description: 'Capability `feat:custom_domains` no licenciada.' })
  @ApiResponse({ status: 403, description: 'Solo super_admin / tenant_admin.' })
  async list(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireTenantAdmin(user);
    const domains = await this.domains.listDomains(u.tenantId);
    return { domains, capability: LICENSE_CAPABILITIES.CUSTOM_DOMAINS };
  }

  @Post()
  @RequiresCapability(LICENSE_CAPABILITIES.CUSTOM_DOMAINS)
  @ApiOperation({
    summary:
      'Añade un nuevo dominio personalizado al tenant. Genera cnameTarget + ' +
      'verificationToken. Estado inicial: pending. Requiere capability ' +
      '`feat:custom_domains`.',
  })
  @ApiResponse({ status: 201, description: 'Dominio añadido (pending).' })
  @ApiResponse({ status: 402, description: 'Capability no licenciada.' })
  @ApiResponse({ status: 409, description: 'El hostname ya está registrado.' })
  async add(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(addCustomDomainDtoSchema)) dto: AddCustomDomainDto,
  ) {
    const u = requireTenantAdmin(user);
    const domain = await this.domains.addDomain(u.tenantId, dto, { userId: u.sub });

    const ctx = extractClientContext(req);
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'tenancy.custom_domain.added',
      resourceType: 'custom_domain',
      resourceId: domain.id,
      metadata: {
        hostname: domain.hostname,
        cnameTarget: domain.cnameTarget,
      },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
    return domain;
  }

  @Post(':id/verify')
  @RequiresCapability(LICENSE_CAPABILITIES.CUSTOM_DOMAINS)
  @ApiOperation({
    summary:
      'Marca un dominio como verified si el providedToken coincide con el ' +
      'verificationToken almacenado. En producción real esto lo dispara un ' +
      'cron de DNS-01 challenge; en este piloto la verificación es manual.',
  })
  @ApiResponse({ status: 200, description: 'Dominio verificado.' })
  @ApiResponse({ status: 402, description: 'Capability no licenciada.' })
  @ApiResponse({ status: 404, description: 'Dominio no encontrado.' })
  @ApiResponse({ status: 409, description: 'Token de verificación incorrecto.' })
  async verify(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(verifyCustomDomainDtoSchema)) dto: VerifyCustomDomainDto,
  ) {
    const u = requireTenantAdmin(user);
    const domain = await this.domains.verifyDomain(u.tenantId, id, dto, { userId: u.sub });

    const ctx = extractClientContext(req);
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'tenancy.custom_domain.verified',
      resourceType: 'custom_domain',
      resourceId: domain.id,
      metadata: {
        hostname: domain.hostname,
      },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
    return domain;
  }

  @Patch(':id')
  @RequiresCapability(LICENSE_CAPABILITIES.CUSTOM_DOMAINS)
  @ApiOperation({
    summary:
      'Cambia el estado del dominio entre verified e inactive (suspender/reactivar ' +
      'sin borrar). No permite volver a pending — para eso usa POST /verify.',
  })
  @ApiResponse({ status: 200, description: 'Estado actualizado.' })
  @ApiResponse({ status: 402, description: 'Capability no licenciada.' })
  @ApiResponse({ status: 404, description: 'Dominio no encontrado.' })
  async patch(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setCustomDomainStatusDtoSchema)) dto: SetCustomDomainStatusDto,
  ) {
    const u = requireTenantAdmin(user);
    const domain = await this.domains.setActive(u.tenantId, id, dto, { userId: u.sub });

    const ctx = extractClientContext(req);
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'tenancy.custom_domain.status_changed',
      resourceType: 'custom_domain',
      resourceId: domain.id,
      metadata: {
        hostname: domain.hostname,
        status: domain.status,
      },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
    return domain;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(LICENSE_CAPABILITIES.CUSTOM_DOMAINS)
  @ApiOperation({
    summary: 'Elimina un dominio personalizado del tenant. Requiere capability EE.',
  })
  @ApiResponse({ status: 200, description: 'Dominio eliminado.' })
  @ApiResponse({ status: 402, description: 'Capability no licenciada.' })
  @ApiResponse({ status: 404, description: 'Dominio no encontrado.' })
  async remove(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
  ) {
    const u = requireTenantAdmin(user);
    const removed = await this.domains.removeDomain(u.tenantId, id, { userId: u.sub });

    const ctx = extractClientContext(req);
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'tenancy.custom_domain.removed',
      resourceType: 'custom_domain',
      resourceId: removed.id,
      metadata: {
        hostname: removed.hostname,
      },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
    return { id: removed.id, removed: true };
  }
}
