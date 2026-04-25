import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createQuestionSchema,
  createQuizSchema,
  updateQuizSchema,
  type CreateQuestionDto,
  type CreateQuizDto,
  type UpdateQuizDto,
} from '@learnship/mod-assessments';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { ModuleRegistryService } from './module-registry.service';

const FORMADOR_ROLES = new Set(['formador', 'tenant_admin', 'super_admin']);

function requireFormador(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  const allowed = user.roles.some((r) => FORMADOR_ROLES.has(r));
  if (!allowed) {
    throw new ForbiddenException(
      'Solo formador, tenant_admin o super_admin pueden gestionar quizzes',
    );
  }
  return user;
}

@ApiTags('Modules · Assessments (formador)')
@ApiBearerAuth()
@Controller('modules/assessments')
@UseGuards(JwtAuthGuard)
export class AssessmentsController {
  constructor(private readonly registry: ModuleRegistryService) {}

  @Post('quizzes')
  @ApiOperation({ summary: 'Crear quiz (DRAFT)' })
  async createQuiz(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createQuizSchema)) dto: CreateQuizDto,
  ) {
    const u = requireFormador(user);
    return this.registry.getAssessmentsService().createQuiz(u.tenantId, u.sub, dto);
  }

  @Get('quizzes/:id')
  @ApiOperation({
    summary:
      'Detalle del quiz para el formador (incluye opciones con isCorrect — NO usar en vista alumno)',
  })
  async getQuiz(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = requireFormador(user);
    return this.registry.getAssessmentsService().getQuizForFormador(u.tenantId, id);
  }

  @Put('quizzes/:id')
  @ApiOperation({ summary: 'Actualizar metadatos del quiz' })
  async updateQuiz(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateQuizSchema)) dto: UpdateQuizDto,
  ) {
    const u = requireFormador(user);
    return this.registry.getAssessmentsService().updateQuiz(u.tenantId, id, dto);
  }

  @Post('quizzes/:id/questions')
  @ApiOperation({ summary: 'Añadir pregunta al quiz' })
  async addQuestion(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createQuestionSchema)) dto: CreateQuestionDto,
  ) {
    const u = requireFormador(user);
    return this.registry.getAssessmentsService().addQuestion(u.tenantId, id, dto);
  }

  @Delete('quizzes/:id/questions/:questionId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Borrar pregunta (soft delete)' })
  async deleteQuestion(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Param('questionId') questionId: string,
  ) {
    const u = requireFormador(user);
    await this.registry.getAssessmentsService().deleteQuestion(u.tenantId, id, questionId);
    return { deleted: true };
  }

  @Post('quizzes/:id/publish')
  @HttpCode(200)
  @ApiOperation({ summary: 'Publicar quiz (exige al menos 1 pregunta)' })
  async publishQuiz(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = requireFormador(user);
    return this.registry.getAssessmentsService().publishQuiz(u.tenantId, u.sub, id);
  }
}
