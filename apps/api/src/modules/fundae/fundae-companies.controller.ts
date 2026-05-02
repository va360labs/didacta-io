import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createCompanySchema,
  updateCompanySchema,
  type CreateCompanyDto,
  type UpdateCompanyDto,
} from '@didacta/mod-fundae';
import { z } from 'zod';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { ModuleRegistryService } from '../module-registry.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

const listQuerySchema = z.object({
  search: z.string().max(200).optional(),
  includeDeleted: z.enum(['true', 'false']).optional(),
});

/**
 * Endpoints CRUD de empresas bonificadas Fundae (LMS-79).
 * Path: `/api/v1/admin/fundae/companies` — bajo el prefijo admin para
 * que el guard MFA aplique automáticamente y para coincidir con la URL
 * que la UI Next.js consume desde `/admin/fundae/empresas`.
 */
@ApiTags('Admin · Fundae · Empresas')
@ApiBearerAuth()
@Controller('admin/fundae/companies')
@UseGuards(JwtAuthGuard)
export class FundaeCompaniesController {
  constructor(private readonly registry: ModuleRegistryService) {}

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new UnauthorizedException(
        'Solo super_admin y tenant_admin pueden gestionar empresas bonificadas.',
      );
    }
    return user;
  }

  @Get()
  @ApiOperation({
    summary: 'Listar empresas bonificadas del tenant. Soporta search + includeDeleted.',
  })
  async list(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(listQuerySchema)) q: z.infer<typeof listQuerySchema>,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeCompanyService().list(u.tenantId, {
      search: q.search,
      includeDeleted: q.includeDeleted === 'true',
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de una empresa bonificada.' })
  async get(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeCompanyService().get(u.tenantId, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Crear empresa bonificada. NIF se normaliza y valida con checksum español.',
  })
  async create(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createCompanySchema)) dto: CreateCompanyDto,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeCompanyService().create(u.tenantId, u.sub, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Actualizar empresa. El NIF NO es editable: si la empresa cambia de NIF hay que crear una nueva por trazabilidad.',
  })
  async update(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateCompanySchema)) dto: UpdateCompanyDto,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeCompanyService().update(u.tenantId, u.sub, id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Soft-delete de empresa. Rechaza con 409 si tiene grupos bonificables activos vinculados.',
  })
  async remove(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    await this.registry.getFundaeCompanyService().softDelete(u.tenantId, u.sub, id);
    return { deleted: true };
  }
}
