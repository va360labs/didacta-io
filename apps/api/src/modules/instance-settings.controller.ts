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
  NotFoundException,
  Param,
  Put,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import { PrismaInstanceConfigService } from './prisma-instance-config.service';

const ScopeKeyParamSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9._-]+$/i, 'Solo letras, números, ".", "_", "-"');

const SetInstanceSettingBodySchema = z.object({
  value: z.unknown(),
  isSecret: z.boolean().default(false),
});

function requireSuperAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.includes('super_admin')) {
    throw new ForbiddenException('Solo super_admin puede gestionar la configuración de instancia.');
  }
  return user;
}

function validateParam(name: string, value: string) {
  const r = ScopeKeyParamSchema.safeParse(value);
  if (!r.success) {
    throw new NotFoundException(`Parámetro ${name} inválido`);
  }
  return r.data;
}

/**
 * Config a nivel de instalación (licencia, telemetría, rate limits, crons):
 * la 10ª tabla global sin tenant_id descrita en `work/migracion-env-a-panel.md`
 * §7.1. super_admin-only — es una decisión del operador, nunca de un tenant.
 * Los valores marcados `isSecret` nunca se devuelven en claro (solo metadata).
 */
@ApiTags('Admin Instance Settings')
@ApiBearerAuth()
@Controller('admin/instance-settings')
@UseGuards(JwtAuthGuard)
export class InstanceSettingsController {
  constructor(private readonly settings: PrismaInstanceConfigService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar todos los settings de instancia (metadata sin valores secretos)',
  })
  async listAll(@CurrentUser() user: SessionClaims | undefined) {
    requireSuperAdmin(user);
    return this.settings.list();
  }

  @Get(':scope')
  @ApiOperation({ summary: 'Listar settings de un scope específico' })
  async listScope(@CurrentUser() user: SessionClaims | undefined, @Param('scope') scope: string) {
    requireSuperAdmin(user);
    const validScope = validateParam('scope', scope);
    return this.settings.list(validScope);
  }

  @Get(':scope/:key')
  @ApiOperation({
    summary: 'Leer un setting. Los secretos devuelven solo metadata (hasValue), nunca el valor.',
  })
  async getOne(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('scope') scope: string,
    @Param('key') key: string,
  ) {
    requireSuperAdmin(user);
    const validScope = validateParam('scope', scope);
    const validKey = validateParam('key', key);
    const list = await this.settings.list(validScope);
    const meta = list.find((m) => m.key === validKey);
    if (!meta) throw new NotFoundException();
    if (meta.isSecret) return meta;
    const value = await this.settings.get(validScope, validKey);
    return { ...meta, value: value ?? null };
  }

  @Put(':scope/:key')
  @ApiOperation({
    summary: 'Crear o actualizar un setting de instancia (cifrado si isSecret=true)',
  })
  async upsert(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('scope') scope: string,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(SetInstanceSettingBodySchema))
    body: z.infer<typeof SetInstanceSettingBodySchema>,
  ) {
    const claims = requireSuperAdmin(user);
    const validScope = validateParam('scope', scope);
    const validKey = validateParam('key', key);
    await this.settings.set(validScope, validKey, body.value, {
      isSecret: body.isSecret,
      actorId: claims.sub,
    });
    return { ok: true };
  }

  @Delete(':scope/:key')
  @ApiOperation({ summary: 'Eliminar un setting de instancia' })
  async remove(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('scope') scope: string,
    @Param('key') key: string,
  ) {
    const claims = requireSuperAdmin(user);
    const validScope = validateParam('scope', scope);
    const validKey = validateParam('key', key);
    await this.settings.delete(validScope, validKey, { actorId: claims.sub });
    return { ok: true };
  }
}
