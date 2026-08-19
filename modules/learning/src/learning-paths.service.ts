/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import {
  LearningPathAlreadyEnrolledError,
  LearningPathEnrollmentNotFoundError,
  LearningPathNotFoundError,
  LearningPathNotPublishedError,
  LearningPathNoCourseError,
} from './errors.js';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export interface CreateLearningPathDto {
  title: string;
  description?: string;
  sequenceType?: 'LINEAR' | 'FLEXIBLE';
}

export interface UpdateLearningPathDto {
  title?: string;
  description?: string;
  sequenceType?: 'LINEAR' | 'FLEXIBLE';
  estimatedMinutes?: number;
  courses?: Array<{ courseId: string; position: number }>;
}

export interface LearningPathCourseInput {
  courseId: string;
  position: number;
}

export class LearningPathsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
  ) {}

  async listPaths(tenantId: string, userId?: string) {
    const paths = await this.prisma.modLearningPath.findMany({
      where: { tenantId, status: 'PUBLISHED', deletedAt: null },
      include: { courses: { orderBy: { position: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });

    if (!userId) return paths.map((p) => this.formatPath(p, null));

    const enrollments = await this.prisma.modLearningPathEnrollment.findMany({
      where: { tenantId, userId, status: { in: ['ACTIVE', 'COMPLETED'] } },
      select: { pathId: true, status: true, progressPercent: true },
    });
    const enrollmentMap = new Map(enrollments.map((e) => [e.pathId, e]));

    return paths.map((p) => this.formatPath(p, enrollmentMap.get(p.id) ?? null));
  }

  async getPath(tenantId: string, slug: string, userId?: string) {
    const path = await this.prisma.modLearningPath.findFirst({
      where: { tenantId, slug, status: 'PUBLISHED', deletedAt: null },
      include: { courses: { orderBy: { position: 'asc' } } },
    });
    if (!path) throw new LearningPathNotFoundError();

    let enrollment = null;
    let nextStep = null;

    if (userId) {
      enrollment = await this.prisma.modLearningPathEnrollment.findUnique({
        where: { tenantId_pathId_userId: { tenantId, pathId: path.id, userId } },
      });

      if (enrollment?.status === 'ACTIVE') {
        nextStep = await this.resolveNextStep(tenantId, userId, path.courses);
      }
    }

    return {
      ...this.formatPath(path, enrollment),
      nextStep,
      courses: path.courses.map((c) => ({
        id: c.id,
        courseId: c.courseId,
        position: c.position,
      })),
    };
  }

  async createPath(tenantId: string, createdById: string, dto: CreateLearningPathDto) {
    const baseSlug = slugify(dto.title);
    const slug = await this.uniqueSlug(tenantId, baseSlug);

    return this.prisma.modLearningPath.create({
      data: {
        tenantId,
        slug,
        title: dto.title,
        description: dto.description,
        sequenceType: dto.sequenceType ?? 'LINEAR',
        status: 'DRAFT',
        createdById,
      },
      include: { courses: true },
    });
  }

  async updatePath(tenantId: string, pathId: string, dto: UpdateLearningPathDto) {
    const path = await this.requirePath(tenantId, pathId);

    let slug = path.slug;
    if (dto.title && dto.title !== path.title) {
      const baseSlug = slugify(dto.title);
      slug = await this.uniqueSlug(tenantId, baseSlug, pathId);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.modLearningPath.update({
        where: { id: pathId },
        data: {
          ...(dto.title !== undefined && { title: dto.title, slug }),
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.sequenceType !== undefined && { sequenceType: dto.sequenceType }),
          ...(dto.estimatedMinutes !== undefined && { estimatedMinutes: dto.estimatedMinutes }),
        },
      });

      if (dto.courses !== undefined) {
        await tx.modLearningPathCourse.deleteMany({ where: { pathId } });
        if (dto.courses.length > 0) {
          await tx.modLearningPathCourse.createMany({
            data: dto.courses.map((c) => ({ pathId, courseId: c.courseId, position: c.position })),
          });
        }
      }

      return tx.modLearningPath.findUniqueOrThrow({
        where: { id: pathId },
        include: { courses: { orderBy: { position: 'asc' } } },
      });
    });

    return updated;
  }

  async publishPath(tenantId: string, pathId: string) {
    const path = await this.requirePath(tenantId, pathId);
    const courseCount = await this.prisma.modLearningPathCourse.count({ where: { pathId } });

    if (path.status === 'DRAFT' && courseCount === 0) {
      throw new LearningPathNoCourseError();
    }

    const newStatus = path.status === 'PUBLISHED' ? 'DRAFT' : 'PUBLISHED';
    return this.prisma.modLearningPath.update({
      where: { id: pathId },
      data: { status: newStatus },
    });
  }

  async archivePath(tenantId: string, pathId: string) {
    await this.requirePath(tenantId, pathId);
    return this.prisma.modLearningPath.update({
      where: { id: pathId },
      data: { status: 'ARCHIVED' },
    });
  }

  async restorePath(tenantId: string, pathId: string) {
    await this.requirePath(tenantId, pathId);
    return this.prisma.modLearningPath.update({
      where: { id: pathId },
      data: { status: 'DRAFT' },
    });
  }

  async listPathsByFormador(tenantId: string) {
    return this.prisma.modLearningPath.findMany({
      where: { tenantId, deletedAt: null },
      include: {
        courses: { select: { id: true } },
        enrollments: {
          where: { status: { in: ['ACTIVE', 'COMPLETED'] } },
          select: { id: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async enrollUser(tenantId: string, userId: string, pathId: string) {
    const path = await this.prisma.modLearningPath.findFirst({
      where: { tenantId, id: pathId, status: 'PUBLISHED', deletedAt: null },
      include: { courses: { select: { courseId: true } } },
    });
    if (!path) throw new LearningPathNotPublishedError();

    const existing = await this.prisma.modLearningPathEnrollment.findUnique({
      where: { tenantId_pathId_userId: { tenantId, pathId, userId } },
    });
    if (existing && existing.status === 'ACTIVE') throw new LearningPathAlreadyEnrolledError();

    return this.prisma.$transaction(async (tx) => {
      const enrollment = await tx.modLearningPathEnrollment.upsert({
        where: { tenantId_pathId_userId: { tenantId, pathId, userId } },
        create: { tenantId, pathId, userId, status: 'ACTIVE', progressPercent: 0 },
        update: { status: 'ACTIVE', completedAt: null },
      });

      for (const { courseId } of path.courses) {
        const existingCourseEnrollment = await tx.modLearningEnrollment.findUnique({
          where: { tenantId_userId_courseId: { tenantId, userId, courseId } },
        });
        if (!existingCourseEnrollment) {
          await tx.modLearningEnrollment.create({
            data: { tenantId, userId, courseId, status: 'ACTIVE', source: 'ADMIN' },
          });
        }
      }

      return enrollment;
    });
  }

  async cancelEnrollment(tenantId: string, userId: string, pathId: string) {
    const enrollment = await this.prisma.modLearningPathEnrollment.findUnique({
      where: { tenantId_pathId_userId: { tenantId, pathId, userId } },
    });
    if (!enrollment || enrollment.status !== 'ACTIVE') {
      throw new LearningPathEnrollmentNotFoundError();
    }

    return this.prisma.modLearningPathEnrollment.update({
      where: { id: enrollment.id },
      data: { status: 'CANCELLED' },
    });
  }

  async listMyPaths(tenantId: string, userId: string) {
    const enrollments = await this.prisma.modLearningPathEnrollment.findMany({
      where: { tenantId, userId, status: { in: ['ACTIVE', 'COMPLETED'] } },
      include: {
        path: {
          include: { courses: { orderBy: { position: 'asc' } } },
        },
      },
      orderBy: { enrolledAt: 'desc' },
    });

    return enrollments.map((e) => ({
      ...this.formatPath(e.path, e),
      enrolledAt: e.enrolledAt,
    }));
  }

  async recalculatePathProgressByEnrollment(
    tenantId: string,
    userId: string,
    enrollmentId: string,
  ) {
    const enrollment = await this.prisma.modLearningEnrollment.findFirst({
      where: { id: enrollmentId, tenantId, userId },
      select: { courseId: true },
    });
    if (!enrollment) return;
    return this.recalculatePathProgress(tenantId, userId, enrollment.courseId);
  }

  async recalculatePathProgress(tenantId: string, userId: string, courseId: string) {
    const pathCourses = await this.prisma.modLearningPathCourse.findMany({
      where: { courseId },
      select: { pathId: true },
    });
    if (pathCourses.length === 0) return;

    const pathIds = pathCourses.map((pc) => pc.pathId);

    for (const pathId of pathIds) {
      const enrollment = await this.prisma.modLearningPathEnrollment.findUnique({
        where: { tenantId_pathId_userId: { tenantId, pathId, userId } },
      });
      if (!enrollment || enrollment.status !== 'ACTIVE') continue;

      const allCourses = await this.prisma.modLearningPathCourse.findMany({
        where: { pathId },
        select: { courseId: true },
      });

      const courseIds = allCourses.map((c) => c.courseId);
      // Cuenta los cursos DADOS POR TERMINADOS, no los que llegan al 100 %.
      // Una matrícula pasa a COMPLETED al cruzar su `completionThreshold`, que
      // por defecto es 75: exigir `progressPercent >= 100` hacía que un alumno
      // con todos los cursos de la ruta terminados al 80-99 % viera cada curso
      // como completado y la ruta clavada en ACTIVE para siempre, con
      // `nextStep` apuntando a un curso que ya había acabado.
      const completedEnrollments = await this.prisma.modLearningEnrollment.count({
        where: {
          tenantId,
          userId,
          courseId: { in: courseIds },
          status: 'COMPLETED',
        },
      });

      const progressPercent = Math.round((completedEnrollments / courseIds.length) * 100);
      const isCompleted = progressPercent >= 100;

      await this.prisma.modLearningPathEnrollment.update({
        where: { id: enrollment.id },
        data: {
          progressPercent,
          ...(isCompleted && enrollment.completedAt === null
            ? { status: 'COMPLETED', completedAt: new Date() }
            : {}),
        },
      });
    }
  }

  private async resolveNextStep(
    tenantId: string,
    userId: string,
    courses: Array<{ courseId: string }>,
  ) {
    if (courses.length === 0) return null;
    // Una sola query para todas las matriculaciones del usuario en los cursos
    // de la ruta (antes: una findUnique por curso → N+1 en cada carga del
    // detalle de la ruta). Resolvemos el "siguiente" en memoria.
    const courseIds = courses.map((c) => c.courseId);
    const enrollments = await this.prisma.modLearningEnrollment.findMany({
      where: { tenantId, userId, courseId: { in: courseIds } },
      select: { courseId: true, status: true },
    });
    const byCourse = new Map(enrollments.map((e) => [e.courseId, e]));
    for (const { courseId } of courses) {
      const courseEnrollment = byCourse.get(courseId);
      // Mismo criterio que el porcentaje de la ruta: terminado es COMPLETED,
      // no 100 %. Con el umbral por defecto (75) un curso acabado al 90 %
      // seguía saliendo aquí como "siguiente paso" para siempre.
      if (!courseEnrollment || courseEnrollment.status !== 'COMPLETED') {
        return { courseId, lessonId: null, courseUrl: `/cursos/${courseId}` };
      }
    }
    return null;
  }

  private formatPath(
    path: {
      id: string;
      slug: string;
      title: string;
      description: string | null;
      sequenceType: string;
      status: string;
      estimatedMinutes: number | null;
      createdAt: Date;
      courses: Array<{ courseId: string }>;
    },
    enrollment: { status: string; progressPercent: number } | null,
  ) {
    return {
      id: path.id,
      slug: path.slug,
      title: path.title,
      description: path.description,
      sequenceType: path.sequenceType,
      status: path.status,
      estimatedMinutes: path.estimatedMinutes,
      courseCount: path.courses.length,
      createdAt: path.createdAt,
      enrollment: enrollment
        ? {
            status: enrollment.status,
            progressPercent: enrollment.progressPercent,
          }
        : null,
    };
  }

  private async requirePath(tenantId: string, pathId: string) {
    const path = await this.prisma.modLearningPath.findFirst({
      where: { tenantId, id: pathId, deletedAt: null },
    });
    if (!path) throw new LearningPathNotFoundError();
    return path;
  }

  private async uniqueSlug(tenantId: string, base: string, excludeId?: string): Promise<string> {
    let slug = base;
    let attempt = 0;
    while (true) {
      const existing = await this.prisma.modLearningPath.findFirst({
        where: { tenantId, slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
        select: { id: true },
      });
      if (!existing) return slug;
      attempt++;
      slug = `${base}-${attempt}`;
    }
  }
}
