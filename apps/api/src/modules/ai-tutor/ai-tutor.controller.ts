import { Body, Controller, Param, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  askSchema,
  indexCourseSchema,
  type AskDto,
  type IndexCourseDto,
} from '@didacta/mod-ai-tutor';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { ModuleRegistryService } from '../module-registry.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

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
  constructor(private readonly registry: ModuleRegistryService) {}

  private requireAuth(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    return user;
  }

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    const u = this.requireAuth(user);
    if (!u.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new UnauthorizedException('Solo admins pueden re-indexar cursos.');
    }
    return u;
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
    return this.registry.getAiTutorChatService().ask(u.tenantId, u.sub, courseId, dto);
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
      throw new UnauthorizedException('mod.ai-tutor no está activo en este tenant.');
    }
    return indexer.indexCourse(u.tenantId, courseId, { force: dto.force });
  }
}
