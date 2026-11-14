/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Optional,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  askSchema,
  indexCourseSchema,
  type AskDto,
  type IndexCourseDto,
} from '@didacta/mod-ai-tutor';
import { AiGatewayService } from '../../ai/ai-gateway.service';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { ModuleRegistryService } from '../module-registry.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);
/** Mismos roles que previsualizan un curso sin matricularse (PREVIEW_ROLES en web). */
const STAFF_ROLES = new Set(['super_admin', 'tenant_admin', 'formador']);

/** Respuesta de `GET /modules/ai-tutor/status`. */
export interface AiTutorStatus {
  /** El tutor puede contestar en este aula: se le enseña al alumno. */
  available: boolean;
  /** Por qué no, si no: sin proveedor de IA o sin el módulo cargado. */
  reason: 'NO_PROVIDER' | 'MODULE_INACTIVE' | null;
}

/**
 * Endpoints REST del tutor IA (LMS-90.E).
 *
 *   - POST /modules/ai-tutor/courses/:courseId/ask
 *       El alumno (o admin/formador en modo prueba) hace una pregunta.
 *       Devuelve respuesta + citas + conversationId para follow-ups.
 *   - POST /admin/ai-tutor/courses/:courseId/index
 *       Lanza re-indexación manual del curso. Solo admin.
 */
@ApiTags('Modules · AI Tutor')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class AiTutorController {
  constructor(
    private readonly registry: ModuleRegistryService,
    // Opcional para los tests que construyen el controller a mano: sin él el
    // estado no mira el proveedor (lo de antes).
    @Optional() private readonly ai?: AiGatewayService,
  ) {}

  private requireAuth(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    return user;
  }

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    const u = this.requireAuth(user);
    if (!u.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new ForbiddenException({
        message: 'Solo admins pueden re-indexar cursos.',
        code: 'AI_TUTOR_REINDEX_ADMIN_REQUIRED',
      });
    }
    return u;
  }

  @Get('modules/ai-tutor/status')
  @ApiOperation({
    summary:
      '¿Puede el tutor IA contestar en este aula? Sin proveedor de IA (ni propio ni por defecto) la respuesta es no y la web no lo enseña.',
  })
  async status(@CurrentUser() user: SessionClaims | undefined): Promise<AiTutorStatus> {
    const u = this.requireAuth(user);
    // Con el módulo apagado para el aula ni se llega aquí: el
    // ModuleAccessInterceptor responde 403 a todo `/modules/ai-tutor/…`.
    if (!this.registry.getAiTutorIndexerServiceOrNull()) {
      return { available: false, reason: 'MODULE_INACTIVE' };
    }
    if (this.ai) {
      // El tutor necesita las dos cosas: embeddings para buscar en el curso y
      // chat para contestar. Con una sola respondería «no está indexado».
      const [chat, embed] = await Promise.all([
        this.ai.isConfigured(u.tenantId, 'chat'),
        this.ai.isConfigured(u.tenantId, 'embed'),
      ]);
      if (!chat || !embed) return { available: false, reason: 'NO_PROVIDER' };
    }
    return { available: true, reason: null };
  }

  @Post('modules/ai-tutor/courses/:courseId/ask')
  @ApiOperation({
    summary:
      'Pregunta al tutor IA del curso. Devuelve respuesta basada en RAG sobre el contenido + citas a las lecciones.',
  })
  async ask(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('courseId') courseId: string,
    @Body(new ZodValidationPipe(askSchema)) dto: AskDto,
  ) {
    const u = this.requireAuth(user);
    // Formador/admin puede probar el tutor de cualquier curso sin matricularse
    // y sin gastar cuota — es la misma regla con la que ya previsualizan el
    // contenido. Nunca se decide desde el cuerpo de la petición.
    const staff = u.roles.some((r) => STAFF_ROLES.has(r));
    return this.registry.getAiTutorChatService().ask(u.tenantId, u.sub, courseId, dto, { staff });
  }

  @Post('admin/ai-tutor/courses/:courseId/index')
  @ApiOperation({
    summary:
      'Re-indexa el curso manualmente (limpia chunks previos y vuelve a generar embeddings). Solo admin.',
  })
  async reindex(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('courseId') courseId: string,
    @Body(new ZodValidationPipe(indexCourseSchema)) dto: IndexCourseDto,
  ) {
    const u = this.requireAdmin(user);
    const indexer = this.registry.getAiTutorIndexerServiceOrNull();
    if (!indexer) {
      throw new ForbiddenException({
        message: 'mod.ai-tutor no está activo en este tenant.',
        code: 'AI_TUTOR_MODULE_INACTIVE',
      });
    }
    return indexer.indexCourse(u.tenantId, courseId, { force: dto.force });
  }

  @Post('admin/ai-tutor/reindex-all')
  @ApiOperation({
    summary:
      'Re-indexa TODOS los cursos publicados del tenant (backfill). Útil para cursos que se publicaron antes de configurar el proveedor de IA o cuando la indexación automática falló. Solo admin.',
  })
  async reindexAll(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    const indexer = this.registry.getAiTutorIndexerServiceOrNull();
    if (!indexer) {
      throw new ForbiddenException({
        message: 'mod.ai-tutor no está activo en este tenant.',
        code: 'AI_TUTOR_MODULE_INACTIVE',
      });
    }
    const courses = await this.registry
      .getCoursesService()
      .listCourses(u.tenantId, { status: 'PUBLISHED' });
    const results: Array<{ courseId: string; ok: boolean; error?: string }> = [];
    for (const course of courses) {
      try {
        await indexer.indexCourse(u.tenantId, course.id, { force: true });
        results.push({ courseId: course.id, ok: true });
      } catch (err) {
        results.push({
          courseId: course.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return {
      total: courses.length,
      indexed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }
}
