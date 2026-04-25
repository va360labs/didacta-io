import type { ModuleContext } from '@learnship/core-kernel';
import type { PrismaClient } from '@learnship/database';
import { randomUUID } from 'node:crypto';
import {
  CourseAlreadyPublishedError,
  CourseHasNoLessonsError,
  CourseNotFoundError,
  CourseSlugAlreadyExistsError,
  PublishValidationError,
} from './errors.js';
import type {
  CreateCourseDto,
  CreateLessonDto,
  CreateModuleDto,
  UpdateCourseDto,
  UpdateLessonDto,
} from './dto.js';

export class CoursesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
  ) {}

  async createCourse(tenantId: string, actorId: string | null, dto: CreateCourseDto) {
    const existing = await this.prisma.modCoursesCourse.findUnique({
      where: { tenantId_slug: { tenantId, slug: dto.slug } },
    });
    if (existing) throw new CourseSlugAlreadyExistsError(dto.slug);

    const course = await this.prisma.modCoursesCourse.create({
      data: {
        tenantId,
        slug: dto.slug,
        title: dto.title,
        description: dto.description ?? null,
        thumbnailUrl: dto.thumbnailUrl ?? null,
        language: dto.language,
        estimatedMinutes: dto.estimatedMinutes ?? null,
        category: dto.category ?? null,
        createdById: actorId,
      },
    });

    await this.publish(tenantId, actorId, 'courses.course.created', { courseId: course.id });
    await this.ctx.auditLog.record({
      tenantId,
      actorId,
      action: 'course.created',
      resourceType: 'course',
      resourceId: course.id,
      metadata: { slug: course.slug, title: course.title },
    });
    return course;
  }

  async updateCourse(
    tenantId: string,
    actorId: string | null,
    courseId: string,
    dto: UpdateCourseDto,
  ) {
    await this.requireCourse(tenantId, courseId);
    const updated = await this.prisma.modCoursesCourse.update({
      where: { id: courseId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.thumbnailUrl !== undefined ? { thumbnailUrl: dto.thumbnailUrl } : {}),
        ...(dto.language !== undefined ? { language: dto.language } : {}),
        ...(dto.estimatedMinutes !== undefined ? { estimatedMinutes: dto.estimatedMinutes } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
      },
    });
    await this.publish(tenantId, actorId, 'courses.course.updated', { courseId });
    return updated;
  }

  async listCourses(tenantId: string, opts: { status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' } = {}) {
    return this.prisma.modCoursesCourse.findMany({
      where: { tenantId, deletedAt: null, ...(opts.status ? { status: opts.status } : {}) },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getCourseDetail(tenantId: string, courseId: string) {
    const course = await this.prisma.modCoursesCourse.findFirst({
      where: { tenantId, id: courseId, deletedAt: null },
      include: {
        modules: {
          where: { deletedAt: null },
          orderBy: { position: 'asc' },
          include: {
            lessons: {
              where: { deletedAt: null },
              orderBy: { position: 'asc' },
            },
          },
        },
      },
    });
    if (!course) throw new CourseNotFoundError(courseId);
    return course;
  }

  async createModule(
    tenantId: string,
    actorId: string | null,
    courseId: string,
    dto: CreateModuleDto,
  ) {
    await this.requireCourse(tenantId, courseId);
    const position =
      dto.position ??
      (await this.prisma.modCoursesModule.count({
        where: { tenantId, courseId, deletedAt: null },
      }));
    const created = await this.prisma.modCoursesModule.create({
      data: {
        tenantId,
        courseId,
        title: dto.title,
        description: dto.description ?? null,
        position,
      },
    });
    await this.publish(tenantId, actorId, 'courses.module.created', {
      courseId,
      moduleId: created.id,
    });
    return created;
  }

  async createLesson(
    tenantId: string,
    actorId: string | null,
    moduleId: string,
    dto: CreateLessonDto,
  ) {
    const courseModule = await this.prisma.modCoursesModule.findFirst({
      where: { tenantId, id: moduleId, deletedAt: null },
    });
    if (!courseModule) throw new CourseNotFoundError(moduleId);
    const position =
      dto.position ??
      (await this.prisma.modCoursesLesson.count({
        where: { tenantId, moduleId, deletedAt: null },
      }));
    const created = await this.prisma.modCoursesLesson.create({
      data: {
        tenantId,
        moduleId,
        type: dto.type,
        title: dto.title,
        position,
        content: (dto.content ?? {}) as never,
        durationMinutes: dto.durationMinutes ?? null,
      },
    });
    await this.publish(tenantId, actorId, 'courses.lesson.created', {
      courseId: courseModule.courseId,
      moduleId,
      lessonId: created.id,
    });
    return created;
  }

  async updateLesson(
    tenantId: string,
    actorId: string | null,
    lessonId: string,
    dto: UpdateLessonDto,
  ) {
    const lesson = await this.prisma.modCoursesLesson.findFirst({
      where: { tenantId, id: lessonId, deletedAt: null },
    });
    if (!lesson) throw new CourseNotFoundError(lessonId);

    const updated = await this.prisma.modCoursesLesson.update({
      where: { id: lessonId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.content !== undefined ? { content: dto.content as never } : {}),
        ...(dto.durationMinutes !== undefined ? { durationMinutes: dto.durationMinutes } : {}),
      },
    });

    await this.publish(tenantId, actorId, 'courses.lesson.updated', { lessonId });
    return updated;
  }

  async publishCourse(tenantId: string, actorId: string | null, courseId: string) {
    const course = await this.requireCourse(tenantId, courseId);
    if (course.status === 'PUBLISHED') throw new CourseAlreadyPublishedError(courseId);

    const lessonCount = await this.prisma.modCoursesLesson.count({
      where: { tenantId, module: { courseId }, deletedAt: null },
    });
    if (lessonCount === 0) throw new CourseHasNoLessonsError();

    // Hook abierto: otros módulos pueden bloquear la publicación añadiendo razones
    const reasons: string[] = [];
    await this.ctx.hookRegistry.run('courses.publish.validate', {
      tenantId,
      input: { courseId, reasons },
      metadata: { actorId },
    });
    if (reasons.length > 0) throw new PublishValidationError(reasons);

    const published = await this.prisma.modCoursesCourse.update({
      where: { id: courseId },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });

    await this.publish(tenantId, actorId, 'courses.course.published', { courseId });
    await this.ctx.auditLog.record({
      tenantId,
      actorId,
      action: 'course.published',
      resourceType: 'course',
      resourceId: courseId,
      metadata: { lessonCount, slug: course.slug },
    });
    return published;
  }

  async archiveCourse(tenantId: string, actorId: string | null, courseId: string) {
    const course = await this.requireCourse(tenantId, courseId);
    if (course.status === 'ARCHIVED') return course;
    const updated = await this.prisma.modCoursesCourse.update({
      where: { id: courseId },
      data: { status: 'ARCHIVED' },
    });
    await this.publish(tenantId, actorId, 'courses.course.archived', { courseId });
    await this.ctx.auditLog.record({
      tenantId,
      actorId,
      action: 'course.archived',
      resourceType: 'course',
      resourceId: courseId,
    });
    return updated;
  }

  private async requireCourse(tenantId: string, courseId: string) {
    const course = await this.prisma.modCoursesCourse.findFirst({
      where: { tenantId, id: courseId, deletedAt: null },
    });
    if (!course) throw new CourseNotFoundError(courseId);
    return course;
  }

  private async publish(
    tenantId: string,
    actorId: string | null,
    name: string,
    data: Record<string, unknown>,
  ) {
    await this.ctx.eventBus.publish({
      name,
      version: 1,
      data,
      metadata: {
        tenantId,
        userId: actorId ?? undefined,
        timestamp: new Date().toISOString(),
        traceId: randomUUID(),
        idempotencyKey: `${name}:${JSON.stringify(data)}:${Date.now()}`,
      },
    });
  }
}
