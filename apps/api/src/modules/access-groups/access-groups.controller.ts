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
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import {
  assignAccessGroupMembersSchema,
  createAccessGroupSchema,
  setAccessGroupCoursesSchema,
  updateAccessGroupSchema,
  type AssignAccessGroupMembersDto,
  type CreateAccessGroupDto,
  type SetAccessGroupCoursesDto,
  type UpdateAccessGroupDto,
} from '@didacta/mod-access-groups';
import { AccessGroupsService } from './access-groups.service';

const ADMIN_ROLES = ['super_admin', 'tenant_admin'];

/**
 * mod.access-groups (Fase 2) — gestión de grupos de acceso. Es una pantalla de
 * administración: TODOS los endpoints (incluidas las lecturas list/detalle, que
 * exponen el roster de membresía) requieren rol super_admin / tenant_admin. La
 * lógica vive en AccessGroupsService.
 */
@ApiTags('Modules · Access Groups')
@ApiBearerAuth()
@Controller('modules/access-groups')
@UseGuards(JwtAuthGuard)
export class AccessGroupsController {
  constructor(private readonly service: AccessGroupsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista grupos de acceso del tenant (paginada)' })
  async list(
    @CurrentUser() user: SessionClaims | undefined,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const u = this.requireAdmin(user);
    return this.service.listGroups(
      u.tenantId,
      parseInt(page ?? '1', 10) || 1,
      parseInt(limit ?? '20', 10) || 20,
    );
  }

  @Get('catalog/courses')
  @ApiOperation({ summary: 'Cursos publicados del tenant (selector de grupo)' })
  async courseCatalog(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    return this.service.listCourseCatalog(u.tenantId);
  }

  @Get('catalog/users')
  @ApiOperation({ summary: 'Usuarios candidatos para asignar a un grupo' })
  async userCatalog(@CurrentUser() user: SessionClaims | undefined, @Query('q') q?: string) {
    const u = this.requireAdmin(user);
    return this.service.listUserCandidates(u.tenantId, q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle del grupo (cursos + miembros)' })
  async get(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    return this.service.getGroup(u.tenantId, id);
  }

  @Post()
  @ApiOperation({ summary: 'Crear grupo de acceso (admin)' })
  async create(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createAccessGroupSchema)) dto: CreateAccessGroupDto,
  ) {
    const u = this.requireAdmin(user);
    return this.service.createGroup(u.tenantId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Editar grupo (admin)' })
  async update(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateAccessGroupSchema)) dto: UpdateAccessGroupDto,
  ) {
    const u = this.requireAdmin(user);
    return this.service.updateGroup(u.tenantId, id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Eliminar grupo (admin) — revoca membresías' })
  async remove(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    return this.service.deleteGroup(u.tenantId, id);
  }

  @Put(':id/courses')
  @ApiOperation({ summary: 'Reemplaza el set de cursos del grupo (admin)' })
  async setCourses(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setAccessGroupCoursesSchema)) dto: SetAccessGroupCoursesDto,
  ) {
    const u = this.requireAdmin(user);
    return this.service.setGroupCourses(u.tenantId, id, dto);
  }

  @Post(':id/members')
  @HttpCode(200)
  @ApiOperation({ summary: 'Asignar miembros al grupo (admin)' })
  async assign(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assignAccessGroupMembersSchema)) dto: AssignAccessGroupMembersDto,
  ) {
    const u = this.requireAdmin(user);
    return this.service.assignMembers(u.tenantId, id, dto.userIds);
  }

  @Delete(':id/members/:userId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revocar un miembro del grupo (admin)' })
  async revoke(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    const u = this.requireAdmin(user);
    return this.service.revokeMember(u.tenantId, id, userId);
  }

  private requireUser(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    return user;
  }

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    const u = this.requireUser(user);
    if (!u.roles.some((r) => ADMIN_ROLES.includes(r))) {
      throw new ForbiddenException({
        message: 'Requiere rol super_admin o tenant_admin',
        code: 'ACCESS_GROUPS_ADMIN_ROLE_REQUIRED',
      });
    }
    return u;
  }
}
