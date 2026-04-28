import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
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
    if (!user) throw new UnauthorizedException();
    try {
      return await this.registry.getCoursesService().createCourse(user.tenantId, user.sub, dto);
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
      return await this.registry.getCoursesService().getCourseDetail(user.tenantId, id);
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
    if (!user) throw new UnauthorizedException();
    try {
      return await this.registry.getCoursesService().updateCourse(user.tenantId, user.sub, id, dto);
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
    if (!user) throw new UnauthorizedException();
    try {
      return await this.registry.getCoursesService().createModule(user.tenantId, user.sub, id, dto);
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
    if (!user) throw new UnauthorizedException();
    try {
      return await this.registry
        .getCoursesService()
        .createLesson(user.tenantId, user.sub, moduleId, dto);
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
    if (!user) throw new UnauthorizedException();
    try {
      return await this.registry
        .getCoursesService()
        .updateLesson(user.tenantId, user.sub, lessonId, dto);
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Post(':id/publish')
  @HttpCode(200)
  @ApiOperation({ summary: 'Publicar curso (corre hook courses.publish.validate)' })
  async publish(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    try {
      return await this.registry.getCoursesService().publishCourse(user.tenantId, user.sub, id);
    } catch (error) {
      throw this.translate(error);
    }
  }

  @Post(':id/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Archivar curso' })
  async archive(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    try {
      return await this.registry.getCoursesService().archiveCourse(user.tenantId, user.sub, id);
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
    if (!user) throw new UnauthorizedException();
    try {
      return await this.registry
        .getCoursesService()
        .moveLesson(user.tenantId, user.sub, lessonId, body.direction);
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
    if (!user) throw new UnauthorizedException();
    try {
      await this.registry.getCoursesService().deleteModule(user.tenantId, user.sub, moduleId);
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
    if (!user) throw new UnauthorizedException();
    try {
      await this.registry.getCoursesService().deleteLesson(user.tenantId, user.sub, lessonId);
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
    if (!user) throw new UnauthorizedException();
    try {
      await this.registry
        .getCoursesService()
        .moveLessonToModule(user.tenantId, user.sub, lessonId, body.targetModuleId, body.position);
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
    if (!user) throw new UnauthorizedException();
    try {
      await this.registry
        .getCoursesService()
        .reorderLessons(user.tenantId, user.sub, moduleId, body.lessonIds);
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
    if (!user) throw new UnauthorizedException();
    try {
      await this.registry
        .getCoursesService()
        .reorderModules(user.tenantId, user.sub, id, body.moduleIds);
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
