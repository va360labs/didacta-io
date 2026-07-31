/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  suggestForAttemptSchema,
  upsertRubricSchema,
  type SuggestForAttemptDto,
  type UpsertRubricDto,
} from '@didacta/mod-ai-grader';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { ModuleRegistryService } from '../module-registry.service';

const FORMADOR_ROLES = new Set(['super_admin', 'tenant_admin', 'formador']);

/**
 * Endpoints REST de mod.ai-grader (LMS-91.C).
 *
 *  Rúbricas (formador del curso o admin):
 *    GET  /modules/ai-grader/questions/:questionId/rubric
 *    PUT  /modules/ai-grader/questions/:questionId/rubric
 *    DELETE /modules/ai-grader/questions/:questionId/rubric
 *
 *  Sugerencias (formador en vista de corrección):
 *    POST /modules/ai-grader/attempts/:attemptId/suggest
 *    GET  /modules/ai-grader/attempts/:attemptId/suggestions
 *    POST /modules/ai-grader/suggestions/:id/apply
 */
@ApiTags('Modules · AI Grader')
@ApiBearerAuth()
@Controller('modules/ai-grader')
@UseGuards(JwtAuthGuard)
export class AiGraderController {
  constructor(private readonly registry: ModuleRegistryService) {}

  private requireFormador(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => FORMADOR_ROLES.has(r))) {
      throw new UnauthorizedException('Solo formadores y admins pueden usar AI Grader.');
    }
    return user;
  }

  @Get('questions/:questionId/rubric')
  @ApiOperation({
    summary: 'Devuelve la rúbrica de la pregunta o null si no hay configurada.',
  })
  async getRubric(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('questionId') questionId: string,
  ) {
    const u = this.requireFormador(user);
    return this.registry.getAiGraderRubricService().get(u.tenantId, questionId);
  }

  @Put('questions/:questionId/rubric')
  @ApiOperation({
    summary: 'Crea o reemplaza la rúbrica de la pregunta. Σweights debe igualar question.points.',
  })
  async upsertRubric(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('questionId') questionId: string,
    @Body(new ZodValidationPipe(upsertRubricSchema)) dto: UpsertRubricDto,
  ) {
    const u = this.requireFormador(user);
    return this.registry.getAiGraderRubricService().upsert(u.tenantId, questionId, dto);
  }

  @Delete('questions/:questionId/rubric')
  @ApiOperation({ summary: 'Elimina la rúbrica de la pregunta.' })
  async removeRubric(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('questionId') questionId: string,
  ) {
    const u = this.requireFormador(user);
    return this.registry.getAiGraderRubricService().remove(u.tenantId, questionId);
  }

  @Post('attempts/:attemptId/suggest')
  @ApiOperation({
    summary:
      'Genera sugerencias IA para todas las respuestas abiertas del attempt. Reusa cache salvo force=true.',
  })
  async suggest(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('attemptId') attemptId: string,
    @Body(new ZodValidationPipe(suggestForAttemptSchema)) dto: SuggestForAttemptDto,
  ) {
    const u = this.requireFormador(user);
    return this.registry
      .getAiGraderSuggestionService()
      .suggestForAttempt(u.tenantId, attemptId, dto);
  }

  @Get('attempts/:attemptId/suggestions')
  @ApiOperation({
    summary: 'Lista sugerencias persistidas del attempt (no llama al modelo).',
  })
  async listSuggestions(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('attemptId') attemptId: string,
  ) {
    const u = this.requireFormador(user);
    return this.registry.getAiGraderSuggestionService().listForAttempt(u.tenantId, attemptId);
  }

  @Post('suggestions/:id/apply')
  @ApiOperation({
    summary:
      'Marca la sugerencia como aplicada (auditoría). NO modifica el attempt — eso lo hace gradeAttempt de mod.assessments.',
  })
  async markApplied(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') suggestionId: string,
  ) {
    const u = this.requireFormador(user);
    return this.registry
      .getAiGraderSuggestionService()
      .markApplied(u.tenantId, suggestionId, u.sub);
  }
}
