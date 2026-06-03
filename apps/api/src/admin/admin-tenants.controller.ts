import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
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
import { AdminTenantsService } from './admin-tenants.service';

const createTenantSchema = z.object({
  slug: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  adminEmail: z.string().email().max(200),
  adminName: z.string().min(1).max(120).optional(),
  primaryHostname: z.string().min(1).max(253),
});
type CreateTenantDto = z.infer<typeof createTenantSchema>;

const setStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']),
});
type SetStatusDto = z.infer<typeof setStatusSchema>;

const renameSchema = z.object({
  name: z.string().min(1).max(120),
});
type RenameDto = z.infer<typeof renameSchema>;

const domainSchema = z.object({
  hostname: z.string().min(1).max(253),
});
type DomainDto = z.infer<typeof domainSchema>;

function requireSuperAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.includes('super_admin')) {
    throw new ForbiddenException('Esta acción requiere rol super_admin.');
  }
  return user;
}

@ApiTags('Admin · Tenants')
@ApiBearerAuth()
@Controller('admin/tenants')
@UseGuards(JwtAuthGuard)
export class AdminTenantsController {
  constructor(private readonly service: AdminTenantsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar todos los tenants. Solo super_admin.' })
  async list(@CurrentUser() user: SessionClaims | undefined) {
    requireSuperAdmin(user);
    return this.service.list();
  }

  @Get('capacity')
  @ApiOperation({
    summary:
      '11º piloto License SDK — informa cuántos tenants hay y si la licencia EE permite crear más (feat:multi_tenant.real). Solo super_admin.',
  })
  async capacity(@CurrentUser() user: SessionClaims | undefined) {
    requireSuperAdmin(user);
    return this.service.getCapacityInfo();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de un tenant. Solo super_admin.' })
  async getOne(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    requireSuperAdmin(user);
    return this.service.getDetail(id);
  }

  @Post()
  @ApiOperation({
    summary:
      'Crear tenant + primer tenant_admin + dominio primario. Envía email de bienvenida con link de definir contraseña.',
  })
  async create(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createTenantSchema)) dto: CreateTenantDto,
  ) {
    const u = requireSuperAdmin(user);
    const webBaseUrl = process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000';
    return this.service.create(u.sub, dto, webBaseUrl, extractClientContext(req));
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Cambiar estado del tenant. SUSPENDED/ARCHIVED invalidan sessions de todos los users.',
  })
  async setStatus(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setStatusSchema)) dto: SetStatusDto,
  ) {
    const u = requireSuperAdmin(user);
    return this.service.setStatus(u.sub, id, dto.status, extractClientContext(req));
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Renombrar tenant (`tenant.name`). Afecta firma de emails ("Equipo {name}") y sidebar. Solo super_admin.',
  })
  async rename(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(renameSchema)) dto: RenameDto,
  ) {
    const u = requireSuperAdmin(user);
    return this.service.rename(u.sub, id, dto.name, extractClientContext(req));
  }

  @Post(':id/domains')
  @ApiOperation({ summary: 'Añadir dominio adicional al tenant.' })
  async addDomain(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(domainSchema)) dto: DomainDto,
  ) {
    const u = requireSuperAdmin(user);
    return this.service.addDomain(u.sub, id, dto.hostname, extractClientContext(req));
  }

  @Delete(':id/domains/:hostname')
  @ApiOperation({ summary: 'Quitar dominio del tenant. No permite quitar el primario.' })
  async removeDomain(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Param('hostname') hostname: string,
  ) {
    const u = requireSuperAdmin(user);
    return this.service.removeDomain(u.sub, id, hostname, extractClientContext(req));
  }
}
