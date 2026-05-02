import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  bulkEnrollSchema,
  enrollParticipantSchema,
  updateParticipantSchema,
  type BulkEnrollDto,
  type EnrollParticipantDto,
  type UpdateParticipantDto,
} from '@didacta/mod-fundae';
import { z } from 'zod';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { ModuleRegistryService } from '../module-registry.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

const listQuerySchema = z.object({
  includeRemoved: z.enum(['true', 'false']).optional(),
});

/**
 * Endpoints anidados de matriculaciones nominales en grupo bonificable
 * Fundae (LMS-82). Path base:
 *   `/api/v1/admin/fundae/groups/:groupId/participants`
 */
@ApiTags('Admin · Fundae · Grupo · Participantes')
@ApiBearerAuth()
@Controller('admin/fundae/groups/:groupId/participants')
@UseGuards(JwtAuthGuard)
export class FundaeGroupParticipantsController {
  constructor(private readonly registry: ModuleRegistryService) {}

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new UnauthorizedException(
        'Solo super_admin y tenant_admin pueden gestionar participantes de grupos.',
      );
    }
    return user;
  }

  @Get()
  @ApiOperation({
    summary: 'Listar matriculaciones del grupo (por defecto solo ENROLLED).',
  })
  async list(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('groupId') groupId: string,
    @Query(new ZodValidationPipe(listQuerySchema)) q: z.infer<typeof listQuerySchema>,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeGroupParticipantService().listByGroup(u.tenantId, groupId, {
      includeRemoved: q.includeRemoved === 'true',
    });
  }

  @Post()
  @ApiOperation({
    summary: 'Matricular un alumno en el grupo. Valida que esté inscrito en el curso de la acción.',
  })
  async enroll(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('groupId') groupId: string,
    @Body(new ZodValidationPipe(enrollParticipantSchema)) dto: EnrollParticipantDto,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeGroupParticipantService().enroll(u.tenantId, u.sub, groupId, dto);
  }

  @Post('bulk-enroll')
  @ApiOperation({
    summary:
      'Bulk enroll: matricula a todos los inscritos del curso de la acción que aún no estén en el grupo.',
  })
  async bulkEnroll(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('groupId') groupId: string,
    @Body(new ZodValidationPipe(bulkEnrollSchema)) dto: BulkEnrollDto,
  ) {
    const u = this.requireAdmin(user);
    return this.registry
      .getFundaeGroupParticipantService()
      .bulkEnrollFromCourse(u.tenantId, u.sub, groupId, dto.sourceCourseId);
  }

  @Patch(':participantId')
  @ApiOperation({ summary: 'Actualizar metadatos de la matriculación (NIF snapshot, notas).' })
  async update(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('groupId') groupId: string,
    @Param('participantId') participantId: string,
    @Body(new ZodValidationPipe(updateParticipantSchema)) dto: UpdateParticipantDto,
  ) {
    const u = this.requireAdmin(user);
    return this.registry
      .getFundaeGroupParticipantService()
      .update(u.tenantId, u.sub, groupId, participantId, dto);
  }

  @Delete(':participantId')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Soft-delete: marca la matriculación como REMOVED (la fila se conserva por trazabilidad Fundae).',
  })
  async remove(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('groupId') groupId: string,
    @Param('participantId') participantId: string,
  ) {
    const u = this.requireAdmin(user);
    await this.registry
      .getFundaeGroupParticipantService()
      .remove(u.tenantId, u.sub, groupId, participantId);
    return { removed: true };
  }
}
