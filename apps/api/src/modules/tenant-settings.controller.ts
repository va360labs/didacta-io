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
import { ModuleContextFactory } from './module-context.factory';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

const ScopeKeyParamSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9._-]+$/i, 'Solo letras, números, ".", "_", "-"');

const SetSettingBodySchema = z.object({
  value: z.unknown(),
  isSecret: z.boolean().default(false),
});

function requireAdmin(user: SessionClaims | undefined) {
  if (!user) throw new UnauthorizedException();
  const isAdmin = user.roles.some((r) => ADMIN_ROLES.has(r));
  if (!isAdmin) {
    throw new ForbiddenException('Solo super_admin o tenant_admin pueden gestionar settings');
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

@ApiTags('Tenant Settings')
@ApiBearerAuth()
@Controller('tenant-settings')
@UseGuards(JwtAuthGuard)
export class TenantSettingsController {
  constructor(private readonly modules: ModuleContextFactory) {}

  @Get()
  @ApiOperation({
    summary: 'Listar todos los settings del tenant del usuario (metadata sin valores secretos)',
  })
  async listAll(@CurrentUser() user: SessionClaims | undefined) {
    const claims = requireAdmin(user);
    const svc = this.modules.getTenantConfig();
    return svc.list(claims.tenantId);
  }

  @Get(':scope')
  @ApiOperation({ summary: 'Listar settings de un scope (módulo) específico' })
  async listScope(@CurrentUser() user: SessionClaims | undefined, @Param('scope') scope: string) {
    const claims = requireAdmin(user);
    const validScope = validateParam('scope', scope);
    const svc = this.modules.getTenantConfig();
    return svc.list(claims.tenantId, validScope);
  }

  @Get(':scope/:key')
  @ApiOperation({
    summary: 'Leer un setting. Para secretos solo se devuelve metadata (no el valor en claro).',
  })
  async getOne(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('scope') scope: string,
    @Param('key') key: string,
  ) {
    const claims = requireAdmin(user);
    const validScope = validateParam('scope', scope);
    const validKey = validateParam('key', key);
    const svc = this.modules.getTenantConfig();
    const list = await svc.list(claims.tenantId, validScope);
    const meta = list.find((m) => m.key === validKey);
    if (!meta) throw new NotFoundException();
    if (meta.isSecret) {
      return { ...meta, value: null };
    }
    const value = await svc.get(claims.tenantId, validScope, validKey);
    return { ...meta, value: value ?? null };
  }

  @Put(':scope/:key')
  @ApiOperation({ summary: 'Crear o actualizar un setting (cifrado si isSecret=true)' })
  async upsert(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('scope') scope: string,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(SetSettingBodySchema))
    body: z.infer<typeof SetSettingBodySchema>,
  ) {
    const claims = requireAdmin(user);
    const validScope = validateParam('scope', scope);
    const validKey = validateParam('key', key);
    const svc = this.modules.getTenantConfig();
    await svc.set(claims.tenantId, validScope, validKey, body.value, {
      isSecret: body.isSecret,
      actorId: claims.sub,
    });
    return { ok: true };
  }

  @Delete(':scope/:key')
  @ApiOperation({ summary: 'Eliminar un setting' })
  async remove(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('scope') scope: string,
    @Param('key') key: string,
  ) {
    const claims = requireAdmin(user);
    const validScope = validateParam('scope', scope);
    const validKey = validateParam('key', key);
    const svc = this.modules.getTenantConfig();
    await svc.delete(claims.tenantId, validScope, validKey, { actorId: claims.sub });
    return { ok: true };
  }
}
