import {
  Body,
  Controller,
  Delete,
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
      const httpError = new Error(error.message) as Error & { status?: number; code?: string };
      httpError.status = status;
      httpError.code = error.code;
      return httpError;
    }
    return error;
  }
}
