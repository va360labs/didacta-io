import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  startAttemptSchema,
  submitAttemptSchema,
  type StartAttemptDto,
  type SubmitAttemptDto,
} from '@learnship/mod-assessments';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { ModuleRegistryService } from './module-registry.service';

const listAttemptsQuerySchema = z.object({
  quizId: z.string().uuid(),
});

@ApiTags('Modules · Assessments (alumno)')
@ApiBearerAuth()
@Controller('modules/assessments')
@UseGuards(JwtAuthGuard)
export class AssessmentsAttemptsController {
  constructor(private readonly registry: ModuleRegistryService) {}

  @Get('quizzes/:id/preview')
  @ApiOperation({
    summary: 'Vista del quiz para el alumno (sin isCorrect ni feedback por pregunta)',
  })
  async preview(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getAssessmentsService().getQuizForAlumno(user.tenantId, id);
  }

  @Post('attempts')
  @ApiOperation({ summary: 'Iniciar un intento de quiz' })
  async startAttempt(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(startAttemptSchema)) dto: StartAttemptDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getAssessmentsService().startAttempt(user.tenantId, user.sub, dto);
  }

  @Post('attempts/:id/submit')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Enviar respuestas del intento. Aplica scoring y emite assessments.attempt.passed o .failed.',
  })
  async submitAttempt(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(submitAttemptSchema.omit({ attemptId: true })))
    body: Omit<SubmitAttemptDto, 'attemptId'>,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry
      .getAssessmentsService()
      .submitAttempt(user.tenantId, user.sub, { attemptId: id, answers: body.answers });
  }

  @Get('attempts/:id')
  @ApiOperation({ summary: 'Detalle de un intento del alumno (incluye respuestas y scoring)' })
  async getAttempt(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getAssessmentsService().getAttempt(user.tenantId, user.sub, id);
  }

  @Get('attempts')
  @ApiOperation({ summary: 'Listar mis intentos para un quiz dado' })
  async listAttempts(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(listAttemptsQuerySchema))
    query: z.infer<typeof listAttemptsQuerySchema>,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry
      .getAssessmentsService()
      .listAttemptsForUser(user.tenantId, user.sub, query.quizId);
  }
}
