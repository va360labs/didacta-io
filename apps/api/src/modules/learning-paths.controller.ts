/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  LearningPathAlreadyEnrolledError,
  LearningPathEnrollmentNotFoundError,
  LearningPathNoCourseError,
  LearningPathNotFoundError,
  LearningPathNotPublishedError,
} from '@didacta/mod-learning';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { ModuleRegistryService } from './module-registry.service';

const EDITOR_ROLES = new Set(['super_admin', 'tenant_admin', 'formador']);

const createPathSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  sequenceType: z.enum(['LINEAR', 'FLEXIBLE']).optional(),
});

const updatePathSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  sequenceType: z.enum(['LINEAR', 'FLEXIBLE']).optional(),
  estimatedMinutes: z.number().int().min(1).optional(),
  courses: z
    .array(z.object({ courseId: z.string().uuid(), position: z.number().int().min(0) }))
    .optional(),
});

function requireEditor(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => EDITOR_ROLES.has(r))) {
    throw new ForbiddenException({
      message: 'Esta acción requiere rol formador o admin.',
      code: 'LEARNING_REQUIRES_EDITOR_ROLE',
    });
  }
  return user;
}

function mapError(err: unknown): never {
  // Se preserva el `code` del error de dominio (LEARNING_PATH_*) en el body
  // para que el front lo traduzca; el mensaje es-ES queda como fallback.
  if (err instanceof LearningPathNotFoundError)
    throw new NotFoundException({ message: err.message, code: err.code });
  if (err instanceof LearningPathNotPublishedError)
    throw new NotFoundException({ message: err.message, code: err.code });
  if (err instanceof LearningPathAlreadyEnrolledError)
    throw new ConflictException({ message: err.message, code: err.code });
  if (err instanceof LearningPathEnrollmentNotFoundError)
    throw new NotFoundException({ message: err.message, code: err.code });
  if (err instanceof LearningPathNoCourseError)
    throw new BadRequestException({ message: err.message, code: err.code });
  throw err as Error;
}

@ApiTags('Modules · Learning Paths')
@ApiBearerAuth()
@Controller('modules/learning/paths')
@UseGuards(JwtAuthGuard)
export class LearningPathsController {
  constructor(private readonly registry: ModuleRegistryService) {}

  @Get()
  @ApiOperation({ summary: 'Listar rutas publicadas del tenant con progreso del usuario' })
  async listPaths(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getLearningPathsService().listPaths(user.tenantId, user.sub);
  }

  @Get('formador')
  @ApiOperation({ summary: 'Panel formador: listar todas las rutas del tenant (cualquier estado)' })
  async listPathsByFormador(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireEditor(user);
    return this.registry.getLearningPathsService().listPathsByFormador(u.tenantId);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Detalle de una ruta publicada con cursos y estado del usuario' })
  async getPath(@CurrentUser() user: SessionClaims | undefined, @Param('slug') slug: string) {
    if (!user) throw new UnauthorizedException();
    try {
      return await this.registry.getLearningPathsService().getPath(user.tenantId, slug, user.sub);
    } catch (err) {
      mapError(err);
    }
  }

  @Post()
  @ApiOperation({ summary: 'Crear nueva ruta de aprendizaje (formador / admin)' })
  async createPath(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createPathSchema))
    dto: z.infer<typeof createPathSchema>,
  ) {
    const u = requireEditor(user);
    return this.registry.getLearningPathsService().createPath(u.tenantId, u.sub, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Actualizar título, descripción, tipo de secuencia y cursos de la ruta',
  })
  async updatePath(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updatePathSchema))
    dto: z.infer<typeof updatePathSchema>,
  ) {
    const u = requireEditor(user);
    try {
      return await this.registry.getLearningPathsService().updatePath(u.tenantId, id, dto);
    } catch (err) {
      mapError(err);
    }
  }

  @Post(':id/publish')
  @HttpCode(200)
  @ApiOperation({ summary: 'Publicar o despublicar una ruta (toggle DRAFT ↔ PUBLISHED)' })
  async publishPath(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = requireEditor(user);
    try {
      return await this.registry.getLearningPathsService().publishPath(u.tenantId, id);
    } catch (err) {
      mapError(err);
    }
  }

  @Post(':id/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Archivar una ruta' })
  async archivePath(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = requireEditor(user);
    try {
      return await this.registry.getLearningPathsService().archivePath(u.tenantId, id);
    } catch (err) {
      mapError(err);
    }
  }

  @Post(':id/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Restaurar una ruta archivada a DRAFT' })
  async restorePath(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = requireEditor(user);
    try {
      return await this.registry.getLearningPathsService().restorePath(u.tenantId, id);
    } catch (err) {
      mapError(err);
    }
  }

  @Post(':id/enroll')
  @HttpCode(200)
  @ApiOperation({ summary: 'Matricularse en una ruta (también matricula en cada curso)' })
  async enrollPath(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    try {
      return await this.registry.getLearningPathsService().enrollUser(user.tenantId, user.sub, id);
    } catch (err) {
      mapError(err);
    }
  }

  @Delete(':id/enroll')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancelar la matriculación en una ruta' })
  async cancelEnrollment(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    try {
      return await this.registry
        .getLearningPathsService()
        .cancelEnrollment(user.tenantId, user.sub, id);
    } catch (err) {
      mapError(err);
    }
  }
}

@ApiTags('Modules · Learning Paths')
@ApiBearerAuth()
@Controller('modules/learning/me/paths')
@UseGuards(JwtAuthGuard)
export class LearningPathsMeController {
  constructor(private readonly registry: ModuleRegistryService) {}

  @Get()
  @ApiOperation({ summary: 'Mis rutas de aprendizaje (ACTIVE + COMPLETED)' })
  async listMyPaths(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getLearningPathsService().listMyPaths(user.tenantId, user.sub);
  }
}
