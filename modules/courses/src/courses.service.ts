import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
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
        featuredVideoUrl: dto.featuredVideoUrl ?? null,
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
    if (dto.certificateTemplateId) {
      const tpl = await this.prisma.modCertificatesTemplate.findFirst({
        where: { tenantId, id: dto.certificateTemplateId },
      });
      if (!tpl) {
        throw new CourseNotFoundError(
          `Plantilla de certificado ${dto.certificateTemplateId} no existe en este tenant.`,
        );
      }
    }
    const updated = await this.prisma.modCoursesCourse.update({
      where: { id: courseId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.thumbnailUrl !== undefined ? { thumbnailUrl: dto.thumbnailUrl } : {}),
        ...(dto.featuredVideoUrl !== undefined ? { featuredVideoUrl: dto.featuredVideoUrl } : {}),
        ...(dto.estimatedMinutes !== undefined ? { estimatedMinutes: dto.estimatedMinutes } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.externalPurchaseUrl !== undefined
          ? { externalPurchaseUrl: dto.externalPurchaseUrl }
          : {}),
        ...(dto.certificateTemplateId !== undefined
          ? { certificateTemplateId: dto.certificateTemplateId }
          : {}),
      },
    });
    await this.publish(tenantId, actorId, 'courses.course.updated', { courseId });
    return updated;
  }

  async listCourses(
    tenantId: string,
    opts: {
      status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
      q?: string;
      category?: string;
    } = {},
  ) {
    const q = opts.q?.trim();
    return this.prisma.modCoursesCourse.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.category ? { category: opts.category } : {}),
        ...(q
          ? {
              OR: [
                { title: { contains: q, mode: 'insensitive' as const } },
                { description: { contains: q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Lista de categorías distintas en uso por cursos publicados, sólo
   * nombres. Mantenida por compat con el filtro del catálogo, que sigue
   * leyendo strings. Para metadata curada (color/icono) usar
   * `listManagedCategories`.
   */
  async listCategories(tenantId: string): Promise<string[]> {
    const rows = await this.prisma.modCoursesCourse.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: 'PUBLISHED',
        category: { not: null },
      },
      select: { category: true },
      distinct: ['category'],
      orderBy: { category: 'asc' },
    });
    return rows
      .map((r) => r.category)
      .filter((c): c is string => typeof c === 'string' && c.length > 0);
  }

  // -------------------- Categorías curadas (admin) --------------------

  /**
   * Devuelve las categorías curadas del tenant, ordenadas alfabéticamente.
   * Lectura pública dentro del tenant: cualquier usuario autenticado puede
   * consumirla para que el catálogo pinte chips con color/icono.
   */
  async listManagedCategories(tenantId: string) {
    return this.prisma.modCoursesCategory.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
    });
  }

  async createCategory(
    tenantId: string,
    actorId: string | null,
    dto: { name: string; color: string; icon?: string | null },
  ) {
    const name = dto.name.trim();
    const collision = await this.prisma.modCoursesCategory.findUnique({
      where: { tenantId_name: { tenantId, name } },
    });
    if (collision) {
      // Reusamos CourseSlugAlreadyExistsError para señalar conflicto
      // sin sumar un error nuevo todavía. El controller lo mapea a 409.
      throw new CourseSlugAlreadyExistsError(name);
    }
    const cat = await this.prisma.modCoursesCategory.create({
      data: {
        id: randomUUID(),
        tenantId,
        name,
        color: dto.color,
        icon: dto.icon ?? null,
      },
    });
    await this.ctx.auditLog.record({
      tenantId,
      actorId,
      action: 'courses.category.created',
      resourceType: 'course_category',
      resourceId: cat.id,
      metadata: { name, color: dto.color, icon: dto.icon ?? null },
    });
    return cat;
  }

  async updateCategory(
    tenantId: string,
    actorId: string | null,
    categoryId: string,
    dto: { name?: string; color?: string; icon?: string | null },
  ) {
    const existing = await this.prisma.modCoursesCategory.findFirst({
      where: { id: categoryId, tenantId },
    });
    if (!existing) throw new CourseNotFoundError(categoryId);
    const cat = await this.prisma.modCoursesCategory.update({
      where: { id: categoryId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
        ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
      },
    });
    await this.ctx.auditLog.record({
      tenantId,
      actorId,
      action: 'courses.category.updated',
      resourceType: 'course_category',
      resourceId: cat.id,
      metadata: dto,
    });
    return cat;
  }

  async deleteCategory(tenantId: string, actorId: string | null, categoryId: string) {
    const existing = await this.prisma.modCoursesCategory.findFirst({
      where: { id: categoryId, tenantId },
    });
    if (!existing) throw new CourseNotFoundError(categoryId);
    await this.prisma.modCoursesCategory.delete({ where: { id: categoryId } });
    await this.ctx.auditLog.record({
      tenantId,
      actorId,
      action: 'courses.category.deleted',
      resourceType: 'course_category',
      resourceId: categoryId,
      metadata: { name: existing.name },
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
    // BUG fix: contar deletedAt:null y usar count daba colisión con la
    // unique [courseId, position] cuando había módulos soft-deleted —
    // sus posiciones siguen ocupadas en la tabla. Usamos el máximo +1
    // sobre TODAS las filas (incluyendo soft-deleted) para que la
    // posición del nuevo módulo no choque con un legacy soft-deleted.
    const last =
      dto.position === undefined
        ? await this.prisma.modCoursesModule.findFirst({
            where: { tenantId, courseId },
            orderBy: { position: 'desc' },
            select: { position: true },
          })
        : null;
    const position = dto.position ?? (last ? last.position + 1 : 0);
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
    // Mismo bug que en createModule: count(deletedAt:null) chocaba con
    // la unique [moduleId, position] al haber lecciones soft-deleted.
    // Resolvemos con max(position)+1 sobre todas las filas, ignorando
    // deletedAt para el cálculo (la unique no filtra por deletedAt).
    const last =
      dto.position === undefined
        ? await this.prisma.modCoursesLesson.findFirst({
            where: { tenantId, moduleId },
            orderBy: { position: 'desc' },
            select: { position: true },
          })
        : null;
    const position = dto.position ?? (last ? last.position + 1 : 0);
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

  /**
   * Mueve una lección 1 puesto arriba o abajo dentro de su módulo,
   * intercambiándola con la vecina. Si la lección ya está en el extremo del
   * módulo, no hace nada (no error).
   *
   * Idempotente y transaccional: si los dos updates fallaran, el orden no
   * queda corrupto.
   */
  async moveLesson(
    tenantId: string,
    actorId: string | null,
    lessonId: string,
    direction: 'up' | 'down',
  ) {
    const lesson = await this.prisma.modCoursesLesson.findFirst({
      where: { tenantId, id: lessonId, deletedAt: null },
    });
    if (!lesson) throw new CourseNotFoundError(lessonId);

    const neighbor = await this.prisma.modCoursesLesson.findFirst({
      where: {
        tenantId,
        moduleId: lesson.moduleId,
        deletedAt: null,
        position: direction === 'up' ? { lt: lesson.position } : { gt: lesson.position },
      },
      orderBy: { position: direction === 'up' ? 'desc' : 'asc' },
    });
    if (!neighbor) return lesson; // ya está en el extremo

    // Truco para evitar conflicto con el unique (moduleId, position): pasamos
    // la lección actual a una posición temporal negativa, movemos la vecina,
    // luego ponemos la actual en la posición destino.
    const temp = -lesson.position - 1;
    await this.prisma.$transaction([
      this.prisma.modCoursesLesson.update({
        where: { id: lesson.id },
        data: { position: temp },
      }),
      this.prisma.modCoursesLesson.update({
        where: { id: neighbor.id },
        data: { position: lesson.position },
      }),
      this.prisma.modCoursesLesson.update({
        where: { id: lesson.id },
        data: { position: neighbor.position },
      }),
    ]);

    await this.publish(tenantId, actorId, 'courses.lesson.moved', {
      lessonId: lesson.id,
      moduleId: lesson.moduleId,
      from: lesson.position,
      to: neighbor.position,
    });

    return this.prisma.modCoursesLesson.findUniqueOrThrow({ where: { id: lesson.id } });
  }

  /**
   * Mueve una lección de su módulo actual a otro, insertándola en `position`
   * dentro del módulo destino. Si `position` es `undefined`, la coloca al final.
   *
   * Garantiza:
   * - Tenant isolation: la lección, el módulo origen y el destino tienen que
   *   ser del mismo tenant.
   * - El curso tiene que ser el mismo (por ahora; mover lecciones entre cursos
   *   distintos es otro caso).
   * - El unique `(moduleId, position)` no se corrompe: igual que `reorderLessons`,
   *   pasamos las lecciones afectadas por posiciones temporales negativas y luego
   *   las reasignamos.
   *
   * Necesario para cross-module drag & drop en el constructor.
   */
  async moveLessonToModule(
    tenantId: string,
    actorId: string | null,
    lessonId: string,
    targetModuleId: string,
    position?: number,
  ) {
    const lesson = await this.prisma.modCoursesLesson.findFirst({
      where: { tenantId, id: lessonId, deletedAt: null },
      include: { module: { select: { id: true, courseId: true } } },
    });
    if (!lesson) throw new CourseNotFoundError(lessonId);

    const targetModule = await this.prisma.modCoursesModule.findFirst({
      where: { tenantId, id: targetModuleId, deletedAt: null },
    });
    if (!targetModule) throw new CourseNotFoundError(targetModuleId);

    if (lesson.module.courseId !== targetModule.courseId) {
      throw new CourseNotFoundError(
        `los módulos pertenecen a cursos distintos; mover entre cursos no está soportado`,
      );
    }

    if (lesson.moduleId === targetModuleId) {
      // Mismo módulo: delegamos a la operación de reorden con la nueva posición.
      const siblings = await this.prisma.modCoursesLesson.findMany({
        where: { tenantId, moduleId: targetModuleId, deletedAt: null },
        orderBy: { position: 'asc' },
        select: { id: true },
      });
      const ids = siblings.map((s) => s.id).filter((id) => id !== lessonId);
      const insertAt = Math.max(0, Math.min(position ?? ids.length, ids.length));
      ids.splice(insertAt, 0, lessonId);
      await this.reorderLessons(tenantId, actorId, targetModuleId, ids);
      return;
    }

    // Calculamos el nuevo orden del módulo destino.
    const destSiblings = await this.prisma.modCoursesLesson.findMany({
      where: { tenantId, moduleId: targetModuleId, deletedAt: null },
      orderBy: { position: 'asc' },
      select: { id: true },
    });
    const destIds = destSiblings.map((s) => s.id);
    const insertAt = Math.max(0, Math.min(position ?? destIds.length, destIds.length));
    destIds.splice(insertAt, 0, lessonId);

    // Y el del módulo origen tras quitarla.
    const sourceSiblings = await this.prisma.modCoursesLesson.findMany({
      where: { tenantId, moduleId: lesson.moduleId, deletedAt: null, NOT: { id: lessonId } },
      orderBy: { position: 'asc' },
      select: { id: true },
    });
    const sourceIds = sourceSiblings.map((s) => s.id);

    // 1. Mover la lección al destino con position temporal y actualizar moduleId.
    // 2. Compactar destino con posiciones temporales negativas y luego definitivas.
    // 3. Compactar origen igual.
    await this.prisma.$transaction([
      // Saca la lección a una posición segura (-1) y le cambia el módulo.
      this.prisma.modCoursesLesson.update({
        where: { id: lessonId },
        data: { moduleId: targetModuleId, position: -999_999 },
      }),
      // Posiciones temporales negativas para el destino.
      ...destIds.map((id, idx) =>
        this.prisma.modCoursesLesson.update({
          where: { id },
          data: { position: -(idx + 1) * 1000 },
        }),
      ),
      // Posiciones temporales negativas para el origen.
      ...sourceIds.map((id, idx) =>
        this.prisma.modCoursesLesson.update({
          where: { id },
          data: { position: -(idx + 1) * 1000 - 500_000 },
        }),
      ),
    ]);

    await this.prisma.$transaction([
      ...destIds.map((id, idx) =>
        this.prisma.modCoursesLesson.update({
          where: { id },
          data: { position: idx },
        }),
      ),
      ...sourceIds.map((id, idx) =>
        this.prisma.modCoursesLesson.update({
          where: { id },
          data: { position: idx },
        }),
      ),
    ]);

    await this.publish(tenantId, actorId, 'courses.lesson.moved-to-module', {
      lessonId,
      fromModuleId: lesson.moduleId,
      toModuleId: targetModuleId,
      position: insertAt,
    });
  }

  /**
   * Reordena las lecciones de un módulo en bulk según la lista provista.
   *
   * `lessonIds` debe contener exactamente los IDs de las lecciones activas del
   * módulo (ni más ni menos). El orden de la lista define las nuevas
   * posiciones (0..n-1). Esto desbloquea drag & drop en el editor del curso.
   *
   * Implementación en dos pasadas para esquivar el unique `(moduleId, position)`:
   * 1. Pasar todas las lecciones a posiciones temporales negativas (offset por
   *    índice) en una transacción.
   * 2. Setearlas a las posiciones definitivas en otra transacción.
   * Es transaccional, idempotente y no corrompe el orden si falla a mitad.
   */
  async reorderLessons(
    tenantId: string,
    actorId: string | null,
    moduleId: string,
    lessonIds: string[],
  ) {
    const courseModule = await this.prisma.modCoursesModule.findFirst({
      where: { tenantId, id: moduleId, deletedAt: null },
    });
    if (!courseModule) throw new CourseNotFoundError(moduleId);

    const lessons = await this.prisma.modCoursesLesson.findMany({
      where: { tenantId, moduleId, deletedAt: null },
      select: { id: true },
    });
    const existingIds = new Set(lessons.map((l) => l.id));
    if (lessonIds.length !== existingIds.size) {
      throw new CourseNotFoundError(
        `reorder esperaba ${existingIds.size} lecciones, recibió ${lessonIds.length}`,
      );
    }
    for (const id of lessonIds) {
      if (!existingIds.has(id)) {
        throw new CourseNotFoundError(`lección ${id} no pertenece al módulo ${moduleId}`);
      }
    }

    await this.prisma.$transaction(
      lessonIds.map((id, idx) =>
        this.prisma.modCoursesLesson.update({
          where: { id },
          data: { position: -(idx + 1) * 1000 },
        }),
      ),
    );
    await this.prisma.$transaction(
      lessonIds.map((id, idx) =>
        this.prisma.modCoursesLesson.update({
          where: { id },
          data: { position: idx },
        }),
      ),
    );

    await this.publish(tenantId, actorId, 'courses.lessons.reordered', {
      moduleId,
      lessonIds,
    });
  }

  /**
   * Reordena los módulos de un curso en bulk. Mismo patrón que
   * `reorderLessons` pero a nivel de módulo.
   */
  async reorderModules(
    tenantId: string,
    actorId: string | null,
    courseId: string,
    moduleIds: string[],
  ) {
    await this.requireCourse(tenantId, courseId);

    const modules = await this.prisma.modCoursesModule.findMany({
      where: { tenantId, courseId, deletedAt: null },
      select: { id: true },
    });
    const existingIds = new Set(modules.map((m) => m.id));
    if (moduleIds.length !== existingIds.size) {
      throw new CourseNotFoundError(
        `reorder esperaba ${existingIds.size} módulos, recibió ${moduleIds.length}`,
      );
    }
    for (const id of moduleIds) {
      if (!existingIds.has(id)) {
        throw new CourseNotFoundError(`módulo ${id} no pertenece al curso ${courseId}`);
      }
    }

    await this.prisma.$transaction(
      moduleIds.map((id, idx) =>
        this.prisma.modCoursesModule.update({
          where: { id },
          data: { position: -(idx + 1) * 1000 },
        }),
      ),
    );
    await this.prisma.$transaction(
      moduleIds.map((id, idx) =>
        this.prisma.modCoursesModule.update({
          where: { id },
          data: { position: idx },
        }),
      ),
    );

    await this.publish(tenantId, actorId, 'courses.modules.reordered', {
      courseId,
      moduleIds,
    });
  }

  /**
   * Soft-delete del módulo y de todas sus lecciones (cascade lógico).
   * No borra registros: solo marca `deletedAt`. El curso sigue publicado y
   * el resto de módulos quedan intactos.
   */
  async deleteModule(tenantId: string, actorId: string | null, moduleId: string) {
    const courseModule = await this.prisma.modCoursesModule.findFirst({
      where: { tenantId, id: moduleId, deletedAt: null },
    });
    if (!courseModule) throw new CourseNotFoundError(moduleId);

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.modCoursesLesson.updateMany({
        where: { tenantId, moduleId, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.modCoursesModule.update({
        where: { id: moduleId },
        data: { deletedAt: now },
      }),
    ]);

    await this.publish(tenantId, actorId, 'courses.module.deleted', {
      courseId: courseModule.courseId,
      moduleId,
    });
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

  /**
   * Soft-delete de una lección. No borra el registro: solo marca `deletedAt`,
   * para preservar progreso histórico (`mod_learning_progress`) y permitir
   * auditoría posterior. Al desaparecer del listado, deja de mostrarse a alumnos.
   */
  async deleteLesson(tenantId: string, actorId: string | null, lessonId: string) {
    const lesson = await this.prisma.modCoursesLesson.findFirst({
      where: { tenantId, id: lessonId, deletedAt: null },
    });
    if (!lesson) throw new CourseNotFoundError(lessonId);

    await this.prisma.modCoursesLesson.update({
      where: { id: lessonId },
      data: { deletedAt: new Date() },
    });

    await this.publish(tenantId, actorId, 'courses.lesson.deleted', {
      lessonId,
      moduleId: lesson.moduleId,
    });
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
