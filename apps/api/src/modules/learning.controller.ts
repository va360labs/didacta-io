import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createInvitationSchema,
  enrollByAdminSchema,
  enrollByCodeSchema,
  enrollByLinkSchema,
  trackProgressSchema,
  type CreateInvitationDto,
  type EnrollByAdminDto,
  type EnrollByCodeDto,
  type EnrollByLinkDto,
  type TrackProgressDto,
  LearningError,
} from '@learnship/mod-learning';
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

  @Post('enrollments')
  @ApiOperation({ summary: 'Enrollar a un usuario por admin (requiere permiso)' })
  async enrollAdmin(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(enrollByAdminSchema)) dto: EnrollByAdminDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getLearningService().enrollByAdmin(user.tenantId, user.sub, dto);
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

  @Post('invitations')
  @ApiOperation({ summary: 'Crear invitación (código + token)' })
  async createInvitation(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createInvitationSchema)) dto: CreateInvitationDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getLearningService().createInvitation(user.tenantId, user.sub, dto);
  }
}

export { LearningError };
