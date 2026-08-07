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
  HttpCode,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CoursesError,
  createCourseSchema,
  createLessonSchema,
  createModuleSchema,
  updateCourseSchema,
  updateLessonSchema,
  type CreateCourseDto,
  type CreateLessonDto,
  type CreateModuleDto,
  type UpdateCourseDto,
  type UpdateLessonDto,
} from '@didacta/mod-courses';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { ModuleRegistryService } from './module-registry.service';

const listQuerySchema = z.object({
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().min(1).max(80).optional(),
});

/** Roles que gestionan cursos y ven SIEMPRE el contenido completo (sin gating de drip). */
const COURSE_EDITOR_ROLES = new Set(['super_admin', 'tenant_admin', 'formador']);

/**
 * Toda escritura del catálogo (crear/editar/publicar/borrar cursos, módulos y
 * lecciones) exige rol editor. Sin este check, cualquier usuario autenticado
 * del tenant (un alumno) podía editar y publicar cursos.
 */
function requireCourseEditor(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => COURSE_EDITOR_ROLES.has(r))) {
    throw new ForbiddenException({
      message: 'Esta acción requiere rol formador, tenant_admin o super_admin.',
      code: 'COURSES_REQUIRES_EDITOR_ROLE',
    });
  }
  return user;
}

/**
 * Devuelve el detalle del curso con el `content` de las lecciones puesto a null
 * cuando `shouldMask(lessonId)` es true. Conserva la estructura (módulos +
 * títulos/tipos de lección) para que el currículo se muestre; oculta el cuerpo.
 */
function maskCourseContent(
  course: { modules: Array<{ lessons: Array<{ id: string }> }> },
  shouldMask: (lessonId: string) => boolean,
): unknown {
  return {
    ...course,
    modules: course.modules.map((m) => ({
      ...m,
      lessons: m.lessons.map((l) => (shouldMask(l.id) ? { ...l, content: null } : l)),
    })),
  };
}

@ApiTags('Modules · Courses')
@ApiBearerAuth()
@Controller('modules/courses')
@UseGuards(JwtAuthGuard)
export class CoursesController {
  constructor(private readonly registry: ModuleRegistryService) {}

  @Get()
  @ApiOperation({ summary: 'Listar cursos del tenant' })
  async list(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
  ) {
    if (!user) throw new UnauthorizedException();
    try {
      return await this.registry.getCoursesService().listCourses(user.tenantId, query);
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Post()
  @ApiOperation({ summary: 'Crear curso (DRAFT)' })
  async create(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createCourseSchema)) dto: CreateCourseDto,
  ) {
    const u = requireCourseEditor(user);
    try {
      return await this.registry.getCoursesService().createCourse(u.tenantId, u.sub, dto);
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Get('categories')
  @ApiOperation({ summary: 'Listar categorías distintas usadas por cursos publicados' })
  async categories(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    try {
      return await this.registry.getCoursesService().listCategories(user.tenantId);
    } catch (error) {
      throw this.translate(error);
    }
  }

  // ------------------- Categorías curadas (CRUD admin) -------------------

  @Get('managed-categories')
  @ApiOperation({
    summary:
      'Lista las categorías curadas del tenant con color/icono. Lectura pública dentro del tenant.',
  })
  async listManagedCategories(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    try {
      return await this.registry.getCoursesService().listManagedCategories(user.tenantId);
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Post('managed-categories')
  @ApiOperation({ summary: 'Crear categoría curada. Solo super_admin / tenant_admin.' })
  async createCategory(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(
      new ZodValidationPipe(
        z.object({
          name: z.string().trim().min(1).max(60),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color debe ser hex 6 dígitos'),
          icon: z.string().max(40).nullable().optional(),
        }),
      ),
    )
    dto: { name: string; color: string; icon?: string | null },
  ) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ['super_admin', 'tenant_admin'].includes(r))) {
      throw new HttpException(
        { code: 'FORBIDDEN', message: 'Solo admins pueden gestionar categorías.' },
        403,
      );
    }
    try {
      return await this.registry.getCoursesService().createCategory(user.tenantId, user.sub, dto);
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Put('managed-categories/:id')
  @ApiOperation({ summary: 'Actualizar categoría curada. Solo super_admin / tenant_admin.' })
  async updateCategory(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(
      new ZodValidationPipe(
        z.object({
          name: z.string().trim().min(1).max(60).optional(),
          color: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .optional(),
          icon: z.string().max(40).nullable().optional(),
        }),
      ),
    )
    dto: { name?: string; color?: string; icon?: string | null },
  ) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ['super_admin', 'tenant_admin'].includes(r))) {
      throw new HttpException(
        { code: 'FORBIDDEN', message: 'Solo admins pueden gestionar categorías.' },
        403,
      );
    }
    try {
      return await this.registry
        .getCoursesService()
        .updateCategory(user.tenantId, user.sub, id, dto);
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Delete('managed-categories/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Borrar categoría curada. Solo super_admin / tenant_admin.' })
  async deleteCategory(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ['super_admin', 'tenant_admin'].includes(r))) {
      throw new HttpException(
        { code: 'FORBIDDEN', message: 'Solo admins pueden gestionar categorías.' },
        403,
      );
    }
    try {
      await this.registry.getCoursesService().deleteCategory(user.tenantId, user.sub, id);
      return { deleted: true };
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle del curso con módulos y lecciones' })
  async get(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    try {
      const course = await this.registry.getCoursesService().getCourseDetail(user.tenantId, id);

      // Los editores (formador/admin) ven el contenido completo para gestionarlo.
      const isEditor = user.roles.some((r) => COURSE_EDITOR_ROLES.has(r));
      if (isEditor) return course;

      // Alumno: el curso debe estar publicado (no filtramos DRAFT/ARCHIVED).
      if ((course as { status?: string }).status !== 'PUBLISHED') {
        throw new NotFoundException({ message: 'Curso no encontrado', code: 'COURSE_NOT_FOUND' });
      }

      const learning = this.registry.getLearningService();
      // Sin matrícula viva: devolvemos la ESTRUCTURA (currículo) pero NUNCA el
      // `content` de las lecciones. Antes el cuerpo completo viajaba a cualquier
      // usuario autenticado, dejando el drip (y el muro de pago) en decorativo.
      const enrolled = await learning.hasActiveEnrollment(user.tenantId, user.sub, id);
      if (!enrolled) return maskCourseContent(course, () => true);

      // Matriculado: ocultar solo el `content` de las lecciones aún no liberadas
      // por el drip (lectura adelantada). El resto, completo.
      const availability = await learning.getCourseAvailability(user.tenantId, user.sub, id);
      if (!availability.drip) return course;
      return maskCourseContent(
        course,
        (lessonId) => availability.lessons[lessonId]?.available === false,
      );
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Put(':id')
  @ApiOperation({ summary: 'Actualizar metadatos del curso' })
  async update(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateCourseSchema)) dto: UpdateCourseDto,
  ) {
    const u = requireCourseEditor(user);
    try {
      return await this.registry.getCoursesService().updateCourse(u.tenantId, u.sub, id, dto);
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Post(':id/modules')
  @ApiOperation({ summary: 'Añadir módulo al curso' })
  async addModule(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createModuleSchema)) dto: CreateModuleDto,
  ) {
    const u = requireCourseEditor(user);
    try {
      return await this.registry.getCoursesService().createModule(u.tenantId, u.sub, id, dto);
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Post('modules/:moduleId/lessons')
  @ApiOperation({ summary: 'Añadir lección al módulo' })
  async addLesson(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('moduleId') moduleId: string,
    @Body(new ZodValidationPipe(createLessonSchema)) dto: CreateLessonDto,
  ) {
    const u = requireCourseEditor(user);
    try {
      return await this.registry.getCoursesService().createLesson(u.tenantId, u.sub, moduleId, dto);
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Put('lessons/:lessonId')
  @ApiOperation({ summary: 'Actualizar contenido de una lección' })
  async updateLesson(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('lessonId') lessonId: string,
    @Body(new ZodValidationPipe(updateLessonSchema)) dto: UpdateLessonDto,
  ) {
    const u = requireCourseEditor(user);
    try {
      return await this.registry.getCoursesService().updateLesson(u.tenantId, u.sub, lessonId, dto);
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Post(':id/publish')
  @HttpCode(200)
  @ApiOperation({ summary: 'Publicar curso (corre hook courses.publish.validate)' })
  async publish(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = requireCourseEditor(user);
    try {
      return await this.registry.getCoursesService().publishCourse(u.tenantId, u.sub, id);
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Post(':id/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Archivar curso' })
  async archive(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = requireCourseEditor(user);
    try {
      return await this.registry.getCoursesService().archiveCourse(u.tenantId, u.sub, id);
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Post(':id/unarchive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Desarchivar curso (ARCHIVED → DRAFT)' })
  async unarchive(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = requireCourseEditor(user);
    try {
      return await this.registry.getCoursesService().unarchiveCourse(u.tenantId, u.sub, id);
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Post('lessons/:lessonId/move')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mover lección 1 puesto arriba o abajo dentro de su módulo' })
  async moveLesson(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('lessonId') lessonId: string,
    @Body(new ZodValidationPipe(z.object({ direction: z.enum(['up', 'down']) })))
    body: { direction: 'up' | 'down' },
  ) {
    const u = requireCourseEditor(user);
    try {
      return await this.registry
        .getCoursesService()
        .moveLesson(u.tenantId, u.sub, lessonId, body.direction);
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Delete('modules/:moduleId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Eliminar módulo (soft delete con cascade lógico de sus lecciones)' })
  async deleteModule(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('moduleId') moduleId: string,
  ) {
    const u = requireCourseEditor(user);
    try {
      await this.registry.getCoursesService().deleteModule(u.tenantId, u.sub, moduleId);
      return { deleted: true };
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Delete('lessons/:lessonId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Eliminar lección (soft delete; preserva progreso histórico)' })
  async deleteLesson(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('lessonId') lessonId: string,
  ) {
    const u = requireCourseEditor(user);
    try {
      await this.registry.getCoursesService().deleteLesson(u.tenantId, u.sub, lessonId);
      return { deleted: true };
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Post('lessons/:lessonId/move-to-module')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mover una lección a otro módulo (cross-module drop)' })
  async moveLessonToModule(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('lessonId') lessonId: string,
    @Body(
      new ZodValidationPipe(
        z.object({
          targetModuleId: z.string().uuid(),
          position: z.number().int().min(0).optional(),
        }),
      ),
    )
    body: { targetModuleId: string; position?: number },
  ) {
    const u = requireCourseEditor(user);
    try {
      await this.registry
        .getCoursesService()
        .moveLessonToModule(u.tenantId, u.sub, lessonId, body.targetModuleId, body.position);
      return { moved: true };
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Post('modules/:moduleId/reorder-lessons')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reordenar lecciones del módulo (bulk, drag & drop)' })
  async reorderLessons(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('moduleId') moduleId: string,
    @Body(new ZodValidationPipe(z.object({ lessonIds: z.array(z.string().uuid()).min(1) })))
    body: { lessonIds: string[] },
  ) {
    const u = requireCourseEditor(user);
    try {
      await this.registry
        .getCoursesService()
        .reorderLessons(u.tenantId, u.sub, moduleId, body.lessonIds);
      return { reordered: true };
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Post(':id/reorder-modules')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reordenar módulos del curso (bulk, drag & drop)' })
  async reorderModules(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(z.object({ moduleIds: z.array(z.string().uuid()).min(1) })))
    body: { moduleIds: string[] },
  ) {
    const u = requireCourseEditor(user);
    try {
      await this.registry.getCoursesService().reorderModules(u.tenantId, u.sub, id, body.moduleIds);
      return { reordered: true };
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * Convierte un `CoursesError` del módulo de dominio en un `HttpException`
   * con el status code apropiado para que NestJS lo serialice como response
   * HTTP. Antes se devolvía un `Error` genérico con propiedad `.status`,
   * pero NestJS no inspecciona esa propiedad y lo trataba como 500.
   *
   * Nota: existe un `CoursesErrorFilter` global que también atrapa
   * `CoursesError` por catch decorator, pero solo se dispara cuando el
   * error sale crudo del handler — los try/catch en este controller lo
   * absorbían antes y rompían la cadena. Mantenemos ambos por defensa en
   * profundidad: si en el futuro alguien quita un try/catch, el filter
   * global cubre.
   */
  private translate(error: unknown): unknown {
    if (error instanceof CoursesError) {
      const map: Record<string, number> = {
        COURSE_NOT_FOUND: 404,
        COURSE_SLUG_EXISTS: 409,
        COURSE_ALREADY_PUBLISHED: 409,
        COURSE_NO_LESSONS: 422,
        COURSE_PUBLISH_VALIDATION_FAILED: 422,
      };
      const status = map[error.code] ?? 400;
      const body = {
        statusCode: status,
        code: error.code,
        message: error.message,
        ...('reasons' in error
          ? { reasons: (error as unknown as { reasons: string[] }).reasons }
          : {}),
      };
      return new HttpException(body, status);
    }
    return error;
  }
}
