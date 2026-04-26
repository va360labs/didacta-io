import {
  Body,
  Controller,
  Delete,
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
  createInvitationSchema,
  enrollByAdminSchema,
  enrollByCodeSchema,
  enrollByLinkSchema,
  enrollSelfSchema,
  listInvitationsQuerySchema,
  trackProgressSchema,
  type CreateInvitationDto,
  type EnrollByAdminDto,
  type EnrollByCodeDto,
  type EnrollByLinkDto,
  type EnrollSelfDto,
  type ListInvitationsQueryDto,
  type TrackProgressDto,
  LearningError,
} from '@didacta/mod-learning';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { ModuleRegistryService } from './module-registry.service';

@ApiTags('Modules · Learning')
@ApiBearerAuth()
@Controller('modules/learning')
@UseGuards(JwtAuthGuard)
export class LearningController {
  constructor(private readonly registry: ModuleRegistryService) {}

  @Get('me/enrollments')
  @ApiOperation({ summary: 'Listar mis matriculaciones' })
  async listMine(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getLearningService().listMyEnrollments(user.tenantId, user.sub);
  }

  @Get('courses/:courseId/enrollments')
  @ApiOperation({
    summary:
      'HU-FORM-002: lista de alumnos matriculados en un curso. Solo formador / tenant_admin / super_admin.',
  })
  async listEnrollmentsByCourse(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('courseId') courseId: string,
    @Query('status') status?: 'ACTIVE' | 'COMPLETED' | 'CANCELLED',
    @Query('limit') limit?: string,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ['super_admin', 'tenant_admin', 'formador'].includes(r))) {
      throw new UnauthorizedException(
        'Solo formadores y administradores pueden ver el listado de alumnos.',
      );
    }
    return this.registry.getLearningService().listEnrollmentsByCourse(user.tenantId, courseId, {
      status,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('enrollments')
  @ApiOperation({ summary: 'Enrollar a un usuario por admin' })
  async enrollAdmin(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(enrollByAdminSchema)) dto: EnrollByAdminDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getLearningService().enrollByAdmin(user.tenantId, user.sub, dto);
  }

  @Post('enrollments/me')
  @ApiOperation({ summary: 'Auto-matriculación: el alumno se enrolla a sí mismo en un curso' })
  async enrollSelf(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(enrollSelfSchema)) dto: EnrollSelfDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getLearningService().enrollSelf(user.tenantId, user.sub, dto.courseId);
  }

  @Post('enrollments/by-code')
  @ApiOperation({ summary: 'Auto-matriculación con código' })
  async enrollByCode(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(enrollByCodeSchema)) dto: EnrollByCodeDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getLearningService().enrollByCode(user.tenantId, user.sub, dto);
  }

  @Post('enrollments/by-link')
  @ApiOperation({ summary: 'Auto-matriculación con token de invitación' })
  async enrollByLink(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(enrollByLinkSchema)) dto: EnrollByLinkDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getLearningService().enrollByLink(user.tenantId, user.sub, dto);
  }

  @Delete('enrollments/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancelar mi matriculación' })
  async cancel(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getLearningService().cancelEnrollment(user.tenantId, user.sub, id);
  }

  @Post('progress')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reportar progreso en una lección' })
  async track(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(trackProgressSchema)) dto: TrackProgressDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getLearningService().trackProgress(user.tenantId, user.sub, dto);
  }

  @Get('invitations')
  @ApiOperation({ summary: 'Listar invitaciones activas de un curso' })
  async listInvitations(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(listInvitationsQuerySchema)) query: ListInvitationsQueryDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry
      .getLearningService()
      .listInvitationsForCourse(user.tenantId, query.courseId);
  }

  @Post('invitations')
  @ApiOperation({ summary: 'Crear invitación (código + token)' })
  async createInvitation(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createInvitationSchema)) dto: CreateInvitationDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getLearningService().createInvitation(user.tenantId, user.sub, dto);
  }

  @Delete('invitations/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revocar invitación' })
  async revokeInvitation(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    await this.registry.getLearningService().revokeInvitation(user.tenantId, id);
    return { revoked: true };
  }
}

export { LearningError };
