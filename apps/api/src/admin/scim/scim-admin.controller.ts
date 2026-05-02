/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Endpoints admin para gestionar el token SCIM del tenant — séptimo piloto
 * License SDK (`feat:scim`).
 *
 *   GET    /api/v1/admin/scim/token   → estado actual del token (sin valor).
 *   POST   /api/v1/admin/scim/token   → genera token nuevo (devuelve UNA sola vez).
 *   DELETE /api/v1/admin/scim/token   → revoca el token actual.
 *
 * Estos endpoints van con JWT estándar (admin loguea con email/password) +
 * `feat:scim` capability. Distinto de `/scim/v2/...` que usan Bearer estático
 * desde el IdP.
 *
 * El token plano se devuelve UNA SOLA VEZ tras `POST`; el admin tiene que
 * copiarlo y pegarlo en el panel del IdP. Despues sólo persiste el hash. Mismo
 * patrón que webhook secrets de Stripe / GitHub deploy keys / API tokens de
 * GitHub.
 *
 * Why hashed-only persistence:
 *   Si alguien comprometiera la DB del tenant, no podría usar el token SCIM
 *   para hacer requests — sólo el hash. Y como el hash es sha256, no se puede
 *   reversa para reconstruir el plano.
 */

import { randomUUID, createHash } from 'node:crypto';
import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
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
import { extractClientContext } from '../../auth/client-context';
import { PrismaAuditLogService } from '../../modules/prisma-audit-log.service';
import { PrismaTenantConfigService } from '../../modules/prisma-tenant-config.service';
import {
  SCIM_TOKEN_KEY,
  SCIM_TOKEN_MODULE_NAME,
  type ScimApiTokenRecord,
} from '../../scim/scim.types';
import { hashScimToken } from '../../scim/scim-auth.guard';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

function requireTenantAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new ForbiddenException('Solo super_admin y tenant_admin pueden gestionar el token SCIM.');
  }
  return user;
}

/**
 * Genera un token plano con prefijo identificable (`scim_`) seguido de 36
 * caracteres aleatorios derivados de un UUID v4 + sha256 (base64url para
 * compactar). Equivalente a ~256 bits de entropía.
 *
 * Prefijo `scim_`:
 *   Útil para que herramientas de scanning (TruffleHog, GitGuardian) detecten
 *   tokens filtrados con regex. También permite al admin distinguir de un
 *   vistazo entre webhook secret, API key y SCIM token.
 */
export function generateScimToken(): string {
  const seed = randomUUID() + '|' + randomUUID();
  const hash = createHash('sha256').update(seed).digest('base64url');
  // 43 chars de base64url (256 bits) más prefijo identificable.
  return `scim_${hash}`;
}

@ApiTags('SCIM · Admin Token')
@ApiBearerAuth()
@Controller('admin/scim/token')
@UseGuards(JwtAuthGuard)
export class ScimAdminTokenController {
  constructor(
    private readonly tenantConfig: PrismaTenantConfigService,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  @Get()
  @RequiresCapability(LICENSE_CAPABILITIES.SCIM)
  @ApiOperation({
    summary:
      'Devuelve el estado del token SCIM del tenant: si existe, prefix + ' +
      'createdAt + lastUsedAt. NO devuelve el token plano (sólo se entrega ' +
      'al crear). Requiere capability `feat:scim`.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 402, description: 'Capability `feat:scim` no licenciada.' })
  async status(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireTenantAdmin(user);
    const record = await this.loadRecord(u.tenantId);
    if (!record) {
      return { active: false };
    }
    return {
      active: true,
      prefix: record.prefix,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequiresCapability(LICENSE_CAPABILITIES.SCIM)
  @ApiOperation({
    summary:
      'Genera un token nuevo. SI ya existía uno → lo reemplaza (el anterior ' +
      'queda revocado). El token plano se devuelve UNA SOLA VEZ; copialo en ' +
      'el panel del IdP. Después sólo verás el prefix.',
  })
  @ApiResponse({
    status: 201,
    description: 'Token creado. Body: { token, prefix, createdAt }.',
  })
  @ApiResponse({ status: 402 })
  async create(@Req() req: FastifyRequest, @CurrentUser() user: SessionClaims | undefined) {
    const u = requireTenantAdmin(user);
    const previous = await this.loadRecord(u.tenantId);

    const token = generateScimToken();
    const tokenHash = hashScimToken(token);
    // Prefix = "scim_" + primeros 8 chars del hash plano. El admin lo ve en
    // el panel y puede correlacionar con el token que copió.
    const prefix = token.slice(0, 13);
    const createdAt = new Date().toISOString();
    const record: ScimApiTokenRecord = {
      tokenHash,
      prefix,
      createdAt,
      lastUsedAt: null,
    };

    await this.tenantConfig.set<ScimApiTokenRecord>(
      u.tenantId,
      SCIM_TOKEN_MODULE_NAME,
      SCIM_TOKEN_KEY,
      record,
      { isSecret: false, actorId: u.sub },
    );

    const ctx = extractClientContext(req);
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: previous ? 'scim.token.rotated' : 'scim.token.created',
      resourceType: 'scim_token',
      resourceId: u.tenantId,
      metadata: { prefix, hadPrevious: previous !== null },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    // ÚNICO momento en el que devolvemos el token plano.
    return {
      token,
      prefix,
      createdAt,
      warning:
        'Este token solo se muestra UNA VEZ. Copialo y pegalo en el panel del IdP ahora; ' +
        'no podrás recuperarlo más adelante. Si lo perdés, generá uno nuevo (revoca el anterior).',
    };
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(LICENSE_CAPABILITIES.SCIM)
  @ApiOperation({
    summary:
      'Revoca el token SCIM del tenant. El IdP empezará a recibir 401 ' +
      'inmediatamente. Si quieres volver a habilitarlo, llamá POST.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 402 })
  async revoke(@Req() req: FastifyRequest, @CurrentUser() user: SessionClaims | undefined) {
    const u = requireTenantAdmin(user);
    const previous = await this.loadRecord(u.tenantId);
    if (!previous) {
      return { revoked: false, message: 'No había token activo.' };
    }

    await this.tenantConfig.delete(u.tenantId, SCIM_TOKEN_MODULE_NAME, SCIM_TOKEN_KEY, {
      actorId: u.sub,
    });

    const ctx = extractClientContext(req);
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'scim.token.revoked',
      resourceType: 'scim_token',
      resourceId: u.tenantId,
      metadata: { prefix: previous.prefix },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return { revoked: true, prefix: previous.prefix };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async loadRecord(tenantId: string): Promise<ScimApiTokenRecord | null> {
    const record = await this.tenantConfig.get<ScimApiTokenRecord>(
      tenantId,
      SCIM_TOKEN_MODULE_NAME,
      SCIM_TOKEN_KEY,
    );
    if (!record || typeof record.tokenHash !== 'string') return null;
    return record;
  }
}
