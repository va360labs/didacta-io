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
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  listAnswersSchema,
  monthlyReportSchema,
  reviewAnswerSchema,
  upsertCorrectionSchema,
  type ListAnswersDto,
  type MonthlyReportDto,
  type ReviewAnswerDto,
  type UpsertCorrectionDto,
} from '@didacta/mod-ai-tutor';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { ModuleRegistryService } from '../module-registry.service';

/**
 * Panel de calidad del tutor IA (`/admin/ai-tutor/*`).
 *
 * Todo lo de aquí es de admin: ver qué se le pregunta al tutor, juzgar si
 * respondió bien y dejar escrita la respuesta correcta cuando no. Lo corregido
 * se convierte en conocimiento validado que el propio tutor reinyecta en sus
 * siguientes respuestas.
 *
 * Se separa de `AiTutorController` (chat del alumno + reindexado) porque es
 * otra audiencia y otro ciclo de vida: aquello lo llama el aula en cada
 * pregunta, esto lo abre una persona una vez por semana.
 */
const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

@ApiTags('Modules · AI Tutor · Revisión')
@ApiBearerAuth()
@Controller('admin/ai-tutor')
@UseGuards(JwtAuthGuard)
export class AiTutorReviewController {
  constructor(private readonly registry: ModuleRegistryService) {}

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new ForbiddenException('Solo admins pueden revisar las respuestas del tutor.');
    }
    return user;
  }

  @Get('answers')
  @ApiOperation({
    summary:
      'Lista los pares pregunta→respuesta del tutor con quién preguntó, en qué se apoyó y su estado de revisión.',
  })
  async listAnswers(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(listAnswersSchema)) query: ListAnswersDto,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getAiTutorReviewService().listAnswers(u.tenantId, query);
  }

  @Post('answers/:messageId/review')
  @ApiOperation({
    summary:
      'Marca una respuesta como correcta o corregida. Al corregir, la respuesta buena pasa a ser conocimiento validado que el tutor reutiliza.',
  })
  async review(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('messageId') messageId: string,
    @Body(new ZodValidationPipe(reviewAnswerSchema)) dto: ReviewAnswerDto,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getAiTutorReviewService().review(u.tenantId, messageId, dto, u.sub);
  }

  @Get('corrections')
  @ApiOperation({ summary: 'Conocimiento validado del tenant (respuestas escritas por personas).' })
  async listCorrections(
    @CurrentUser() user: SessionClaims | undefined,
    @Query('courseId') courseId?: string,
    @Query('soloActivas') soloActivas?: string,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getAiTutorReviewService().listCorrections(u.tenantId, {
      courseId: courseId || undefined,
      soloActivas: soloActivas === 'true',
    });
  }

  @Post('corrections')
  @ApiOperation({
    summary: 'Añade conocimiento validado a mano, sin partir de una respuesta concreta del tutor.',
  })
  async createCorrection(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(upsertCorrectionSchema)) dto: UpsertCorrectionDto,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getAiTutorReviewService().createCorrection(u.tenantId, dto, u.sub);
  }

  @Patch('corrections/:id')
  @ApiOperation({
    summary:
      'Edita o desactiva una respuesta validada. Si cambia la pregunta se vuelve a calcular su embedding.',
  })
  async updateCorrection(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(upsertCorrectionSchema.partial()))
    dto: Partial<UpsertCorrectionDto>,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getAiTutorReviewService().updateCorrection(u.tenantId, id, dto);
  }

  @Delete('corrections/:id')
  @ApiOperation({ summary: 'Borra una respuesta validada.' })
  async deleteCorrection(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    await this.registry.getAiTutorReviewService().deleteCorrection(u.tenantId, id);
    return { deleted: true };
  }

  @Get('report/monthly')
  @ApiOperation({
    summary:
      'Informe del mes: preguntas agrupadas por tema, ordenadas por volumen, con cuántos alumnos distintos preguntaron y quiénes.',
  })
  async monthlyReport(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(monthlyReportSchema)) query: MonthlyReportDto,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getAiTutorReviewService().monthlyReport(u.tenantId, query);
  }
}
