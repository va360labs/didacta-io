import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
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
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { ModuleRegistryService } from './module-registry.service';
import { LessonUnlockNotifierWorker } from './lesson-unlock-notifier.worker';

const SCORM_EDITOR_ROLES = new Set(['super_admin', 'tenant_admin', 'formador']);
const MAX_SCORM_BASE64_BYTES = 100 * 1024 * 1024 * 1.4; // 140 MiB de base64 ≈ 100 MiB binarios

const uploadScormSchema = z.object({
  data: z.string().min(1),
  filename: z.string().min(1).max(200),
});
type UploadScormDto = z.infer<typeof uploadScormSchema>;

const createCompetencySchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(280).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
});
type CreateCompetencyDto = z.infer<typeof createCompetencySchema>;

const setCourseCompetenciesSchema = z.object({
  items: z
    .array(
      z.object({
        competencyId: z.string().uuid(),
        weight: z.number().int().min(1).max(10).optional(),
      }),
    )
    .max(50),
});
type SetCourseCompetenciesDto = z.infer<typeof setCourseCompetenciesSchema>;

const createDripScheduleSchema = z
  .object({
    audienceKind: z.enum(['TIER', 'GROUP']),
    /** Nombre del tier (TIER) o id del grupo de acceso (GROUP). */
    audienceRef: z.string().trim().min(1).max(200),
    unit: z.enum(['LESSON', 'MODULE']).optional(),
    // Mínimo 1: "cada 0 días" liberaría todo de golpe (desactiva el gating).
    intervalDays: z.number().int().min(1).max(3650),
    startOffsetDays: z.number().int().min(0).max(3650).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
type CreateDripScheduleDto = z.infer<typeof createDripScheduleSchema>;

const updateDripScheduleSchema = z
  .object({
    unit: z.enum(['LESSON', 'MODULE']).optional(),
    intervalDays: z.number().int().min(1).max(3650).optional(),
    startOffsetDays: z.number().int().min(0).max(3650).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
type UpdateDripScheduleDto = z.infer<typeof updateDripScheduleSchema>;

function requireScormEditor(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => SCORM_EDITOR_ROLES.has(r))) {
    throw new ForbiddenException('Esta acción requiere rol formador o admin.');
  }
  return user;
}

@ApiTags('Modules · Learning')
@ApiBearerAuth()
@Controller('modules/learning')
@UseGuards(JwtAuthGuard)
export class LearningController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly unlockNotifier: LessonUnlockNotifierWorker,
  ) {}

  @Get('me/enrollments')
  @ApiOperation({ summary: 'Listar mis matriculaciones' })
  async listMine(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getLearningService().listMyEnrollments(user.tenantId, user.sub);
  }

  @Get('me/stats')
  @ApiOperation({
    summary: 'Stats de aprendizaje del usuario (cursos completados + segundos vistos)',
  })
  async myStats(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getLearningService().getMyStats(user.tenantId, user.sub);
  }

  // -------------------- Competencias --------------------

  @Get('me/competencies')
  @ApiOperation({ summary: 'Mapa de competencias del usuario (derivado de cursos)' })
  async myCompetencies(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getLearningService().getMyCompetencies(user.tenantId, user.sub);
  }

  @Get('competencies')
  @ApiOperation({ summary: 'Catálogo de competencias del tenant' })
  async listCompetencies(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getLearningService().listCompetencies(user.tenantId);
  }

  @Post('competencies')
  @ApiOperation({ summary: 'Crear competencia (formador/admin)' })
  async createCompetency(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createCompetencySchema)) dto: CreateCompetencyDto,
  ) {
    const u = requireScormEditor(user);
    try {
      return await this.registry.getLearningService().createCompetency(u.tenantId, dto);
    } catch (e) {
      if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002') {
        throw new BadRequestException('Ya existe una competencia con ese nombre.');
      }
      throw e;
    }
  }

  @Delete('competencies/:id')
  @ApiOperation({ summary: 'Eliminar competencia (formador/admin)' })
  async deleteCompetency(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = requireScormEditor(user);
    return this.registry.getLearningService().deleteCompetency(u.tenantId, id);
  }

  @Get('courses/:courseId/competencies')
  @ApiOperation({ summary: 'Competencias asociadas a un curso' })
  async courseCompetencies(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('courseId') courseId: string,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getLearningService().getCourseCompetencies(user.tenantId, courseId);
  }

  @Put('courses/:courseId/competencies')
  @ApiOperation({ summary: 'Definir competencias de un curso (formador/admin)' })
  async setCourseCompetencies(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('courseId') courseId: string,
    @Body(new ZodValidationPipe(setCourseCompetenciesSchema)) dto: SetCourseCompetenciesDto,
  ) {
    const u = requireScormEditor(user);
    return this.registry
      .getLearningService()
      .setCourseCompetencies(u.tenantId, courseId, dto.items);
  }

  @Get('me/enrollments/:enrollmentId/progress')
  @ApiOperation({
    summary:
      'Lista el progreso por lección de una matriculación del usuario. Usado para hidratar qué lecciones ya completó.',
  })
  async listMyProgress(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('enrollmentId') enrollmentId: string,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getLearningService().listMyProgress(user.tenantId, user.sub, enrollmentId);
  }

  // -------------------- DRIP (liberación programada) --------------------

  @Get('courses/:courseId/drip')
  @ApiOperation({ summary: 'Lista los calendarios de drip de un curso (formador/admin).' })
  async listDrip(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('courseId') courseId: string,
  ) {
    const u = requireScormEditor(user);
    const schedules = await this.registry
      .getLearningService()
      .listDripSchedules(u.tenantId, courseId);
    return { schedules };
  }

  @Post('courses/:courseId/drip')
  @ApiOperation({ summary: 'Crea un calendario de drip para un curso (formador/admin).' })
  async createDrip(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('courseId') courseId: string,
    @Body(new ZodValidationPipe(createDripScheduleSchema)) dto: CreateDripScheduleDto,
  ) {
    const u = requireScormEditor(user);
    try {
      const schedule = await this.registry
        .getLearningService()
        .createDripSchedule(u.tenantId, { ...dto, courseId });
      return { schedule };
    } catch (e) {
      if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002') {
        throw new BadRequestException(
          'Ya existe un calendario de drip para ese curso y audiencia.',
        );
      }
      throw e;
    }
  }

  @Put('drip/:id')
  @ApiOperation({ summary: 'Edita un calendario de drip (formador/admin).' })
  async updateDrip(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateDripScheduleSchema)) dto: UpdateDripScheduleDto,
  ) {
    const u = requireScormEditor(user);
    const schedule = await this.registry
      .getLearningService()
      .updateDripSchedule(u.tenantId, id, dto);
    return { schedule };
  }

  @Delete('drip/:id')
  @ApiOperation({ summary: 'Borra un calendario de drip (formador/admin).' })
  async deleteDrip(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = requireScormEditor(user);
    await this.registry.getLearningService().deleteDripSchedule(u.tenantId, id);
    return { ok: true };
  }

  @Get('courses/:courseId/availability')
  @ApiOperation({
    summary:
      'Disponibilidad (drip) de las lecciones de un curso para el alumno actual: ' +
      'fecha de desbloqueo + si ya está disponible. Las lecciones no listadas están libres.',
  })
  async courseAvailability(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('courseId') courseId: string,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry
      .getLearningService()
      .getCourseAvailability(user.tenantId, user.sub, courseId);
  }

  // ── Aviso de desbloqueo de lecciones programadas por fecha (publishAt) ────────

  @Get('lessons/:lessonId/unlock-subscription')
  @ApiOperation({ summary: '¿Estoy suscrito al aviso de desbloqueo de esta lección?' })
  async getUnlockSubscription(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('lessonId') lessonId: string,
  ) {
    if (!user) throw new UnauthorizedException();
    const subscribed = await this.registry
      .getLearningService()
      .isSubscribedLessonUnlock(user.sub, lessonId);
    return { subscribed };
  }

  @Post('lessons/:lessonId/unlock-subscription')
  @ApiOperation({ summary: 'Pedir aviso por email cuando la lección se desbloquee.' })
  async subscribeUnlock(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('lessonId') lessonId: string,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry
      .getLearningService()
      .subscribeLessonUnlock(user.tenantId, user.sub, lessonId);
  }

  @Delete('lessons/:lessonId/unlock-subscription')
  @ApiOperation({ summary: 'Cancelar el aviso de desbloqueo de la lección.' })
  async unsubscribeUnlock(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('lessonId') lessonId: string,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry
      .getLearningService()
      .unsubscribeLessonUnlock(user.tenantId, user.sub, lessonId);
  }

  @Post('lesson-unlock/run-now')
  @ApiOperation({
    summary:
      'Fuerza un ciclo del notificador de desbloqueo (envía los avisos pendientes de clases ya publicadas). Solo super_admin. Para QA.',
  })
  async runUnlockNotifier(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.includes('super_admin')) {
      throw new ForbiddenException('Solo super_admin.');
    }
    return this.unlockNotifier.runNow();
  }

  // -------------------- Comentarios en lecciones --------------------

  @Get('lessons/:lessonId/comments')
  @ApiOperation({
    summary:
      'Lista comentarios de una lección. APPROVED de cualquier autor + propios del viewer (incluyendo PENDING/REJECTED). Si el viewer es formador/admin, también ve los PENDING de otros.',
  })
  async listLessonComments(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('lessonId') lessonId: string,
  ) {
    if (!user) throw new UnauthorizedException();
    const includePending = user.roles.some((r) =>
      ['super_admin', 'tenant_admin', 'formador'].includes(r),
    );
    return this.registry
      .getLearningService()
      .listLessonComments(user.tenantId, user.sub, lessonId, { includePending });
  }

  @Post('lessons/:lessonId/comments')
  @ApiOperation({
    summary: 'Alumno crea un comentario en la lección. Queda en estado PENDING hasta aprobación.',
  })
  async createLessonComment(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('lessonId') lessonId: string,
    @Body(
      new ZodValidationPipe(
        z.object({
          courseId: z.string().uuid(),
          body: z.string().trim().min(1).max(4000),
        }),
      ),
    )
    dto: { courseId: string; body: string },
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry
      .getLearningService()
      .createLessonComment(
        user.tenantId,
        { id: user.sub, displayName: null },
        { lessonId, courseId: dto.courseId, body: dto.body },
      );
  }

  @Get('courses/:courseId/comments/pending')
  @ApiOperation({
    summary: 'Cola de comentarios pendientes de moderación del curso. Solo formador / admin.',
  })
  async listPendingComments(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('courseId') courseId: string,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ['super_admin', 'tenant_admin', 'formador'].includes(r))) {
      throw new ForbiddenException('Sólo formadores y admins pueden ver la cola de moderación.');
    }
    return this.registry.getLearningService().listPendingCommentsForCourse(user.tenantId, courseId);
  }

  @Post('comments/:commentId/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Aprueba un comentario pendiente. Solo formador / admin.' })
  async approveLessonComment(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('commentId') commentId: string,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ['super_admin', 'tenant_admin', 'formador'].includes(r))) {
      throw new ForbiddenException('Sólo formadores y admins pueden moderar comentarios.');
    }
    return this.registry
      .getLearningService()
      .approveLessonComment(user.tenantId, user.sub, commentId);
  }

  @Post('comments/:commentId/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rechaza un comentario pendiente. Solo formador / admin.' })
  async rejectLessonComment(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('commentId') commentId: string,
    @Body(new ZodValidationPipe(z.object({ reason: z.string().max(500).optional() })))
    dto: { reason?: string },
  ) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ['super_admin', 'tenant_admin', 'formador'].includes(r))) {
      throw new ForbiddenException('Sólo formadores y admins pueden moderar comentarios.');
    }
    return this.registry
      .getLearningService()
      .rejectLessonComment(user.tenantId, user.sub, commentId, dto.reason);
  }

  @Delete('comments/:commentId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Soft-delete del comentario (sólo el autor).' })
  async deleteLessonComment(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('commentId') commentId: string,
  ) {
    if (!user) throw new UnauthorizedException();
    await this.registry
      .getLearningService()
      .deleteLessonComment(user.tenantId, user.sub, commentId);
    return { deleted: true };
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

  @Get('courses/:courseId/enrollments/:enrollmentId/progress')
  @ApiOperation({
    summary:
      'Detalle de progreso por lección de un alumno en un curso (tiempo visto). Solo formador / tenant_admin / super_admin.',
  })
  async getEnrollmentProgressDetail(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('courseId') courseId: string,
    @Param('enrollmentId') enrollmentId: string,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ['super_admin', 'tenant_admin', 'formador'].includes(r))) {
      throw new ForbiddenException(
        'Solo formadores y administradores pueden ver el progreso de un alumno.',
      );
    }
    return this.registry
      .getLearningService()
      .getEnrollmentProgressDetail(user.tenantId, courseId, enrollmentId);
  }

  @Post('enrollments')
  @ApiOperation({ summary: 'Enrollar a un usuario por admin (formador/admin)' })
  async enrollAdmin(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(enrollByAdminSchema)) dto: EnrollByAdminDto,
  ) {
    // Matricular a OTRO usuario es una acción administrativa: sin este check,
    // cualquier alumno podía matricular a cualquiera (y a sí mismo con source
    // 'ADMIN', indistinguible de una matrícula legítima del staff).
    const u = requireScormEditor(user);
    return this.registry.getLearningService().enrollByAdmin(u.tenantId, u.sub, dto);
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
    const result = await this.registry
      .getLearningService()
      .trackProgress(user.tenantId, user.sub, dto);
    // Side-effect: recalcular progreso de rutas que contengan el curso — fire-and-forget.
    this.registry
      .getLearningPathsService()
      .recalculatePathProgressByEnrollment(user.tenantId, user.sub, dto.enrollmentId)
      .catch(() => undefined);
    return result;
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

  // -----------------------------------------------------------------------
  // HU-FOR-002 — SCORM upload + metadata.
  // -----------------------------------------------------------------------

  @Post('lessons/:lessonId/scorm')
  @ApiOperation({
    summary:
      'Subir paquete SCORM (1.2 / 2004) para una lección de tipo SCORM. Body: { data: base64, filename }.',
  })
  async uploadScorm(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('lessonId') lessonId: string,
    @Body(new ZodValidationPipe(uploadScormSchema)) dto: UploadScormDto,
  ) {
    const u = requireScormEditor(user);
    if (dto.data.length > MAX_SCORM_BASE64_BYTES) {
      throw new BadRequestException('Paquete demasiado grande');
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(dto.data, 'base64');
    } catch {
      throw new BadRequestException('data debe ser base64 válido');
    }
    return this.registry
      .getScormService()
      .uploadPackage(u.tenantId, lessonId, u.sub, { zipData: buf, filename: dto.filename });
  }

  @Get('lessons/:lessonId/scorm')
  @ApiOperation({
    summary: 'Metadata del paquete SCORM de la lección + signed URL del entry para el iframe.',
  })
  async getScorm(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('lessonId') lessonId: string,
  ) {
    if (!user) throw new UnauthorizedException();
    const learning = this.registry.getLearningService();
    // La metadata del paquete incluye la signed URL del entry: para un ALUMNO
    // exige matrícula viva (un revocado/ex-trial no puede seguir reproduciendo
    // el SCORM pidiendo el paquete directo). Los editores previsualizan sin
    // matrícula, como en el resto del contenido.
    const isEditor = user.roles.some((r) => SCORM_EDITOR_ROLES.has(r));
    if (!isEditor) {
      const enrolled = await learning.hasActiveEnrollmentForLesson(
        user.tenantId,
        user.sub,
        lessonId,
      );
      if (!enrolled) {
        throw new ForbiddenException('Necesitas una matrícula activa para ver esta lección.');
      }
      // DRIP/TRIAL: una lección bloqueada tampoco se reproduce vía paquete
      // directo (attempt/commit ya estaban gateados; esto también).
      await learning.assertLessonAccessible(user.tenantId, user.sub, lessonId);
    }
    return this.registry.getScormService().getPackage(user.tenantId, lessonId);
  }

  @Post('lessons/:lessonId/scorm/attempt')
  @ApiOperation({
    summary:
      'Inicia o reanuda el attempt SCORM del alumno para esta lección. Devuelve cmi state previo o vacío.',
  })
  async startScormAttempt(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('lessonId') lessonId: string,
  ) {
    if (!user) throw new UnauthorizedException();
    // DRIP: SCORM no pasa por trackProgress, así que gateamos aquí también.
    await this.registry
      .getLearningService()
      .assertLessonAccessible(user.tenantId, user.sub, lessonId);
    return this.registry.getScormService().getOrCreateAttempt(user.tenantId, user.sub, lessonId);
  }

  @Post('lessons/:lessonId/scorm/commit')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Persiste el cmi state del attempt SCORM. Si completion_status indica done, dispara bridge a learning.trackProgress.',
  })
  async commitScormAttempt(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('lessonId') lessonId: string,
    @Body() body: { cmiData?: Record<string, string> },
  ) {
    if (!user) throw new UnauthorizedException();
    // DRIP: bloquear también el commit de una lección no liberada.
    await this.registry
      .getLearningService()
      .assertLessonAccessible(user.tenantId, user.sub, lessonId);
    return this.registry
      .getScormService()
      .commitAttempt(user.tenantId, user.sub, lessonId, body.cmiData ?? {});
  }
}

export { LearningError };
