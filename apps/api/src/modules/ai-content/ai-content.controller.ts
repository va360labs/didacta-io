/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { SessionClaims } from '../../auth/token.service';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { ModuleRegistryService } from '../module-registry.service';

const FORMADOR_ROLES = ['super_admin', 'tenant_admin', 'formador'] as const;

const generateSchema = z.object({
  lessonId: z.string().uuid(),
  courseId: z.string().uuid(),
  type: z.enum(['SUMMARY', 'FLASHCARDS', 'QUIZ']),
});

const updateContentSchema = z.object({
  type: z.enum(['SUMMARY', 'FLASHCARDS', 'QUIZ']),
  content: z.record(z.unknown()),
});

const rejectSchema = z.object({
  reason: z.string().max(500).optional(),
});

const listFiltersSchema = z.object({
  lessonId: z.string().uuid().optional(),
  courseId: z.string().uuid().optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'REJECTED']).optional(),
});

type GenerateDto = z.infer<typeof generateSchema>;
type UpdateContentDto = z.infer<typeof updateContentSchema>;
type RejectDto = z.infer<typeof rejectSchema>;

function requireFormador(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  const allowed = user.roles.some((r) => (FORMADOR_ROLES as readonly string[]).includes(r));
  if (!allowed) {
    throw new ForbiddenException({
      message: 'Esta acción requiere rol formador, tenant_admin o super_admin.',
      code: 'AI_CONTENT_STAFF_ROLE_REQUIRED',
    });
  }
  return user;
}

@ApiTags('AI Content · Formador')
@Controller('modules/ai-content')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AiContentController {
  constructor(private readonly registry: ModuleRegistryService) {}

  @Post('generate')
  @ApiOperation({
    summary:
      'Genera un draft (SUMMARY/FLASHCARDS/QUIZ) de la lección. Devuelve el draft en estado DRAFT, listo para revisar.',
  })
  async generate(
    @Body(new ZodValidationPipe(generateSchema)) dto: GenerateDto,
    @CurrentUser() user: SessionClaims | undefined,
  ) {
    const u = requireFormador(user);
    const draft = await this.registry.getAiContentService().generate({
      tenantId: u.tenantId,
      requestedBy: u.sub,
      lessonId: dto.lessonId,
      courseId: dto.courseId,
      type: dto.type,
    });
    return { draft };
  }

  @Get('drafts')
  @ApiOperation({
    summary: 'Lista drafts del tenant. Filtros opcionales por lessonId, courseId, status.',
  })
  async list(
    @Query(new ZodValidationPipe(listFiltersSchema))
    filters: z.infer<typeof listFiltersSchema>,
    @CurrentUser() user: SessionClaims | undefined,
  ) {
    const u = requireFormador(user);
    const drafts = await this.registry.getAiContentService().listDrafts({
      tenantId: u.tenantId,
      lessonId: filters.lessonId,
      courseId: filters.courseId,
      status: filters.status,
    });
    return { drafts };
  }

  @Get('drafts/:id')
  @ApiOperation({ summary: 'Detalle de un draft.' })
  async get(@Param('id') id: string, @CurrentUser() user: SessionClaims | undefined) {
    const u = requireFormador(user);
    const draft = await this.registry.getAiContentService().getDraft(u.tenantId, id);
    return { draft };
  }

  @Patch('drafts/:id/content')
  @ApiOperation({
    summary: 'Edita el content JSON del draft (solo en estado DRAFT). Revalida shape.',
  })
  async updateContent(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateContentSchema)) dto: UpdateContentDto,
    @CurrentUser() user: SessionClaims | undefined,
  ) {
    const u = requireFormador(user);
    const draft = await this.registry.getAiContentService().updateContent({
      tenantId: u.tenantId,
      draftId: id,
      type: dto.type,
      content: dto.content as never,
    });
    return { draft };
  }

  @Patch('drafts/:id/publish')
  @ApiOperation({ summary: 'Publica el draft (transición DRAFT → PUBLISHED).' })
  async publish(@Param('id') id: string, @CurrentUser() user: SessionClaims | undefined) {
    const u = requireFormador(user);
    const draft = await this.registry.getAiContentService().publish(u.tenantId, u.sub, id);
    return { draft };
  }

  @Patch('drafts/:id/reject')
  @ApiOperation({ summary: 'Rechaza el draft con razón opcional (transición DRAFT → REJECTED).' })
  async reject(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rejectSchema)) dto: RejectDto,
    @CurrentUser() user: SessionClaims | undefined,
  ) {
    const u = requireFormador(user);
    const draft = await this.registry
      .getAiContentService()
      .reject(u.tenantId, u.sub, id, dto.reason);
    return { draft };
  }
}
